import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { packStatus, type Status, type TemperatureUnit, unpackStatus } from './fridge_common'
import { Enum } from '@/util/enum'

// 2REF12EJDD__2 - LG LRFDS3006D ThinQ Refrigerator
//
// ThinQ reports the shared STATUS_FIELDS in an 18-byte status record. F017 writes the same
// layout in a 41-byte payload, with 0xFF meaning "leave unchanged".
//
// Unlike 2REF11EII__M2, this model reports one aggregated door field and Sabbath mode. Its
// fresh-air filter is replacement status only; selectable fresh-air modes have not been observed.
const STATUS_LEN = 18
const SETTING_LEN = 41

// Express mode (called "ice plus" on this model)
const EXPRESS_ON = 2
const EXPRESS_OFF = 1

// This model reports replacement as 3. No other fresh-air states have been identified.
const FRESH_AIR_REPLACE = 3

// Water filter reports in "months since last reset." Resets start at 6mo, cap at 12mo.
const WATER_FILTER_REPLACE_FROM = 6
const WATER_FILTER_MAX = 12

function waterFilterProblem(months: number) {
    if (months > WATER_FILTER_MAX) return undefined
    return months >= WATER_FILTER_REPLACE_FROM ? 'ON' : 'OFF'
}

const SMART_GRID_OPTIONS = Enum.of({
    'Not In Use': 0, // In-app as Not in use
    'Seasonal Energy Saver': 2, // In-app as SMARTGRID_DD_ON
    // SMARTGRID_DR_ON in the model JSON. ThinQ required utility enrollment, so activation was untested.
    'Peak Energy Saver': 3,
})

const FRIDGE_F = new Map([
    [1, 43],
    [2, 42],
    [3, 41],
    [4, 40],
    [5, 39],
    [6, 38],
    [7, 37],
    [8, 36],
    [9, 35],
    [10, 34],
    [11, 33],
])

const FREEZER_F = new Map([
    [1, 5],
    [2, 4],
    [3, 3],
    [4, 2],
    [5, 1],
    [6, 0],
    [7, -1],
    [8, -2],
    [9, -3],
    [10, -4],
    [11, -5],
    [12, -6],
    [13, -7],
])

// The Celsius indexes in this model's fridgeTemp_C/freezerTemp_C tables are sparse.
const FRIDGE_C = new Map([
    [1, 7],
    [2, 6],
    [3, 5],
    [5, 4],
    [7, 3],
    [9, 2],
    [11, 1],
])
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

function inverseLookup(table: Map<number, number>, value: number): number | undefined {
    for (const [raw, v] of table) if (v === value) return raw
    return undefined
}

function range(table: Map<number, number>, unit: TemperatureUnit) {
    const values = [...table.values()]
    return { unit_of_measurement: unit === 'F' ? '°F' : '°C', min: Math.min(...values), max: Math.max(...values) }
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined
    energyWh = 0

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Captures with automatic acknowledgments had one status frame per change instead of repeated frames.
        super(HA, thinq, true)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    private tables(unit: TemperatureUnit) {
        return unit === 'F' ? { fridge: FRIDGE_F, freezer: FREEZER_F } : { fridge: FRIDGE_C, freezer: FREEZER_C }
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
        const { fridge, freezer } = this.tables(unit)
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
                        ...range(fridge, unit),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...range(freezer, unit),
                    },
                    express_freeze: {
                        platform: 'switch',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Ice Plus',
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
                        unique_id: '$deviceid-water_filter_months',
                        state_topic: '$this/water_filter_months',
                        name: 'Water filter months',
                        icon: 'mdi:calendar-clock',
                        unit_of_measurement: 'months',
                        suggested_display_precision: 0,
                    },
                    fresh_air_filter_replace: {
                        platform: 'binary_sensor',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                        icon: 'mdi:air-filter',
                        unique_id: '$deviceid-fresh_air_filter_replace',
                        state_topic: '$this/fresh_air_filter_replace',
                        name: 'Fresh air filter health',
                    },
                    smart_grid: {
                        platform: 'select',
                        icon: 'mdi:transmission-tower',
                        unique_id: '$deviceid-smart_grid',
                        state_topic: '$this/smart_grid',
                        command_topic: '$this/smart_grid/set',
                        name: 'Smart Grid',
                        options: SMART_GRID_OPTIONS.options,
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    sabbath_mode: {
                        platform: 'switch',
                        icon: 'mdi:candle',
                        unique_id: '$deviceid-sabbath_mode',
                        state_topic: '$this/sabbath_mode',
                        command_topic: '$this/sabbath_mode/set',
                        name: 'Sabbath Mode',
                    },
                    energy: {
                        platform: 'sensor',
                        device_class: 'energy',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                        name: 'Energy',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (this.processCommonStatus(buf, 0x10, STATUS_LEN, this.processStatus)) return
        if (buf[0] === 0x10 && buf[1] === 0xaf && buf.length >= 5) this.processEnergy(buf.readUInt16BE(3))
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit: TemperatureUnit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)
        const { fridge, freezer } = this.tables(unit)

        this.publishProperty('fridge_setpoint', fridge.get(status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', freezer.get(status.freezerSetpoint))
        this.publishProperty('express_freeze', status.expressFreeze === EXPRESS_ON ? 'ON' : 'OFF')

        this.publishProperty('fresh_air_filter_replace', status.freshAirFilter === FRESH_AIR_REPLACE ? 'ON' : 'OFF')

        this.publishProperty('smart_grid', SMART_GRID_OPTIONS.map(status.smartSaving))

        const waterFilterMonths = status.waterFilter
        this.publishProperty('water_filter', waterFilterProblem(waterFilterMonths))
        this.publishProperty(
            'water_filter_months',
            waterFilterMonths <= WATER_FILTER_MAX ? waterFilterMonths : undefined,
        )

        this.publishProperty('door', status.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('sabbath_mode', status.sabbathMode === 1 ? 'ON' : 'OFF')
    }

    processEnergy(wh: number) {
        this.energyWh += wh
        // temperatureUnit is set when the first status creates the Home Assistant configuration.
        // This initialization guard follows the energy handling in 2REBGLUB_2P__.
        if (this.temperatureUnit) this.publishProperty('energy', this.energyWh)
    }

    setProperty(prop: string, mqttValue: string) {
        const unit = this.temperatureUnit || 'F'
        const { fridge, freezer } = this.tables(unit)

        const setting: Partial<Status> = {}

        if (prop === 'fridge_setpoint' || prop === 'freezer_setpoint') {
            const isFridge = prop === 'fridge_setpoint'
            const raw = inverseLookup(isFridge ? fridge : freezer, Number(mqttValue))
            if (raw === undefined) {
                this.log(`${prop}: no ${unit} code for ${mqttValue}`)
                return
            }
            if (isFridge) setting.fridgeSetpoint = raw
            else setting.freezerSetpoint = raw
            setting.tempUnit = unit === 'C' ? 1 : 0
        } else if (prop === 'smart_grid') {
            const code = SMART_GRID_OPTIONS.unmap(mqttValue)
            if (code === undefined) {
                this.log(`Unexpected value ${mqttValue}`)
                return
            }
            setting.smartSaving = code
        } else if (prop === 'express_freeze') {
            setting.expressFreeze = mqttValue === 'ON' ? EXPRESS_ON : EXPRESS_OFF
        } else if (prop === 'sabbath_mode') {
            setting.sabbathMode = mqttValue === 'ON' ? 1 : 0
        } else {
            this.log(`Unknown property ${prop}`)
            return
        }

        this.send(this.buildSetting(setting))
    }

    // Every captured ThinQ F017 command for this model sets the dispenser fields,
    // monDataNumber, and byte 31 to 0x00. Preserve those fixed bytes while leaving
    // all other unchanged fields at 0xFF.
    private buildSetting(setting: Partial<Status>) {
        const body = packStatus(
            { dispenserMode: 0, dispenserCapacity: 0, dispenserUnit: 0, monDataNumber: 0, ...setting },
            SETTING_LEN,
        )
        body[31] = 0
        return Buffer.concat([Buffer.from('F017', 'hex'), body])
    }
}
