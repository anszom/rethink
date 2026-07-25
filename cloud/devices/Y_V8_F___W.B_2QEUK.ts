import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES, COURSES, TEMPERATURES, SPINS, DRYING_MODES } from './washer_common'

// LG W4WR70E61 washer/dryer combo (article F4Y7ERP1W.ABWQPDG).
// Control commands are identical to F_V8_Y___W.B_2QEUK / Y_V8_Y___W.B32QEUK, but the status
// frame layout differs: status frames come as a 53-byte single block (status block at offset
// 15) or a 92-byte double block (previous + current state, current block at offset 54).
// Field offsets are documented on the wiki page Appliance:Y_V8_F___W.B_2QEUK.
export default class Device extends AABBDevice {
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
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.filter((a) => a !== undefined),
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
                        options: ERRORS.filter((a) => a !== undefined),
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
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                        value_template: "{{ value if value | is_number else 'None' }}",
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
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return

        // 79-byte configuration frame (buf[8] == 0x02) carries the wash cycle counter
        if (buf[8] === 0x02 && buf.length === 79) {
            this.publishProperty('cycles', buf[19])
            return
        }
        if (buf[8] !== 0x01) return

        const S = buf.length > 73 ? 54 : 15
        if (buf.length <= S + 19) return

        const status = buf[S]
        const remaining = buf[S + 1] * 60 + buf[S + 2]
        const initial = buf[S + 3] * 60 + buf[S + 4]
        const course = buf[S + 5]
        const error = buf[S + 6]
        const spin = buf[S + 8]
        const temp = buf[S + 9]
        const drying = buf[S + 11]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS[error] ?? 'unknown') // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES[status] ?? 'unknown')
        this.publishProperty('course', COURSES[course] ?? 'unknown')
        this.publishProperty('spin', SPINS[spin] ?? 'unknown')
        this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown')
        this.publishProperty('drying_mode', DRYING_MODES[drying] ?? 'unknown')
        // NB: on this variant remote-start is bit 0x40 of S+15 (V8_Y carries it in bit 0x02 of the lock byte)
        this.publishProperty('remote_start', buf[S + 15] & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', !(buf[S + 19] & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
        this.publishProperty('initial_time', initial)
        this.publishProperty('remaining_time', remaining)
        // per-cycle energy counter (Wh); not present in the shorter frame variants
        if (buf.length > S + 29) this.publishProperty('energy', buf[S + 28] * 256 + buf[S + 29])
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
        if (prop === 'start') this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))
    }
}
