import HADevice from './base.js'
import { Device as Thinq2Device } from "../thinq2/devmgr.js"
import { DeviceDiscovery, type Connection } from '../homeassistant.js'
import { type Metadata } from '../thinq.js'
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'
import { convertFreezerTemperature, convertFridgeTemperature, freezerRange, fridgeRange } from './fridge_common.js'

type TemperatureUnit = 'C' | 'F'

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, 'device', thinq)
        this.deviceConfig = HADevice.deviceConfig(meta, { name: "LG Fridge" })

        // HomeAssistant configuration will be ready once we find out the temperature unit
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if(this.temperatureUnit === unit)
            return

        this.temperatureUnit = unit
        // set or re-set the temperature unit
        this.setConfig(allowExtendedType({
            ...this.deviceConfig,
            components: {
                fridge_setpoint: {
                    platform: "number",
                    device_class: "temperature",
                    unique_id: '$deviceid-fridge_setpoint',
                    state_topic: '$this/fridge_setpoint',
                    command_topic: '$this/fridge_setpoint/set',
                    name: 'Fridge temperature',
                    ...fridgeRange(unit)
                },
                express_cool: {
                    platform: 'switch',
                    unique_id: '$deviceid-express_cool',
                    state_topic: '$this/express_cool',
                    command_topic: '$this/express_cool/set',
                    icon: "mdi:snowflake-variant",
                    name: 'Express Cool',
                },
                freezer_setpoint: {
                    platform: "number",
                    device_class: "temperature",
                    unique_id: '$deviceid-freezer_setpoint',
                    state_topic: '$this/freezer_setpoint',
                    command_topic: '$this/freezer_setpoint/set',
                    name: 'Freezer temperature',
                    ...freezerRange(unit)
                },
                express_freeze: {
                    platform: 'switch',
                    unique_id: '$deviceid-express_freeze',
                    state_topic: '$this/express_freeze',
                    command_topic: '$this/express_freeze/set',
                    icon: "mdi:snowflake",
                    name: 'Express Freeze',
                },
                door: {
                    platform: "binary_sensor",
                    device_class: "door",
                    unique_id: '$deviceid-door',
                    state_topic: '$this/door',
                    name: "Door"
                }
            }
        }))
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // I'm not sure what is the proper way to identify packet types, so let's match
        // on the length and a few initial bytes

        if(buf.length === 2 + 27 * 2 && buf[0] == 0x10 && buf[1] == 0xEC) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + 27, 2+27+27))
        }

        if(buf.length === 2 + 27 && buf[0] == 0x10 && buf[1] == 0xEB) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2, 2+27))
        }
    }

    processStatus(curStatus: Buffer) {
        const s = unpackStatus(curStatus)
        this.setTemperatureUnit(s.tempUnit ? 'C' : 'F')
        this.publishProperty('door', s.anyDoorOpen ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', convertFridgeTemperature(this.temperatureUnit, s.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(this.temperatureUnit, s.freezerSetpoint))
        this.publishProperty('express_cool', s.expressCool===1 ? 'ON' : 'OFF')
        this.publishProperty('express_freeze', s.expressCool===2 ? 'ON' : 'OFF')
    }

    sendSetting(setting: Partial<Status>) {
        this.send(Buffer.concat([ Buffer.from('F017', 'hex'), packStatus(setting) ]))
    }

    setProperty(prop: string, mqttValue: string) {
        let setting: Partial<Status> = {
            tempUnit: this.temperatureUnit === 'C' ? 1 : 0,
        }

        if(prop === 'fridge_setpoint') {
            setting.fridgeSetpoint = convertFridgeTemperature(this.temperatureUnit, Number(mqttValue))
            this.sendSetting(setting)

        } else if(prop === 'freezer_setpoint') {
            setting.freezerSetpoint = convertFreezerTemperature(this.temperatureUnit, Number(mqttValue))
            this.sendSetting(setting)

        } else if(prop === 'express_cool') {
            setting.expressCool = mqttValue === 'ON' ? 1 : 0
            this.sendSetting(setting)

        } else if(prop === 'express_freeze') {
            setting.expressCool = mqttValue === 'ON' ? 2 : 1
            this.sendSetting(setting)
        }
    }
}

const STATUS_FIELDS = [
    'monStatus',
    'fridgeSetpoint',     // 44-F or 8-C
    'freezerSetpoint',    // 6-F or -14-C
    'expressFreeze',      // 1=off 2=on
    'freshAirFilter',
    'smartSaving',
    'waterFilter',
    'anyDoorOpen',        // 0=closed 1=open
    'tempUnit',           // 0=fahrenheit 1=celsius
    'smartSavingRun',
    'displayLock',
    'activeSaving',
    'ecoFriendly',
    'convertibleTemp',
    'sabbathMode',
    'dualFridge',
    'expressCool',        // 0=off 1=on
    'smartCare',          // 0=off 1=on
    'drawerMode',
    'pantryMode',
    'voiceMode',
    'dispenserMode',
    'dispenserCapacity',
    'dispenserUnit',
    'selfCare',
    'craftIce',
    'monDataNumber'
] as const

type Status = Record<typeof STATUS_FIELDS[number],number>;

function unpackStatus(buf: Buffer): Status {
    let rv = {} as Status
    STATUS_FIELDS.forEach((key, index) => {
        rv[key] = buf[index]
    })

    return rv
}

function packStatus(status: Partial<Status>): Buffer {
    const rv = Buffer.alloc(STATUS_FIELDS.length, 0xff)
    STATUS_FIELDS.forEach((key, index) => {
        if(status[key] !== undefined) 
            rv[index] = status[key]
    })
    return rv
}