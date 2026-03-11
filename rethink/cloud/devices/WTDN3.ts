import HADevice from './base.js'
import { Device as Thinq1Device } from "../thinq1/device.js"
import { type Connection } from '../homeassistant.js'
import { allowExtendedType } from '../../util/util.js'
import { Metadata } from '../thinq.js'

const ERRORS = [
    'OK',
    'Door lock error (DE2)',
    'Door open error (DE1)',
    'Water supply error (IE)',
    'Water drain error (OE)',
    'Out of balance error (UE)',
    'Overfill error (FE)',
    'Water level sensor error (PE)',
    'Temperature sensor error (TE)',
    'Locked motor error (LE)',
    undefined,  
    'Unknown error (dHE)',
    'Power fail error (PF)',
    'Unknown error (FF)',
    'Unknown error (DCE)',
    'Unknown error (AE)',
    'EEPROM error',
    'Unknown error (PS)',
    'Door sensor error (DE4)',
    'Vibration sensor error (VS)',
    'Unknown error (LE8)',
    'Unknown error (LE9)',
    'Unknown error (ED1)',
    'Unknown error (ED2)',
    'Unknown error (ED3)',
    'Unknown error (ED4)',
    'Unknown error (ED5)',
]

const STATES = [
    'Off',
    'Ready',
    'Paused',
    'Delayed',
    'Measurement',
    'Pre-wash',
    'Wash',
    'Rinse',
    'Spin',
    'Drying',
    'Finished',
    'Cooling',
    'Rinse hold',
    undefined,
    'Refreshing',
    'Steam softening',
    'Demo',
    undefined,
    'Error',
    'Auto DT Open Pause'
]

const NATIVE_COURSES = {
    0x1: 'Cotton',
    0x2: 'Ease Care',
    0x4: 'Cotton +',
    0x5: 'Duvet',
    0x7: 'Mix',
    0x8: 'Sports Wear',
    0x9: 'Silent Wash',
    0xb: 'Gentle Care',
    0xe: 'Rinse',
    0x12: 'Drum Clean',
    0x13: 'Wash + Dry',
    0x17: 'Spin + Drain',
    0x18: 'Drying',
    0x20: 'Delicate',
    0x22: 'Quick 30',
    0x24: 'Direct Wear',
    0x2d: 'Allergy Care',
    0x2c: 'Baby Steam Care',
}

const CUSTOM_COURSES = {
    0x6f: 'Reducing Wrinkles',
    0x42: 'Fast Wash + Dry',
    0x40: 'Silent',
    0x4d: 'Cold Water Wash',
    0x39: 'Jeans',
    0x37: 'Rain Season',
    0x48: 'Disinfection',
    0x36: 'Swimsuit',
    0x49: 'Light Load',
    0x6b: 'Cuffs + Collars',
    0x33: 'Baby Clothes',
    0x34: 'Children Clothing',
    0x35: 'School Uniform',
    0x3e: 'Single Cloth',
    0x3a: 'Bedspreads',
    0x4a: 'Delicate Underwear',
    0x6e: 'Saving Time',
    0x6c: 'Juice + Food Stains',
    0x3b: 'Sweat Stains',
    0x38: 'Lightly Soiled Fabrics',
    0x66: 'Powder Residue',
    0x4b: 'Wool',
    0x46: 'Drying shirts',
    0x45: 'Turbo drying',
    0x64: 'Rinse'
}

const TEMPERATURES = [
    undefined,
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
]

const DRYING_MODES = {
    0x0: 'Off',
    0x2: 'Auto',
    0x3: '00:30',
    0x4: '01:00',
    0x5: '01:30',
    0x6: '02:00',
    0x7: '02:30',
    0xa: 'Iron',
    0xb: 'Delicate',
    0xc: 'Eco',
}

export default class Device extends HADevice {
    constructor(HA: Connection, readonly thinq: Thinq1Device, meta: Metadata) {
        super(HA, 'device', thinq.id)
        this.setConfig(allowExtendedType({
            ...HADevice.deviceConfig(meta, { name: "LG Washer" }),
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
                    name: 'Current status',
                    icon: 'mdi:state-machine',
                    device_class: 'enum',
                    options: STATES.filter((a) => a !== undefined)
                },
                error: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-error-message',
                    state_topic: '$this/error',
                    name: 'Error',
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
                    options: ERRORS.filter((a) => a !== undefined)
                },
                current_course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-current_course',
                    state_topic: '$this/current_course',
                    name: 'Current course',
                    icon: 'mdi:pin-outline'
                },
                water_temp: {
                    platform: 'sensor',
                    unique_id: '$deviceid-water-temp',
                    state_topic: '$this/water_temp',
                    name: 'Water temp',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    suggested_display_precision: 0,
                    value_template: "{{ value if value | is_number else 'None' }}"
                },
                spin_speed: {
                    platform: 'sensor',
                    unique_id: '$deviceid-spin-speed',
                    state_topic: '$this/spin_speed',
                    name: 'Spin speed',
                    icon: 'mdi:autorenew',
                    value_template: "{{ value if value | is_number else 'None' }}"
                },
                drying_mode: {
                    platform: 'sensor',
                    unique_id: '$deviceid-drying-mode',
                    state_topic: '$this/drying_mode',
                    name: 'Drying mode',
                    icon: 'mdi:tumble-dryer'
                },
                cycles: {
                    platform: 'sensor',
                    unique_id: '$deviceid-cycles',
                    state_topic: '$this/cycles',
                    name: 'Cycle count',
                    icon: 'mdi:counter'
                },
                remote_start: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-remote_start',
                    state_topic: '$this/remote_start',
                    name: 'Remote start',
                    icon: 'mdi:play-circle-outline'
                },
                door_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-door_lock',
                    state_topic: '$this/door_lock',
                    name: 'Door lock',
                    device_class: 'lock'
                },
                initial_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-initial_time',
                    state_topic: '$this/initial_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Initial time'
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time'
                },
            }
        }))

        thinq.on('data', (buf) => {
            if(buf.length == 28) {
                const status = buf[0]
                const tremain = buf[1] * 60 + buf[2]
                const tinitial = buf[3] * 60 + buf[4]
                const error = buf[6];
                const flags1 = buf[15];
                const native_course = buf[5];
                const custom_course = buf[20];
                const spin = buf[8];
                const temperature = buf[9];
                const drying_mode = buf[11];
                const cycles = buf[21];

                this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
                this.publishProperty('error_message', ERRORS[error] ?? 'unknown') // publish message before set error state
                this.publishProperty('error', error ? 'ON' : 'OFF')
                this.publishProperty('status', STATES[status] ?? 'unknown')
                this.publishProperty('current_course', CUSTOM_COURSES[custom_course] ?? NATIVE_COURSES[native_course] ?? 'unknown')
                this.publishProperty('spin_speed', SPINS[spin] ?? 'unknown')
                this.publishProperty('water_temp', TEMPERATURES[temperature] ?? 'unknown')
                this.publishProperty('drying_mode', DRYING_MODES[drying_mode] ?? 'unknown')
                this.publishProperty('cycles', cycles)
                this.publishProperty('remote_start', (flags1 & 2) ? 'ON': 'OFF')
                this.publishProperty('door_lock', !(flags1 & 0x40) ? 'ON': 'OFF') // inverted logic, off=locked
                this.publishProperty('initial_time', tinitial)
                this.publishProperty('remaining_time', tremain)
            }
        })
    }

    start() {
        this.thinq.send({Cmd:"Mon", CmdOpt:"Start"})
    }

    publishCache: Record<string, string|number> =  {}

    publishProperty(prop: string, value: string|number) {
        if(this.publishCache[prop] === value)
            return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        if(prop === 'power') {
            if (mqttValue === 'ON') {
                this.thinq.send({ Cmd:"Control", CmdOpt:"Power", Value:"On", Format:"B64", Data:""})
            } else if (mqttValue === 'OFF') {
                this.thinq.send({ Cmd:"Control", CmdOpt:"Power", Value:"Off", Format:"B64", Data:""})
            }
        }
        if(prop === 'pause') this.thinq.send({ Cmd:"Control", CmdOpt:"Operation", Value:"Stop", Format:"B64", Data:""})
        if(prop === 'start') this.thinq.send({ Cmd:"Control", CmdOpt:"Operation", Value:"Start", Format:"B64", Data: mqttValue})   
    }
}