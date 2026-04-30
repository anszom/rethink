import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'
import { ERRORS, STATES, COURSES, TEMPERATURES, SPINS, DRYING_MODES } from './washer_common'

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
                        options: STATES.filter((a) => a !== undefined),
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
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

        thinq.on('data', (buf) => {
            if (buf.length == 28) {
                const status = buf[0]
                const time_remain = buf[1] * 60 + buf[2]
                const time_initial = buf[3] * 60 + buf[4]
                const native_course = buf[5]
                const error = buf[6]
                const spin = buf[8]
                const temp = buf[9]
                const drying_mode = buf[11]
                const lock_status = buf[15]
                const custom_course = buf[20]
                const cycles = buf[21]

                this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
                this.publishProperty('error_message', ERRORS[error] ?? 'unknown') // publish message before set error state
                this.publishProperty('error', error ? 'ON' : 'OFF')
                this.publishProperty('status', STATES[status] ?? 'unknown')
                this.publishProperty('course', COURSES[custom_course] ?? COURSES[native_course] ?? 'unknown')
                this.publishProperty('spin', SPINS[spin] ?? 'unknown')
                this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown')
                this.publishProperty('drying_mode', DRYING_MODES[drying_mode] ?? 'unknown')
                this.publishProperty('cycles', cycles)
                this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
                this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
                this.publishProperty('initial_time', time_initial)
                this.publishProperty('remaining_time', time_remain)
            }
        })
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return

        this.publishCache[prop] = value
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
