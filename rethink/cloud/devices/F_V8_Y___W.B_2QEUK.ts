import HADevice from './base.js'
import { Device as Thinq2Device } from "../thinq2/device.js"
import { type Connection } from '../homeassistant.js'
import { type Metadata } from "../thinq.js"
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'

const ERRORS = [
    'OK',
    'Door_lock_error', // DE2
    'Door_open_error', // DE1
    'Water_supply_error', // IE
    'Water_drain_error', // OE
    'Put_of_balance_error', // UE
    'Overfill_error', // FE
    'Water_level_sensor_error', // PE
    'Temperature_sensor_error', // TE
    'Locked_motor_error', // LE
    undefined,  
    'dHE_error',
    'Power_fail_error', // PF
    'FF_error',
    'DCE_error',
    'AE_error',
    'eeprom_error',
    'PS_error',
    'Door_sensor_error', // DE4
    'Vibration_sensor_error',  // VS
    'LE8_error',
    'LE9_error',
    'ED1_error',
    'ED2_error',
    'ED3_error',
    'ED4_error',
    'ED5_error',
]

const STATES = [
    'Power_off',
    'Ready',
    'Paused',
    'Delayed',
    'Measuring',
    'Pre-wash',
    'Washing',
    'Rinsing',
    'Spinning',
    'Drying',
    'End',
    'Cool_down',
    'Rinse_hold',
    undefined,
    'Refreshing',
    'Steam_softening',
    'Demo',
    undefined,
    'Error',
    'Auto_dt_open_pause',
]

const COURSES = {
    0x1: 'Cotton',
    0x2: 'Easy Care',
    0x4: 'Eco 40-60',
    0x5: 'Duvet',
    0x7: 'Mix',
    0x8: 'Sports Wear',
    0x9: 'Night Wash',
    0xc: 'Quick 14',
    0xe: 'Rinse + Spin',
    0x1b: 'Hand Wash/Wool',
    0x12: 'Drum Clean',
    0x17: 'Spin + Drain',
    0x20: 'Delicate',
    0x2d: 'Allergy Care',
    0x31: 'TurboWash 39',
}

const TEMPERATURES = [
    0,
    10,
    20,
    30,
    40,
    50,
    60,
    95,
]

const SPINS = [
    undefined,
    0,
    400,
    500,
    700,
    800,
    900,
    1000,
    1100,
    1200,
    1400,
]

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, 'device', thinq)
        this.setConfig(allowExtendedType({
            ...HADevice.deviceConfig(meta, { name: "LG F4WV709P1E" }),
            components: {
                power: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    name: 'Power',
                    icon: 'mdi:washing-machine',
                },
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Status',
                    icon: 'mdi:state-machine'
                },
                error: {
                    platform: 'sensor',
                    unique_id: '$deviceid-error',
                    state_topic: '$this/error',
                    name: 'Error',
                    icon: 'mdi:alert-circle-outline'
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
                    value_template: "{{ value if value | is_number else 'None' }}"
                },
                spin: {
                    platform: 'sensor',
                    unique_id: '$deviceid-spin',
                    state_topic: '$this/spin',
                    name: 'Spin',
                    icon: 'mdi:autorenew',
                    unit_of_measurement: 'RPM',
                    value_template: "{{ value if value | is_number else 'None' }}"
                },
                cycles: {
                    platform: 'sensor',
                    unique_id: '$deviceid-cycles',
                    state_topic: '$this/cycles',
                    name: 'Cycle count',
                    icon: 'mdi:rotate-3d-variant'
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time'
                }
            }
        }))
    }

    start() {
        // this is only *slightly* different to the init string for the fridge                       
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        if(buf.length === 80 && buf[0] == 0x20) {
            const status = buf[43]
            const error = buf[49]
            const tremain = buf[44] * 60 + buf[45]
            const course = buf[48]
            const temp = buf[52]
            const spin = buf[51]
            const cycles = buf[64]

            this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[status] ?? 'unknown_status')
            this.publishProperty('error', ERRORS[error] ?? 'unknown_error')
            this.publishProperty('remaining_time', tremain)
            this.publishProperty('course', COURSES[course] ?? 'unknown_course')
            this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown_temperature')
            this.publishProperty('spin', SPINS[spin] ?? 'unknown_spin')
            this.publishProperty('cycles', cycles)
        }
    }
}