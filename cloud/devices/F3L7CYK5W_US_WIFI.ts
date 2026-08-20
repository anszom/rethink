import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG front-load washer — matched on modelId "F3L7CYK5W_US_WIFI". Shares the AABB record layout of the
// F3L2CYU__ sibling (25-byte record led by a 0x18 marker) but is NOT an alias of it:
//   * The course table is genuinely different — not a superset or a renaming, a different assignment.
//     Aliasing would mislabel nine of the twelve dial positions (it would call Normal "Heavy Duty").
//   * rec[11] packs two fields: the low nibble is a live rinse count, the high nibble the extra-rinse
//     setting. The sibling documents the low nibble as "a constant 1".
//   * rec[15] carries two option bits the sibling does not have (child lock, Rinse+Spin), and this model
//     has no TurboWash button at all, so the sibling's 0x80 is left unmapped rather than inherited.
//   * rec[4:6] is a persistent initial-cycle-time estimate. The sibling states that model has none.
//   * rec[22] and rec[24] carry fields the sibling does not decode.
//
// Frames are discriminated by buf[1] (buf[0] == 0x20 on every frame):
//   0xEC        status frame — two stacked 25-byte records (old state, then current), each led by a 0x18
//               marker; we read record B (buf[29:]). Verified across a 172-frame capture: record A is
//               byte-identical to the previous frame's record B in 171/171 consecutive pairs.
//   0xEB        single-record status frame, record at buf[3:] — same 25-byte layout, no preceding "old
//               state" record. Seen right after the appliance reconnects.
//   0xE2        NOT decoded, deliberately. It has the same 28-byte shape as 0xEB with a valid 0x18 record
//               at buf[3:], so it is tempting to treat as status — but it is emitted in a burst
//               immediately AFTER a cycle finishes and replays a stale snapshot of that cycle's START
//               (phase Sensing, the pre-run time estimate, and the pre-increment rec[22]). Decoding it
//               would knock the machine back from "Complete" to "Sensing" every time a wash ended.
//   0xBD / 0xCD full status dump / idle keepalive (~405-476 bytes) — not decoded.
//   0x31        one-time device-ID/serial frame at connect — not decoded.
//   0x72, 0xD8  short heartbeat/ping frames — not decoded.
//
// All offsets below are live-verified against the LG cloud's own decoded washerDryer state: captured real
// traffic while driving the physical washer (dial sweep through every position, single-variable settings
// toggles, three complete wash cycles, pause/resume, Add Garments mid-cycle) and correlated each byte
// change against the cloud field that moved with it. Cloud notifications were filtered on the capture
// tool's matchesDevice flag — the dryer on the same account emits washerDryer updates that share key
// names (state, preState, temp), and merging those in silently corrupts the mapping.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 54 // 3B header + 26B record A (old) + 25B record B (current)
const RECORD_B_OFFSET = 29

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 28 // 3B header + 25B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request —
// the fridges, the EU washers and the US WashTower all use it; actuating commands are 0xF0E5,
// so this only ever reads. Confirmed on a live F3L7CYK5W: the washer answered within a second
// with a 0xEB snapshot.
const STATUS_REQUEST = 'F0ED1121010000001800'

const RECORD_MARKER = 0x18

// Offsets below are relative to the record's own 0x18 marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute], the live countdown, matching the cloud's remainTimeHour/Minute.
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute], the cycle's total estimate, matching initialTimeHour/Minute. While the
// machine is idle this tracks rec[2:4] exactly; the moment a cycle starts it PINS and stays fixed while
// rec[2:4] counts down (observed pinned at 80 minutes for one run and 58 for two others).
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
const COURSE_OFFSET = 6
const SOIL_OFFSET = 8
const SPIN_OFFSET = 9
const TEMP_OFFSET = 10
// rec[11] packs two independent fields, each confirmed by isolating it against its own cloud enum:
//   low nibble  = rinseCount   (RINSE_1/2/3) — how many rinses this cycle will do, and it decrements as
//                 they complete, reaching 0 by the spin phase.
//   high nibble = extraRinseCount (NO_EXTRARINSE / EXTRARINSE_1/2/3) — watched step 1->2->3->0 across two
//                 full presses of the Extra Rinse button.
// The sibling reads only the high nibble and calls the low nibble a constant; here it is neither constant
// nor static.
const RINSE_OFFSET = 11
// rec[13:15] = [hour][minute], the Delay Wash reserve clock, matching reserveTimeHour. Confirmed by
// stepping the delay from 2 up to 19 hours and watching rec[13] track it exactly.
const RESERVE_HOUR_OFFSET = 13
const RESERVE_MIN_OFFSET = 14
// rec[15]: options bitfield. Every bit below was isolated with a single-variable toggle and matched to the
// cloud field named beside it. Bit 0x80 is TurboWash on the sibling; this model HAS NO TurboWash button
// (confirmed against the physical control panel), so it is deliberately left unmapped rather than
// inherited on faith.
const FLAGS_OFFSET = 15
// Child lock. Both the sibling washer and the RV13B6BSD dryer document this as unfindable in device
// frames ("appears cloud-side only"); on this model it is rec[15] bit 0x01, confirmed against
// childLock:"CHILDLOCK_ON" 1s after the press.
const FLAG_CHILD_LOCK = 0x01
const FLAG_DELAY_ACTIVE = 0x02
const FLAG_STEAM = 0x04
const FLAG_PRE_WASH = 0x08
// Rinse+Spin. Not present on the sibling at all. Selecting it also zeroes the soil and temperature
// indices, which is why those report unknown while it is active.
const FLAG_RINSE_SPIN = 0x20
const FLAG_EXTRA_RINSE = 0x40
// rec[16]: a separate bitfield from rec[15].
const OPT2_OFFSET = 16
const OPT2_COLD_WASH = 0x10
// Door lock, confirmed by watching it unlock when Add Garments was pressed mid-cycle and relock on resume.
// NOTE: the cloud's remoteStart moved in lockstep with this bit throughout the capture, so a remote-start
// bit could not be separated from it; no remote_start entity is published as a result.
const OPT2_DOOR_LOCKED = 0x80
// rec[17] was previously published as a door sensor. IT IS NOT ONE — it tracks the door *latch*, and the
// entity was retracted after direct testing on the appliance (2026-08-13):
//   * polled with the door physically OPEN and again physically CLOSED, machine powered on and idle: the
//     two frames were byte-for-byte identical, so door position is simply not carried in this frame.
//   * bit 0x02 only appears while the machine has the door latched for a cycle, and it lags the rec[16]
//     lock bit by a frame or two on release — unlocked-but-shut and genuinely-open both read 0x00, so the
//     entity reported "open" whenever the washer was merely idle.
//   * opening or closing the door produces no frame at all, in either power state.
// The original mapping was confirmed against the cloud's doorClose during a *running* cycle, where
// "latched" and "closed" are necessarily the same thing. The two only diverge when the machine is idle,
// which is the state that was never sampled; LG's doorClose appears to be derived the same way, so the
// cloud agreeing with the wire did not catch it either.
// Nothing is published for door position: this washer does not report it. Use door_lock (rec[16] 0x80),
// or an external contact sensor if you need to know whether the door is actually open.
// Bit 0x10 at rec[17] also sets during Add Garments and Pause — unidentified, so not published.
// rec[20]: the phase the machine was in before the current one — literally the cloud's preState, and it
// holds steady across every frame of a phase rather than tracking the previous frame. Not published as an
// entity (the RV13B6ES dryer driver treats its equivalent the same way).
// rec[22]: the cloud's TCLCount — washes since the last Tub Clean. Read 46 while the cloud reported 46,
// and incremented by exactly one at each Spinning -> Complete transition across three cycles.
const TCL_COUNT_OFFSET = 22
// rec[24]: the cloud's loadLevel, a direct value latched when Sensing hands over to Washing.
const LOAD_LEVEL_OFFSET = 24

const PHASE_OFF = 0x00
const PHASE_COMPLETE = 0x3c

// Phase/status byte, named after the cloud's own state enum. Off/Initial/Pause/Add Garments/Rinsing were
// confirmed directly against the cloud in this session; Sensing/Washing/Spinning/Complete were observed in
// their correct sequence across three full cycles. Delay Wash (0x0a) is carried over from the sibling and
// was not exercised. Anything unmapped falls back to 'Running'.
const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x05: 'Initial',
    0x06: 'Pause',
    0x0a: 'Delay Wash',
    0x14: 'Sensing',
    0x15: 'Add Garments', // cloud: ADD_DRAIN — the paused-with-door-unlocked state
    0x17: 'Washing',
    0x1e: 'Rinsing',
    0x28: 'Spinning',
    0x3c: 'Complete',
}

// Course identifier -> name. Every one of the twelve dial positions was confirmed by turning the dial one
// stop at a time and reading the cloud's apCourseFLUpper25inchBaseUS, then cross-checked against the
// printed control panel. This table is NOT the sibling's — it disagrees at nine of twelve positions.
// 0x00 and 0xFE are both no-selection sentinels (0xFE is what this model parks on at power-off).
const COURSE: Record<number, string> = {
    0x01: 'Tub Clean',
    0x02: 'Allergiene',
    0x03: 'Sanitary',
    0x04: 'Bedding',
    0x05: 'Heavy Duty',
    0x06: 'Normal',
    0x07: 'Bright Whites',
    0x08: 'Perm Press',
    0x09: 'Delicates',
    0x0a: 'Towels',
    0x0b: 'Speed Wash',
    0x0c: 'Downloaded',
}

// Soil / Spin / Temp index tables, each stepped through every position against the cloud's soilWash, spin
// and temp enums. These match the sibling exactly. Index 0 means "not applicable" and reports as unknown —
// it is what the machine shows once a setting stops applying (soil drops to 0 when washing ends, temp when
// spinning starts, and both while Rinse+Spin is selected).
const SOIL: Record<number, string> = {
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

const SPIN: Record<number, string> = {
    1: 'No Spin',
    2: 'Low',
    3: 'Medium',
    4: 'High',
    5: 'Extra High',
}

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
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
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
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse_count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinses remaining',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-plus',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-plus',
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
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse + Spin',
                        icon: 'mdi:water-sync',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' — that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
                    },
                    load_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_level',
                        state_topic: '$this/load_level',
                        name: 'Load level',
                        icon: 'mdi:weight',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since Tub Clean',
                        icon: 'mdi:counter',
                        state_class: 'total_increasing',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // These washers only volunteer a status frame when something changes, so a driver that never
    // asks stays blank until the next physical interaction — and every reconnect (container
    // restart, appliance reboot) discards the last known state, leaving Home Assistant pinned at
    // "Off"/unknown indefinitely. Asking once per connect is what makes the entities survive a
    // restart.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0xE2 is intentionally NOT handled here despite looking like a valid single-record status frame —
        // see the header note; it is a post-cycle replay of stale data.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== RECORD_MARKER) return // the record should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF
        // Both timers are zeroed once there is no cycle in flight. The raw bytes park on a stale 1 minute
        // at Off and at Complete, and a washer that has just finished should not be advertising "1 minute
        // remaining" to an automation.
        const idle = isOff || phase === PHASE_COMPLETE

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Running')
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('remaining_time', idle ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            idle ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('spin', SPIN[rec[SPIN_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')

        this.publishProperty('rinse_count', rec[RINSE_OFFSET] & 0x0f)
        this.publishProperty('extra_rinse_count', rec[RINSE_OFFSET] >> 4)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('delay_wash', (flags & FLAG_DELAY_ACTIVE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (flags & FLAG_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (flags & FLAG_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', (flags & FLAG_RINSE_SPIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse', (flags & FLAG_EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('cold_wash', (opt2 & OPT2_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (opt2 & OPT2_DOOR_LOCKED) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('load_level', rec[LOAD_LEVEL_OFFSET])
        this.publishProperty('tub_clean_count', rec[TCL_COUNT_OFFSET])

        // Declared entities intentionally omitted rather than published wrong:
        //   * remote_start — the cloud reports it, but it moved in lockstep with the rec[16] door-lock bit
        //     for the whole capture, so no independent bit could be isolated.
        //   * turbo_wash — this model has no such button; the sibling's rec[15] bit 0x80 is left unmapped.
        //   * door position — not reported by this appliance at all; see the rec[17] note above.
        //   * error, smartGridEnable — never exercised (no fault occurred during the capture).
        //   * the Signal (beeper volume) setting, which the LG cloud does not report for this model.
        //   * rec[17] bit 0x10 (sets during Add Garments and Pause), and rec[18/19/21/23], which move
        //     without a matching cloud field.
    }
}
