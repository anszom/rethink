import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { freezerRange, fridgeRange, unpackStatus } from './fridge_common'

// 2REF12EII_P_2 - LG ThinQ Refrigerator
// Protocol derived from live capture
//
// 0x10EC: [cmd 2B][prev status 9B][cur status 9B], buf.length === 20
//   Status fields defined in fridge_common.ts STATUS_FIELDS (first 9 indices):
//     [0]monStatus [1]fridgeSetpoint [2]freezerSetpoint [3]expressFreeze
//     [4]freshAirFilter [5]smartSaving [6]waterFilter [7]anyDoorOpen [8]tempUnit
//   Fridge: C = 7 - raw   (verified: raw 2->5C, raw 5->2C, raw 4->3C)
//   Freezer: C = -(raw + 15)   (verified: raw 3->-18C, raw 4->-19C)
//   Pure N Fresh: raw 1=OFF, 2=AUTO, 3=POWER, 4=replace   (verified against live capture + wiki)
// 0x10A8: [cmd 2B][door_type 1B][state 1B]: buf.length === 4, state: 0x00=closed, 0x01=open (secondary source)
// 0xF017 command (43-byte body): byte[3]=fridge, byte[4]=freezer, byte[5]=expressFreeze,
//   byte[6]=pureNFresh, byte[10]=tempUnit (C=0x01 on temp changes — was mislabeled "ack flag").
//   Temperature formulas are device-specific; the generic convert*() helpers from fridge_common use different constants.

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
                    pure_n_fresh_replace: {
                        platform: 'sensor',
                        icon: 'mdi:alert-circle-outline',
                        unique_id: '$deviceid-pure_n_fresh_replace',
                        state_topic: '$this/pure_n_fresh_replace',
                        entity_category: 'diagnostic',
                        name: 'Pure N Fresh Replace',
                    },
                    water_filter: {
                        platform: 'sensor',
                        icon: 'mdi:water',
                        unique_id: '$deviceid-water_filter',
                        state_topic: '$this/water_filter',
                        unit_of_measurement: 'months',
                        entity_category: 'diagnostic',
                        name: 'Water Filter',
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

    start() {
        // Request initial status so all entities (including pure_n_fresh_replace and water_filter) are populated at boot.
        // Without this, the device only sends 10AF keepalives until the first user command, leaving entities undefined.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 20 && buf[0] == 0x10 && buf[1] == 0xec) {
            // [cmd 2B][prev status 9B][cur status 9B]
            this.processStatus(buf.subarray(2 + 9, 2 + 9 + 9))
        }
        if (buf.length === 2 + 9 && buf[0] == 0x10 && buf[1] == 0xeb) {
            // [cmd 2B][initial status 9B] — initial-status push from F0ED query
            this.processStatus(buf.subarray(2, 2 + 9))
        }
        if (buf.length === 4 && buf[0] == 0x10 && buf[1] == 0xa8) {
            // Door update: [cmd][door_type][state]
            // state: 0x00 = CLOSED, 0x01 = OPEN
            const doorOpen = buf[3] === 0x01
            this.publishProperty('door', doorOpen ? 'ON' : 'OFF')
        }
    }

    processStatus(curStatus: Buffer) {
        // Use named fields from fridge_common STATUS_FIELDS instead of raw byte offsets
        const status = unpackStatus(curStatus)

        // Temperature formulas are device-specific (different constants than convert*() helpers)
        const fridgeTemp = 7 - status.fridgeSetpoint!
        const freezerTemp = -(status.freezerSetpoint! + 15)
        const expressOn = status.expressFreeze! === 0x02
        const pureNFreshName = PURE_RAW_TO_NAME[status.freshAirFilter!] ?? 'Automatic'

        this.publishProperty('fridge_setpoint', fridgeTemp)
        this.publishProperty('freezer_setpoint', freezerTemp)
        this.publishProperty('express_freeze', expressOn ? 'ON' : 'OFF')
        this.publishProperty('pure_option', pureNFreshName)
        // Door state from status block (byte[7] = anyDoorOpen) so it is correct at startup
        this.publishProperty('door', status.anyDoorOpen === 0x01 ? 'ON' : 'OFF')
        // Pure N Fresh replace indicator: byte[4] = 0x04 means filter needs replacing
        this.publishProperty('pure_n_fresh_replace', status.freshAirFilter === 0x04 ? 'replace' : 'OK')
        // Water filter: raw month counter from byte[6] (see wiki 2RES1VE61NFA2 status block)
        this.publishProperty('water_filter', status.waterFilter!.toString())
    }

    setProperty(prop: string, mqttValue: string) {
        const baseMessage = Buffer.from(
            'f017ffffffffffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff',
            'hex',
        )

        if (prop === 'fridge_setpoint') {
            // Inverted encoding: raw = 7 - C
            baseMessage[3] = 7 - Math.round(Number(mqttValue))
            baseMessage[10] = 0x01 // tempUnit (C=0x01 on temp changes — live captures show body[10], not body[8])
            this.send(baseMessage)
        } else if (prop === 'freezer_setpoint') {
            // Inverse of status formula: raw = -(C + 15)
            baseMessage[4] = -(Math.round(Number(mqttValue)) + 15)
            baseMessage[10] = 0x01 // tempUnit (C=0x01 on temp changes — live captures show body[10], not body[8])
            this.send(baseMessage)
        } else if (prop === 'express_freeze') {
            // body[5]: 0x02 = ON, 0x01 = OFF
            const on = mqttValue === 'ON' || mqttValue === 'true'
            baseMessage[5] = on ? 0x02 : 0x01
            this.send(baseMessage)
        } else if (prop === 'pure_option') {
            // body[6] = mode value: 0x01 = Off, 0x02 = Automatic, 0x03 = Power
            // Verified against live capture: value at index 6, no ack flag needed
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
