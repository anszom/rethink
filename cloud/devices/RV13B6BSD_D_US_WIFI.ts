import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { STATES, DRY_LEVELS, TEMPERATURES, ERRORS } from './dryer_common'

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

// One status block is a leading byte + the 28B record; 0xEB carries one block, 0xEC two (old, current).
const STATUS_LENGTH = 29

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
// rec[7]: error code, located by injecting it into a bridged simulated appliance and reading the cloud's
// error field.
const ERROR_OFFSET = 7
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

// Course/mode identifier -> name. Live-confirmed against the cloud's courseDryer27inchBase (dial
// positions) and timeDry (the Time Dry button, which is not a dial position but shares this same byte).
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    Antibacterial: 0x08,
    'Small Load': 0x09,
    Sportswear: 0x0b,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': 0x12,
    'Steam Fresh': 0x15,
    'Steam Sanitary': 0x16,
    'Super Dry': 0x1a,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
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
                        device_class: 'enum',
                        options: STATES.options,
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.options,
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
        this.processCommonStatus(buf, 0x30, STATUS_LENGTH, this.processStatus)
        // 0x31 (serial), 0xE2 (idle/keepalive snapshot) and 0x72 (heartbeat) are not yet decoded.
    }

    private processStatus(status: Buffer) {
        const rec = status.subarray(1)
        if (rec[0] !== 0x1b) return // record B should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATES.map(phase))
        const error = rec[ERROR_OFFSET]
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('dry_level', DRY_LEVELS.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('temp', TEMPERATURES.map(rec[TEMP_OFFSET]))

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('reduce_static', (flags & FLAG_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_steam', (opt2 & OPT2_TURBO_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (opt2 & OPT2_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        // not yet located (declared entities intentionally omitted rather than published wrong): door
        // (opening the door mid-cycle just forces the same generic Pause phase a button-press would — no
        // distinguishing byte or cloud field found, tested both early- and late-cycle), Anti-Bacterial and Easy Iron (the former is a course on this unit, not a separate toggle; the
        // latter has no control on this physical model's panel at all).
    }
}
