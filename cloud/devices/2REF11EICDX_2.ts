import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import {
    convertFreezerTemperature,
    convertFridgeTemperature,
    freezerRange,
    fridgeRange,
    type TemperatureUnit,
} from './fridge_common'
import { Enum } from '@/util/enum'

// LG LHFS28XBS. Celsius uses model-specific, nonlinear setpoint tables.
// 26-byte status records; 41-byte F017 setting records.
const STATUS_LEN = 26
const SETTING_TEMPLATE = Buffer.from(
    'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF',
    'hex',
)
const DOORS: Record<number, string> = { 1: 'fridge_door', 2: 'freezer_door' }
const CRAFT_ICE = Enum.of({ '3 balls': 1, '6 balls': 2 })
const FRIDGE_C = new Map([
    [1, 7],
    [2, 6],
    [3, 5],
    [5, 4],
    [7, 3],
    [9, 2],
    [11, 1],
])
// The modelJson repeats index 12 for −23°C; captured writes/reports confirm raw 13.
const FREEZER_C = new Map([
    [1, -15],
    [3, -16],
    [5, -17],
    [7, -18],
    [9, -19],
    [10, -20],
    [11, -21],
    [12, -22],
    [13, -23],
])
const SMART_GRID = Enum.of({ 'Not In Use': 0, 'Seasonal Energy Saver': 2 })

export default class Device extends AABBDevice {
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Fridge' }),
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...fridgeRange('F'),
                        step: 1,
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange('F'),
                        step: 1,
                    },
                    express_freeze: {
                        platform: 'switch',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Ice Plus',
                    },
                    craft_ice_mode: {
                        platform: 'select',
                        icon: 'mdi:snowflake-variant',
                        unique_id: '$deviceid-craft_ice_mode',
                        state_topic: '$this/craft_ice_mode',
                        command_topic: '$this/craft_ice_mode/set',
                        name: 'Craft ice',
                        options: CRAFT_ICE.options,
                    },
                    sabbath_mode: {
                        platform: 'switch',
                        icon: 'mdi:candle',
                        unique_id: '$deviceid-sabbath_mode',
                        state_topic: '$this/sabbath_mode',
                        command_topic: '$this/sabbath_mode/set',
                        name: 'Sabbath Mode',
                    },
                    smart_learner: {
                        platform: 'switch',
                        icon: 'mdi:brain',
                        unique_id: '$deviceid-smart_learner',
                        state_topic: '$this/smart_learner',
                        command_topic: '$this/smart_learner/set',
                        name: 'Smart Learner',
                    },
                    smart_grid: {
                        platform: 'select',
                        icon: 'mdi:transmission-tower',
                        unique_id: '$deviceid-smart_grid',
                        state_topic: '$this/smart_grid',
                        command_topic: '$this/smart_grid/set',
                        name: 'Smart Grid',
                        options: SMART_GRID.options,
                    },
                    water_filter: {
                        platform: 'binary_sensor',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                        icon: 'mdi:water-opacity',
                        unique_id: '$deviceid-water_filter',
                        state_topic: '$this/water_filter',
                        name: 'Water filter health',
                    },
                    water_filter_months: {
                        platform: 'sensor',
                        entity_category: 'diagnostic',
                        icon: 'mdi:calendar-clock',
                        unique_id: '$deviceid-water_filter_months',
                        state_topic: '$this/water_filter_months',
                        name: 'Water filter months',
                        unit_of_measurement: 'months',
                        suggested_display_precision: 0,
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Any door',
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
                },
            }),
        )
        // Retained compartment values cannot establish current state on reconnect.
        for (const prop of [
            'fridge_setpoint',
            'freezer_setpoint',
            'express_freeze',
            'craft_ice_mode',
            'sabbath_mode',
            'smart_learner',
            'smart_grid',
            'water_filter',
            'water_filter_months',
            'door',
            ...Object.values(DOORS),
        ]) {
            this.publishProperty(prop, undefined)
        }
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x10) return
        if (buf[1] === 0xa8 && buf.length === 4) {
            const prop = DOORS[buf[2]]
            if (prop && (buf[3] === 0 || buf[3] === 1)) {
                this.publishProperty(prop, buf[3] === 1 ? 'ON' : 'OFF')
            }
            return
        }
        this.processCommonStatus(buf, 0x10, STATUS_LEN, this.processStatus)
    }

    processStatus(status: Buffer) {
        const unit = status[8] === 0 ? 'F' : status[8] === 1 ? 'C' : undefined
        if (unit && unit !== this.temperatureUnit && this.config) {
            // Keep entity IDs stable when the physical panel changes units.
            this.setConfig(
                allowExtendedType({
                    ...this.config,
                    components: {
                        ...this.config.components,
                        fridge_setpoint: { ...this.config.components.fridge_setpoint, ...fridgeRange(unit) },
                        freezer_setpoint: { ...this.config.components.freezer_setpoint, ...freezerRange(unit) },
                    },
                }),
            )
        }
        this.temperatureUnit = unit
        this.publishProperty(
            'fridge_setpoint',
            unit === 'C'
                ? FRIDGE_C.get(status[1])
                : unit === 'F' && status[1] >= 1 && status[1] <= 11
                  ? convertFridgeTemperature('F', status[1])
                  : undefined,
        )
        this.publishProperty(
            'freezer_setpoint',
            unit === 'C'
                ? FREEZER_C.get(status[2])
                : unit === 'F' && status[2] >= 1 && status[2] <= 13
                  ? convertFreezerTemperature('F', status[2])
                  : undefined,
        )
        this.publishProperty('express_freeze', status[3] === 2 ? 'ON' : status[3] === 1 ? 'OFF' : undefined)
        this.publishProperty('craft_ice_mode', CRAFT_ICE.map(status[25]))
        this.publishProperty('sabbath_mode', status[14] === 1 ? 'ON' : status[14] === 0 ? 'OFF' : undefined)
        this.publishProperty('smart_learner', status[17] === 1 ? 'ON' : status[17] === 0 ? 'OFF' : undefined)
        this.publishProperty('smart_grid', SMART_GRID.map(status[5]))
        // modelJson defines months 0-5 as good and 6-12 as replace. One month/good
        // was cross-checked against the app and existing LG cloud entities.
        const filterMonths = status[6] <= 12 ? status[6] : undefined
        this.publishProperty('water_filter_months', filterMonths)
        this.publishProperty('water_filter', filterMonths === undefined ? undefined : filterMonths >= 6 ? 'ON' : 'OFF')
        const door = status[7]
        this.publishProperty('door', door === 1 ? 'ON' : door === 0 || door === 2 ? 'OFF' : undefined)
        // A closed aggregate report establishes both compartments are closed.
        // An open report alone cannot identify which compartment opened.
        if (door === 0 || door === 2) {
            for (const prop of Object.values(DOORS)) this.publishProperty(prop, 'OFF')
        }
    }

    setProperty(prop: string, value: string) {
        const setting = Buffer.from(SETTING_TEMPLATE)
        if (prop === 'fridge_setpoint' || prop === 'freezer_setpoint') {
            const unit = this.temperatureUnit
            if (!unit || value.trim() === '') return
            const temperature = Number(value)
            const fridge = prop === 'fridge_setpoint'
            const limits = fridge ? fridgeRange(unit) : freezerRange(unit)
            if (!Number.isInteger(temperature) || temperature < limits.min || temperature > limits.max) return
            const table = fridge ? FRIDGE_C : FREEZER_C
            const raw =
                unit === 'C'
                    ? [...table].find(([, degrees]) => degrees === temperature)?.[0]
                    : fridge
                      ? convertFridgeTemperature('F', temperature)
                      : convertFreezerTemperature('F', temperature)
            if (raw === undefined) return
            setting[2 + (fridge ? 1 : 2)] = raw
            setting[2 + 8] = unit === 'F' ? 0 : 1
        } else if (prop === 'express_freeze' && (value === 'ON' || value === 'OFF')) {
            setting[2 + 3] = value === 'ON' ? 2 : 1
        } else if (prop === 'craft_ice_mode') {
            const mode = CRAFT_ICE.unmap(value)
            if (mode === undefined) return
            setting[2 + 25] = mode
        } else if (prop === 'sabbath_mode' && (value === 'ON' || value === 'OFF')) {
            setting[2 + 14] = value === 'ON' ? 1 : 0
        } else if (prop === 'smart_learner' && (value === 'ON' || value === 'OFF')) {
            setting[2 + 17] = value === 'ON' ? 1 : 0
        } else if (prop === 'smart_grid') {
            // Peak Energy Saver is gated by utility enrollment in the LG app and
            // has no confirmed command on this appliance.
            const mode = SMART_GRID.unmap(value)
            if (mode === undefined) return
            setting[2 + 5] = mode
        } else return
        this.send(setting)
    }
}
