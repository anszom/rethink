import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import {
    ERRORS,
    STATES,
    COURSES as SHARED_COURSES,
    TEMPERATURES,
    SPINS,
    DOSES,
    SMART_COURSES,
    RINSES,
} from './washer_common'
import AABBDevice from './aabb_device'
import crc16 from '@/util/crc16'

// This model reports a course code differently from the shared table, so start from
// SHARED_COURSES.forward (aliases already flattened to one code each) and override just that code.
const COURSES = new Enum(
    Object.entries({ ...SHARED_COURSES.forward, 0x3a: 'AI Wash' }).map(([code, label]): [string, number] => [
        label,
        Number(code),
    ]),
)

const STATUS_LENGTH = 39

// The range the LG app allows for both ezDispense amounts
const EZDISPENSE_MIN = 9
const EZDISPENSE_MAX = 150

function parseEzDispense(value: string) {
    if (value.trim() === '') return undefined

    const ml = Number(value)
    return Number.isInteger(ml) && ml >= EZDISPENSE_MIN && ml <= EZDISPENSE_MAX ? ml : undefined
}

export default class Device extends AABBDevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq, true)

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
                    },
                    downloaded_program: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_program',
                        state_topic: '$this/downloaded_program',
                        name: 'Downloaded program',
                        icon: 'mdi:download',
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
                        icon: 'mdi:water-sync',
                        device_class: 'enum',
                        options: RINSES.options,
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycles since Drum Clean',
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
                    delay_end: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_end',
                        state_topic: '$this/delay_end',
                        name: 'Delay end',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                        suggested_display_precision: 0,
                    },
                    detergent: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent',
                        state_topic: '$this/detergent',
                        name: 'Detergent dose',
                        icon: 'mdi:cup',
                        device_class: 'enum',
                        options: DOSES.options,
                    },
                    softener: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener',
                        state_topic: '$this/softener',
                        name: 'Softener dose',
                        icon: 'mdi:cup-outline',
                        device_class: 'enum',
                        options: DOSES.options,
                    },
                    ezdispense_detergent: {
                        platform: 'number',
                        unique_id: '$deviceid-ezdispense_detergent',
                        state_topic: '$this/ezdispense_detergent',
                        command_topic: '$this/ezdispense_detergent/set',
                        name: 'ezDispense detergent amount',
                        icon: 'mdi:cup',
                        unit_of_measurement: 'mL',
                        min: EZDISPENSE_MIN,
                        max: EZDISPENSE_MAX,
                        step: 1,
                        mode: 'box',
                        entity_category: 'config',
                    },
                    ezdispense_softener: {
                        platform: 'number',
                        unique_id: '$deviceid-ezdispense_softener',
                        state_topic: '$this/ezdispense_softener',
                        command_topic: '$this/ezdispense_softener/set',
                        name: 'ezDispense softener amount',
                        icon: 'mdi:cup-outline',
                        unit_of_measurement: 'mL',
                        min: EZDISPENSE_MIN,
                        max: EZDISPENSE_MAX,
                        step: 1,
                        mode: 'box',
                        entity_category: 'config',
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
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    dispenser_drawer: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dispenser_drawer',
                        state_topic: '$this/dispenser_drawer',
                        name: 'Dispenser drawer',
                        device_class: 'opening',
                    },
                },
            }),
        )
    }

    processData(buf: Buffer) {
        if (this.verify_frame_valid(buf)) {
            super.processData(buf)
        }
    }

    verify_frame_valid(buf: Buffer) {
        const computed_check_sum = crc16(buf.subarray(0, buf.length - 3))
        const received_check_sum = (buf[buf.length - 3] << 8) | buf[buf.length - 2]
        return received_check_sum == computed_check_sum
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processEnvelopedStatus(buf, 0x20, STATUS_LENGTH, this.processStatus)
    }

    processStatus(rec: Buffer) {
        const status = rec[2]
        const time_remain_hours = rec[3]
        const time_remain_minutes = rec[4]
        const time_start_hours = rec[5]
        const time_start_minutes = rec[6]
        const course = rec[7]
        const error = rec[8]
        const spin = rec[10]
        const temp = rec[11]
        const rinse = rec[12]
        const delay_end = rec[14]
        const options = rec[16]
        const lock_status = rec[17]
        const selected_downloaded_program = rec[22]
        const cycles = rec[23]
        const downloaded_program = rec[25]
        const energy = rec[30] * 256 + rec[31]
        const detergent = rec[32]
        const softener = rec[33]
        const ezdispense_detergent = rec[34]
        const ezdispense_softener = rec[35]
        // bit 2 stays set while the drawer is open; bit 6 pulses on and off meanwhile, meaning unknown
        const dispenser_status = rec[37]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(status))
        this.publishProperty(
            'course',
            selected_downloaded_program ? SMART_COURSES.map(selected_downloaded_program) : COURSES.map(course),
        )
        this.publishProperty('downloaded_program', SMART_COURSES.map(downloaded_program))
        this.publishProperty('spin', SPINS.map(spin))
        this.publishProperty('temp', TEMPERATURES.map(temp))
        this.publishProperty('rinse', RINSES.map(rinse))
        this.publishProperty('cycles', cycles)
        this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
        this.publishProperty('child_lock', lock_status & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('initial_time', time_start_hours * 60 + time_start_minutes)
        this.publishProperty('remaining_time', time_remain_hours * 60 + time_remain_minutes)
        this.publishProperty('energy', energy)
        this.publishProperty('delay_end', delay_end)
        this.publishProperty('detergent', DOSES.map(detergent))
        this.publishProperty('softener', DOSES.map(softener))
        this.publishProperty('ezdispense_detergent', ezdispense_detergent)
        this.publishProperty('ezdispense_softener', ezdispense_softener)
        this.publishProperty('turbowash', options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('prewash', options & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('steam', options & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('dispenser_drawer', dispenser_status & 0x04 ? 'ON' : 'OFF')
    }

    setParameter(parameter: number, value: number) {
        this.send(Buffer.from([0xf0, 0x24, parameter, 0x01, value]))
    }

    setProperty(prop: string, mqttValue: string) {
        // Parameters set with F0 24 <parameter> 01 <value>
        const PARAMETERS = {
            POWER_OFF: 0x01,
            PAUSE: 0x04,
            START: 0x05,
            EZDISPENSE_DETERGENT: 0x0d, // ml per 5 kg of laundry
            EZDISPENSE_SOFTENER: 0x0e, // ml per 5 kg of laundry
        }

        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.setParameter(PARAMETERS.POWER_OFF, 0)
            }
        }

        if (prop === 'pause') this.setParameter(PARAMETERS.PAUSE, 0)

        if (prop === 'start') this.setParameter(PARAMETERS.START, 0)

        if (prop === 'ezdispense_detergent') {
            const ml = parseEzDispense(mqttValue)
            if (ml !== undefined) this.setParameter(PARAMETERS.EZDISPENSE_DETERGENT, ml)
        }

        if (prop === 'ezdispense_softener') {
            const ml = parseEzDispense(mqttValue)
            if (ml !== undefined) this.setParameter(PARAMETERS.EZDISPENSE_SOFTENER, ml)
        }
    }
}
