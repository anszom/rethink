import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import AABBDevice from './aabb_device'
import { COURSES, DRYING_MODES, ERRORS, STATES } from './washer_common'

/*
 * LG CV9014WC2 washer/dryer (ThinQ model ID F_V__F___W.B__ECON).
 *
 * ECON uses the standard AABB washer protocol, but a 0x60 live-state packet
 * carries two consecutive state snapshots. The second snapshot is the newer
 * one and is therefore the one published to Home Assistant.
 */

const ECON_COURSES = Enum.of({
    Cotton: 0x01,
    Synthetics: 0x02,
    'Cotton+': 0x04,
    Mix: 0x07,
    'Quick 14': 0x0c,
    'Steam refresh': 0x0d,
    'Drum Clean': 0x12,
    'Wash + Dry': 0x13,
    Drying: 0x18,
    Wool: 0x1b,
    Delicate: 0x20,
    'Allergy Care': 0x2d,
    'TurboWash 39': 0x31,
})

/* Values confirmed for the CV9014WC2. */
const ECON_SPINS = Enum.of({
    '0': 0x01,
    '400': 0x02,
    '800': 0x05,
    '1000': 0x07,
    '1200': 0x09,
    '1400': 0xff,
})

const SPIN_RPM: Record<number, number | undefined> = {
    0x01: 0,
    0x02: 400,
    0x05: 800,
    0x07: 1000,
    0x09: 1200,
    0x0a: 1400,
    0xff: 1400,
}

const ECON_TEMPERATURES = new Enum([
    ['Cold', 0x01],
    ['20', 0x02],
    ['30', 0x03],
    ['40', 0x04],
    ['50', 0x05],
    ['60', 0x06],
])

const TEMPERATURE_CELSIUS: Record<number, number | undefined> = {
    0x02: 20,
    0x03: 30,
    0x04: 40,
    0x05: 50,
    0x06: 60,
}

const ECON_RINSES = Enum.of({
    Normal: 0x01,
    'Rinse+': 0x02,
})

const MAX_DELAY_HOURS = 19

const CONVENTIONAL_SNAPSHOT_OFFSET = 15
const ECON_NEWEST_SNAPSHOT_OFFSET = 54
const SNAPSHOT_LENGTH = 30

interface ProgramParameters {
    programId: number
    mode: number
    spin: number
    temperature: number
    rinse: number
    dry: number
    options: number
}

interface StagedProgram {
    program?: string
    spin?: string
    temp?: string
    rinse?: string
    dry?: string
    delay?: number
}

const ECON_COURSE_PARAMETERS: Record<number, Omit<ProgramParameters, 'programId'>> = {
    0x01: {
        mode: 0x03,
        spin: 0xff,
        temperature: 0x04,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x02: {
        mode: 0x03,
        spin: 0xff,
        temperature: 0x04,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x04: {
        mode: 0x03,
        spin: 0xff,
        temperature: 0x06,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x07: {
        mode: 0x03,
        spin: 0x07,
        temperature: 0x04,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x0c: {
        mode: 0x03,
        spin: 0x02,
        temperature: 0x02,
        rinse: 0x01,
        dry: 0x00,
        options: 0x01,
    },
    0x0d: {
        mode: 0x00,
        spin: 0x00,
        temperature: 0x00,
        rinse: 0x00,
        dry: 0x00,
        options: 0x80,
    },
    0x12: {
        mode: 0x03,
        spin: 0x01,
        temperature: 0x06,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x13: {
        mode: 0x03,
        spin: 0xff,
        temperature: 0x04,
        rinse: 0x01,
        dry: 0x02,
        options: 0x00,
    },
    0x18: {
        mode: 0x00,
        spin: 0x01,
        temperature: 0x00,
        rinse: 0x00,
        dry: 0x02,
        options: 0x00,
    },
    0x1b: {
        mode: 0x03,
        spin: 0x05,
        temperature: 0x03,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x20: {
        mode: 0x03,
        spin: 0x05,
        temperature: 0x02,
        rinse: 0x01,
        dry: 0x00,
        options: 0x00,
    },
    0x2d: {
        mode: 0x03,
        spin: 0xff,
        temperature: 0x06,
        rinse: 0x01,
        dry: 0x00,
        options: 0x80,
    },
    0x31: {
        mode: 0x03,
        spin: 0x09,
        temperature: 0x04,
        rinse: 0x01,
        dry: 0x00,
        options: 0x01,
    },
}

function buildSetProgramPacket(parameters: ProgramParameters, delay: number): Buffer {
    const packet = Buffer.alloc(20)

    packet[0] = 0xf0
    packet[1] = 0x25
    packet[2] = 0x03
    packet[3] = 0x15
    packet[4] = parameters.programId
    packet[5] = parameters.mode
    packet[6] = parameters.spin
    packet[7] = parameters.temperature
    packet[8] = parameters.rinse
    packet[9] = parameters.dry
    packet[10] = delay
    packet[13] = parameters.options
    packet[14] = 0x03

    return packet
}

function buildStartProgramPacket(parameters: ProgramParameters, delay: number): Buffer {
    const packet = Buffer.alloc(18)

    packet[0] = 0xf0
    packet[1] = 0x26
    packet[2] = parameters.programId
    packet[3] = parameters.mode
    packet[4] = parameters.spin
    packet[5] = parameters.temperature
    packet[6] = parameters.rinse
    packet[7] = parameters.dry
    packet[8] = delay
    packet[11] = parameters.options
    packet[12] = 0x03

    return packet
}

export default class Device extends AABBDevice {
    private readonly staged: StagedProgram = {}

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    power_toggle: {
                        platform: 'button',
                        unique_id: '$deviceid-power_toggle',
                        command_topic: '$this/power_toggle/set',
                        payload_press: '',
                        name: 'Power toggle',
                        icon: 'mdi:power-cycle',
                    },
                    stage_program: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_program',
                        state_topic: '$this/stage_program',
                        command_topic: '$this/stage_program/set',
                        name: 'Staged: Program',
                        icon: 'mdi:format-list-bulleted',
                        options: ECON_COURSES.options,
                    },
                    stage_spin: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_spin',
                        state_topic: '$this/stage_spin',
                        command_topic: '$this/stage_spin/set',
                        name: 'Staged: Spin',
                        icon: 'mdi:autorenew',
                        options: ECON_SPINS.options,
                    },
                    stage_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_temp',
                        state_topic: '$this/stage_temp',
                        command_topic: '$this/stage_temp/set',
                        name: 'Staged: Temperature',
                        icon: 'mdi:thermometer',
                        options: ECON_TEMPERATURES.options,
                    },
                    stage_rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_rinse',
                        state_topic: '$this/stage_rinse',
                        command_topic: '$this/stage_rinse/set',
                        name: 'Staged: Rinse',
                        icon: 'mdi:water-sync',
                        options: ECON_RINSES.options,
                    },
                    stage_dry: {
                        platform: 'select',
                        unique_id: '$deviceid-stage_dry',
                        state_topic: '$this/stage_dry',
                        command_topic: '$this/stage_dry/set',
                        name: 'Staged: Dry',
                        icon: 'mdi:tumble-dryer',
                        options: DRYING_MODES.options,
                    },
                    stage_delay: {
                        platform: 'number',
                        unique_id: '$deviceid-stage_delay',
                        state_topic: '$this/stage_delay',
                        command_topic: '$this/stage_delay/set',
                        name: 'Staged: Delay',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                        min: 0,
                        max: MAX_DELAY_HOURS,
                        step: 1,
                    },
                    set_program: {
                        platform: 'button',
                        unique_id: '$deviceid-set_program',
                        command_topic: '$this/set_program/set',
                        payload_press: '',
                        name: 'Set staged program',
                        icon: 'mdi:upload-outline',
                    },
                    start_program: {
                        platform: 'button',
                        unique_id: '$deviceid-start_program',
                        command_topic: '$this/start_program/set',
                        payload_press: '',
                        name: 'Start staged program',
                        icon: 'mdi:play-box-outline',
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
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        suggested_display_precision: 0,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                    },
                    dry: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry',
                        state_topic: '$this/dry',
                        name: 'Dry',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: DRYING_MODES.options,
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycle count',
                        icon: 'mdi:counter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock-outline',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'Turbo wash',
                        icon: 'mdi:weather-windy',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease_care',
                        state_topic: '$this/crease_care',
                        name: 'Crease care',
                        icon: 'mdi:iron-outline',
                    },
                    eco_hybrid: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco hybrid',
                        icon: 'mdi:leaf',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-outline',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:heat-wave',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(packet: Buffer) {
        if (packet[0] !== 0x20 || packet[1] !== 0x0a) return

        if (packet[3] === 0x39) {
            this.processSnapshot(packet, CONVENTIONAL_SNAPSHOT_OFFSET)
        } else if (packet[3] === 0x60) {
            this.processSnapshot(packet, ECON_NEWEST_SNAPSHOT_OFFSET)
        }
    }

    private processSnapshot(packet: Buffer, offset: number) {
        if (packet.length < offset + SNAPSHOT_LENGTH) return

        const snapshot = packet.subarray(offset, offset + SNAPSHOT_LENGTH)
        const status = snapshot[0]
        const timeRemain = snapshot[1] * 60 + snapshot[2]
        const timeInitial = snapshot[3] * 60 + snapshot[4]
        const course = snapshot[5]
        const error = snapshot[6]
        const spin = snapshot[8]
        const temperature = snapshot[9]
        const dry = snapshot[11]
        const options = snapshot[14]
        const locks = snapshot[15]
        const cycles = snapshot[21]
        const energy = snapshot[29]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(error))
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(status))
        this.publishProperty('course', course === 0 ? undefined : (ECON_COURSES.map(course) ?? COURSES.map(course)))
        this.publishProperty('spin', SPIN_RPM[spin])
        this.publishProperty('temp', TEMPERATURE_CELSIUS[temperature])
        this.publishProperty('dry', DRYING_MODES.map(dry))
        this.publishProperty('cycles', cycles)
        this.publishProperty('remote_start', locks & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', locks & 0x40 ? 'OFF' : 'ON')
        this.publishProperty('child_lock', locks & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('crease_care', options & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('eco_hybrid', options & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', options & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('steam', options & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('initial_time', timeInitial)
        this.publishProperty('remaining_time', timeRemain)
        this.publishProperty('energy', energy)
    }

    private stagedParameters(): ProgramParameters | undefined {
        if (!this.staged.program) return undefined

        const programId = ECON_COURSES.unmap(this.staged.program)
        if (programId === undefined) return undefined

        const defaults = ECON_COURSE_PARAMETERS[programId]
        if (!defaults) return undefined

        const spin = this.staged.spin === undefined ? defaults.spin : ECON_SPINS.unmap(this.staged.spin)
        const temperature =
            this.staged.temp === undefined ? defaults.temperature : ECON_TEMPERATURES.unmap(this.staged.temp)
        const rinse = this.staged.rinse === undefined ? defaults.rinse : ECON_RINSES.unmap(this.staged.rinse)
        const dry = this.staged.dry === undefined ? defaults.dry : DRYING_MODES.unmap(this.staged.dry)

        if (spin === undefined || temperature === undefined || rinse === undefined || dry === undefined) {
            return undefined
        }

        return { programId, ...defaults, spin, temperature, rinse, dry }
    }

    private stageEnumProperty(prop: string, value: string, values: Enum<string>) {
        if (values.unmap(value) === undefined) return false

        this.publishProperty(prop, value)
        return true
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power':
                if (mqttValue === 'ON') this.send(Buffer.from('F02A0100', 'hex'))
                else if (mqttValue === 'OFF') this.send(Buffer.from('F024010100', 'hex'))
                return

            case 'pause':
                this.send(Buffer.from('F024040100', 'hex'))
                return

            case 'start':
                this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))
                return

            case 'power_toggle':
                this.send(Buffer.from('F02A0100', 'hex'))
                return

            case 'stage_program':
                {
                    const programId = ECON_COURSES.unmap(mqttValue)
                    const defaults = programId === undefined ? undefined : ECON_COURSE_PARAMETERS[programId]
                    if (!defaults) return

                    this.staged.program = mqttValue
                    this.staged.spin = ECON_SPINS.map(defaults.spin)
                    this.staged.temp = ECON_TEMPERATURES.map(defaults.temperature)
                    this.staged.rinse = ECON_RINSES.map(defaults.rinse)
                    this.staged.dry = DRYING_MODES.map(defaults.dry)
                    this.staged.delay = 0

                    this.publishProperty(prop, mqttValue)
                    this.publishProperty('stage_spin', this.staged.spin)
                    this.publishProperty('stage_temp', this.staged.temp)
                    this.publishProperty('stage_rinse', this.staged.rinse)
                    this.publishProperty('stage_dry', this.staged.dry)
                    this.publishProperty('stage_delay', this.staged.delay)
                }
                return

            case 'stage_spin':
                if (this.stageEnumProperty(prop, mqttValue, ECON_SPINS)) {
                    this.staged.spin = mqttValue
                }
                return

            case 'stage_temp':
                if (this.stageEnumProperty(prop, mqttValue, ECON_TEMPERATURES)) {
                    this.staged.temp = mqttValue
                }
                return

            case 'stage_rinse':
                if (this.stageEnumProperty(prop, mqttValue, ECON_RINSES)) {
                    this.staged.rinse = mqttValue
                }
                return

            case 'stage_dry':
                if (this.stageEnumProperty(prop, mqttValue, DRYING_MODES)) {
                    this.staged.dry = mqttValue
                }
                return

            case 'stage_delay': {
                const delay = Number(mqttValue)

                if (Number.isInteger(delay) && delay >= 0 && delay <= MAX_DELAY_HOURS) {
                    this.staged.delay = delay
                    this.publishProperty(prop, delay)
                }
                return
            }

            case 'set_program': {
                const parameters = this.stagedParameters()
                if (parameters) this.send(buildSetProgramPacket(parameters, this.staged.delay ?? 0))
                return
            }

            case 'start_program': {
                const parameters = this.stagedParameters()
                if (parameters) {
                    this.send(buildStartProgramPacket(parameters, this.staged.delay ?? 0))
                }
                return
            }
        }
    }
}
