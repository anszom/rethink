import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG electric dryer — matched on modelId "RV13B6BSD_D_US_WIFI" (real-world nameplate DLEX3900B, product
// code RV13B6JSD.ABLEEUS). AABB frames (buf = the AABB body, AA+len and checksum+BB already stripped)
// start with 0x30 (the washer's equivalent frames start with 0x20) and are discriminated by buf[1]:
//   0x31        one-time device-ID/serial frame at connect — not decoded.
//   0xEC        dial/status frame — two stacked records (29-byte old state, 28-byte current state), each
//               starting with a 0x1b marker; we read the current-state record (buf[32:]).
//   0xEB        single-record status frame (28-byte record at buf[3:]) — same field layout as 0xEC's
//               current-state record, seen right after the appliance (re)connects.
//   0xE2        idle/keepalive variant carrying a frozen snapshot of the last active state — not decoded.
//   0x72        short heartbeat/ping frames — not decoded.
// All offsets below are live-verified: captured real traffic via the rethink-agent MCP tools while
// driving the physical dryer (course/dial browsing, single-variable settings toggles, two full dry
// cycles run to completion, pause/resume, remote start/power-off from the LG app) and correlating each
// byte change against the LG cloud's own decoded washerDryer state at matching timestamps — not guessed
// from static analysis.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 60 // 3B header + 29B record A (old) + 28B record B (current)
const RECORD_B_OFFSET = 32

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 31 // 3B header + 28B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

// Offsets below are relative to record B's own 0x1b marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute]: the live countdown while running, or the estimated cycle time while
// Initial/Selecting. Confirmed exactly against the cloud's remainTimeHour/Minute.
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute]: unlike the washer (where the equivalent bytes just mirror the current
// value), this model keeps a genuine, separate initial-time estimate that stays fixed once a cycle is
// running while rec[2:4] counts down — confirmed against the cloud's initialTimeHour/Minute.
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
// rec[6]: course/mode identifier. 14 named dial programs plus Time Dry (engaged by its own button, not a
// dial position) map to 14 distinct values, confirmed against the cloud's courseDryer27inchBase/timeDry.
const COURSE_OFFSET = 6
const DRY_LEVEL_OFFSET = 8
const TEMP_OFFSET = 9
// rec[15]: options bitfield, each bit isolated via a single-variable toggle against the cloud's enum.
// The 0x40 "base" bit is present while Initial/Selecting/Pause but reads 0x00 while actively Drying —
// it's a running-state artifact, not part of any single option, so it's not exposed as its own entity.
const FLAGS_OFFSET = 15
const FLAG_CHILD_LOCK = 0x01
const FLAG_REDUCE_STATIC = 0x02
const FLAG_DAMP_DRY_SIGNAL = 0x08
// rec[16]: a separate options bitfield from rec[15].
const OPT2_OFFSET = 16
const OPT2_ENERGY_SAVER = 0x02
const OPT2_TURBO_STEAM = 0x04
const OPT2_WRINKLE_CARE = 0x10

const PHASE_OFF = 0x00

// Phase/status byte. 0x01 covers both dial-browsing-before-start and "paused, settings panel open" — the
// cloud itself calls both of these "INITIAL", so that's the name used here rather than inventing two
// separate labels for what the appliance treats as one state.
const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x03: 'Pause',
    0x32: 'Drying',
    0x33: 'Cooling',
    0x04: 'End',
}

// Course/mode identifier -> name. Live-confirmed against the cloud's courseDryer27inchBase (dial
// positions) and timeDry (the Time Dry button, which is not a dial position but shares this same byte).
const COURSE: Record<number, string> = {
    0x01: 'Heavy Duty',
    0x02: 'Towels',
    0x03: 'Normal',
    0x04: 'Perm Press',
    0x05: 'Delicates',
    0x07: 'Bedding',
    0x08: 'Antibacterial',
    0x09: 'Small Load',
    0x0b: 'Sportswear',
    0x10: 'Speed Dry',
    0x11: 'Air Dry',
    0x12: 'Time Dry',
    0x15: 'Steam Fresh',
    0x16: 'Steam Sanitary',
    0x1a: 'Super Dry',
}

// Dry level 1-5, confirmed via a clean isolated toggle (course/temp held fixed) against the cloud's
// dryLevel enum. 0 (NO_DRYLEVEL) is used by courses that don't auto-sense dryness (Speed Dry, Air Dry,
// Steam Fresh, Time Dry) and falls back to 'unknown' below.
const DRY_LEVEL: Record<number, string> = {
    1: 'Damp',
    2: 'Less',
    3: 'Normal',
    4: 'More',
    5: 'Very',
}

// Temp 1-5, confirmed the same way against the cloud's temp enum. 0 (NO_TEMP) is used by courses with no
// heating element (Air Dry) and falls back to 'unknown' below.
const TEMP: Record<number, string> = {
    1: 'Ultra Low',
    2: 'Low',
    3: 'Medium',
    4: 'Mid High',
    5: 'High',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
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
                        name: 'Initial time estimate',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    reduce_static: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-reduce_static',
                        state_topic: '$this/reduce_static',
                        name: 'Reduce static',
                        icon: 'mdi:flash-off-outline',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    turbo_steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_steam',
                        state_topic: '$this/turbo_steam',
                        name: 'Turbo Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0x31 (serial), 0xE2 (idle/keepalive snapshot) and 0x72 (heartbeat) are not yet decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== 0x1b) return // record B should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Running')
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('dry_level', DRY_LEVEL[rec[DRY_LEVEL_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('reduce_static', (flags & FLAG_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_steam', (opt2 & OPT2_TURBO_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (opt2 & OPT2_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        // not yet located (declared entities intentionally omitted rather than published wrong): error,
        // door (opening the door mid-cycle just forces the same generic Pause phase a button-press
        // would — no distinguishing byte or cloud field found, tested both early- and late-cycle),
        // Anti-Bacterial and Easy Iron (the former is a course on this unit, not a separate toggle; the
        // latter has no control on this physical model's panel at all).
    }
}
