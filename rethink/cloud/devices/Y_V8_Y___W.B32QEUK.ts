import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES } from './washer_common'

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
                        name: 'Power',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Current status',
                        options: STATES.filter((a) => a !== undefined),
                    },
                    error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        options: ERRORS.filter((a) => a !== undefined),
                    },
                    operation: {
                        platform: 'select',
                        unique_id: '$deviceid-operation',
                        command_topic: '$this/operation/set',
                        name: 'Operation',
                        options: ['start', 'stop', 'pause', 'power_off', 'wake_up'],
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycle count',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock', // inverted logic, off=locked
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

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 53 && buf[0] == 0x20) {
            const status = buf[15]
            const time_remain = buf[16] * 60 + buf[17]
            const time_initial = buf[18] * 60 + buf[19]
            const error = buf[21]
            const lock_status = buf[30]
            const cycles = buf[36]

            this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[status] ?? 'unknown')
            this.publishProperty('error', ERRORS[error] ?? 'unknown')
            this.publishProperty('cycles', cycles)
            this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
            this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
            this.publishProperty('remaining_time', time_remain)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power' && mqttValue === 'OFF') {
            // only power-off is supported
            this.send(Buffer.from('f024010100', 'hex'))
        }

        if (prop === 'operation') {
            // options: [ 'start', 'stop', 'power_off', 'wake_up' ]
            if (mqttValue === 'start') {
                // this op. is complex, it needs to supply the full configuration
                console.warn('not supported yet')
            }

            // this is actually 'pause'
            if (mqttValue === 'stop') this.send(Buffer.from('F024040100', 'hex'))

            if (mqttValue === 'power_off') this.send(Buffer.from('f024010100', 'hex'))

            if (mqttValue === 'wake_up') this.send(Buffer.from('F02A0100', 'hex'))
        }
    }
}
