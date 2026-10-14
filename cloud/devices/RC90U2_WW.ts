import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'
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
//
// The commands, the energy counter and Remote start were mapped live on another unit, in
// https://github.com/cash83/rethink-lan-addon, and checked again on a third one through RC90U2_WW_T1.

// One status block is 00 19 + the 25-byte record; 0xEB carries one block, 0xEC two (previous, current).
const RECORD_LEN_MARKER = 0x19
const STATUS_LENGTH = 27

// Family-wide read-only "report your state" request; the dryer answers with a 0xEB frame within a
// second. Sent once per connect so the entities survive a rethink restart.
const STATUS_REQUEST = 'F0ED1121010000001800'
const POWER_ON = 'F02A0100'
const POWER_OFF = 'F024010100'
// On this model the panel's Start/Pause is a single toggle, and remotely only F0 24 04 drives it.
// F0 24 05 (the usual "start") is acked with a beep and otherwise ignored.
const START_PAUSE = 'F024040100'

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
const OPTION2_OFFSET = 15
// Not in the spec: Wh used by the current cycle, big-endian. It advances only while the drum turns,
// restarts at 0 on every new cycle and is retained afterwards. Complete cycles on three units ended
// between 237 and 1414 Wh, in line with a 9 kg heat pump dryer; the BDH_D30007_US carries the same field.
const ENERGY_OFFSET = 17
const SMART_COURSE_OFFSET = 20

// Option1 bits (modelJson Value.Option1). Bit 3 (0x08) is not in the spec: it is on by default, cleared
// by a panel button (Buzzer suspected) and restored at power-off, so it is deliberately not exposed.
const OPT1_RESERVATION = 0x01
const OPT1_ANTI_CREASE = 0x02
const OPT1_CHILD_LOCK = 0x10
const OPT1_DAMP_DRY_BEEP = 0x40
const OPT1_HAND_IRON = 0x80

// Option2 bit 0 is the spec's RemoteStart. Holding the panel's Remote Start button for 3 s sets it, and
// the appliance also holds it while a cycle runs and drops it in pause, so it reads as "remote commands
// accepted right now". On one unit it did not react to arming Remote Start on the panel. Bit 2 (0x04) is
// a constant and is not exposed.
const OPT2_REMOTE_START = 0x01

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
// SmartCourse overrides the base course. The base courses are listed in the order the dial walks them,
// so the course select offers them the same way; the dial's downloaded-course position sits between
// Quick Dry and Warm Air and reports base course 0x01.
export const COURSES = Enum.of({
    Cotton: 0x07,
    'Mixed Fabric': 0x06,
    'Easy Care': 0x05,
    Duvet: 0x04,
    'Cotton Soft': 0x02,
    'Allergy Care': 0x10,
    'Quick Dry': 0x09,
    'Warm Air': 0x0e,
    'Cool Air': 0x0d,
    'Rack Dry': 0x0c,
    Delicate: 0x0a,
    Wool: 0x0b,
    'Sports Wear': 0x08,
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
const FIRST_SMART_COURSE = 0x65

// 0 = no dry level (timed courses such as Duvet, Cool Air, Warm Air), left undecoded.
export const DRY_LEVELS = Enum.of({
    Iron: 1,
    Cupboard: 3,
    Extra: 4,
})

// The panel's Eco Hybrid button toggles Eco and Time (labelled Turbo on some panels); Normal is in the
// spec but has not been seen.
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

const NO_YES = ['No', 'Yes']

// What each base course takes in a remote start, from the model's ThinQ1 modelJSON (TITAN2.0_D_WIFI_CZ,
// Course): the first value is the course default, and 0 means the course has no such setting. A
// combination the course does not take powers the appliance on with no course, and it turns itself off
// 10 s later. `time` is the MoreLessTime of the time-based courses, in minutes.
type CourseOptions = { dryLevel: number[]; ecoHybrid: number[]; time?: number }
const COURSE_OPTIONS: Record<number, CourseOptions> = {
    0x02: { dryLevel: [0], ecoHybrid: [3] },
    0x04: { dryLevel: [0], ecoHybrid: [3] },
    0x05: { dryLevel: [3, 1], ecoHybrid: [3, 1] },
    0x06: { dryLevel: [3, 1, 4], ecoHybrid: [3, 1] },
    0x07: { dryLevel: [3, 1, 4], ecoHybrid: [1, 3] },
    0x08: { dryLevel: [0], ecoHybrid: [1] },
    0x09: { dryLevel: [0], ecoHybrid: [3] },
    0x0a: { dryLevel: [0], ecoHybrid: [1] },
    0x0b: { dryLevel: [0], ecoHybrid: [1] },
    0x0c: { dryLevel: [0], ecoHybrid: [1], time: 180 },
    0x0d: { dryLevel: [0], ecoHybrid: [0], time: 60 },
    0x0e: { dryLevel: [0], ecoHybrid: [1, 3], time: 60 },
    0x10: { dryLevel: [0], ecoHybrid: [3] },
}

// The chosen value when the course takes it, otherwise the course default.
function allowed(options: number[] | undefined, value: number | undefined) {
    if (!options) return value ?? 0
    return value !== undefined && options.includes(value) ? value : options[0]
}

// F0 26: write a course and start it. [2] course, [3] dry level, [4] Eco Hybrid, [5] duration of a
// time-based course in minutes (MoreLessTime), [8] delayed end in hours, [11] Option1 (Anti crease),
// [12] operation. The ThinQ app sends 0x03 as the operation; 0x01 starts the drum just the same, and is
// what was tested end to end.
const START_COURSE_LEN = 16
const START_COURSE_OP = 0x01
// A running cycle ignores F0 26 (the appliance beeps and keeps its settings), while a paused one takes
// it and resumes with the new settings. So mid-cycle the command is preceded by a pause.
const PAUSE_BEFORE_START_MS = 1200

// The ThinQ app offers a delayed end of 3 to 19 hours, counted from the END of the cycle.
const DELAY_MIN_HOURS = 3
const DELAY_MAX_HOURS = 19

export default class Device extends AABBDevice {
    // The course and settings shown in HA and sent by Start selected cycle. The appliance does not
    // report "what will run next", so a choice made in HA is held here until the button is pressed.
    remote = {
        course: 'Cotton',
        dryLevel: 'Cupboard',
        ecoHybrid: 'Eco',
        antiCrease: false,
        delayHours: 0,
    }

    // The last values the appliance itself reported. A change on the panel is mirrored into the selects
    // only when the appliance's own value changes, so a choice made in HA is not overwritten by every
    // subsequent status frame.
    private seen: { course?: string; dryLevel?: string; ecoHybrid?: string; antiCrease?: boolean } = {}
    private cycleRunning = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                    },
                    start_pause: {
                        platform: 'button',
                        unique_id: '$deviceid-start_pause',
                        command_topic: '$this/start_pause/set',
                        payload_press: '',
                        name: 'Pause/Resume',
                        icon: 'mdi:play-pause',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start selected cycle',
                        icon: 'mdi:play-circle-outline',
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
                    // The course and its settings are selects: they show what the panel last reported and
                    // are what Start selected cycle sends.
                    course: {
                        platform: 'select',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        command_topic: '$this/course/set',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        options: COURSES.options,
                    },
                    dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        command_topic: '$this/dry_level/set',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        options: DRY_LEVELS.options,
                    },
                    eco_hybrid: {
                        platform: 'select',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        command_topic: '$this/eco_hybrid/set',
                        name: 'Eco Hybrid',
                        icon: 'mdi:leaf',
                        options: ECO_HYBRID.options,
                    },
                    // A select rather than a switch: the toggle on HA's controls card switches every
                    // switch of the device, and would turn Anti crease on together with the power.
                    anti_crease: {
                        platform: 'select',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        command_topic: '$this/anti_crease/set',
                        name: 'Anti crease',
                        icon: 'mdi:iron-outline',
                        options: NO_YES,
                    },
                    // Applies to the next Start selected cycle only, then returns to 0: the ThinQ app
                    // also clears it after every start, and a sticky value would delay a later cycle
                    // nobody asked to delay.
                    start_delay_end: {
                        platform: 'number',
                        unique_id: '$deviceid-start_delay_end',
                        state_topic: '$this/start_delay_end',
                        command_topic: '$this/start_delay_end/set',
                        min: 0,
                        max: DELAY_MAX_HOURS,
                        step: 1,
                        mode: 'box',
                        unit_of_measurement: 'h',
                        name: 'Delay end of the next start',
                        icon: 'mdi:timer-play-outline',
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
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
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

    // The module reconnects several times a day: keep what was chosen in HA instead of going back to the
    // defaults, and what the panel last reported so the mirror does not overwrite it either.
    takeOver(previous: HADevice) {
        if (!(previous instanceof Device)) return
        this.remote = { ...previous.remote }
        this.seen = { ...previous.seen }
        this.cycleRunning = previous.cycleRunning
    }

    start() {
        this.publishRemote()
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x30, STATUS_LENGTH, this.processStatus)
        // 0x31 (serial numbers) and 0x19 (power events) are not decoded.
    }

    private processStatus(status: Buffer) {
        if (status[1] !== RECORD_LEN_MARKER) return // reject layout drift
        const rec = status.subarray(2)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF
        const isActive = state === STATES.unmap('Running') || state === STATES.unmap('Paused')
        const error = rec[ERROR_OFFSET]
        const option1 = rec[OPTION1_OFFSET]
        this.cycleRunning = state === STATES.unmap('Running')

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(state))
        // the sub-phase byte keeps a stale value while idle, so it is only meaningful during a cycle
        this.publishProperty('phase', isActive ? PHASES.map(rec[PROCESS_OFFSET]) : undefined)
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        this.publishProperty('delay', option1 & OPT1_RESERVATION ? 'ON' : 'OFF')
        this.publishProperty('remote_start', !isOff && rec[OPTION2_OFFSET] & OPT2_REMOTE_START ? 'ON' : 'OFF')
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))
        this.publishProperty('child_lock', option1 & OPT1_CHILD_LOCK ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_beep', option1 & OPT1_DAMP_DRY_BEEP ? 'ON' : 'OFF')
        this.publishProperty('hand_iron', option1 & OPT1_HAND_IRON ? 'ON' : 'OFF')

        if (isOff) return
        this.mirrorPanel(
            COURSES.map(rec[SMART_COURSE_OFFSET]) ?? COURSES.map(rec[COURSE_OFFSET]),
            DRY_LEVELS.map(rec[DRY_LEVEL_OFFSET]),
            ECO_HYBRID.map(rec[ECO_HYBRID_OFFSET]),
            (option1 & OPT1_ANTI_CREASE) !== 0,
        )
    }

    // Turn the dial and the selects follow; choose something in HA and it stays until the appliance
    // itself reports a different value. An appliance that is off reports no course, so the selects keep
    // their last value.
    private mirrorPanel(course?: string, dryLevel?: string, ecoHybrid?: string, antiCrease?: boolean) {
        let changed = false
        if (course !== this.seen.course) {
            this.seen.course = course
            if (course) {
                this.remote.course = course
                changed = true
            }
        }
        if (dryLevel !== this.seen.dryLevel) {
            this.seen.dryLevel = dryLevel
            if (dryLevel) {
                this.remote.dryLevel = dryLevel
                changed = true
            }
        }
        if (ecoHybrid !== this.seen.ecoHybrid) {
            this.seen.ecoHybrid = ecoHybrid
            if (ecoHybrid) {
                this.remote.ecoHybrid = ecoHybrid
                changed = true
            }
        }
        if (antiCrease !== this.seen.antiCrease) {
            this.seen.antiCrease = antiCrease
            this.remote.antiCrease = !!antiCrease
            changed = true
        }
        if (changed) this.publishRemote()
    }

    private publishRemote() {
        this.publishProperty('course', this.remote.course)
        this.publishProperty('dry_level', this.remote.dryLevel)
        this.publishProperty('eco_hybrid', this.remote.ecoHybrid)
        this.publishProperty('anti_crease', this.remote.antiCrease ? 'Yes' : 'No')
        this.publishProperty('start_delay_end', this.remote.delayHours)
    }

    // Downloaded courses are not started remotely: how the F0 26 frame carries them is unverified.
    buildStartCommand() {
        const course = COURSES.unmap(this.remote.course)
        if (course === undefined || course >= FIRST_SMART_COURSE) return undefined

        const options = COURSE_OPTIONS[course]
        const cmd = Buffer.alloc(START_COURSE_LEN, 0)
        cmd[0] = 0xf0
        cmd[1] = 0x26
        cmd[2] = course
        cmd[3] = allowed(options?.dryLevel, DRY_LEVELS.unmap(this.remote.dryLevel))
        cmd[4] = allowed(options?.ecoHybrid, ECO_HYBRID.unmap(this.remote.ecoHybrid))
        cmd[5] = options?.time ?? 0
        cmd[8] = this.remote.delayHours
        cmd[11] = this.remote.antiCrease ? OPT1_ANTI_CREASE : 0x00
        cmd[12] = START_COURSE_OP
        return cmd
    }

    private startSelected() {
        const cmd = this.buildStartCommand()
        if (!cmd) {
            log('RC90U2_WW', `${this.remote.course} cannot be started remotely`)
            return
        }

        if (this.remote.delayHours) {
            this.remote.delayHours = 0
            this.publishRemote()
        }

        if (!this.cycleRunning) {
            this.send(cmd)
            return
        }

        this.send(Buffer.from(START_PAUSE, 'hex'))
        setTimeout(() => this.send(cmd), PAUSE_BEFORE_START_MS).unref?.()
    }

    // 0 clears the delay. Below the minimum the appliance silently drops the command, so round up.
    static clampDelay(value: string) {
        const n = Math.round(Number(value))
        if (!Number.isFinite(n) || n <= 0) return 0
        return Math.min(Math.max(n, DELAY_MIN_HOURS), DELAY_MAX_HOURS)
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power':
                if (mqttValue === 'ON') this.send(Buffer.from(POWER_ON, 'hex'))
                else if (mqttValue === 'OFF') this.send(Buffer.from(POWER_OFF, 'hex'))
                return
            case 'start_pause':
                this.send(Buffer.from(START_PAUSE, 'hex'))
                return
            case 'start':
                this.startSelected()
                return
            case 'course':
                if (COURSES.unmap(mqttValue) !== undefined) this.remote.course = mqttValue
                break
            case 'dry_level':
                if (DRY_LEVELS.unmap(mqttValue) !== undefined) this.remote.dryLevel = mqttValue
                break
            case 'eco_hybrid':
                if (ECO_HYBRID.unmap(mqttValue) !== undefined) this.remote.ecoHybrid = mqttValue
                break
            case 'anti_crease':
                this.remote.antiCrease = mqttValue === 'Yes'
                break
            case 'start_delay_end':
                this.remote.delayHours = Device.clampDelay(mqttValue)
                break
            default:
                return
        }
        this.publishRemote()
    }
}
