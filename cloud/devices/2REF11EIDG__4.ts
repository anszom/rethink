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
    unpackStatus,
    TemperatureUnit,
} from './fridge_common'

// LG LRFXC2606S — 26 cu. ft. 3-door French door refrigerator with in-door ice and water.
// ThinQ model 2REF11EIDG__4 (model JSON family VF_GOOD_G). Same 68-byte AABB status block as
// 2REF11EIDA__4 (10EB initial / 10EC previous+current), minus the flex drawer (byte 13 reads FF).
//
// Every entity below was confirmed against the LG app and the LG cloud on this fridge; the F017
// commands are byte-for-byte the ones the LG app sends. Bytes beyond STATUS_FIELDS:
//   [35] fresh air filter life, percent     [36] water filter life, percent
// A filter reset is the app writing 100 to that filter's byte.
//
// 10C5 is a usage report the fridge sends by itself every 15 minutes: a sequence byte, a record
// count, then 6-byte records <id> <recent: u16> <?> <total: u16>. Record 0x21 is water dispensed
// in millilitres (a measured gallon read 3788 ml). The other records (ice, and what are probably
// door counts and times) are not decoded here.

// The LG app's F017 command: 118 bytes, all 0xFF ("leave unchanged") except these.
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

const FRESH_AIR_FILTER = 35
const WATER_FILTER = 36
const WATER_DISPENSED_RECORD = 0x21

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
                    fresh_air_filter: {
                        platform: 'sensor',
                        icon: 'mdi:air-filter',
                        unique_id: '$deviceid-fresh_air_filter',
                        state_topic: '$this/fresh_air_filter',
                        unit_of_measurement: '%',
                        state_class: 'measurement',
                        name: 'Fresh air filter',
                    },
                    water_filter: {
                        platform: 'sensor',
                        icon: 'mdi:water-check',
                        unique_id: '$deviceid-water_filter',
                        state_topic: '$this/water_filter',
                        unit_of_measurement: '%',
                        state_class: 'measurement',
                        name: 'Water filter',
                    },
                    fresh_air_filter_reset: {
                        platform: 'button',
                        icon: 'mdi:restore',
                        unique_id: '$deviceid-fresh_air_filter_reset',
                        command_topic: '$this/fresh_air_filter_reset/set',
                        payload_press: '',
                        name: 'Reset fresh air filter',
                    },
                    water_filter_reset: {
                        platform: 'button',
                        icon: 'mdi:restore',
                        unique_id: '$deviceid-water_filter_reset',
                        command_topic: '$this/water_filter_reset/set',
                        payload_press: '',
                        name: 'Reset water filter',
                    },
                    water_dispensed: {
                        platform: 'sensor',
                        device_class: 'water',
                        unique_id: '$deviceid-water_dispensed',
                        state_topic: '$this/water_dispensed',
                        unit_of_measurement: 'L',
                        state_class: 'total_increasing',
                        name: 'Water dispensed',
                    },
                },
            }),
        )
    }

    start() {
        // The initial query 2REF11EIDA__4 needs before it reports anything.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + 68 * 2 && buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + 68, 2 + 68 + 68))
        }

        if (buf.length === 2 + 68 && buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2, 2 + 68))
        }

        if (buf.length >= 4 && buf[0] == 0x10 && buf[1] == 0xc5) {
            this.processUsage(buf.subarray(2))
        }
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, status.freezerSetpoint))
        this.publishProperty('door', status.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('ice_plus', status.expressFreeze === 2 ? 'ON' : 'OFF')
        this.publishProperty('sabbath_mode', status.sabbathMode === 1 ? 'ON' : 'OFF')
        this.publishProperty('smart_learner', status.smartCare === 1 ? 'ON' : 'OFF')
        this.publishProperty('fresh_air_filter', curStatus[FRESH_AIR_FILTER])
        this.publishProperty('water_filter', curStatus[WATER_FILTER])
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

    command(fields: Record<number, number>) {
        const message = Buffer.alloc(2 + COMMAND_LENGTH, 0xff)
        message[0] = 0xf0
        message[1] = 0x17
        for (const [index, value] of Object.entries({ ...COMMAND_FIXED, ...fields })) message[2 + Number(index)] = value
        this.send(message)
    }

    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'F'
        const unitByte = unit === 'C' ? 1 : 0

        if (prop === 'fridge_setpoint') {
            this.command({ 1: convertFridgeTemperature(unit, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'freezer_setpoint') {
            this.command({ 2: convertFreezerTemperature(unit, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'ice_plus') {
            this.command({ 3: mqttValue === 'ON' ? 2 : 1 })
        } else if (prop === 'sabbath_mode') {
            this.command({ 14: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'smart_learner') {
            this.command({ 17: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'fresh_air_filter_reset') {
            this.command({ [FRESH_AIR_FILTER]: 100 })
        } else if (prop === 'water_filter_reset') {
            this.command({ [WATER_FILTER]: 100 })
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
