import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, COURSES, TEMPERATURES, SPINS, RINSES, SOIL_LEVELS, DRYING_MODES } from './washer_common'
import { Enum } from '@/util/enum'

// Codes derived from modelJSON & observation of the LG app.
const STATUS = Enum.of({
    Off: 0,
    Standby: 1,
    Paused: 2,
    Delayed: 3,
    Detecting: 4,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    Drying: 9,
    End: 10,
    'Cool down': 11,
    'Rinse hold': 12,
    Refreshing: [14, 15], // WASH_REFRESHING & REFRESHING,
    // the app shows the first one as a wash state, the second as a sub-state of Completed
    Demo: 16,
    Error: 18,
})

const SET_COURSES = new Enum<string>([['Not selected', 0], ...COURSES.entries])

// Bit positions in the F026/F025 options byte and in the status record's s[16] field.
const OPTION_BITS: Record<string, number> = {
    turbowash: 0x01,
    medic_rinse: 0x10,
    prewash: 0x40,
    steam: 0x80,
}

// SmartCourse entries from modelJSON (ControlWifi.WMDownload, opcode F0 25):
// F0 25 03 15 <course> <soil> <spin> <temp> <rinse> <dry> 00 00 <load> <opts> 00 00 <smartCourse> 00 00 00
const DOWNLOAD_COURSES = Enum.of({
    'Baby Care': 0x47,
    Lingerie: 0x4a,
    'Cold Wash': 0x4d,
    'Rinse + Spin': 0x64,
    'Kids Wear': 0x34,
    'Swimming Wear': 0x36,
    'Rainy Season': 0x37,
    Jeans: 0x39,
    'Sweat Stain': 0x3b,
    Deodorization: 0x3c,
    'Colour Protection': 0x3f,
    'Lightly Soiled Items': 0x65,
    'Minimize Detergent Residue': 0x66,
    Refresh: 0x6a,
    'Sleeve Hems and Collars': 0x6b,
    'Juice and Food Stains': 0x6c,
    'Quick Tub Clean': 0x71,
    Drain: 0x79,
    Spin: 0x7a,
    'Dry 30': 0x43,
    'Dry 60': 0x44,
    'Turbo Dry': 0x45,
    'Shirt Dry': 0x46,
    'Quick Wash + Dry': 0x42,
    Duvet: 0x81,
    Sportswear: 0x82,
})

const DOWNLOAD_PAYLOADS: Record<string, string> = {
    'Baby Care': 'F025031501030706020000000050000047000000',
    Lingerie: 'F02503152003050201000000000000004A000000',
    'Cold Wash': 'F02503150103FF0101000000000000004D000000',
    'Rinse + Spin': 'F02503150E03FF00010000000000000064000000',
    'Kids Wear': 'F025031501030906010000000040000034000000',
    'Swimming Wear': 'F02503151B030202010000000000000036000000',
    'Rainy Season': 'F02503150103FF04010000000000000037000000',
    Jeans: 'F02503152003FF02010000000000000039000000',
    'Sweat Stain': 'F02503150103FF0401000000000000003B000000',
    Deodorization: 'F02503150D00000000000000038000003C000000',
    'Colour Protection': 'F02503152003050201000000000000003F000000',
    'Lightly Soiled Items': 'F02503151B030202010000000000000065000000',
    'Minimize Detergent Residue': 'F02503150103FF04020000000000000066000000',
    Refresh: 'F02503150D00000000000000038000006A000000',
    'Sleeve Hems and Collars': 'F02503150103070601000000004000006B000000',
    'Juice and Food Stains': 'F02503150103070401000000004000006C000000',
    'Quick Tub Clean': 'F025031530030201000000000000000071000000',
    Drain: 'F025031517000100000000000000000079000000',
    Spin: 'F02503151700FF0000000000000000007A000000',
    'Dry 30': 'F025031518000000000300000000000043000000',
    'Dry 60': 'F025031518000000000400000000000044000000',
    'Turbo Dry': 'F025031518000000000200000000000045000000',
    'Shirt Dry': 'F025031518000000000A00000000000046000000',
    'Quick Wash + Dry': 'F025031524030703010300000000000042000000',
    Duvet: 'F025031505030701010000000000000081000000',
    Sportswear: 'F025031508030504010000000000000082000000',
}

export default class Device extends AABBDevice {
    protected pending = new Map<string, number>()
    protected reported = {
        course: 0,
        soil: 0,
        spin: 0,
        temp: 0,
        rinse: 0,
        drying_mode: 0,
        delay_end: 0,
        options: 0,
        wrinkle_care: 0,
        downloaded_course: 0x47,
    }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
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
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS.options,
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
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water',
                        device_class: 'enum',
                        options: RINSES.options,
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
                    drying_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-drying-mode',
                        state_topic: '$this/drying_mode',
                        name: 'Drying mode',
                        icon: 'mdi:tumble-dryer',
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
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew',
                    },
                    turbowash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    medic_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-medic_rinse',
                        state_topic: '$this/medic_rinse',
                        name: 'Medic rinse',
                        icon: 'mdi:water-check',
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
                    downloaded_course: {
                        platform: 'select',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        command_topic: '$this/downloaded_course/set',
                        name: 'Downloaded cycle',
                        icon: 'mdi:cloud-download-outline',
                        options: DOWNLOAD_COURSES.options,
                    },
                    set_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_course',
                        state_topic: '$this/set_course',
                        command_topic: '$this/set_course/set',
                        name: 'Set course',
                        icon: 'mdi:tune-vertical',
                        options: SET_COURSES.options,
                    },
                    set_soil: {
                        platform: 'select',
                        unique_id: '$deviceid-set_soil',
                        state_topic: '$this/set_soil',
                        command_topic: '$this/set_soil/set',
                        name: 'Set soil level',
                        icon: 'mdi:washing-machine',
                        options: SOIL_LEVELS.options,
                    },
                    set_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-set_temp',
                        state_topic: '$this/set_temp',
                        command_topic: '$this/set_temp/set',
                        name: 'Set temperature',
                        icon: 'mdi:thermometer',
                        options: TEMPERATURES.options,
                    },
                    set_spin: {
                        platform: 'select',
                        unique_id: '$deviceid-set_spin',
                        state_topic: '$this/set_spin',
                        command_topic: '$this/set_spin/set',
                        name: 'Set spin',
                        icon: 'mdi:autorenew',
                        options: SPINS.options,
                    },
                    set_rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-set_rinse',
                        state_topic: '$this/set_rinse',
                        command_topic: '$this/set_rinse/set',
                        name: 'Set rinse',
                        icon: 'mdi:water',
                        options: RINSES.options,
                    },
                    set_drying_mode: {
                        platform: 'select',
                        unique_id: '$deviceid-set_drying_mode',
                        state_topic: '$this/set_drying_mode',
                        command_topic: '$this/set_drying_mode/set',
                        name: 'Set drying mode',
                        icon: 'mdi:tumble-dryer',
                        options: DRYING_MODES.options,
                    },
                    set_delay_end: {
                        platform: 'number',
                        unique_id: '$deviceid-set_delay_end',
                        state_topic: '$this/set_delay_end',
                        command_topic: '$this/set_delay_end/set',
                        name: 'Set delayed end',
                        icon: 'mdi:timer-sand',
                        unit_of_measurement: 'h',
                        min: 0,
                        max: 19,
                        step: 1,
                    },
                    set_steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_steam',
                        state_topic: '$this/set_steam',
                        command_topic: '$this/set_steam/set',
                        name: 'Set steam',
                        icon: 'mdi:kettle-steam',
                    },
                    set_prewash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_prewash',
                        state_topic: '$this/set_prewash',
                        command_topic: '$this/set_prewash/set',
                        name: 'Set pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    set_turbowash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_turbowash',
                        state_topic: '$this/set_turbowash',
                        command_topic: '$this/set_turbowash/set',
                        name: 'Set TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    set_medic_rinse: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_medic_rinse',
                        state_topic: '$this/set_medic_rinse',
                        command_topic: '$this/set_medic_rinse/set',
                        name: 'Set medic rinse',
                        icon: 'mdi:water-check',
                    },
                    set_wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_wrinkle_care',
                        state_topic: '$this/set_wrinkle_care',
                        command_topic: '$this/set_wrinkle_care/set',
                        name: 'Set wrinkle care',
                        icon: 'mdi:tshirt-crew',
                    },
                    run_programme: {
                        platform: 'button',
                        unique_id: '$deviceid-run_programme',
                        command_topic: '$this/run_programme/set',
                        payload_press: '',
                        name: 'Run programme',
                        icon: 'mdi:play-box-outline',
                    },
                    save_custom_download: {
                        platform: 'button',
                        unique_id: '$deviceid-save_custom_download',
                        command_topic: '$this/save_custom_download/set',
                        payload_press: '',
                        name: 'Save custom download',
                        icon: 'mdi:content-save-cog-outline',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x20, 39, this.processStatus)
    }

    protected setting(prop: keyof typeof this.reported) {
        return this.pending.get(prop) ?? this.reported[prop]
    }

    protected publishSettings() {
        this.publishProperty('set_course', SET_COURSES.map(this.setting('course')))
        this.publishProperty('set_soil', SOIL_LEVELS.map(this.setting('soil')))
        this.publishProperty('set_temp', TEMPERATURES.map(this.setting('temp')))
        this.publishProperty('set_spin', SPINS.map(this.setting('spin')))
        this.publishProperty('set_rinse', RINSES.map(this.setting('rinse')))
        this.publishProperty('set_drying_mode', DRYING_MODES.map(this.setting('drying_mode')))
        this.publishProperty('set_delay_end', this.setting('delay_end'))
        const options = this.setting('options')
        for (const [name, bit] of Object.entries(OPTION_BITS)) {
            this.publishProperty(`set_${name}`, options & bit ? 'ON' : 'OFF')
        }
        this.publishProperty('set_wrinkle_care', this.setting('wrinkle_care') ? 'ON' : 'OFF')
    }

    protected programmeCommand() {
        const wrinkleFlag = this.setting('wrinkle_care') ? 0x20 : 0x00
        return Buffer.from([
            0xf0,
            0x26,
            this.setting('course'),
            this.setting('soil'),
            this.setting('spin'),
            this.setting('temp'),
            this.setting('rinse'),
            this.setting('drying_mode'),
            this.setting('delay_end'),
            0, // reserveTimeMinute
            this.setting('course') === 0x0d ? 0x03 : 0x00, // loadItemWasher (3 for Steam refresh)
            this.setting('options'),
            0x03 | wrinkleFlag, // initialBit (0x01) | remoteStart (0x02) | wrinkleCare (0x20)
            0,
            0,
            0,
            0,
            0,
        ])
    }

    protected customDownloadCommand() {
        const wrinkleFlag = this.setting('wrinkle_care') ? 0x20 : 0x00
        const smartId = this.setting('downloaded_course') || 0x47
        return Buffer.from([
            0xf0,
            0x25,
            0x03,
            0x15,
            this.setting('course'),
            this.setting('soil'),
            this.setting('spin'),
            this.setting('temp'),
            this.setting('rinse'),
            this.setting('drying_mode'),
            this.setting('delay_end'),
            0, // reserveTimeMinute
            this.setting('course') === 0x0d ? 0x03 : 0x00,
            this.setting('options'),
            wrinkleFlag,
            0,
            smartId,
            0,
            0,
            0,
        ])
    }

    processStatus(buf: Buffer) {
        const status = buf[2]
        const time_remain = buf[3] * 60 + buf[4]
        const time_initial = buf[5] * 60 + buf[6]
        const course = buf[7]
        const error = buf[8]
        const soil = buf[9]
        const spin = buf[10]
        const temp = buf[11]
        const rinse = buf[12]
        const drying_mode = buf[13]
        const delay_end = buf[14]
        const options = buf[16]
        const lock_status = buf[17]
        const cycles = buf[23]
        const downloaded_course = buf[25]
        const energy = buf[30] * 256 + buf[31]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(error))
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS.map(status))
        this.publishProperty('course', COURSES.map(course))
        this.publishProperty('soil', SOIL_LEVELS.map(soil))
        this.publishProperty('spin', SPINS.map(spin))
        this.publishProperty('temp', TEMPERATURES.map(temp))
        this.publishProperty('rinse', RINSES.map(rinse))
        this.publishProperty('drying_mode', DRYING_MODES.map(drying_mode))
        this.publishProperty('cycles', cycles)
        if (downloaded_course) {
            this.publishProperty('downloaded_course', DOWNLOAD_COURSES.map(downloaded_course))
        }
        this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
        this.publishProperty('child_lock', !(lock_status & 0x80) ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', lock_status & 0x20 ? 'ON' : 'OFF')
        this.publishProperty('turbowash', options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('medic_rinse', options & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('prewash', options & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('steam', options & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('initial_time', time_initial)
        this.publishProperty('remaining_time', time_remain)
        this.publishProperty('energy', energy)

        this.reported = {
            course,
            soil,
            spin,
            temp,
            rinse,
            drying_mode,
            delay_end,
            options,
            wrinkle_care: lock_status & 0x20 ? 1 : 0,
            downloaded_course: downloaded_course || this.reported.downloaded_course,
        }
        this.publishSettings()
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
            return
        }

        if (prop === 'pause') {
            this.send(Buffer.from('F024040100', 'hex'))
            return
        }
        if (prop === 'start') {
            this.send(Buffer.from('F024050100', 'hex'))
            return
        }
        if (prop === 'downloaded_course' && DOWNLOAD_PAYLOADS[mqttValue]) {
            this.send(Buffer.from(DOWNLOAD_PAYLOADS[mqttValue], 'hex'))
            return
        }
        if (prop === 'run_programme') {
            this.send(this.programmeCommand())
            this.pending.clear()
            return
        }
        if (prop === 'save_custom_download') {
            this.send(this.customDownloadCommand())
            return
        }

        const table: Record<string, Enum<string>> = {
            set_course: SET_COURSES,
            set_soil: SOIL_LEVELS,
            set_temp: TEMPERATURES,
            set_spin: SPINS,
            set_rinse: RINSES,
            set_drying_mode: DRYING_MODES,
        }
        if (prop in table) {
            const code = table[prop].unmap(mqttValue)
            if (code !== undefined) this.pending.set(prop.slice(4), code)
            this.publishSettings()
            return
        }

        if (prop === 'set_delay_end') {
            const hours = Number(mqttValue)
            if (Number.isFinite(hours) && (hours === 0 || (hours >= 3 && hours <= 19))) {
                this.pending.set('delay_end', hours)
            }
            this.publishSettings()
            return
        }

        if (prop === 'set_wrinkle_care') {
            this.pending.set('wrinkle_care', mqttValue === 'ON' ? 1 : 0)
            this.publishSettings()
            return
        }

        const bit = OPTION_BITS[prop.slice(4)]
        if (prop.startsWith('set_') && bit !== undefined) {
            const options = this.setting('options')
            this.pending.set('options', mqttValue === 'ON' ? options | bit : options & ~bit)
            this.publishSettings()
        }
    }
}
