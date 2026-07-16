import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { freezerRange, fridgeRange } from './fridge_common'

// 2REF12EII_P_2 - LG ThinQ Refrigerator
// Protocol derived from live capture (my_fridge_study.jsonl, my_fridge_study2.jsonl).
//
// 0x10EC: [cmd 2B][prev status 9B][cur status 9B] → buf.length === 20
//   Status block: [type][fridge raw][freezer raw][expressFreeze 1=off 2=on][door 0=closed 1=open][...4B reserved?]
//   Fridge: °C = 7 - raw   (verified against live capture: raw 2→5°C, raw 5→2°C, raw 4→3°C)
//   Freezer: °C = -(raw + 15)   (verified: raw 3→-18°C, raw 4→-19°C)
// 0x10A8: [cmd 2B][type][door 0=closed 2=open] → buf.length === 4
// 0xF017 command (43-byte payload): byte[1]=fridge setpoint raw, byte[2]=freezer raw, byte[3]=express freeze, byte[8]=ack flag

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...fridgeRange('C'),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange('C'),
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    express_freeze: {
                        platform: 'switch',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Express Freeze',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                },
            }),
        )
    }

    start() {}

    processAABB(buf: Buffer) {
        if (buf.length === 20 && buf[0] == 0x10 && buf[1] == 0xec) {
            // [cmd 2B][prev status 9B][cur status 9B]
            this.processStatus(buf.subarray(2 + 9, 2 + 9 + 9))
        }
        if (buf.length === 4 && buf[0] == 0x10 && buf[1] == 0xa8) {
            // Door update: [cmd][type][door_state]
            // door_state: 0x00 = CLOSED, 0x02 = OPEN
            const doorOpen = buf[3] === 0x02
            this.publishProperty('door', doorOpen ? 'ON' : 'OFF')
        }
    }

    processStatus(curStatus: Buffer) {
        // curStatus is 9 bytes: [type][fridge_raw][freezer_raw][expressFreeze][door][...4B]
        const fridgeTemp = 7 - curStatus[1] // Inverted encoding: °C = 7 - raw (verified against live capture)
        const freezerRaw = curStatus[2]
        // Freezer encoding verified against cloud (my_fridge_study2.jsonl):
        //   raw 3 → -18°C, raw 4 → -19°C  →  °C = -(raw + 15)
        const freezerTemp = -(freezerRaw + 15)
        const expressOn = curStatus[3] === 0x02

        this.publishProperty('fridge_setpoint', fridgeTemp)
        this.publishProperty('freezer_setpoint', freezerTemp)
        this.publishProperty('express_freeze', expressOn ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        const baseMessage = Buffer.from(
            'f017ffffffffffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff',
            'hex',
        )

        if (prop === 'fridge_setpoint') {
            // Inverted encoding: raw = 7 - °C
            baseMessage[2 + 1] = 7 - Math.round(Number(mqttValue))
            baseMessage[2 + 8] = 0x01 // Ack flag required for temperature changes
            this.send(baseMessage)
        } else if (prop === 'freezer_setpoint') {
            // Inverse of status formula: raw = -(°C + 15)
            baseMessage[2 + 2] = -(Math.round(Number(mqttValue)) + 15)
            baseMessage[2 + 8] = 0x01
            this.send(baseMessage)
        } else if (prop === 'express_freeze') {
            // 0x02 = ON, 0x01 = OFF
            const on = mqttValue === 'ON' || mqttValue === 'true'
            baseMessage[2 + 3] = on ? 0x02 : 0x01
            this.send(baseMessage)
        } else {
            console.warn(`[${this.id}] Unknown property ${prop}`)
        }
    }
}
