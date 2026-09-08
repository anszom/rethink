import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG RC9DN9029 (ThinQ Model ID RC90U2_WW, deviceType 202): 9 kg DUAL Inverter heat pump dryer with
// Eco Hybrid, EU/Nordic market. ThinQ2 with the QCOM_QCA4010 module (clip_hna_v1.9.230, protocolVer
// 4.9). Same AABB dialect as the US dryers (RV13B6ES_D_US_WIFI): frames start with 0x30 and are
// discriminated by buf[1]:
//   0xEC  status update, two stacked records (previous, current), each prefixed 0x00 0x19
//   0xEB  single-record status, the reply to the family-wide 0xF0ED status request
//   0x31  serial/part-number frame, 0x19 five-byte power events — not decoded
// Records are 25 bytes and follow LG's own modelJson Monitoring.protocol for this model byte for byte,
// so field meanings come from the spec. The offsets and the enum codes below were confirmed live by
// driving the panel and diffing consecutive 0xEC records: power off/on, eleven courses (one of them
// downloaded) with their default dry level / Eco Hybrid / time estimate, the Dry Level button, Delay
// End, and a Cool Air cycle (Running, Cooling phase, remaining time counting down). The Option1 bits
// for Anti crease and Child lock were each toggled by a panel button whose
// label has not been matched to the bit yet; Damp dry beep and Hand iron follow the spec and have not
// been observed set. Errors are per spec only.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 56 // 30 EC + 2 x (00 19 + 25-byte record)
const CURRENT_RECORD_OFFSET = 31 // second record

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 29 // 30 EB + 00 19 + 25-byte record
const SINGLE_RECORD_OFFSET = 4

const RECORD_LEN = 25
const RECORD_LEN_MARKER = 0x19

// Family-wide read-only "report your state" request; the dryer answers with a 0xEB frame within a
// second. Sent once per connect so the entities survive a rethink restart.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Record offsets (modelJson Monitoring.protocol)
const STATE_OFFSET = 0
const REMAIN_HOUR_OFFSET = 1
const REMAIN_MIN_OFFSET = 2
const INITIAL_HOUR_OFFSET = 3
const INITIAL_MIN_OFFSET = 4
const COURSE_OFFSET = 5
const ERROR_OFFSET = 6
const DRY_LEVEL_OFFSET = 7
const ECO_HYBRID_OFFSET = 8
const PROCESS_OFFSET = 9
const RESERVE_HOUR_OFFSET = 12
const RESERVE_MIN_OFFSET = 13
const OPTION1_OFFSET = 14
const SMART_COURSE_OFFSET = 20

// Option1 bits (modelJson Value.Option1). Bit 3 (0x08) is not in the spec: it is on by default, cleared
// by a panel button (Buzzer suspected) and restored at power-off, so it is deliberately not exposed.
const OPT1_RESERVATION = 0x01
const OPT1_ANTI_CREASE = 0x02
const OPT1_CHILD_LOCK = 0x10
const OPT1_DAMP_DRY_BEEP = 0x40
const OPT1_HAND_IRON = 0x80

// Option2 (byte 15) is not decoded: the spec's RemoteStart bit 0 was set for the whole of a cycle started
// from the panel and did not react to arming Remote Start, and bit 2 (0x04) is a constant. Neither is exposed.

const STATE_OFF = 0x00

export const STATES = Enum.of({
    Off: 0,
    Ready: 1,
    Running: 2,
    Paused: 3,
    End: 4,
    Error: 5,
    Delayed: 100,
})

// ProcessState: the sub-phase while a cycle runs. The spec maps codes 2, 3 and 4 all to "Dry".
export const PHASES = Enum.of({
    Detecting: 0,
    Steam: 1,
    Drying: [2, 3, 4],
    Cooling: 5,
    'Anti-crease': 6,
    End: 7,
})

// Course (byte 5) and SmartCourse (byte 20, downloaded courses) share one label space; a non-zero
// SmartCourse overrides the base course.
export const COURSES = Enum.of({
    'Cotton Soft': 0x02,
    Duvet: 0x04,
    'Easy Care': 0x05,
    'Mixed Fabric': 0x06,
    Cotton: 0x07,
    'Sports Wear': 0x08,
    'Quick Dry': 0x09,
    Delicate: 0x0a,
    Wool: 0x0b,
    'Rack Dry': 0x0c,
    'Cool Air': 0x0d,
    'Warm Air': 0x0e,
    'Allergy Care': 0x10,
    // downloaded ("smart") courses
    'Baby Wear': 0x65,
    'Gym Clothes': 0x66,
    Blanket: 0x67,
    'Blanket Refresh': 0x68,
    'Rainy Season': 0x69,
    'Single Garments': 0x6a,
    Deodorization: 0x6b,
    'Small Load': 0x6c,
    Lingerie: 0x6d,
    'Easy Iron': 0x6e,
    'Super Dry': 0x6f,
    'Economic Dry': 0x70,
    'Big Size Item': 0x71,
    'Minimize Wrinkles': 0x72,
    'Shoes/Fabric Doll': 0x73,
    'Full Size Load': 0x74,
})

// 0 = no dry level (timed courses such as Duvet, Cool Air, Warm Air), left undecoded.
export const DRY_LEVELS = Enum.of({
    Iron: 1,
    Cupboard: 3,
    Extra: 4,
})

export const ECO_HYBRID = Enum.of({
    Eco: 1,
    Normal: 2,
    Time: 3,
})

export const ERRORS = Enum.of({
    OK: 0,
    'Temperature sensor error (tE1)': 1,
    'Temperature sensor error (tE2)': 2,
    'Condenser error (CE1)': 7,
    'Drain motor error': 13,
    'Empty water container': 14,
    'Door open': 15,
    'Filter missing': 17,
    'Unknown error (F1)': 19,
    'Motor error (LE2)': 20,
    'Unknown error (AE)': 21,
    'Motor error (LE1)': 30,
    'Door sensor error (dE4)': 37,
})

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
                        device_class: 'enum',
                        options: STATES.options,
                    },
                    phase: {
                        platform: 'sensor',
                        unique_id: '$deviceid-phase',
                        state_topic: '$this/phase',
                        name: 'Phase',
                        icon: 'mdi:progress-clock',
                        device_class: 'enum',
                        options: PHASES.options,
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
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco Hybrid',
                        icon: 'mdi:leaf',
                        device_class: 'enum',
                        options: ECO_HYBRID.options,
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
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay end',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    delay: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay',
                        state_topic: '$this/delay',
                        name: 'Delay end set',
                        icon: 'mdi:timer-sand',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti crease',
                        icon: 'mdi:iron-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock-outline',
                        entity_category: 'diagnostic',
                    },
                    damp_dry_beep: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_beep',
                        state_topic: '$this/damp_dry_beep',
                        name: 'Damp dry beep',
                        icon: 'mdi:water-alert-outline',
                    },
                    hand_iron: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-hand_iron',
                        state_topic: '$this/hand_iron',
                        name: 'Hand iron',
                        icon: 'mdi:iron',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length < 2 || buf[0] !== 0x30) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, CURRENT_RECORD_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0x31 (serial numbers) and 0x19 (power events) are not decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        if (buf[recordOffset - 1] !== RECORD_LEN_MARKER) return
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF
        const isActive = state === STATES.unmap('Running') || state === STATES.unmap('Paused')
        const error = rec[ERROR_OFFSET]
        const option1 = rec[OPTION1_OFFSET]

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(state))
        // the sub-phase byte keeps a stale value while idle, so it is only meaningful during a cycle
        this.publishProperty('phase', isActive ? PHASES.map(rec[PROCESS_OFFSET]) : undefined)
        this.publishProperty(
            'course',
            isOff ? undefined : (COURSES.map(rec[SMART_COURSE_OFFSET]) ?? COURSES.map(rec[COURSE_OFFSET])),
        )
        this.publishProperty('dry_level', isOff ? undefined : DRY_LEVELS.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('eco_hybrid', isOff ? undefined : ECO_HYBRID.map(rec[ECO_HYBRID_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        this.publishProperty('delay', option1 & OPT1_RESERVATION ? 'ON' : 'OFF')
        this.publishProperty('anti_crease', option1 & OPT1_ANTI_CREASE ? 'ON' : 'OFF')
        this.publishProperty('child_lock', option1 & OPT1_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_beep', option1 & OPT1_DAMP_DRY_BEEP ? 'ON' : 'OFF')
        this.publishProperty('hand_iron', option1 & OPT1_HAND_IRON ? 'ON' : 'OFF')
    }
}
