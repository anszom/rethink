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
    TemperatureUnit,
} from './fridge_common'
import { Enum } from '@/util/enum'

const STATUS_LENGTH = 68

// Byte 25 command / byte 34 status share these same three levels.
const CRAFT_ICE_OPTIONS = Enum.of({
    Off: 0,
    '3 balls': 1,
    '6 balls': 2,
})

const CRAFT_ICE_MAKER_STATUS = Enum.of({
    Off: 0,
    'Making ice': 1,
    'Ice full': 2,
    'Quiet mode': 3,
})

// Shared by night view (byte 30) and quiet mode (byte 31) - same underlying enum in modelJson.
const NIGHT_MODE_OPTIONS = Enum.of({
    Off: 0,
    'Every day': 1,
    'Sunset to sunrise': 2,
    Custom: 3,
})

// LG "F-Next6 Disp Craft Instaview" French-door fridge/freezer (InstaView window, in-door
// dispenser, auto + craft ice makers). Confirmed against a real unit by cross-referencing
// captured AA..BB traffic with the official LG cloud's decoded state (bridge mode +
// lgcloud-monitor.ts) - see tests/cloud/devices/2REFT1DIC4P_U.test.ts for the packets.
//
// Shares the same 68-byte status block layout as 2REF11EIDA__4 and 2RES1VE61NFA2 (see the
// wiki pages for those models) for the fields confirmed below, though offsets drift past
// the shared prefix - e.g. byte 34 here is the craft ice maker's own status, versus bytes
// 32/33 on 2REF11EIDA__4's in-door/cubed ice makers. Byte 26 is a change-sequence counter
// (modelJson's monDataNumber) that increments on every write - not exposed, it carries no
// state of its own.
//
// Night view and quiet mode (bytes 30/31) are read-only here even though they're plain
// status-block bytes like everything else: writing them via F017 was tried against a real
// unit and silently ignored (no 10EC change, no cloud update, value reverts). The official
// app instead uses a distinct command, F010, to turn quiet mode off - e.g.
// F0100300000000000000000000000000 flips byte 31 from CUSTOM to OFF - where the leading 03
// looks like an operation code and the trailing zeros are presumably schedule start/end
// time and brightness for other operations (turning a mode *on* needs to specify which
// schedule). That wasn't chased further: modelling the schedule itself belongs in Home
// Assistant's own automations, not here.
//
// Not exposed here (wire encoding unconfirmed, or confirmed to not reach the wire at all):
// the ice/water dispenser mode (toggling it produces no packet - purely local UI state),
// the auto ice maker, fresh air filter, sabbath mode, and the InstaView knock-to-light
// window (also purely local). The night view / quiet mode schedule and brightness settings
// are likewise invisible on the wire.
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
                    craft_ice_mode: {
                        platform: 'select',
                        icon: 'mdi:snowflake-variant',
                        unique_id: '$deviceid-craft_ice_mode',
                        state_topic: '$this/craft_ice_mode',
                        command_topic: '$this/craft_ice_mode/set',
                        name: 'Craft ice',
                        options: CRAFT_ICE_OPTIONS.options,
                    },
                    craft_ice_maker_status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-craft_ice_maker_status',
                        state_topic: '$this/craft_ice_maker_status',
                        name: 'Craft ice maker status',
                        icon: 'mdi:snowflake-variant',
                        device_class: 'enum',
                        options: CRAFT_ICE_MAKER_STATUS.options,
                    },
                    night_view: {
                        platform: 'sensor',
                        icon: 'mdi:weather-night',
                        unique_id: '$deviceid-night_view',
                        state_topic: '$this/night_view',
                        name: 'Night view',
                        device_class: 'enum',
                        options: NIGHT_MODE_OPTIONS.options,
                    },
                    quiet_mode: {
                        platform: 'sensor',
                        icon: 'mdi:volume-off',
                        unique_id: '$deviceid-quiet_mode',
                        state_topic: '$this/quiet_mode',
                        name: 'Quiet mode',
                        device_class: 'enum',
                        options: NIGHT_MODE_OPTIONS.options,
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // matching on length and the leading 0x10 marker, same as the other AABB fridges

        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] === 0x10 && buf[1] === 0xec) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        }

        if (buf.length === 2 + STATUS_LENGTH && buf[0] === 0x10 && buf[1] === 0xeb) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2, 2 + STATUS_LENGTH))
        }
    }

    processStatus(curStatus: Buffer) {
        const unit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const setpointFridge = convertFridgeTemperature(unit, curStatus[1])
        const setpointFreezer = convertFreezerTemperature(unit, curStatus[2])
        const expressFreeze = curStatus[3] // 1=off 2=on
        const anyDoorOpen = curStatus[7] // 1=open 0=closed, aggregated across all 4 doors
        const nightView = curStatus[30]
        const quietMode = curStatus[31]
        const craftIceMode = curStatus[25]
        const craftIceMakerStatus = curStatus[34]

        this.publishProperty('door', anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
        this.publishProperty('express_freeze', expressFreeze === 2 ? 'ON' : 'OFF')
        this.publishProperty('night_view', NIGHT_MODE_OPTIONS.map(nightView))
        this.publishProperty('quiet_mode', NIGHT_MODE_OPTIONS.map(quietMode))
        this.publishProperty('craft_ice_mode', CRAFT_ICE_OPTIONS.map(craftIceMode))
        this.publishProperty('craft_ice_maker_status', CRAFT_ICE_MAKER_STATUS.map(craftIceMakerStatus))
    }

    // The official LG app's own F017 command (captured via bridge mode) carries a batch of
    // extra non-0xFF filler bytes and an inconsistent length/checksum that doesn't match
    // its own framing - the fridge evidently doesn't validate checksums on incoming
    // commands. A plain 0xFF-filled status block (leaving byte 8, the temperature unit,
    // at 0xFF/unchanged) with the standard AABBDevice checksum was confirmed to work just
    // as well against a real unit - see tests/cloud/devices/2REFT1DIC4P_U.test.ts.
    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'C'
        const baseMessage = Buffer.alloc(STATUS_LENGTH, 0xff)

        if (prop === 'fridge_setpoint') {
            baseMessage[1] = convertFridgeTemperature(unit, Number(mqttValue))
            this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
        } else if (prop === 'freezer_setpoint') {
            baseMessage[2] = convertFreezerTemperature(unit, Number(mqttValue))
            this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
        } else if (prop === 'express_freeze') {
            baseMessage[3] = mqttValue === 'ON' ? 2 : 1
            this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
        } else if (prop === 'craft_ice_mode') {
            const code = CRAFT_ICE_OPTIONS.unmap(mqttValue)
            if (code === undefined) console.warn(`Unexpected value ${mqttValue}`)
            else {
                baseMessage[25] = code
                this.send(Buffer.concat([Buffer.from('F017', 'hex'), baseMessage]))
            }
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
