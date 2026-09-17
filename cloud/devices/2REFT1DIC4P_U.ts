import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import {
    convertFreezerTemperature,
    convertFridgeTemperature,
    freezerRange,
    fridgeRange,
    TemperatureUnit,
} from './fridge_common'

const STATUS_LENGTH = 68

// LG "F-Next6 Disp Craft Instaview" French-door fridge/freezer (InstaView window, in-door
// dispenser, auto + craft ice makers). Confirmed against a real unit by cross-referencing
// captured AA..BB traffic with the official LG cloud's decoded state (bridge mode +
// lgcloud-monitor.ts) - see tests/cloud/devices/2REFT1DIC4P_U.test.ts for the packets.
//
// Shares the exact same 68-byte status block layout as 2REF11EIDA__4 (see the wiki's
// Appliance:2REF11EIDA__4 page): byte 1 = fridge setpoint, byte 2 = freezer setpoint,
// byte 3 = express freeze, byte 7 = any-door-open. Only these four fields have been
// exercised/confirmed; the fridge also has an ice/water dispenser, two ice makers and an
// InstaView knock-to-light window, none of which are exposed here since their wire
// encoding hasn't been confirmed (the knock-to-light feature in particular never reaches
// the cloud at all - it's purely local to the appliance).
export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })

        // HomeAssistant configuration will be ready once we find out the temperature unit
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
        // set or re-set the temperature unit
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
                        ...fridgeRange(unit),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange(unit),
                    },
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        icon: 'mdi:snowflake',
                        name: 'Express Freeze',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // matching on length and the leading 0x10 marker, same as the other AABB fridges

        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] === 0x10 && buf[1] === 0xec) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        }

        if (buf.length === 2 + STATUS_LENGTH && buf[0] === 0x10 && buf[1] === 0xeb) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2, 2 + STATUS_LENGTH))
        }
    }

    processStatus(curStatus: Buffer) {
        const unit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const setpointFridge = convertFridgeTemperature(unit, curStatus[1])
        const setpointFreezer = convertFreezerTemperature(unit, curStatus[2])
        const expressFreeze = curStatus[3] // 1=off 2=on
        const anyDoorOpen = curStatus[7] // 1=open 0=closed, aggregated across all 4 doors

        this.publishProperty('door', anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
        this.publishProperty('express_freeze', expressFreeze === 2 ? 'ON' : 'OFF')
    }

    // The official LG app's own F017 command (captured via bridge mode) carries a batch of
    // extra non-0xFF filler bytes and an inconsistent length/checksum that doesn't match
    // its own framing - the fridge evidently doesn't validate checksums on incoming
    // commands. A plain 0xFF-filled status block (leaving byte 8, the temperature unit,
    // at 0xFF/unchanged) with the standard AABBDevice checksum was confirmed to work just
    // as well against a real unit - see tests/cloud/devices/2REFT1DIC4P_U.test.ts.
    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'C'
        const baseMessage = Buffer.alloc(STATUS_LENGTH, 0xff)

        if (prop === 'fridge_setpoint') {
            baseMessage[1] = convertFridgeTemperature(unit, Number(mqttValue))
            this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
        } else if (prop === 'freezer_setpoint') {
            baseMessage[2] = convertFreezerTemperature(unit, Number(mqttValue))
            this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
        } else if (prop === 'express_freeze') {
            baseMessage[3] = mqttValue === 'ON' ? 2 : 1
            this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
