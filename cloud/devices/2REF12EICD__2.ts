import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { freezerRange, fridgeRange, unpackStatus, TemperatureUnit } from './fridge_common'

// LG 2REF12EICD__2 — French Door "T20 Monarch Craft Ice" refrigerator.
// ThinQ model 2REF12EICD__2 (deviceType 101). Uses the same AABB framing and
// STATUS_FIELDS order as the other fridges in fridge_common.ts, but a SHORTER
// 26-byte status record (the 68-byte fridges carry extra filter-life % at bytes
// 35/36 which this model does not report). Class byte 0x10.
//
// Confirmed live on a real unit: door-open flips byte 7 (anyDoorOpen) 0x00 -> 0x01,
// matching fridge_common's STATUS_FIELDS index 7.

const STATUS_LENGTH = 26

// Temperature decoding for THIS model, taken from the modelJson MonitoringValue
// enums (bridge endpoint /bridge/:id/modeljson). LG's temperature encoding is
// NON-LINEAR: it skips even raw indices in the warmer half of the range, so the
// shared linear formulas in fridge_common.ts (8-input / -14-input) are WRONG and
// report the freezer 1-4°C too cold (e.g. raw 3 = -16°C, not -17°C).
//
//   freezer °C: raw 1, 3, 5, 7, 9, 10, 11, 12, 13  ->  -15 -16 -17 -18 -19 -20 -21 -22 -23
//   fridge  °C: raw 1, 2, 3, 5, 7, 9, 11           ->    7   6   5   4   3   2   1
// (Fahrenheit variants happen to be linear and are included for completeness.)

const FRIDGE_TEMP_C: Record<number, number> = { 1: 7, 2: 6, 3: 5, 5: 4, 7: 3, 9: 2, 11: 1 }
const FRIDGE_TEMP_F: Record<number, number> = {
    1: 43,
    2: 42,
    3: 41,
    4: 40,
    5: 39,
    6: 38,
    7: 37,
    8: 36,
    9: 35,
    10: 34,
    11: 33,
}
const FREEZER_TEMP_C: Record<number, number> = {
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
const FREEZER_TEMP_F: Record<number, number> = {
    1: 5,
    2: 4,
    3: 3,
    4: 2,
    5: 1,
    6: 0,
    7: -1,
    8: -2,
    9: -3,
    10: -4,
    11: -5,
    12: -6,
    13: -7,
}

// raw status byte -> temperature (°C or °F). Falls back to the raw value if the
// device reports an index outside the table (shouldn't happen in practice).
function rawToTemp(table: Record<number, number>, raw: number): number {
    return table[raw] ?? raw
}

// temperature (°C or °F) -> raw status byte. 0xff (IGNORE) when the value has no
// known mapping, so a write never sends garbage to the appliance.
function tempToRaw(table: Record<number, number>, temp: number): number {
    for (const key of Object.keys(table)) {
        if (table[Number(key)] === temp) return Number(key)
    }
    return 0xff
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
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
                    },
                    craft_ice: {
                        platform: 'select',
                        icon: 'mdi:ice-pop',
                        unique_id: '$deviceid-craft_ice',
                        state_topic: '$this/craft_ice',
                        command_topic: '$this/craft_ice/set',
                        name: 'Craft Ice Mode',
                        options: ['3 ice', '6 ice'],
                    },
                },
            }),
        )
    }

    start() {
        // Same initial query the other fridges need before they report anything.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + STATUS_LENGTH))
        }

        if (buf.length === 2 + STATUS_LENGTH && buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2))
        }

        if (buf.length >= 4 && buf[0] == 0x10 && buf[1] == 0xc5) {
            this.processUsage(buf.subarray(2))
        }
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const fridgeTable = unit === 'C' ? FRIDGE_TEMP_C : FRIDGE_TEMP_F
        const freezerTable = unit === 'C' ? FREEZER_TEMP_C : FREEZER_TEMP_F

        this.publishProperty('fridge_setpoint', rawToTemp(fridgeTable, status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', rawToTemp(freezerTable, status.freezerSetpoint))
        this.publishProperty('door', status.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('ice_plus', status.expressFreeze === 2 ? 'ON' : 'OFF')
        this.publishProperty('sabbath_mode', status.sabbathMode === 1 ? 'ON' : 'OFF')
        this.publishProperty('smart_learner', status.smartCare === 1 ? 'ON' : 'OFF')
        // craftIce byte: 1 = "3 ice", 2 = "6 ice" (modelJson craftIceMode enum)
        this.publishProperty('craft_ice', status.craftIce === 2 ? '6 ice' : status.craftIce === 1 ? '3 ice' : 'off')
    }

    processUsage(report: Buffer) {
        // <seq> <count> then <count> records of <id> <recent: u16> <?> <total: u16>
        const count = report[1]
        for (let i = 0; i < count; i++) {
            const record = report.subarray(2 + i * 6, 2 + i * 6 + 6)
            if (record.length < 6) return
            // water-dispensed record 0x21 is not decoded here (no confirmed usage on this model yet)
        }
    }

    command(fields: Record<number, number>) {
        // Write path reverse-engineered from a live capture of the LG app driving the same
        // model through the bridge (freezer setpoint change). The cloud's F017 command is a
        // SHORT 41-byte payload — not the 118-byte shape inherited from 2REF11EIDG__4, which
        // this fridge silently ignores. Byte offsets match the status record:
        //   data[1] fridge setpoint, data[2] freezer setpoint, data[8] temp unit.
        // Fixed non-0xff bytes at indices 21/22/23/26/31 are part of the command envelope.
        const COMMAND_LENGTH = 41
        const COMMAND_FIXED: Record<number, number> = {
            21: 0x00,
            22: 0x00,
            23: 0x00,
            26: 0x00,
            31: 0x00,
        }
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
            this.command({ 1: tempToRaw(unit === 'C' ? FRIDGE_TEMP_C : FRIDGE_TEMP_F, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'freezer_setpoint') {
            this.command({
                2: tempToRaw(unit === 'C' ? FREEZER_TEMP_C : FREEZER_TEMP_F, Number(mqttValue)),
                8: unitByte,
            })
        } else if (prop === 'ice_plus') {
            this.command({ 3: mqttValue === 'ON' ? 2 : 1 })
        } else if (prop === 'sabbath_mode') {
            this.command({ 14: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'smart_learner') {
            this.command({ 17: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'craft_ice') {
            // craft ice mode: byte 25 = 1 ("3 ice") or 2 ("6 ice")
            this.command({ 25: mqttValue === '6 ice' ? 2 : 1 })
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
