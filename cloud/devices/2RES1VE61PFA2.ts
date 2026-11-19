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
    packStatus,
    type Status,
    type TemperatureUnit,
    unpackStatus,
} from './fridge_common'

const STATUS_LENGTH = 27
// F017 writes are 41 bytes with captured zeros at 21/22/23/26/31; NFA2 packs the 27-byte status record.
const COMMAND_LENGTH = 41
const COMMAND_FIXED_OFFSETS = [21, 22, 23, 26, 31]
const DOOR_COMPARTMENTS: Record<number, string> = { 1: 'fridge_door', 2: 'freezer_door' }

// Descriptor-backed ThinQ mapping: 0..5 months Good, 6..12 Replace, 255 IGNORE.
const WATER_FILTER_STATUS = Enum.of({
    Good: [0, 1, 2, 3, 4, 5],
    Replace: [6, 7, 8, 9, 10, 11, 12],
})

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
        // Clear retained values until a door event or an all-closed status establishes the state.
        for (const compartment of Object.values(DOOR_COMPARTMENTS)) this.publishProperty(compartment, undefined)
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
                    express_cool: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_cool',
                        state_topic: '$this/express_cool',
                        command_topic: '$this/express_cool/set',
                        icon: 'mdi:snowflake-variant',
                        name: 'Express Cool',
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
                    fridge_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-fridge_door',
                        state_topic: '$this/fridge_door',
                        name: 'Fridge door',
                    },
                    freezer_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-freezer_door',
                        state_topic: '$this/freezer_door',
                        name: 'Freezer door',
                    },
                    smart_learner: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-smart_learner',
                        state_topic: '$this/smart_learner',
                        name: 'Smart Learner',
                        icon: 'mdi:brain',
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
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 4 && buf[0] === 0x10 && buf[1] === 0xa8) {
            const compartment = DOOR_COMPARTMENTS[buf[2]]
            if (compartment && (buf[3] === 0 || buf[3] === 1)) {
                this.publishProperty(compartment, buf[3] === 1 ? 'ON' : 'OFF')
            }
            return
        }
        this.processCommonStatus(buf, 0x10, STATUS_LENGTH, this.processStatus)
    }

    processStatus(curStatus: Buffer) {
        const s = unpackStatus(curStatus)
        const unitIsValid = s.tempUnit === 0 || s.tempUnit === 1

        if (unitIsValid) {
            this.setTemperatureUnit(s.tempUnit === 1 ? 'C' : 'F')
        } else {
            this.temperatureUnit = undefined
        }

        if (this.config) {
            this.publishProperty('door', s.anyDoorOpen === 0 ? 'OFF' : s.anyDoorOpen === 1 ? 'ON' : undefined)
            const unit = this.temperatureUnit
            this.publishProperty(
                'fridge_setpoint',
                unit ? this.temperature(s.fridgeSetpoint, convertFridgeTemperature, fridgeRange(unit)) : undefined,
            )
            this.publishProperty(
                'freezer_setpoint',
                unit ? this.temperature(s.freezerSetpoint, convertFreezerTemperature, freezerRange(unit)) : undefined,
            )
        }

        // An open aggregate cannot identify a side; closed also recovers a missed close event.
        if (s.anyDoorOpen === 0) {
            for (const compartment of Object.values(DOOR_COMPARTMENTS)) this.publishProperty(compartment, 'OFF')
        }

        this.publishProperty('express_cool', s.expressCool === 0 ? 'OFF' : s.expressCool === 1 ? 'ON' : undefined)
        this.publishProperty('express_freeze', s.expressFreeze === 1 ? 'OFF' : s.expressFreeze === 2 ? 'ON' : undefined)
        // Enablement only; this does not indicate whether AI Fresh or energy saving is running.
        this.publishProperty('smart_learner', s.smartCare === 0 ? 'OFF' : s.smartCare === 1 ? 'ON' : undefined)
        this.publishProperty('water_filter_months', s.waterFilter <= 12 ? s.waterFilter : undefined)
        this.publishProperty('water_filter_status', WATER_FILTER_STATUS.map(s.waterFilter))
    }

    temperature(
        raw: number,
        convert: (unit: TemperatureUnit, value: number) => number,
        range: { min: number; max: number },
    ) {
        if (raw === 0xff) return undefined
        const value = convert(this.temperatureUnit!, raw)
        return value >= range.min && value <= range.max ? value : undefined
    }

    sendSetting(setting: Partial<Status>) {
        const payload = packStatus(setting, COMMAND_LENGTH)
        for (const offset of COMMAND_FIXED_OFFSETS) payload[offset] = 0
        this.send(Buffer.concat([Buffer.from('F017', 'hex'), payload]))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'express_cool' || prop === 'express_freeze') {
            if (mqttValue !== 'ON' && mqttValue !== 'OFF') return
            this.sendSetting(
                prop === 'express_cool'
                    ? { expressCool: mqttValue === 'ON' ? 1 : 0 }
                    : { expressFreeze: mqttValue === 'ON' ? 2 : 1 },
            )
            return
        }

        if (prop !== 'fridge_setpoint' && prop !== 'freezer_setpoint') return
        const unit = this.temperatureUnit
        if (!unit || !/^-?\d+$/.test(mqttValue)) return

        const value = Number(mqttValue)
        const fridge = prop === 'fridge_setpoint'
        const range = fridge ? fridgeRange(unit) : freezerRange(unit)
        if (!Number.isSafeInteger(value) || value < range.min || value > range.max) return

        const setting: Partial<Status> = { tempUnit: unit === 'C' ? 1 : 0 }
        if (fridge) {
            setting.fridgeSetpoint = convertFridgeTemperature(unit, value)
        } else {
            setting.freezerSetpoint = convertFreezerTemperature(unit, value)
        }
        this.sendSetting(setting)
    }
}
