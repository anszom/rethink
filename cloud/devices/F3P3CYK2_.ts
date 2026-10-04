import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WM4200HBA front-load washer, matched on modelId "F3P3CYK2_" (thinq2 deviceType 201).
//
// This is the same broad AABB protocol family as F3L2CYU__ and F3L7CYK5W_US_WIFI, but it has its own
// 44-byte status record. It must not be aliased to either 25-byte handler. The fields and enum values
// below were decoded from real wire traffic captured through rethink while operating the washer at its
// panel, including a full Rinse+Spin run, pause/resume, natural completion, every dial position, every
// settings button, and power-off.
//
// Frames are discriminated by buf[1] after AABBDevice has removed AA/length and checksum/BB:
//   0xEC  two status records, previous at buf[3] and current at buf[48]
//   0xEB  one current status record at buf[3], normally sent after connect/status query
//   0xE2  a stale settings replay emitted after a cycle finishes; deliberately ignored
//   0xBD / 0xCD  full status dumps; deliberately ignored because they do not use this record layout
//   0x31, 0x72, 0xD8  identity and heartbeat frames; not decoded

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 92
const STATUS_RECORD_OFFSET = 48

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 47
const SINGLE_RECORD_OFFSET = 3

const RECORD_LEN = 44
const RECORD_MARKER = 0x2b

// Status query captured verbatim from LG's cloud. 0xF0ED is the family-wide read-only request;
// actuating commands use 0xF0E5, so this cannot start or alter a cycle.
const STATUS_REQUEST = 'F0ED112101000000180413140000'

// Offsets are relative to the record's 0x2B marker.
const SOIL_OFFSET = 2
const TEMP_OFFSET = 3
const RINSE_OFFSET = 4
const SPIN_OFFSET = 5
const COURSE_OFFSET = 6
const RESERVE_TIME_OFFSET = 12 // big-endian minutes
const REMAIN_TIME_OFFSET = 14 // big-endian minutes
const INITIAL_TIME_OFFSET = 16 // big-endian minutes
const ERROR_OFFSET = 20 // modelJSON error enum index
const STATE_OFFSET = 22
const TUB_CLEAN_COUNT_OFFSET = 29
const BUZZER_OFFSET = 30
const OPT2_OFFSET = 36
const OPT2_RINSE_SPIN = 0x20

const STATE_OFF = 0
const STATE_END = 16

const ERROR = Enum.of({
    IE: 2,
    OE: 3,
    UE: 4,
    FE: 5,
    AE: 6,
    PE: 7,
    tE: 8,
    LE: 9,
    CE: 10,
    dHE: 11,
    FF: 13,
    dCE: 14,
    EE: 15,
    LOE: 16,
    PS: 19,
    'dE1 - Door Open': 20,
    dE2: 21,
    VS: 23,
    PF: 35,
    sud: 41,
    Ed1: 43,
    Ed2: 44,
    Ed3: 45,
    Ed4: 46,
    Ed5: 47,
})

// For this model the wire state values are the modelJSON enum indices. All states seen in the complete
// capture matched these values exactly; the remaining entries come from this washer's own modelJSON.
const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Pause: 2,
    Detecting: 3,
    'Add drain': 5,
    'Detergent amount': 6,
    Reserved: 7,
    'Pre-wash': 9,
    Running: 11,
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    End: 16,
    Refreshing: 21,
    'Error auto off': 23,
    'Frozen prevent initial': 27,
    'Frozen prevent pause': 28,
    'Frozen prevent running': 29,
    'Audible diagnosis': 34,
    'Auto DT open pause': 35,
    'Confirm start for control': 36,
})

// Every physical dial position was captured. Downloaded uses LG's 0xFF sentinel as a real selection on
// this model; 0x00 is the no-selection value seen while powered off.
const COURSE = Enum.of({
    Allergiene: 0x05,
    Bedding: 0x0d,
    Delicates: 0x16,
    'Drain+Spin': 0x19,
    'Heavy Duty': 0x23,
    Normal: 0x2e,
    'Perm Press': 0x30,
    Sanitary: 0x3c,
    'Speed Wash': 0x4a,
    Sportswear: 0x4f,
    Towels: 0x54,
    'Tub Clean': 0x55,
    'Bright Whites': 0x5a,
    Downloaded: 0xff,
})

const SOIL = Enum.of({
    Light: 1,
    'Light/Normal': 2,
    Normal: 3,
    'Normal/Heavy': 4,
    Heavy: 5,
})

// These are this modelJSON's values, confirmed by stepping the physical settings buttons.
const TEMP = Enum.of({
    'Tap Cold': 13,
    Cold: 14,
    'Eco Warm': 15,
    Warm: 16,
    'Warm Rinse': 17,
    Hot: 18,
    'Extra Hot': 19,
})

const RINSE = Enum.of({
    Normal: 14,
    Plus: 15,
    'Plus 2': 16,
    'Plus 3': 17,
})

const SPIN = Enum.of({
    'No Spin': 12,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
})

const BUZZER = Enum.of({
    Off: 0,
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
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
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: 'PRESS',
                        name: 'Power off',
                        icon: 'mdi:power-off',
                        availability: [
                            {
                                topic: '$this/power',
                                payload_available: 'ON',
                                payload_not_available: 'OFF',
                            },
                        ],
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // Free text so an as-yet unseen state can be reported as Running instead of
                        // violating Home Assistant's declared enum options.
                    },
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run_completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                        icon: 'mdi:check-circle',
                    },
                    error_state: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error_state',
                        state_topic: '$this/error_state',
                        name: 'Error state',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error_message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSE.options,
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
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water-sync',
                        device_class: 'enum',
                        options: RINSE.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse + Spin',
                        icon: 'mdi:water-sync',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since Tub Clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    buzzer: {
                        platform: 'sensor',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        device_class: 'enum',
                        options: BUZZER.options,
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power_off' && mqttValue === 'PRESS') {
            // Captured verbatim from the ThinQ app. AABBDevice adds AA/length/checksum/BB, producing
            // AA09F0240101009CBB. Only power-off is exposed; remote power-on is intentionally absent.
            this.send(Buffer.from('F024010100', 'hex'))
        }
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, STATUS_RECORD_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0xBD/0xCD use a different dump layout. 0xE2 is a stale post-cycle settings replay. They are
        // intentionally ignored rather than treating unrelated byte positions as this record's fields.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)
        if (rec.length !== RECORD_LEN || rec[0] !== RECORD_MARKER) return

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF
        const isEnd = state === STATE_END

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishError(rec[ERROR_OFFSET])
        this.publishProperty('status', STATE.map(state) ?? 'Running')
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('reserve_time', isOff ? 0 : rec.readUInt16BE(RESERVE_TIME_OFFSET))
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('rinse', RINSE.map(rec[RINSE_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('rinse_spin', (rec[OPT2_OFFSET] & OPT2_RINSE_SPIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))

        this.publishProperty('run_completed', isEnd ? 'ON' : 'OFF')

        // Deliberately not published until isolated against a real event: door, door lock, remote start,
        // child lock, and the remaining option bits.
    }

    private publishError(code: number) {
        this.publishProperty('error_state', code === 0 ? 'OFF' : 'ON')
        this.publishProperty(
            'error_message',
            code === 0
                ? '-'
                : (ERROR.map(code) ?? `Unknown error (0x${code.toString(16).padStart(2, '0').toUpperCase()})`),
        )
    }
}
