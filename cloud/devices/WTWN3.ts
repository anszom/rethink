import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'
import { Enum } from '@/util/enum'
import { ERRORS, STATES } from './washer_common'

// LG F4J7TN1W (ThinQ Model ID WTWN3, deviceType 201): 8 kg front-load washer, TITAN2 platform,
// ThinQ1 with the QCA4002 module (FwVer QC_Modem_1.2.80). Same 28-byte status layout as WTDN3
// (F2J7HG1W) minus the dryer: byte 11 is undefined for this model. Field offsets and enum codes
// come from LG's own modelJson for WTWN3 (Monitoring.protocol / Value); labels are the English
// language-pack text.
//
// Confirmed on a real F4J7TN1W: power/status, the Ready and Off frames, door lock and the tub clean
// counter. The option bits, child lock, remote start and the Start/Pause/Power commands follow the
// spec and the WTDN3 handler; they have not been exercised on this washer yet.

// Course (byte 5) and SmartCourse (byte 20, downloaded courses) share one label space. A non-zero
// SmartCourse overrides the base course, as on WTDN3.
export const COURSES = Enum.of({
    Cotton: 0x01,
    'Easy Care': 0x02,
    'Cotton+': 0x04,
    Duvet: 0x05,
    'Stain Care': 0x06,
    Mix: 0x07,
    'Sports Wear': 0x08,
    'Silent Wash': 0x09,
    'Gentle Care': 0x0b,
    'Speed 14': 0x0c,
    'Tub Clean': 0x12,
    Delicate: 0x20,
    'Baby Steam Care': 0x2c,
    'Allergy SpaSteam': 0x2d,
    // downloaded ("smart") courses
    'Kids Wear': 0x34,
    'School Uniform': 0x35,
    'Swimming Wear': 0x36,
    'Rainy Season': 0x37,
    'Gym Clothes': 0x38,
    Jeans: 0x39,
    Blanket: 0x3a,
    'Sweat Stain': 0x3b,
    'Single Garment': 0x3e,
    'Color Protection': 0x3f,
    'Noise Minimize': 0x40,
    'Small Load': 0x49,
    Lingerie: 0x4a,
    Wool: 0x4b,
    'Cold Wash': 0x4d,
    'Rinse + Spin': 0x64,
    'Lightly Soiled Items': 0x65,
    'Minimize Detergent Residue': 0x66,
    '1hr. Wash': 0x67,
    'Sleeve Hems and Collars': 0x6b,
    'Juice and Food Stains': 0x6c,
    'Minimize Wrinkles': 0x6f,
})

export const WASH = Enum.of({
    'Turbo Wash': 1,
    'Time Save': 2,
    Normal: 3,
    Intensive: 4,
})

export const TEMPERATURES = Enum.of({
    Cold: 1,
    '20': 2,
    '30': 3,
    '40': 4,
    '50': 5,
    '60': 6,
    '95': 7,
})

export const RINSE = Enum.of({
    Normal: 1,
    'Rinse+': 2,
    'Rinse++': 3,
    'Normal + Hold': 4,
    'Rinse+ + Hold': 5,
})

// RPM by code; 0 = not set, 0xff = course maximum (reported as unknown).
export const SPINS = [undefined, 0, 400, 600, 700, 800, 900, 1000, 1100, 1200, 1400, 1600]

// Option1 (byte 14) bit flags
const OPT1_TURBO_WASH = 0x01
const OPT1_CREASE_CARE = 0x02
const OPT1_MEDIC_RINSE = 0x10
const OPT1_PRE_WASH = 0x40
const OPT1_STEAM = 0x80

// Option2 (byte 15) bit flags
const OPT2_REMOTE_START = 0x02
const OPT2_DOOR_LOCK = 0x40
const OPT2_CHILD_LOCK = 0x80

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
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
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    wash: {
                        platform: 'sensor',
                        unique_id: '$deviceid-wash',
                        state_topic: '$this/wash',
                        name: 'Wash',
                        icon: 'mdi:waves',
                        device_class: 'enum',
                        options: WASH.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMPERATURES.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water',
                        device_class: 'enum',
                        options: RINSE.options,
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:speedometer',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-plus-outline',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:weather-fog',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease_care',
                        state_topic: '$this/crease_care',
                        name: 'Crease care',
                        icon: 'mdi:iron-outline',
                    },
                    medic_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-medic_rinse',
                        state_topic: '$this/medic_rinse',
                        name: 'Medic rinse',
                        icon: 'mdi:medical-bag',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since tub clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
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
                        icon: 'mdi:lock-outline',
                    },
                    standby: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-standby',
                        state_topic: '$this/standby',
                        name: 'Standby',
                        icon: 'mdi:power-sleep',
                        entity_category: 'diagnostic',
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
                        unit_of_measurement: 'min',
                        name: 'Delay start',
                        icon: 'mdi:timer-sand',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => {
            if (buf.length == 28) {
                const status = buf[0]
                const time_remain = buf[1] * 60 + buf[2]
                const time_initial = buf[3] * 60 + buf[4]
                const native_course = buf[5]
                const error = buf[6]
                const wash = buf[7]
                const spin = buf[8]
                const temp = buf[9]
                const rinse = buf[10]
                const reserve = buf[12] * 60 + buf[13]
                const option1 = buf[14]
                const option2 = buf[15]
                const smart_course = buf[20]
                const tub_clean_count = buf[21]
                const standby = buf[27]

                this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
                this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
                this.publishProperty('error', error ? 'ON' : 'OFF')
                this.publishProperty('status', STATES.map(status))
                this.publishProperty('course', COURSES.map(smart_course) ?? COURSES.map(native_course))
                this.publishProperty('wash', WASH.map(wash))
                this.publishProperty('spin', SPINS[spin])
                this.publishProperty('temp', TEMPERATURES.map(temp))
                this.publishProperty('rinse', RINSE.map(rinse))
                this.publishProperty('turbo_wash', option1 & OPT1_TURBO_WASH ? 'ON' : 'OFF')
                this.publishProperty('crease_care', option1 & OPT1_CREASE_CARE ? 'ON' : 'OFF')
                this.publishProperty('medic_rinse', option1 & OPT1_MEDIC_RINSE ? 'ON' : 'OFF')
                this.publishProperty('pre_wash', option1 & OPT1_PRE_WASH ? 'ON' : 'OFF')
                this.publishProperty('steam', option1 & OPT1_STEAM ? 'ON' : 'OFF')
                this.publishProperty('tub_clean_count', tub_clean_count)
                this.publishProperty('remote_start', option2 & OPT2_REMOTE_START ? 'ON' : 'OFF')
                this.publishProperty('door_lock', !(option2 & OPT2_DOOR_LOCK) ? 'ON' : 'OFF') // lock class: ON = unlocked
                this.publishProperty('child_lock', option2 & OPT2_CHILD_LOCK ? 'ON' : 'OFF')
                this.publishProperty('standby', standby ? 'ON' : 'OFF')
                this.publishProperty('initial_time', time_initial)
                this.publishProperty('remaining_time', time_remain)
                this.publishProperty('reserve_time', reserve)
            }
        })
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    publishCache = new Map<string, string | number | undefined>()

    publishProperty(prop: string, value: string | number | undefined) {
        // has() first: an undefined value on a never-published property must still go out
        if (this.publishCache.has(prop) && this.publishCache.get(prop) === value) return

        this.publishCache.set(prop, value)
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.thinq.send({ Cmd: 'Control', CmdOpt: 'Power', Value: 'On', Format: 'B64', Data: '' })
            } else if (mqttValue === 'OFF') {
                this.thinq.send({ Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' })
            }
        }
        if (prop === 'pause')
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' })
        if (prop === 'start')
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Start', Format: 'B64', Data: mqttValue })
    }
}
