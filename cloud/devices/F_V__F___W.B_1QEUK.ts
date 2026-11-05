import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, COURSES, TEMPERATURES, SPINS, DRYING_MODES } from './washer_common'
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

    processStatus(buf: Buffer) {
        const status = buf[2]
        const time_remain = buf[3] * 60 + buf[4]
        const time_initial = buf[5] * 60 + buf[6]
        const course = buf[7]
        const error = buf[8]
        const spin = buf[10]
        const temp = buf[11]
        const drying_mode = buf[13]
        const lock_status = buf[17]
        const cycles = buf[23]
        const downloaded_course = buf[25]
        const energy = buf[30] * 256 + buf[31]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(error))
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS.map(status))
        this.publishProperty('course', COURSES.map(course))
        this.publishProperty('spin', SPINS.map(spin))
        this.publishProperty('temp', TEMPERATURES.map(temp))
        this.publishProperty('drying_mode', DRYING_MODES.map(drying_mode))
        this.publishProperty('cycles', cycles)
        if (downloaded_course) {
            this.publishProperty('downloaded_course', DOWNLOAD_COURSES.map(downloaded_course))
        }
        this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
        this.publishProperty('initial_time', time_initial)
        this.publishProperty('remaining_time', time_remain)
        this.publishProperty('energy', energy)
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
        if (prop === 'start') this.send(Buffer.from('F024050100', 'hex'))
        if (prop === 'downloaded_course' && DOWNLOAD_PAYLOADS[mqttValue]) {
            this.send(Buffer.from(DOWNLOAD_PAYLOADS[mqttValue], 'hex'))
        }
    }
}
