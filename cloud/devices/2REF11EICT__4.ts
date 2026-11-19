import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import {
    convertFridgeTemperature,
    convertFreezerTemperature,
    fridgeRange,
    freezerRange,
    unpackStatus,
    type TemperatureUnit,
} from './fridge_common'
import { Enum } from '@/util/enum'

// LG LRYXC2606S, ThinQ model 2REF11EICT__4. Shares 2REF11EIDG__4's AABB framing, fridge_common
// struct, and F017 write command, truncated to a 43-byte record (not 68).
//
// Confirmed against the app: fridgeSetpoint[1]/freezerSetpoint[2] (F: 44-raw/6-raw),
// expressFreeze[3] (Ice Plus, 1=off 2=on), anyDoorOpen[7], tempUnit[8] (0=F 1=C), sabbathMode[14]
// (0/1), smartCare[17] (Smart Learner, 0/1), craftIce[25] (0=Off 2=6 ICE 1=3 ICE, read and write).
// Other STATUS_FIELDS entries read constant or implausible, left undecoded.
//
// Celsius isn't linear, so it's looked up from this model's own modelJson (FRIDGE_C_TABLE/
// FREEZER_C_TABLE below); spot-confirmed live via the panel toggle (raw 5 -> 4°C/-17°C).
//
// Bytes beyond STATUS_FIELDS: [35]/[36] fresh air/water filter life percent, confirmed against the
// app (58%/58%), reset writes 100. [32]/[34]/[41] ice maker status (0=Off, 1=Making ice, 2=Full ice
// bin, 3=Quiet Mode), from this model's modelJson; byte 41 (Mini Cubed Ice) caught a live transition
// against the app, the others are spot-checked or correlated snapshots.
//
// 10C5 usage reports (push ~every 15 min): `<seq> <count>`, then `<count>` 6-byte records of
// `<id> <recent: u16> <?> <total: u16>`. Record 0x21 is water dispensed in millilitres (correlated
// with a measured dispense, not exact). Other records are ice/door counters, undecoded.
//
// Sabbath's Set Schedule option (F010, sub-marker 0x09) is confirmed byte-for-byte but left out:
// it's write-only and cloud-scheduled, making it bridge-mode-only, which rethink doesn't support.
const CRAFT_ICE_MODE = Enum.of({ Off: 0, '3 ICE': 1, '6 ICE': 2 })
const ICE_MAKER_STATUS = Enum.of({ Off: 0, 'Making ice': 1, 'Full ice bin': 2, 'Quiet Mode': 3 })

// From this model's own modelJson (fridgeTemp_C/freezerTemp_C): Celsius is not a linear function
// of raw, unlike Fahrenheit. Covers the full range fridgeRange('C')/freezerRange('C') expose.
const FRIDGE_C_TABLE: Record<number, number> = { 1: 7, 2: 6, 3: 5, 5: 4, 7: 3, 9: 2, 11: 1 }
const FREEZER_C_TABLE: Record<number, number> = {
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
function invert(table: Record<number, number>): Record<number, number> {
    return Object.fromEntries(Object.entries(table).map(([raw, c]) => [c, Number(raw)]))
}
const FRIDGE_C_TABLE_INV = invert(FRIDGE_C_TABLE)
const FREEZER_C_TABLE_INV = invert(FREEZER_C_TABLE)

// The F017 command, identical to 2REF11EIDG__4's: 118 bytes, 0xFF ("leave unchanged") except these
// fixed defaults and whatever fields a write overrides.
const COMMAND_FIXED: Record<number, number> = {
    21: 0x00,
    22: 0x00,
    23: 0x00,
    26: 0x00,
    31: 0x00,
    41: 0x00,
    45: 0x1e,
    70: 0x0a,
    102: 0x00,
}
const COMMAND_LENGTH = 118

const CLASS_BYTE = 0x10
const RECORD_LENGTH = 43
const FRESH_AIR_FILTER = 35
const WATER_FILTER = 36
const WATER_DISPENSED_RECORD = 0x21
const MINI_CUBED_ICE_OFFSET = 41
const CRAFT_ICE_STATUS_OFFSET = 34
const CRUSHED_CUBED_ICE_OFFSET = 32

// C-mode table lookup, F-mode shared formula — see header comment. Celsius isn't linear, so
// decode (raw -> display) and encode (display -> raw) need separate directions, unlike F.
function fridgeDecode(unit: TemperatureUnit, raw: number): number {
    return unit === 'C' ? FRIDGE_C_TABLE[raw] : convertFridgeTemperature(unit, raw)
}
function fridgeEncode(unit: TemperatureUnit, display: number): number {
    return unit === 'C' ? FRIDGE_C_TABLE_INV[display] : convertFridgeTemperature(unit, display)
}
function freezerDecode(unit: TemperatureUnit, raw: number): number {
    return unit === 'C' ? FREEZER_C_TABLE[raw] : convertFreezerTemperature(unit, raw)
}
function freezerEncode(unit: TemperatureUnit, display: number): number {
    return unit === 'C' ? FREEZER_C_TABLE_INV[display] : convertFreezerTemperature(unit, display)
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
        // HomeAssistant configuration will be ready once we find out the temperature unit
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
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
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
                        entity_category: 'config',
                    },
                    sabbath_mode: {
                        platform: 'switch',
                        icon: 'mdi:candle',
                        unique_id: '$deviceid-sabbath_mode',
                        state_topic: '$this/sabbath_mode',
                        command_topic: '$this/sabbath_mode/set',
                        name: 'Sabbath Mode',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        entity_category: 'config',
                    },
                    smart_learner: {
                        platform: 'switch',
                        icon: 'mdi:brain',
                        unique_id: '$deviceid-smart_learner',
                        state_topic: '$this/smart_learner',
                        command_topic: '$this/smart_learner/set',
                        name: 'Smart Learner',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        entity_category: 'config',
                    },
                    craft_ice: {
                        platform: 'select',
                        icon: 'mdi:ice-cream',
                        unique_id: '$deviceid-craft_ice',
                        state_topic: '$this/craft_ice',
                        command_topic: '$this/craft_ice/set',
                        name: 'Craft Ice',
                        options: CRAFT_ICE_MODE.options,
                        entity_category: 'config',
                    },
                    fresh_air_filter: {
                        platform: 'sensor',
                        icon: 'mdi:air-filter',
                        unique_id: '$deviceid-fresh_air_filter',
                        state_topic: '$this/fresh_air_filter',
                        unit_of_measurement: '%',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                        name: 'Fresh air filter',
                    },
                    water_filter: {
                        platform: 'sensor',
                        icon: 'mdi:water-check',
                        unique_id: '$deviceid-water_filter',
                        state_topic: '$this/water_filter',
                        unit_of_measurement: '%',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                        name: 'Water filter',
                    },
                    fresh_air_filter_reset: {
                        platform: 'button',
                        icon: 'mdi:restore',
                        unique_id: '$deviceid-fresh_air_filter_reset',
                        command_topic: '$this/fresh_air_filter_reset/set',
                        payload_press: '',
                        entity_category: 'diagnostic',
                        name: 'Reset fresh air filter',
                    },
                    water_filter_reset: {
                        platform: 'button',
                        icon: 'mdi:restore',
                        unique_id: '$deviceid-water_filter_reset',
                        command_topic: '$this/water_filter_reset/set',
                        payload_press: '',
                        entity_category: 'diagnostic',
                        name: 'Reset water filter',
                    },
                    water_dispensed: {
                        platform: 'sensor',
                        device_class: 'water',
                        unique_id: '$deviceid-water_dispensed',
                        state_topic: '$this/water_dispensed',
                        unit_of_measurement: 'L',
                        state_class: 'total_increasing',
                        entity_category: 'diagnostic',
                        name: 'Water dispensed',
                    },
                    mini_cubed_ice: {
                        platform: 'sensor',
                        icon: 'mdi:ice-pop',
                        unique_id: '$deviceid-mini_cubed_ice',
                        state_topic: '$this/mini_cubed_ice',
                        name: 'Mini Cubed Ice',
                        device_class: 'enum',
                        options: ICE_MAKER_STATUS.options,
                        entity_category: 'diagnostic',
                    },
                    craft_ice_status: {
                        platform: 'sensor',
                        icon: 'mdi:ice-cream',
                        unique_id: '$deviceid-craft_ice_status',
                        state_topic: '$this/craft_ice_status',
                        name: 'Craft Ice status',
                        device_class: 'enum',
                        options: ICE_MAKER_STATUS.options,
                        entity_category: 'diagnostic',
                    },
                    crushed_cubed_ice: {
                        platform: 'sensor',
                        icon: 'mdi:ice-pop',
                        unique_id: '$deviceid-crushed_cubed_ice',
                        state_topic: '$this/crushed_cubed_ice',
                        name: 'Crushed/Cubed Ice',
                        device_class: 'enum',
                        options: ICE_MAKER_STATUS.options,
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // Same initial query as the rest of this fridge family — see header comment.
    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + RECORD_LENGTH * 2 && buf[0] === CLASS_BYTE && buf[1] === 0xec) {
            this.processStatus(buf.subarray(2 + RECORD_LENGTH, 2 + RECORD_LENGTH * 2))
        }

        if (buf.length === 2 + RECORD_LENGTH && buf[0] === CLASS_BYTE && buf[1] === 0xeb) {
            this.processStatus(buf.subarray(2, 2 + RECORD_LENGTH))
        }

        if (buf.length >= 4 && buf[0] === CLASS_BYTE && buf[1] === 0xc5) {
            this.processUsage(buf.subarray(2))
        }
    }

    // <seq> <count> then <count> records of <id> <recent: u16> <?> <total: u16>
    processUsage(report: Buffer) {
        const count = report[1]
        for (let i = 0; i < count; i++) {
            const record = report.subarray(2 + i * 6, 2 + i * 6 + 6)
            if (record.length < 6) return
            if (record[0] === WATER_DISPENSED_RECORD) {
                this.publishProperty('water_dispensed', record.readUInt16BE(4) / 1000)
            }
        }
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', fridgeDecode(unit, status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', freezerDecode(unit, status.freezerSetpoint))
        this.publishProperty('door', status.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('ice_plus', status.expressFreeze === 2 ? 'ON' : 'OFF')
        this.publishProperty('sabbath_mode', status.sabbathMode === 1 ? 'ON' : 'OFF')
        this.publishProperty('smart_learner', status.smartCare === 1 ? 'ON' : 'OFF')
        this.publishProperty('craft_ice', CRAFT_ICE_MODE.map(status.craftIce))
        this.publishProperty('fresh_air_filter', curStatus[FRESH_AIR_FILTER])
        this.publishProperty('water_filter', curStatus[WATER_FILTER])
        this.publishProperty('mini_cubed_ice', ICE_MAKER_STATUS.map(curStatus[MINI_CUBED_ICE_OFFSET]))
        this.publishProperty('craft_ice_status', ICE_MAKER_STATUS.map(curStatus[CRAFT_ICE_STATUS_OFFSET]))
        this.publishProperty('crushed_cubed_ice', ICE_MAKER_STATUS.map(curStatus[CRUSHED_CUBED_ICE_OFFSET]))
    }

    command(fields: Record<number, number>) {
        const message = Buffer.alloc(2 + COMMAND_LENGTH, 0xff)
        message[0] = 0xf0
        message[1] = 0x17
        for (const [index, value] of Object.entries({ ...COMMAND_FIXED, ...fields })) message[2 + Number(index)] = value
        this.send(message)
    }

    setProperty(prop: string, mqttValue: string) {
        const unit = this.temperatureUnit || 'F'
        const unitByte = unit === 'C' ? 1 : 0

        if (prop === 'fridge_setpoint') {
            this.command({ 1: fridgeEncode(unit, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'freezer_setpoint') {
            this.command({ 2: freezerEncode(unit, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'ice_plus') {
            this.command({ 3: mqttValue === 'ON' ? 2 : 1 })
        } else if (prop === 'sabbath_mode') {
            this.command({ 14: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'smart_learner') {
            this.command({ 17: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'craft_ice') {
            const mode = CRAFT_ICE_MODE.unmap(mqttValue)
            if (mode !== undefined) this.command({ 25: mode })
        } else if (prop === 'fresh_air_filter_reset') {
            this.command({ [FRESH_AIR_FILTER]: 100 })
        } else if (prop === 'water_filter_reset') {
            this.command({ [WATER_FILTER]: 100 })
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
