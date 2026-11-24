import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { freezerRange, fridgeRange } from './fridge_common'

// 2REF11EBIVPC4 - LG ThinQ Refrigerator (Israeli market)
// Always Celsius, 43-byte status block, Shabbat mode supported.
//
// Closely related to 2REF11EIDA__4 but with:
//   - Smaller 43-byte status block (vs 68 bytes): no flex drawer, no ice maker, no panel lock
//   - Always Celsius (no temperature unit detection needed)
//   - Shabbat mode at status/command byte [14]
//   - No startup query needed — device self-reports on connect
//
// F017 payload offsets (0-indexed, after F017 cmd bytes, 0xFF = leave unchanged):
//   [1]  fridge temp raw
//   [2]  freezer temp raw
//   [3]  express freeze: 0x01=off 0x02=on
//   [8]  zone selector: 0x01 (required with fridge/freezer commands, NOT shabbat)
//   [14] shabbat: 0x00=off 0x01=on
//
// 10EC status block offsets (43 bytes, 0-indexed):
//   [1]  fridge temp raw
//   [2]  freezer temp raw
//   [3]  express freeze: 0x01=off 0x02=on
//   [14] shabbat: 0x00=off 0x01=on
//
// NOTE on temperature encoding (checked on a real fridge by sweeping the raw values):
//   Status and commands share one encoding, 2 raw units per degree, so the 8-C and -14-C
//   conversions in fridge_common do not apply to this model:
//     fridge:  raw = 13 - 2C    1°C -> 11 ... 6°C -> 1
//     freezer: raw = -2C - 29   -15°C -> 1 ... -21°C -> 13
//   Only odd raw values are real settings. Most even values snap to the next odd one, some
//   report half degrees, and values past the coldest setting wrap to the warmest one. The
//   usable range is also narrower than the common fridgeRange/freezerRange.

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
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
                        max: 6,
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange('C'),
                        min: -21,
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
                    shabbat_mode: {
                        platform: 'switch',
                        icon: 'mdi:candle',
                        unique_id: '$deviceid-shabbat_mode',
                        state_topic: '$this/shabbat_mode',
                        command_topic: '$this/shabbat_mode/set',
                        name: 'Shabbat Mode',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                },
            }),
        )
    }

    start() {
        // No startup query needed — device self-reports state on connect
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x10, 43, this.processStatus)
    }

    processStatus(curStatus: Buffer) {
        // See the note at the top of the file for the encoding.
        const setpointFridge = (13 - curStatus[1]) / 2
        const setpointFreezer = -(curStatus[2] + 29) / 2
        const anyDoorOpen = curStatus[7] === 1 // 0=closed, 1=open
        const expressFreezeOn = curStatus[3] === 2 // 1=off, 2=on
        const shabbatOn = curStatus[14] === 1 // 0=off, 1=on

        this.publishProperty('door', anyDoorOpen ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
        this.publishProperty('express_freeze', expressFreezeOn ? 'ON' : 'OFF')
        this.publishProperty('shabbat_mode', shabbatOn ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        // Base message: F017 + 118-byte payload, all 0xFF except fixed non-mask bytes.
        // Extracted verbatim from captured packets (device 86d19923-ac54-1688-afab-4427451643f4).
        const baseMessage = Buffer.from(
            'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
            'hex',
        )

        if (prop === 'fridge_setpoint') {
            baseMessage[2 + 1] = 13 - 2 * Number(mqttValue)
            baseMessage[2 + 8] = 1
            this.send(baseMessage)
        } else if (prop === 'freezer_setpoint') {
            baseMessage[2 + 2] = -2 * Number(mqttValue) - 29
            baseMessage[2 + 8] = 1
            this.send(baseMessage)
        } else if (prop === 'express_freeze') {
            baseMessage[2 + 3] = mqttValue === 'ON' ? 2 : 1
            this.send(baseMessage)
        } else if (prop === 'shabbat_mode') {
            baseMessage[2 + 14] = mqttValue === 'ON' ? 1 : 0
            this.send(baseMessage)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
