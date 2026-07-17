import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { freezerRange, fridgeRange } from './fridge_common'

// 2REF12EII_P_2 - LG ThinQ Refrigerator
// Protocol derived from live capture (my_fridge_study.jsonl, my_fridge_study2.jsonl, my_fridge_study_pure_n_fresh.jsonl).
//
// 0x10EC: [cmd 2B][prev status 9B][cur status 9B], buf.length === 20
//   Status block: [type][fridge raw][freezer raw][expressFreeze 1=off 2=on][pureNFresh 1=off 2=auto 3=power][...4B reserved?]
//   Fridge: C = 7 - raw   (verified: raw 2->5C, raw 5->2C, raw 4->3C)
//   Freezer: C = -(raw + 15)   (verified: raw 3->-18C, raw 4->-19C)
//   Pure N Fresh: raw 1=OFF, 2=AUTO, 3=POWER   (verified against live capture)
// 0x10A8: [cmd 2B][type][door 0=closed 2=open], buf.length === 4
// 0xF017 command (43-byte body): byte[3]=fridge, byte[4]=freezer, byte[5]=expressFreeze, byte[6]=pureNFresh, byte[10]=ack
//   All values verified against live captures: each property writes to a single specific index,
//   temperature changes additionally set byte[10] as ack flag (0x01).
//   Only the fridge_setpoint template has extra ff bytes for alignment; device tolerates this.

const PURE_OPTIONS = ['Automatic', 'Power', 'Off']
const PURE_RAW_MAP: Record<string, number> = {
    Automatic: 0x02,
    Power: 0x03,
    Off: 0x01,
}
const PURE_RAW_TO_NAME: Record<number, string> = {
    0x01: 'Off',
    0x02: 'Automatic',
    0x03: 'Power',
}

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
                    pure_option: {
                        platform: 'select',
                        icon: 'mdi:air-filter',
                        unique_id: '$deviceid-pure_option',
                        state_topic: '$this/pure_option',
                        command_topic: '$this/pure_option/set',
                        name: 'Pure N Fresh',
                        options: PURE_OPTIONS,
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
        // curStatus is 9 bytes: [type][fridge_raw][freezer_raw][expressFreeze][pureNFresh][...4B]
        const fridgeTemp = 7 - curStatus[1] // Inverted encoding: C = 7 - raw (verified against live capture)
        const freezerRaw = curStatus[2]
        // Freezer encoding verified against cloud (my_fridge_study2.jsonl):
        //   raw 3 -> -18C, raw 4 -> -19C  ->  C = -(raw + 15)
        const freezerTemp = -(freezerRaw + 15)
        const expressOn = curStatus[3] === 0x02
        const pureNFreshRaw = curStatus[4]
        const pureNFreshName = PURE_RAW_TO_NAME[pureNFreshRaw] ?? 'Automatic'

        this.publishProperty('fridge_setpoint', fridgeTemp)
        this.publishProperty('freezer_setpoint', freezerTemp)
        this.publishProperty('express_freeze', expressOn ? 'ON' : 'OFF')
        this.publishProperty('pure_option', pureNFreshName)
    }

    setProperty(prop: string, mqttValue: string) {
        const baseMessage = Buffer.from(
            'f017ffffffffffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff',
            'hex',
        )

        if (prop === 'fridge_setpoint') {
            // Inverted encoding: raw = 7 - C
            baseMessage[3] = 7 - Math.round(Number(mqttValue))
            baseMessage[10] = 0x01 // Ack flag required for temperature changes
            this.send(baseMessage)
        } else if (prop === 'freezer_setpoint') {
            // Inverse of status formula: raw = -(C + 15)
            baseMessage[4] = -(Math.round(Number(mqttValue)) + 15)
            baseMessage[10] = 0x01
            this.send(baseMessage)
        } else if (prop === 'express_freeze') {
            // body[5]: 0x02 = ON, 0x01 = OFF
            const on = mqttValue === 'ON' || mqttValue === 'true'
            baseMessage[5] = on ? 0x02 : 0x01
            this.send(baseMessage)
        } else if (prop === 'pure_option') {
            // body[6] = mode value: 0x01 = Off, 0x02 = Automatic, 0x03 = Power
            // Verified against live capture (my_fridge_study_pure_n_fresh.jsonl): value at index 6, no ack flag needed
            const rawValue = PURE_RAW_MAP[mqttValue]
            if (rawValue !== undefined) {
                baseMessage[6] = rawValue
                this.send(baseMessage)
            } else {
                console.warn(`[${this.id}] Invalid Pure N Fresh value: ${mqttValue}`)
            }
        } else {
            console.warn(`[${this.id}] Unknown property ${prop}`)
        }
    }
}
