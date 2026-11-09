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
    packStatus,
    Status,
    TemperatureUnit,
    unpackStatus,
} from './fridge_common'

// 2RES1VE41PFA2 - LG side-by-side refrigerator (LG model T20_VS4M, US market), firmware 1.03.
//
// 27-byte AABB status block in the common fridge layout (fridge_common's STATUS_FIELDS), sent as
// 10EB (initial) / 10EC (previous + current). The offsets used below were confirmed against traffic
// captured from a live unit while operating it through the LG app over rethink's bridge, and
// cross-checked with the values LG's own cloud reported for the same moments:
//   [0]  monStatus          2 = NORMAL
//   [1]  fridge setpoint    raw 7 = 37 °F (44 - x)
//   [2]  freezer setpoint   raw 7 = -1 °F (6 - x)
//   [3]  express freeze     1 = off, 2 = on
//   [6]  water filter       months since last reset (raw 5)
//   [7]  at least one door open, 0 = closed, 1 = open
//   [8]  temperature unit   0 = Fahrenheit, 1 = Celsius
//   [14] sabbath mode       0 = off, 1 = on
// Everything else in the block reads 0xFF on this model - fresh air filter, display lock, express
// cool, smart care, craft ice - and is deliberately left unpublished. A display lock is meaningless
// here anyway: the appliance has no display.
//
// Writes are F017 + a 41-byte block, 0xFF meaning "leave unchanged", with fixed zero bytes at 21,
// 22, 23, 26 and 31 - the same command layout as 2REF11EII__M2. Captured commands and the status
// changes they produced:
//   express freeze on   f017 ffffff02 ...   10EC [3] 01 -> 02
//   express freeze off  f017 ffffff01 ...   10EC [3] 02 -> 01
//   fridge 36 °F        f017 ff08 ....00   10EC [1] 07 -> 08
//   fridge 37 °F        f017 ff07 ....00   10EC [1] 08 -> 07
// The cloud sends the temperature unit (byte 8) along with a setpoint write, but not with the
// express write; that asymmetry is reproduced below.
//
// 10A8 <compartment> <0=closed 1=open> reports each compartment separately: 1 is the fridge, 2 the
// freezer. 10AF (15-minute energy) and 1072 are not decoded - too few captures to pin the layout.

const STATUS_LENGTH = 27
const SETTING_LENGTH = 41

const EXPRESS_ON = 2
const EXPRESS_OFF = 1

// The counter starts at 0 after a reset and stops at 12; replacement is due from 6 months.
const WATER_FILTER_REPLACE_FROM = 6
const WATER_FILTER_MAX = 12

const DOOR_COMPARTMENTS: Record<number, string> = { 1: 'fridge_door', 2: 'freezer_door' }

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // The cloud acked the appliance's 10A8 door events and its telemetry frames; AABBDevice
        // already skips EB/EC status records, which the cloud did not ack either.
        super(HA, thinq, true)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })

        // HomeAssistant configuration will be ready once we find out the temperature unit
    }

    start() {
        // The family-wide "report your state" request, so Home Assistant is populated on reconnect.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
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
                    express_freeze: {
                        platform: 'switch',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        icon: 'mdi:snowflake',
                        name: 'Express Freeze',
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
                    sabbath: {
                        platform: 'binary_sensor',
                        icon: 'mdi:candle',
                        unique_id: '$deviceid-sabbath',
                        state_topic: '$this/sabbath',
                        name: 'Sabbath mode',
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
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x10) return

        if (buf[1] === 0xa8 && buf.length === 4) {
            // 10A8 <compartment> <0=closed 1=open>
            const compartment = DOOR_COMPARTMENTS[buf[2]]
            if (compartment) this.publishProperty(compartment, buf[3] === 1 ? 'ON' : 'OFF')
            return
        }

        if (this.processCommonStatus(buf, 0x10, STATUS_LENGTH, this.processStatus)) return

        if (buf[1] === 0xeb || buf[1] === 0xec) {
            this.log(`unexpected ${buf.subarray(0, 2).toString('hex')} status length ${buf.length}`)
        }
    }

    processStatus(curStatus: Buffer) {
        const status = unpackStatus(curStatus)
        const unit: TemperatureUnit = status.tempUnit ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, status.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, status.freezerSetpoint))
        this.publishProperty('express_freeze', status.expressFreeze === EXPRESS_ON ? 'ON' : 'OFF')
        this.publishProperty('sabbath', status.sabbathMode === 1 ? 'ON' : 'OFF')

        // 0xFF means the model does not report the field; the counter itself stops at 12 months.
        const waterFilterMonths = status.waterFilter
        if (waterFilterMonths <= WATER_FILTER_MAX) {
            this.publishProperty('water_filter_months', waterFilterMonths)
            this.publishProperty('water_filter', waterFilterMonths >= WATER_FILTER_REPLACE_FROM ? 'ON' : 'OFF')
        }

        // The block only says "at least one door is open". With none open, whatever the last 10A8
        // events left behind is stale.
        if (status.anyDoorOpen !== 1) {
            for (const compartment of Object.values(DOOR_COMPARTMENTS)) {
                this.publishProperty(compartment, 'OFF')
            }
        }
    }

    setProperty(prop: string, mqttValue: string) {
        const unit = this.temperatureUnit || 'F'
        const setting: Partial<Status> = {}

        if (prop === 'fridge_setpoint' || prop === 'freezer_setpoint') {
            const isFridge = prop === 'fridge_setpoint'
            if (isFridge) setting.fridgeSetpoint = convertFridgeTemperature(unit, Number(mqttValue))
            else setting.freezerSetpoint = convertFreezerTemperature(unit, Number(mqttValue))
            setting.tempUnit = unit === 'C' ? 1 : 0
        } else if (prop === 'express_freeze') {
            setting.expressFreeze = mqttValue === 'ON' ? EXPRESS_ON : EXPRESS_OFF
        } else {
            this.log(`Unknown property ${prop}`)
            return
        }

        this.send(this.buildSetting(setting))
    }

    // Captured commands carry 0x00 in a few slots that are meaningless for this model, rather than
    // the 0xFF "unchanged" filler; reproduce them as the cloud sends them.
    private buildSetting(setting: Partial<Status>) {
        const body = packStatus(
            { dispenserMode: 0, dispenserCapacity: 0, dispenserUnit: 0, monDataNumber: 0, ...setting },
            SETTING_LENGTH,
        )
        body[31] = 0
        return Buffer.concat([Buffer.from('F017', 'hex'), body])
    }
}
