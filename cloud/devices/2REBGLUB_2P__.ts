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
    unpackStatus,
    TemperatureUnit,
} from './fridge_common'

// LG GBBSJ2CCEP (EU bottom-freezer), ThinQ model 2REBGLUB_2P__, BK7234 modem. 96-byte AABB status
// block in the common fridge layout (10EB initial / 10EC previous+current). The F017 command is the
// same 118 bytes, fixed bytes included, as 2REF11EIDG__4.
//
// Every entity below was confirmed against the LG app through the rethink bridge; the F017 commands
// are byte-for-byte the ones the app sends. The app labels differ from STATUS_FIELDS:
//   [12] ecoFriendly = Vacation     [16] expressCool = Super Cool     [17] smartCare = Smart Learner
// Bytes beyond STATUS_FIELDS:
//   [95] fresh converter (0 Cheese, 1 Fish, 2 Meat)
//
// The fridge also sends, by itself, every 15 minutes:
//   10AF 00 <Wh: u16> 04 04         energy used in the last 15 minutes (summed, it matches the app's kWh)
//   10C5 <seq> <count> <records>    6-byte records <id> <recent: u16> <?> <total: u16>, as on
//                                   2REF11EIDG__4: 0x01 door openings, 0x11 seconds the door was open
// and once on connect 10 31 <count> <modules>, 24-byte records <index> <11-char part number> 00 00
// <version: 2 bytes> <minor> ...; the app shows the version as e.g. "68e0.0".

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
const STATUS_LENGTH = 96

const FRESH_CONVERTER = 95

const DOOR_OPENINGS_RECORD = 0x01
const DOOR_OPEN_TIME_RECORD = 0x11
const FIRMWARE_RECORD_LENGTH = 24

const FRESH_CONVERTER_MODES = Enum.of({
    Meat: 2,
    Fish: 1,
    Cheese: 0,
})

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined
    // the fridge only reports 15-minute amounts, and HA's energy dashboard needs a running total, so
    // this one is summed here; it starts again from 0 whenever the fridge reconnects, which HA treats as
    // a meter reset
    energyWh = 0

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
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        icon: 'mdi:snowflake',
                        name: 'Express Freeze',
                    },
                    super_cool: {
                        platform: 'switch',
                        unique_id: '$deviceid-super_cool',
                        state_topic: '$this/super_cool',
                        command_topic: '$this/super_cool/set',
                        icon: 'mdi:snowflake-variant',
                        name: 'Super Cool',
                    },
                    smart_learner: {
                        platform: 'switch',
                        unique_id: '$deviceid-smart_learner',
                        state_topic: '$this/smart_learner',
                        command_topic: '$this/smart_learner/set',
                        icon: 'mdi:brain',
                        name: 'Smart Learner',
                    },
                    vacation: {
                        platform: 'switch',
                        unique_id: '$deviceid-vacation',
                        state_topic: '$this/vacation',
                        command_topic: '$this/vacation/set',
                        icon: 'mdi:airplane',
                        name: 'Vacation',
                    },
                    fresh_converter: {
                        platform: 'select',
                        unique_id: '$deviceid-fresh_converter',
                        state_topic: '$this/fresh_converter',
                        command_topic: '$this/fresh_converter/set',
                        icon: 'mdi:fridge-bottom',
                        name: 'Fresh Converter+',
                        options: FRESH_CONVERTER_MODES.options,
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
                    door_openings: {
                        platform: 'sensor',
                        icon: 'mdi:door-open',
                        unique_id: '$deviceid-door_openings',
                        state_topic: '$this/door_openings',
                        state_class: 'total_increasing',
                        name: 'Door openings',
                    },
                    door_open_time: {
                        platform: 'sensor',
                        device_class: 'duration',
                        unique_id: '$deviceid-door_open_time',
                        state_topic: '$this/door_open_time',
                        unit_of_measurement: 's',
                        state_class: 'total_increasing',
                        name: 'Door open time',
                    },
                    firmware_1: {
                        platform: 'sensor',
                        entity_category: 'diagnostic',
                        icon: 'mdi:chip',
                        unique_id: '$deviceid-firmware_1',
                        state_topic: '$this/firmware_1',
                        name: 'Firmware 1',
                    },
                    firmware_2: {
                        platform: 'sensor',
                        entity_category: 'diagnostic',
                        icon: 'mdi:chip',
                        unique_id: '$deviceid-firmware_2',
                        state_topic: '$this/firmware_2',
                        name: 'Firmware 2',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (this.processCommonStatus(buf, 0x10, STATUS_LENGTH, this.processStatus)) return
        if (buf[0] !== 0x10) return

        if (buf[1] === 0xaf && buf.length >= 5) this.processEnergy(buf.readUInt16BE(3))
        else if (buf[1] === 0xc5 && buf.length >= 4) this.processUsage(buf.subarray(2))
        else if (buf[1] === 0x31 && buf.length >= 3) this.processFirmware(buf.subarray(2))
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, status.freezerSetpoint))
        this.publishProperty('door', status.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('express_freeze', status.expressFreeze === 2 ? 'ON' : 'OFF')
        this.publishProperty('super_cool', status.expressCool === 1 ? 'ON' : 'OFF')
        this.publishProperty('smart_learner', status.smartCare === 1 ? 'ON' : 'OFF')
        this.publishProperty('vacation', status.ecoFriendly === 1 ? 'ON' : 'OFF')
        this.publishProperty('fresh_converter', FRESH_CONVERTER_MODES.map(curStatus[FRESH_CONVERTER]))
    }

    processEnergy(wh: number) {
        this.energyWh += wh
        // published only once the config exists, like everything else
        if (this.temperatureUnit) this.publishProperty('energy', this.energyWh)
    }

    processUsage(report: Buffer) {
        const count = report[1]
        for (let i = 0; i < count; i++) {
            const record = report.subarray(2 + i * 6, 2 + i * 6 + 6)
            if (record.length < 6) return
            if (record[0] === DOOR_OPENINGS_RECORD) this.publishProperty('door_openings', record.readUInt16BE(4))
            else if (record[0] === DOOR_OPEN_TIME_RECORD) this.publishProperty('door_open_time', record.readUInt16BE(4))
        }
    }

    processFirmware(report: Buffer) {
        const count = report[0]
        for (let i = 0; i < count; i++) {
            const record = report.subarray(1 + i * FIRMWARE_RECORD_LENGTH, 1 + (i + 1) * FIRMWARE_RECORD_LENGTH)
            if (record.length < FIRMWARE_RECORD_LENGTH) return
            if (record[0] !== 1 && record[0] !== 2) continue
            const partNumber = record.subarray(1, 12).toString('latin1')
            const version = `${record.subarray(14, 16).toString('hex')}.${record[16]}`
            this.publishProperty(`firmware_${record[0]}`, `${version} (${partNumber})`)
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
        const unit = this.temperatureUnit || 'C'
        const unitByte = unit === 'C' ? 1 : 0

        if (prop === 'fridge_setpoint') {
            this.command({ 1: convertFridgeTemperature(unit, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'freezer_setpoint') {
            this.command({ 2: convertFreezerTemperature(unit, Number(mqttValue)), 8: unitByte })
        } else if (prop === 'express_freeze') {
            this.command({ 3: mqttValue === 'ON' ? 2 : 1 })
        } else if (prop === 'vacation') {
            this.command({ 12: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'super_cool') {
            this.command({ 16: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'smart_learner') {
            this.command({ 17: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop === 'fresh_converter') {
            const code = FRESH_CONVERTER_MODES.unmap(mqttValue)
            if (code !== undefined) this.command({ [FRESH_CONVERTER]: code })
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
