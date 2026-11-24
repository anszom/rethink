import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { freezerRange, Status, fridgeRange, packStatus, unpackStatus, TemperatureUnit } from './fridge_common'
import { Enum } from '@/util/enum'

// The temperature in fahrenheit is like the other fridges but for some reason the celsius temperature is unique

// TODO: this is proably a very bad way of implementing this and it should be fixed
const fridge_setpoint_c_mapping: Record<number, number> = {
    1: 7,
    2: 6,
    3: 5,
    5: 4,
    7: 3,
    9: 2,
    11: 1,
}

const fridge_setpoint_c_reverse_mapping = Object.fromEntries(
    Object.entries(fridge_setpoint_c_mapping).map(([val, c]) => [c, Number(val)]),
) as Record<number, number>

const freezer_setpoint_c_mapping: Record<number, number> = {
    1: -15,
    3: -16,
    5: -17,
    7: -18,
    9: -19,
    10: -20,
    11: -21,
    12: -22,
    13: -23,
}

const freezer_setpoint_c_reverse_mapping = Object.fromEntries(
    Object.entries(freezer_setpoint_c_mapping).map(([val, c]) => [c, Number(val)]),
) as Record<number, number>

function convertFridgeTemperature(temperatureUnit: TemperatureUnit, input: number) {
    if (temperatureUnit === 'F') return 44 - input
    else return fridge_setpoint_c_mapping[input]
}

function convertFreezerTemperature(temperatureUnit: TemperatureUnit, input: number) {
    if (temperatureUnit === 'F') return 6 - input
    else return freezer_setpoint_c_mapping[input]
}

function unconvertFridgeTemperature(temperatureUnit: TemperatureUnit, input: number) {
    if (temperatureUnit === 'F') return 44 - input
    else return fridge_setpoint_c_reverse_mapping[input]
}

function unconvertFreezerTemperature(temperatureUnit: TemperatureUnit, input: number) {
    if (temperatureUnit === 'F') return 6 - input
    else return freezer_setpoint_c_reverse_mapping[input]
}

// Options Craft ice maker can be set to
const CRAFT_ICE_OPTIONS = Enum.of({
    '3 balls': 1,
    '6 balls': 2,
})

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
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
                    ice_plus: {
                        platform: 'switch',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-ice_plus',
                        state_topic: '$this/ice_plus',
                        command_topic: '$this/ice_plus/set',
                        name: 'Ice Plus',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    display_lock: {
                        platform: 'binary_sensor',
                        icon: 'mdi:lock',
                        unique_id: '$deviceid-display_lock',
                        state_topic: '$this/display_lock',
                        name: 'Display Lock',
                    },
                    sabbath_mode: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb-off',
                        unique_id: '$deviceid-sabbath_mode',
                        state_topic: '$this/sabbath_mode',
                        command_topic: '$this/sabbath_mode/set',
                        name: 'Sabbath Mode',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    craft_ice_mode: {
                        platform: 'select',
                        icon: 'mdi:tray-full',
                        unique_id: '$deviceid-craft_ice_mode',
                        state_topic: '$this/craft_ice_mode',
                        command_topic: '$this/craft_ice_mode/set',
                        name: 'Craft Ice Mode',
                        options: CRAFT_ICE_OPTIONS.options,
                    },
                },
            }),
        )
    }

    //  initial message needed for status reporting
    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
        console.log('start')
    }

    // fridge uses the format used by other fridges
    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x10, 26, this.processStatus)
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, status.freezerSetpoint))
        this.publishProperty('ice_plus', status.expressFreeze === 2 ? 'ON' : 'OFF')
        this.publishProperty('door', status.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('display_lock', status.displayLock === 1 ? 'ON' : 'OFF')
        this.publishProperty('sabbath_mode', status.sabbathMode === 1 ? 'ON' : 'OFF')
        this.publishProperty('craft_ice_mode', CRAFT_ICE_OPTIONS.map(status.craftIce))

        // TODO: implement reading the filters status
        // this.publishProperty('fresh_air_filter', status.freshAirFilter)
        // this.publishProperty('water_filter', status.waterFilter)
    }

    sendSetting(setting: Partial<Status>) {
        this.send(Buffer.concat([Buffer.from('F017', 'hex'), packStatus(setting, 41)]))
    }

    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'C'

        let setting: Partial<Status> = {
            tempUnit: unit === 'C' ? 1 : 0,
        }

        if (prop === 'fridge_setpoint') {
            setting.fridgeSetpoint = unconvertFridgeTemperature(unit, Number(mqttValue))
            this.sendSetting(setting)
        } else if (prop === 'freezer_setpoint') {
            setting.freezerSetpoint = unconvertFreezerTemperature(unit, Number(mqttValue))
            this.sendSetting(setting)
        } else if (prop === 'ice_plus') {
            setting.expressFreeze = mqttValue === 'ON' ? 2 : 1
            this.sendSetting(setting)
        } else if (prop === 'sabbath_mode') {
            setting.sabbathMode = mqttValue === 'ON' ? 1 : 0
            this.sendSetting(setting)
        } else if (prop === 'craft_ice_mode') {
            setting.craftIce = CRAFT_ICE_OPTIONS.unmap(mqttValue)
            this.sendSetting(setting)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
