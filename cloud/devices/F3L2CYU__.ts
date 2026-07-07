import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG front-load washer — matched on modelId "F3L2CYU__". AABB frames (buf = the AABB body, AA+len and
// checksum+BB already stripped, buf[0]==0x20 on every frame) are discriminated by buf[1] (NOT buf[3],
// which is a rolling sequence counter for this model):
//   0x31        one-time device-ID/serial frame at connect — not decoded.
//   0xEC        dial/status frame — two stacked 25/26-byte records (old state, then new state), each
//               starting with a 0x18 marker; we read record B (buf[29:]), the current state.
//   0xEB        single-record status frame — same 25-byte record layout as 0xEC's record B, just without
//               a preceding "old state" record (seen right after the appliance (re)connects, before it has
//               a prior state to diff against). Live-confirmed: identical field offsets to 0xEC's record B.
//   0xBD / 0xCD full status dump / idle keepalive (~406/405 bytes) — carry some of the same fields
//               (e.g. remaining time at absolute offset 10) but were not exhaustively mapped; not decoded.
//   0x72, 0xD8  short heartbeat/ping frames — not decoded.
// All offsets below are live-verified: captured real traffic via the rethink-agent MCP tools while
// driving the physical washer (dial browsing, single-variable settings toggles, full wash cycles,
// pause/resume, remote start/pause/power-off from the LG app) and correlating each byte change against
// the LG cloud's own decoded washerDryer state at matching timestamps — not guessed from static analysis.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 54 // 3B header + 26B record A (old) + 25B record B (current)
const RECORD_B_OFFSET = 29

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 28 // 3B header + 25B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

// Offsets below are relative to record B's own 0x18 marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute]: the estimated cycle time while Selecting/Delay-pending, or the countdown
// while running. Confirmed exactly against the cloud's initialTimeHour/Minute and remainTimeHour/Minute
// across many single-variable settings toggles and a full wash cycle countdown (13->...->1 min).
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[6]: the course/dial-position identifier (NOT the same as rec[2:4] — an earlier pass mistook the
// time-estimate bytes for a "course code" because each course's default settings produce a distinctive
// default time; rec[6] is the real, stable identifier, confirmed unchanged across a whole settings-toggle
// session on a fixed course). 14 named programs map to 14 distinct values; 0x00 is a transitional/
// no-selection state (also the sentinel value seen at power-off, alongside 0xfe).
const COURSE_OFFSET = 6
const SOIL_OFFSET = 8
const SPIN_OFFSET = 9
const TEMP_OFFSET = 10
// rec[11] high nibble = extra-rinse count (0-3); low nibble is a constant 1.
const EXTRA_RINSE_COUNT_OFFSET = 11
// rec[13:15] = [hour][minute]: Delay Wash reserve time, ticking down like a clock (confirmed across a
// 3:00 -> 2:59 hour-boundary rollover). Only meaningful while phase == PHASE_DELAY.
const RESERVE_HOUR_OFFSET = 13
const RESERVE_MIN_OFFSET = 14
// rec[15]: options bitfield, each bit isolated via a single-variable toggle against the cloud's enum.
const FLAGS_OFFSET = 15
const FLAG_TURBO_WASH = 0x80
const FLAG_EXTRA_RINSE = 0x40
const FLAG_PRE_WASH = 0x08
const FLAG_STEAM = 0x04
const FLAG_DELAY_ACTIVE = 0x02
// rec[16]: a separate bitfield from rec[15] — confirmed by isolating Cold Wash (which also forces the
// temp index to 0x02/Cold) and the door-lock state (unlocks on pause, relocks on resume/start) against
// the cloud's coldWash field and the pause/resume phase transitions, respectively.
const OPT2_OFFSET = 16
const OPT2_DOOR_LOCKED = 0x80
const OPT2_COLD_WASH = 0x10
// rec[17]: plain door-closed sensor, independent of the rec[16] lock bit (the machine can be paused with
// the door shut-but-unlocked). Confirmed both directions against the cloud's doorClose field.
const DOOR_OFFSET = 17
const DOOR_CLOSED = 0x02

const PHASE_OFF = 0x00

// Phase/status byte. 0x14 (Sensing) carried over from the original qualitative pass — this session's
// Speed Wash runs went straight 0x05->0x17 without an observed Sensing step, so it's unconfirmed but
// harmless to include (anything genuinely unmapped falls back to 'Running').
const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x05: 'Selecting',
    0x06: 'Paused',
    0x0a: 'Delay Wash',
    0x14: 'Sensing',
    0x17: 'Washing',
    0x1e: 'Rinsing',
    0x28: 'Spinning',
    0x3c: 'Complete',
}

// Course/dial-position identifier -> name. Live-confirmed by turning the dial through every position and
// reading the LG cloud's own apCourseFLUpper25inchBaseUS at each stop.
const COURSE: Record<number, string> = {
    0x01: 'Tub Clean',
    0x02: 'Bright Whites',
    0x03: 'Allergiene',
    0x04: 'Sanitary',
    0x05: 'Bedding',
    0x06: 'Heavy Duty',
    0x07: 'Normal',
    0x08: 'Sportswear',
    0x09: 'Perm Press',
    0x0a: 'Delicates',
    0x0b: 'Towels',
    0x0c: 'Speed Wash',
    0x0d: 'Rinse+Spin',
    0x0e: 'Small Load',
}

// Soil level 1-5, clean sequential mapping confirmed by single-step toggling against the cloud's
// soilWash enum.
const SOIL: Record<number, string> = {
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

// Spin 2-5 confirmed the same way; 1 (No Spin) is implied by the sequence but wasn't directly toggled to.
const SPIN: Record<number, string> = {
    1: 'No Spin',
    2: 'Low',
    3: 'Medium',
    4: 'High',
    5: 'Extra High',
}

// Temp indices confirmed the same way; 3/5 are unused/skipped on this model.
const TEMP: Record<number, string> = {
    1: 'Tap Cold',
    2: 'Cold',
    4: 'Warm',
    6: 'Hot',
    7: 'Extra Hot',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): unmapped phase codes emit 'Running'.
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        // dual-purpose: the estimated cycle time while selecting, the countdown while
                        // running — this model has no separate byte for a persistent "initial estimate".
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash time remaining',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-sync',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door', // payload ON = open, OFF = closed
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' — that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0x31 (serial), 0xBD/0xCD (full/idle dumps) and 0x72/0xD8 (heartbeats) are not yet decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== 0x18) return // record B should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Running')
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        // Zeroed on Off rather than trusting the raw bytes — a stray leftover minute was observed on a
        // real power-off capture, and a stale countdown while OFF would be misleading in HA regardless.
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('spin', SPIN[rec[SPIN_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        this.publishProperty('extra_rinse_count', rec[EXTRA_RINSE_COUNT_OFFSET] >> 4)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('extra_rinse', (flags & FLAG_EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (flags & FLAG_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (flags & FLAG_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', (flags & FLAG_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('delay_wash', (flags & FLAG_DELAY_ACTIVE) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('cold_wash', (opt2 & OPT2_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (opt2 & OPT2_DOOR_LOCKED) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('door', rec[DOOR_OFFSET] === DOOR_CLOSED ? 'OFF' : 'ON')
        // not yet located (declared entities intentionally omitted rather than published wrong): error,
        // child_lock, remote_start (the latter two appear cloud-side only — no device-frame bit found for
        // either despite dedicated isolation tests), tub-clean count.
    }
}
