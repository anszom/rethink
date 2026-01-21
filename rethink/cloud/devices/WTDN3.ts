import HADevice from './base.js'
import { Device as Thinq1Device } from "../thinq1/devmgr.js"
import { type Connection } from '../homeassistant.js'
import { allowExtendedType } from '../../util/util.js'
import { Metadata } from '../thinq.js'

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
                    name: 'Power',
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
                    name: 'Remote start'
                },
                door_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-door_lock',
                    state_topic: '$this/door_lock',
                    name: 'Door lock',
                    device_class: 'lock' // inverted logic, off=locked
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

        thinq.on('data', (buf) => {
            if(buf.length == 28) {
                const status = buf[0]
                const tremain = buf[11] * 60 + buf[12]
                const tinitial = buf[13] * 60 + buf[14]
                const error = buf[6];
                const flags1 = buf[15];
                const cycles = buf[21];

                this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
                //this.publishProperty('status', STATES[status] ?? 'unknown_status')
                //this.publishProperty('error', ERRORS[error] ?? 'unknown_error')
                this.publishProperty('cycles', cycles)
                this.publishProperty('remote_start', (flags1 & 2) ? 'ON': 'OFF')
                this.publishProperty('door_lock', !(flags1 & 0x40) ? 'ON': 'OFF') // inverted logic, off=locked
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
        if(prop === 'power' && mqttValue === 'OFF') {
            this.thinq.send({ Cmd:"Control", CmdOpt:"Power", Value:"Off", Format:"B64", Data:""})
        }
    }
}