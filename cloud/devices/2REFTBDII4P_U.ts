import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import AABBDevice from './aabb_device'
import {
    convertFreezerTemperature,
    convertFridgeTemperature,
    freezerRange,
    fridgeRange,
    type TemperatureUnit,
} from './fridge_common'

// 2REFTBDII4P_U - 68-byte AABB refrigerator status record.
//
// Confirmed 10EC status offsets (0-indexed within each 68-byte record):
//   [1]  fridge target: 8-C / 44-F
//   [2]  freezer target: -14-C / 6-F
//   [3]  express freeze: 1=off, 2=on
//   [4]  fresh-air filter: 0-2/4-6=good, 3=replace
//   [6]  water filter age in months: 0-5=good, 6-12=replace
//   [7]  any door open: 0=closed, 1=open
//   [8]  temperature unit: 0=F, 1=C
//   [27] fridge temperature status (modelJSON MonitoringValue.fridgeStatus)
//   [28] freezer temperature status (modelJSON MonitoringValue.freezerStatus)
//   [32] automatic ice maker: 0=off, 1=making, 2=full, 3=quiet mode
//
// F017 writes use the same offsets. Temperature writes additionally require
// status[8] to carry the current unit. The fixed bytes in BASE_SETTING were
// copied from commands captured from this appliance; 0xFF means unchanged.

const STATUS_LENGTH = 68

const ICE_MAKER_STATUS = Enum.of({
    Off: 0,
    'Making ice': 1,
    Full: 2,
    'Quiet mode': 3,
})

// The modelJSON deliberately presents the operating modes and month counters
// as the same two user-facing states that the ThinQ app shows.
const FRESH_AIR_FILTER_STATUS = Enum.of({
    Good: [0, 1, 2, 4, 5, 6],
    Replace: 3,
})

const WATER_FILTER_STATUS = Enum.of({
    Good: [0, 1, 2, 3, 4, 5],
    Replace: [6, 7, 8, 9, 10, 11, 12],
})

const TEMPERATURE_STATUS = Enum.of({
    Off: 0,
    'Well maintained': 1,
    'Very high': 2,
    High: 3,
    Low: 4,
    Stabilizing: 5,
    'Sensor error': 14,
    Uncertain: 15,
})

const BASE_SETTING =
    'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
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
                    fridge_temperature_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-fridge_temperature_status',
                        state_topic: '$this/fridge_temperature_status',
                        name: 'Fridge temperature status',
                        icon: 'mdi:thermometer-check',
                        options: TEMPERATURE_STATUS.options,
                    },
                    freezer_temperature_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-freezer_temperature_status',
                        state_topic: '$this/freezer_temperature_status',
                        name: 'Freezer temperature status',
                        icon: 'mdi:thermometer-check',
                        options: TEMPERATURE_STATUS.options,
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
                    ice_maker_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        unique_id: '$deviceid-ice_maker_status',
                        state_topic: '$this/ice_maker_status',
                        name: 'Ice maker status',
                        icon: 'mdi:ice-pop',
                        options: ICE_MAKER_STATUS.options,
                    },
                    fresh_air_filter_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-fresh_air_filter_status',
                        state_topic: '$this/fresh_air_filter_status',
                        name: 'Fresh air filter',
                        icon: 'mdi:air-filter',
                        options: FRESH_AIR_FILTER_STATUS.options,
                    },
                    water_filter_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-water_filter_status',
                        state_topic: '$this/water_filter_status',
                        name: 'Water filter',
                        icon: 'mdi:water-check',
                        options: WATER_FILTER_STATUS.options,
                    },
                    water_filter_months: {
                        platform: 'sensor',
                        entity_category: 'diagnostic',
                        unique_id: '$deviceid-water_filter_months',
                        state_topic: '$this/water_filter_months',
                        name: 'Water filter months',
                        icon: 'mdi:calendar-clock',
                        unit_of_measurement: 'months',
                        suggested_display_precision: 0,
                    },
                },
            }),
        )
    }

    start() {
        // Shared by the 68-byte AABB refrigerator family: request a complete state
        // so Home Assistant is populated immediately after reconnecting.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] === 0x10 && buf[1] === 0xec) {
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        }

        if (buf.length === 2 + STATUS_LENGTH && buf[0] === 0x10 && buf[1] === 0xeb) {
            this.processStatus(buf.subarray(2, 2 + STATUS_LENGTH))
        }
    }

    processStatus(status: Buffer) {
        const unit: TemperatureUnit = status[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, status[1]))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, status[2]))
        this.publishProperty('express_freeze', status[3] === 2 ? 'ON' : 'OFF')
        this.publishProperty('fresh_air_filter_status', FRESH_AIR_FILTER_STATUS.map(status[4]))
        this.publishProperty('water_filter_status', WATER_FILTER_STATUS.map(status[6]))
        this.publishProperty('water_filter_months', status[6] <= 12 ? status[6] : undefined)
        this.publishProperty('door', status[7] === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_temperature_status', TEMPERATURE_STATUS.map(status[27]))
        this.publishProperty('freezer_temperature_status', TEMPERATURE_STATUS.map(status[28]))
        this.publishProperty('ice_maker_status', ICE_MAKER_STATUS.map(status[32]))
    }

    setProperty(prop: string, mqttValue: string) {
        const unit = this.temperatureUnit || 'C'
        const setting = Buffer.from(BASE_SETTING, 'hex')

        if (prop === 'fridge_setpoint') {
            setting[2 + 1] = convertFridgeTemperature(unit, Number(mqttValue))
            setting[2 + 8] = unit === 'C' ? 1 : 0
            this.send(setting)
        } else if (prop === 'freezer_setpoint') {
            setting[2 + 2] = convertFreezerTemperature(unit, Number(mqttValue))
            setting[2 + 8] = unit === 'C' ? 1 : 0
            this.send(setting)
        } else if (prop === 'express_freeze') {
            setting[2 + 3] = mqttValue === 'ON' ? 2 : 1
            this.send(setting)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
