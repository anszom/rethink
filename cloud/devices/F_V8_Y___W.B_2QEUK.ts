import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { tombstone, type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES, COURSES, TEMPERATURES, SPINS, SOIL_LEVELS } from './washer_common'

// F0 26 <course> <intensity> <spin> <temp> <rinse> 00 <delay h> 00 00 <options> <flag>,
// using the status record's codes. Requires Remote Start.
const CMD_START = 0x26
const START_FLAG = 0x03
const RESUME_FLAG = 0x01
const PROGRAM_TEMPS: string[] = TEMPERATURES.options.filter((t) => [1, 2, 3, 4, 6, 7].includes(TEMPERATURES.unmap(t)!))
const PROGRAM_SPINS: string[] = SPINS.options.filter((t) => [1, 2, 5, 7, 9, 10].includes(SPINS.unmap(t)!))
const PROGRAM_TURBOWASH = 0x01
const PROGRAM_STEAM = 0x80
const PROGRAM_PREWASH = 0x40
const INTENSITY_NORMAL = 3
const INTENSITY_INTENSIVE = 4
const START_DELAY = 8 // Delay End, whole hours
const DELAY_MIN = 3
const DELAY_MAX = 19

type ProgramSettings = { temp: number; temps: number[]; spin: number; spins: number[]; rinse: boolean; options: number }

// Per-course defaults and choices from the modelJSON; "Max" spin is 1400.
const ALL_SPINS = [1, 2, 5, 7, 9, 10]
const PROGRAMS: Record<number, ProgramSettings> = {
    0x01: { temp: 4, temps: [1, 2, 3, 4, 6, 7], spin: 10, spins: ALL_SPINS, rinse: true, options: 0 },
    0x02: { temp: 4, temps: [1, 2, 3, 4, 6], spin: 10, spins: ALL_SPINS, rinse: true, options: 0 },
    0x04: { temp: 4, temps: [4, 6], spin: 10, spins: ALL_SPINS, rinse: true, options: 0 },
    0x05: { temp: 1, temps: [1, 2, 3, 4], spin: 7, spins: [1, 2, 5, 7], rinse: true, options: 0 },
    0x07: { temp: 4, temps: [1, 2, 3, 4, 6], spin: 7, spins: ALL_SPINS, rinse: true, options: 0 },
    0x08: { temp: 4, temps: [1, 2, 3, 4], spin: 5, spins: [1, 2, 5], rinse: true, options: 0 },
    0x09: { temp: 4, temps: [1, 2, 3, 4, 6], spin: 5, spins: [1, 2, 5, 7], rinse: true, options: 0 },
    0x0c: { temp: 2, temps: [2, 3, 4], spin: 2, spins: ALL_SPINS, rinse: true, options: PROGRAM_TURBOWASH },
    0x12: { temp: 6, temps: [], spin: 1, spins: [], rinse: false, options: 0 },
    0x1b: { temp: 3, temps: [1, 2, 3, 4], spin: 5, spins: [1, 2, 5], rinse: true, options: 0 },
    0x20: { temp: 2, temps: [1, 2, 3, 4], spin: 5, spins: [1, 2, 5], rinse: true, options: 0 },
    0x2d: { temp: 6, temps: [], spin: 10, spins: ALL_SPINS, rinse: true, options: PROGRAM_STEAM },
    0x31: {
        temp: 4,
        temps: [1, 2, 3, 4, 6],
        spin: 9,
        spins: [2, 5, 7, 9, 10],
        rinse: true,
        options: PROGRAM_TURBOWASH,
    },
}
const PROGRAM_COURSES: string[] = COURSES.options.filter((c) => PROGRAMS[COURSES.unmap(c)!])

// Only for the 32-byte models (F4WV909P2TE).
const REMOTE_COMPONENTS = {
    start_program: {
        platform: 'button',
        unique_id: '$deviceid-start_program',
        command_topic: '$this/start_program/set',
        payload_press: '',
        name: 'Start program',
        icon: 'mdi:play-circle',
    },
    program_course: {
        platform: 'select',
        unique_id: '$deviceid-program_course',
        state_topic: '$this/program_course',
        command_topic: '$this/program_course/set',
        name: 'Program',
        icon: 'mdi:pin-outline',
        options: PROGRAM_COURSES,
    },
    program_temp: {
        platform: 'select',
        unique_id: '$deviceid-program_temp',
        state_topic: '$this/program_temp',
        command_topic: '$this/program_temp/set',
        name: 'Program temperature',
        icon: 'mdi:thermometer',
        options: PROGRAM_TEMPS,
    },
    program_spin: {
        platform: 'select',
        unique_id: '$deviceid-program_spin',
        state_topic: '$this/program_spin',
        command_topic: '$this/program_spin/set',
        name: 'Program spin',
        icon: 'mdi:autorenew',
        options: PROGRAM_SPINS,
    },
    program_rinse_plus: {
        platform: 'switch',
        unique_id: '$deviceid-program_rinse_plus',
        state_topic: '$this/program_rinse_plus',
        command_topic: '$this/program_rinse_plus/set',
        name: 'Program Rinse+',
        icon: 'mdi:water-plus',
    },
    program_turbowash: {
        platform: 'switch',
        unique_id: '$deviceid-program_turbowash',
        state_topic: '$this/program_turbowash',
        command_topic: '$this/program_turbowash/set',
        name: 'Program TurboWash',
        icon: 'mdi:rocket-launch',
    },
    program_steam: {
        platform: 'switch',
        unique_id: '$deviceid-program_steam',
        state_topic: '$this/program_steam',
        command_topic: '$this/program_steam/set',
        name: 'Program Steam',
        icon: 'mdi:kettle-steam',
    },
    program_prewash: {
        platform: 'switch',
        unique_id: '$deviceid-program_prewash',
        state_topic: '$this/program_prewash',
        command_topic: '$this/program_prewash/set',
        name: 'Program Pre-wash',
        icon: 'mdi:water-sync',
    },
    program_intensive: {
        platform: 'switch',
        unique_id: '$deviceid-program_intensive',
        state_topic: '$this/program_intensive',
        command_topic: '$this/program_intensive/set',
        name: 'Program Intensive',
        icon: 'mdi:washing-machine-alert',
    },
    program_delay: {
        platform: 'number',
        unique_id: '$deviceid-program_delay',
        state_topic: '$this/program_delay',
        command_topic: '$this/program_delay/set',
        name: 'Program delay end',
        icon: 'mdi:timer-sand',
        min: 0,
        max: DELAY_MAX,
        step: 1,
        mode: 'box',
        unit_of_measurement: 'h',
    },
}

export default class Device extends AABBDevice {
    private program = {
        course: 'Cotton',
        temp: '40 °C',
        spin: '1400 rpm',
        rinsePlus: false,
        turbowash: false,
        steam: false,
        prewash: false,
        intensive: false,
        delay: 0,
    }
    private shortRecord: Buffer | undefined
    private baseConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.baseConfig = allowExtendedType({
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
                    device_class: 'enum',
                    options: TEMPERATURES.options,
                },
                spin: {
                    platform: 'sensor',
                    unique_id: '$deviceid-spin',
                    state_topic: '$this/spin',
                    name: 'Spin',
                    icon: 'mdi:autorenew',
                    device_class: 'enum',
                    options: SPINS.options,
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
                    device_class: 'lock',
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
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Initial time',
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time',
                },
                reserve_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-reserve_time',
                    state_topic: '$this/reserve_time',
                    device_class: 'duration',
                    unit_of_measurement: 'h',
                    name: 'Reserve time',
                    icon: 'mdi:timer-sand',
                },
                extra_rinse: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-extra_rinse',
                    state_topic: '$this/extra_rinse',
                    name: 'Extra rinse',
                    icon: 'mdi:water-plus',
                },
                turbowash: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-turbowash',
                    state_topic: '$this/turbowash',
                    name: 'TurboWash',
                    icon: 'mdi:rocket-launch',
                },
                prewash: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-prewash',
                    state_topic: '$this/prewash',
                    name: 'Pre-wash',
                    icon: 'mdi:water-sync',
                },
                soil: {
                    platform: 'sensor',
                    unique_id: '$deviceid-soil',
                    state_topic: '$this/soil',
                    name: 'Soil level',
                    icon: 'mdi:washing-machine',
                    device_class: 'enum',
                    options: SOIL_LEVELS.options,
                },
                intensive_wash: tombstone('binary_sensor'),
                steam: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-steam',
                    state_topic: '$this/steam',
                    name: 'Steam',
                    icon: 'mdi:kettle-steam',
                },
            },
        })
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // 39-byte records in a 0xEC frame; the current one starts at buf[41]
        if (buf.length === 80 && buf[0] == 0x20) {
            this.configure(false)
            this.processRecord(buf.subarray(41), true)
            return
        }

        // F4WV909P2TE: 32-byte records, same layout as the first 32 bytes of the 39-byte ones
        this.processCommonStatus(buf, 0x20, 32, (rec) => {
            this.configure(true)
            this.shortRecord = Buffer.from(rec)
            this.processRecord(rec, false)
        })
    }

    // published once the record length shows which model this is
    private configure(short: boolean) {
        if (this.config) return
        const base = this.baseConfig
        this.setConfig(short ? { ...base, components: { ...base.components, ...REMOTE_COMPONENTS } } : base)
        if (short) this.publishProgram()
    }

    private processRecord(rec: Buffer, long: boolean) {
        const status = rec[2]
        const time_remain = rec[3] * 60 + rec[4]
        const time_initial = rec[5] * 60 + rec[6]
        const course = rec[7]
        const error = rec[8]
        const soil = rec[9]
        const spin = rec[10]
        const temp = rec[11]
        const extra_rinse = rec[12]
        const time_reserve_hour = rec[14]
        const options = rec[16]
        const lock_status = rec[17]
        const cycles = rec[23]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(status))
        this.publishProperty('spin', SPINS.map(spin))
        this.publishProperty('temp', TEMPERATURES.map(temp))
        this.publishProperty('cycles', cycles)
        this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
        if (long) {
            this.publishProperty('course', COURSES.map(course))
            this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
            this.publishProperty('child_lock', !(lock_status & 0x80) ? 'ON' : 'OFF') // inverted logic, off=locked
        } else {
            this.publishProperty('course', COURSES.map(course))
            // not inverted on the 32-byte models; lock device class: ON = unlocked
            this.publishProperty('door_lock', lock_status & 0x40 ? 'OFF' : 'ON')
            this.publishProperty('child_lock', lock_status & 0x80 ? 'OFF' : 'ON')
        }
        this.publishProperty('energy', rec[30] * 256 + rec[31])
        this.publishProperty('initial_time', time_initial)
        this.publishProperty('remaining_time', time_remain)
        this.publishProperty('reserve_time', time_reserve_hour)
        this.publishProperty('extra_rinse', extra_rinse >= 2 ? 'ON' : 'OFF') // 0/1=off, 2+=one or more extra rinses (Rinse+)
        this.publishProperty('turbowash', options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('prewash', options & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('steam', options & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('soil', SOIL_LEVELS.map(soil))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
        }

        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        if (prop === 'start') {
            if (this.shortRecord && !mqttValue) this.send(this.resumeCommand(this.shortRecord))
            else this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))
        }
        if (prop === 'start_program') {
            const cmd = this.startCommand()
            if (cmd) this.send(cmd)
        }

        if (prop === 'program_course' && PROGRAM_COURSES.includes(mqttValue)) this.program.course = mqttValue
        if (prop === 'program_temp' && PROGRAM_TEMPS.includes(mqttValue)) this.program.temp = mqttValue
        if (prop === 'program_spin' && PROGRAM_SPINS.includes(mqttValue)) this.program.spin = mqttValue
        if (prop === 'program_rinse_plus') this.program.rinsePlus = mqttValue === 'ON'
        if (prop === 'program_turbowash') this.program.turbowash = mqttValue === 'ON'
        if (prop === 'program_steam') this.program.steam = mqttValue === 'ON'
        if (prop === 'program_prewash') this.program.prewash = mqttValue === 'ON'
        if (prop === 'program_intensive') this.program.intensive = mqttValue === 'ON'
        if (prop === 'program_delay') {
            const hours = Math.round(Number(mqttValue))
            if (hours === 0 || (hours >= DELAY_MIN && hours <= DELAY_MAX)) this.program.delay = hours
        }
        if (prop.startsWith('program_')) this.publishProgram()
    }

    private publishProgram() {
        this.publishProperty('program_course', this.program.course)
        this.publishProperty('program_temp', this.program.temp)
        this.publishProperty('program_spin', this.program.spin)
        this.publishProperty('program_rinse_plus', this.program.rinsePlus ? 'ON' : 'OFF')
        this.publishProperty('program_turbowash', this.program.turbowash ? 'ON' : 'OFF')
        this.publishProperty('program_steam', this.program.steam ? 'ON' : 'OFF')
        this.publishProperty('program_prewash', this.program.prewash ? 'ON' : 'OFF')
        this.publishProperty('program_intensive', this.program.intensive ? 'ON' : 'OFF')
        this.publishProperty('program_delay', this.program.delay)
    }

    // the F4WV909P2TE refuses F024050100
    private resumeCommand(rec: Buffer) {
        const cmd = Buffer.alloc(19)
        cmd[0] = 0xf0
        cmd[1] = CMD_START
        cmd[2] = rec[7]
        cmd[3] = rec[9]
        cmd[4] = rec[10]
        cmd[5] = rec[11]
        cmd[6] = rec[12]
        cmd[11] = rec[16]
        cmd[12] = RESUME_FLAG
        return cmd
    }

    // unsupported temperature or spin falls back to the course default
    private startCommand() {
        const course = COURSES.unmap(this.program.course)!
        const settings = PROGRAMS[course]
        const temp = TEMPERATURES.unmap(this.program.temp)!
        const spin = SPINS.unmap(this.program.spin)!

        const cmd = Buffer.alloc(18)
        cmd[0] = 0xf0
        cmd[1] = CMD_START
        cmd[2] = course
        cmd[3] = this.program.intensive ? INTENSITY_INTENSIVE : INTENSITY_NORMAL
        cmd[4] = settings.spins.includes(spin) ? spin : settings.spin
        cmd[5] = settings.temps.includes(temp) ? temp : settings.temp
        cmd[6] = settings.rinse && this.program.rinsePlus ? 2 : 1
        cmd[11] =
            settings.options |
            (this.program.turbowash ? PROGRAM_TURBOWASH : 0) |
            (this.program.steam ? PROGRAM_STEAM : 0) |
            (this.program.prewash ? PROGRAM_PREWASH : 0)
        cmd[START_DELAY] = this.program.delay
        cmd[12] = START_FLAG
        return cmd
    }
}
