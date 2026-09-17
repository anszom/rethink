import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG front-load washer — matched on modelId "F3P2CYVAT__" ("US_Victor2_Refresh_Pro_Steam(VH)", marketing
// name references "Titan27", sold as WM3600HWA). AABB frames (buf = the AABB body, AA+len and
// checksum+BB already stripped, buf[0]==0x20 on every frame) are discriminated by buf[1]:
//   0xD8  heartbeat/ping. 3-byte payload; buf[2] carries the live `TCLCount` (tub clean count) as a
//         single byte — confirmed against a live cloud readout and in app.
//   0xEC  dial/status frame — two stacked 44/45-byte records (old state, then new state), each starting
//         with a 0x2b marker; we read the current-state record at buf[48:].
//   0xEB  single-record status frame — same 44-byte record layout as 0xEC's current-state record, just
//         without a preceding "old state" record. Seen right after the appliance powered off.
//   0xBD  a large (~400 byte) full status/config dump, seen once on connect. Not decoded.
// This model's wire bytes for several fields are the exact same numeric indices LG uses in its own ThinQ
// cloud API (`state`, `temp`, `spin`, `rinse`, `rinseCount`, `soilWash`, `error`, `TCLCount`...) — that
// API is a reliable decoder here, not just a naming reference. Every offset below has been confirmed by
// capturing the wire packet and the LG cloud's own decoded MQTT payload for the same instant and diffing
// them directly, across dial browsing, single-variable settings toggles, a full running-cycle sequence,
// and an attempted start with the door open.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 92 // 3B header + 45B record A (old) + 44B record B (current)
const RECORD_B_OFFSET = 48
const RECORD_LEN = 44

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 47 // 3B header + 44B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

const HEARTBEAT_FRAME_TYPE = 0xd8
const HEARTBEAT_FRAME_LEN = 3
const HEARTBEAT_TCL_COUNT_OFFSET = 2

const UNKNOWN_EVENT_FRAME_TYPE = 0x72 // seen once, not decoded — see header notes

// Offsets below are relative to the record's own 0x2b marker (rec[0]).
const SOIL_OFFSET = 2
const TEMP_OFFSET = 3
// rec[4]: rinse *type* (matches the JSON `rinse` enum: 14 Normal, 15 Plus, 16 Plus2, 17 Plus3). All four
// values confirmed directly against the LG cloud's own `rinse` field across a full Extra Rinse button
// sequence (off -> Plus -> Plus2 -> Plus3 -> off).
const RINSE_OFFSET = 4
const SPIN_OFFSET = 5
// rec[6]: course identifier. Not a small sequential ordinal like the sibling platforms use — this model
// supports downloadable SmartCourses/AI Wash, and 0xff is a sentinel meaning "downloaded course, see
// rec[21] for the real ID" rather than a dial position of its own. Every named course below is confirmed
// directly against the LG cloud's own `course` field.
const COURSE_OFFSET = 6
const COURSE_DOWNLOADED_SENTINEL = 0xff
// rec[21]: the downloaded course's *base* course, reusing the same byte values as rec[6]'s COURSE enum —
// confirmed against a live cloud readout of `baseDownloadCourseData: NORMAL` landing on 0x2e, the same
// byte as COURSE's own Normal. Only meaningful when rec[6] == 0xff.
const DOWNLOADED_COURSE_ID_OFFSET = 21
// rec[12:13]: cloud `reserveTimeMinute`, as a 16-bit BIG-ENDIAN value in total minutes (not a
// [hour][minute] pair). Confirmed across the device's full delay-wash ladder, one button press at a
// time, up to 19 hours (0x0474 = 1140 minutes) before wrapping back to off — every single step matched
// the cloud's reported value exactly.
const DELAY_TIME_HIGH_OFFSET = 12
const DELAY_TIME_LOW_OFFSET = 13
// rec[15]/rec[17]: cloud `remainTimeMinute`/`initialTimeMinute`, each a single byte of total minutes (not
// [hour][minute]). Confirmed 1:1 against a live cloud, and separately
// confirmed ticking down together during a running capture.
const REMAINING_TIME_OFFSET = 15
const INITIAL_TIME_OFFSET = 17
// rec[20]: cloud `error`. Confirmed directly: attempting to start the machine with the door open reads
// 20 here, matching ERROR_DE1 (door open) exactly, and clears back to 0 (ERROR_NO) once the machine is
// powered off.
const ERROR_OFFSET = 20
const STATE_OFFSET = 22 // matches the JSON `state` enum index directly
const PRESTATE_OFFSET = 23 // same enum
// rec[28]: cloud `rinseCount`. Fully confirmed 0 through 5 (every value) via a full Extra Rinse button
// sequence plus the Rinse+Spin (1) and Spin Only (0, no rinsing at all) courses.
const RINSE_COUNT_OFFSET = 28
// rec[29]: cloud `TCLCount` (tub clean count), confirmed 1:1 against a live cloud readout — and, on
// the 0xD8 heartbeat frame, the exact same value shows up again at a different offset (see
// HEARTBEAT_TCL_COUNT_OFFSET above).
const TCL_COUNT_OFFSET = 29
// rec[35]: options bitfield. 0x40 = Pre Wash (cloud `preWash`). 0x04 = Cold Wash (cloud
// `coldWash`) — triggered by a long-press on the Steam button
const OPTIONS_A_OFFSET = 35
const OPTION_A_COLD_WASH = 0x04
const OPTION_A_PRE_WASH = 0x40
// rec[36]: Steam (cloud `steam`), bit 0x10. Confirmed
const STEAM_OFFSET = 36
const STEAM_ON = 0x10
// rec[40]: options bitfield. 0x40 = Extra Rinse (cloud `extraRinse`), 0x80 = Delay Wash active (cloud
// `delay`); seen combined as 0xc0 with both enabled at once, both confirmed against live cloud readouts.
const OPTIONS_B_OFFSET = 40
const OPTION_B_EXTRA_RINSE = 0x40
const OPTION_B_DELAY_ACTIVE = 0x80
// rec[41]: cloud `AIDDLed` — on for Normal/Downloaded, off for specialty courses; confirmed repeatedly
// against live cloud readouts across many course changes.
const AI_WASH_OFFSET = 41

const STATE_OFF = 0x00

const STATE = Enum.of({
    Off: 0x00, // POWEROFF, confirmed
    Initial: 0x01, // INITIAL, confirmed
    Pause: 0x02,
    Detecting: 0x03,
    'Add Drain': 0x05,
    'Detergent Amount': 0x06,
    Reserved: 0x07,
    'Pre Wash': 0x09,
    Running: 0x0b, // RUNNING, confirmed
    Rinsing: 0x0c,
    'Rinse Hold': 0x0d,
    Spinning: 0x0e,
    Drying: 0x0f,
    End: 0x10, // END, confirmed
    Refreshing: 0x15,
    'Confirm Start': 0x24, // CONFIRM_START_FOR_CONTROL, confirmed — seen attempting to start with the door open
})

// Course<->byte pairings, each confirmed directly against the LG cloud's own `course` field.
const COURSE = Enum.of({
    Normal: 0x2e,
    'Heavy Duty': 0x23,
    'Bulky/Large': 0x0d, // cloud: BULKY_LARGE ("Bedding" on the panel)
    'Allergy Care': 0x05, // cloud: ALLERGYCARE ("Allergiene(TM)" on the panel)
    'Tub Clean': 0x55,
    'Rinse+Spin': 0x37,
    'Speed Wash': 0x4a,
    'Perm Press': 0x30,
    Delicates: 0x16,
    'Spin Only': 0x4e,
    Downloaded: 0xff, // sentinel — base course is at DOWNLOADED_COURSE_ID_OFFSET
})

// Soil — CONFIRMED against the LG cloud's own `soilWash` field. Light-Normal (2) and Normal-Heavy (4) are
// listed in the product JSON but the panel's soil button cycle skips straight from Light to Normal to
// Heavy, so they've never actually been observed on the wire.
const SOIL = Enum.of({
    'Not Selected': 0,
    Light: 1,
    'Light-Normal': 2,
    Normal: 3,
    'Normal-Heavy': 4,
    Heavy: 5,
})

// Spin — CONFIRMED, all six values observed directly against the cloud's `spin` field via a full
// step-through of the panel's spin button.
const SPIN = Enum.of({
    'Not Selected': 0,
    'Drain Only': 12,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
})

// Temp — CONFIRMED for every value except Eco Warm/Warm Rinse. The panel's temp button cycles
// Warm -> Hot -> Extra Hot -> Tap Cold -> Cold -> Warm, skipping over Eco Warm (15) and Warm Rinse (17)
// entirely — those two may only be reachable through a specific course rather than the plain temp button.
const TEMP = Enum.of({
    'Not Selected': 0,
    'Tap Cold': 13,
    Cold: 14,
    'Eco Warm': 15,
    Warm: 16,
    'Warm Rinse': 17,
    Hot: 18,
    'Extra Hot': 19,
})

// Rinse — CONFIRMED (all four values captured directly against the LG cloud's `rinse` field).
const RINSE = Enum.of({
    Normal: 14,
    Plus: 15,
    'Plus 2': 16,
    'Plus 3': 17,
})

// Rinse count — CONFIRMED, matches the LG cloud's own `rinseCount` field/names exactly for every value
// 0 through 5 (0 on Spin Only, 1 on Rinse+Spin, 2 as the Normal default, 3-5 via Extra Rinse levels).
const RINSE_COUNT = Enum.of({
    'No Rinse': 0,
    'Rinse x1': 1,
    'Rinse x2': 2,
    'Rinse x3': 3,
    'Rinse x4': 4,
    'Rinse x5': 5,
})

// Error codes — CONFIRMED for No Error (0) and Door Open (20), both directly against the LG cloud's
// `error` field (attempting to start with the door open, then clearing at power-off). The rest of this
// list is taken from the product JSON and not yet independently observed on the wire.
const ERROR = Enum.of({
    'No Error': 0,
    IE: 2, // Input Water Error
    OE: 3, // Drain Water Error
    UE: 4, // Unbalance Error
    FE: 5, // Overflow Error
    AE: 6,
    PE: 7, // Water Pressure Error
    tE: 8, // Thermistor Error
    LE: 9, // BLDC Error
    CE: 10,
    dHE: 11, // SVC Call
    FF: 13, // Freeze Error
    dCE: 14,
    EE: 15, // EEPROM Error
    LOE: 16, // Sliding Lid Open Error
    PS: 19,
    'Door Open': 20, // confirmed — cloud calls this ERROR_DE1
    dE2: 21, // Door Open (alternate)
    VS: 23, // Vibration sensor error
    PF: 35, // Power Failure Error
    sud: 41,
    Ed1: 43,
    Ed2: 44,
    Ed3: 45,
    Ed4: 46,
    Ed5: 47,
})

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
                    },
                    error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
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
                    tcl_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tcl_count',
                        state_topic: '$this/tcl_count',
                        name: 'Tub clean count',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
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
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water-sync',
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse_count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinse count',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-sync',
                    },
                    delay_active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_active',
                        state_topic: '$this/delay_active',
                        name: 'Delay Wash active',
                        icon: 'mdi:clock-plus-outline',
                    },
                    ai_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-ai_wash',
                        state_topic: '$this/ai_wash',
                        name: 'AI Wash',
                        icon: 'mdi:creation',
                    },
                    // Deliberately not declared yet (no confirmed offset/behavior): doorLock, doorClose
                    // (two separate cloud fields), turbo_wash, fresh_care, child_lock, remote_start,
                    // door position.
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === HEARTBEAT_FRAME_TYPE && buf.length === HEARTBEAT_FRAME_LEN) {
            this.publishProperty('tcl_count', buf[HEARTBEAT_TCL_COUNT_OFFSET])
            return
        }
        if (buf[1] === UNKNOWN_EVENT_FRAME_TYPE) return // not decoded, see header notes
        if (buf[1] === STATUS_FRAME_TYPE && buf.length === STATUS_FRAME_LEN) {
            return this.processStatus(buf, RECORD_B_OFFSET)
        }
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE && buf.length === SINGLE_STATUS_FRAME_LEN) {
            return this.processStatus(buf, SINGLE_RECORD_OFFSET)
        }
    }

    private processStatus(buf: Buffer, recordOffset: number) {
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('error', ERROR.map(rec[ERROR_OFFSET]))

        const courseByte = rec[COURSE_OFFSET]
        if (courseByte === COURSE_DOWNLOADED_SENTINEL) {
            const baseCourse = COURSE.map(rec[DOWNLOADED_COURSE_ID_OFFSET])
            this.publishProperty('course', baseCourse ? `Downloaded (${baseCourse})` : 'Downloaded')
        } else {
            this.publishProperty('course', COURSE.map(courseByte))
        }

        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('rinse', RINSE.map(rec[RINSE_OFFSET]))
        this.publishProperty('rinse_count', RINSE_COUNT.map(rec[RINSE_COUNT_OFFSET]))

        this.publishProperty('remaining_time', rec[REMAINING_TIME_OFFSET])
        this.publishProperty('initial_time', rec[INITIAL_TIME_OFFSET])
        this.publishProperty('reserve_time', (rec[DELAY_TIME_HIGH_OFFSET] << 8) | rec[DELAY_TIME_LOW_OFFSET])
        this.publishProperty('tcl_count', rec[TCL_COUNT_OFFSET])

        const optionsA = rec[OPTIONS_A_OFFSET]
        this.publishProperty('pre_wash', (optionsA & OPTION_A_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cold_wash', (optionsA & OPTION_A_COLD_WASH) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('steam', rec[STEAM_OFFSET] === STEAM_ON ? 'ON' : 'OFF')

        const optionsB = rec[OPTIONS_B_OFFSET]
        this.publishProperty('extra_rinse', (optionsB & OPTION_B_EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('delay_active', (optionsB & OPTION_B_DELAY_ACTIVE) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('ai_wash', rec[AI_WASH_OFFSET] === 1 ? 'ON' : 'OFF')
    }
}
