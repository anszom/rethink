// LG GBBS322CEV refrigerator
// ThinQ2 model ID: 2REBGLUB_2P__
// Device type: 101
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

const STATUS_LENGTH = 96

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
                    // Expose the decoded drawer mode and its raw value for validation/debugging.
                    drawer_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-drawer_mode',
                        state_topic: '$this/drawer_mode',
                        icon: 'mdi:food',
                        name: 'Drawer mode',
                    },
                    drawer_mode_raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-drawer_mode_raw',
                        state_topic: '$this/drawer_mode_raw',
                        icon: 'mdi:code-brackets',
                        name: 'Drawer mode raw',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // I'm not sure what is the proper way to identify packet types, so let's match
        // on the length and a few initial bytes

        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        }

        if (buf.length === 2 + STATUS_LENGTH && buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2, 2 + STATUS_LENGTH))
        }
    }

    drawerModeName(raw: number | undefined): string {
        // Drawer mode observed at status offset 95:
        // 0 = Cheese, 1 = Fish, 2 = Meat
        if (raw === 0) return 'Cheese'
        if (raw === 1) return 'Fish'
        if (raw === 2) return 'Meat'
        if (raw === 0xff || raw === undefined) return 'Unknown'
        return 'Unknown ' + raw
    }

    processStatus(curStatus: Buffer) {
        const s = unpackStatus(curStatus)
        this.setTemperatureUnit(s.tempUnit ? 'C' : 'F')
        this.publishProperty('door', s.anyDoorOpen === 1 ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', convertFridgeTemperature(this.temperatureUnit!, s.fridgeSetpoint))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(this.temperatureUnit!, s.freezerSetpoint))
        this.publishProperty('express_cool', s.expressCool === 1 ? 'ON' : 'OFF')
        this.publishProperty('express_freeze', s.expressFreeze === 2 ? 'ON' : 'OFF')

        const drawerModeRaw = curStatus[95]
        this.publishProperty('drawer_mode_raw', drawerModeRaw === undefined ? 'Unknown' : String(drawerModeRaw))
        this.publishProperty('drawer_mode', this.drawerModeName(drawerModeRaw))
    }

    sendSetting(setting: Partial<Status>) {
        this.send(Buffer.concat([Buffer.from('F017', 'hex'), packStatus(setting, STATUS_LENGTH)]))
    }

    setProperty(prop: string, mqttValue: string) {
        // We shouldn't receive any setProperty calls before the temperatureUnit is set. But let's be safe
        const unit = this.temperatureUnit || 'C'

        let setting: Partial<Status> = {
            tempUnit: unit === 'C' ? 1 : 0,
        }

        if (prop === 'fridge_setpoint') {
            setting.fridgeSetpoint = convertFridgeTemperature(unit, Number(mqttValue))
            this.sendSetting(setting)
        } else if (prop === 'freezer_setpoint') {
            setting.freezerSetpoint = convertFreezerTemperature(unit, Number(mqttValue))
            this.sendSetting(setting)
        } else if (prop === 'express_cool') {
            setting.expressCool = mqttValue === 'ON' ? 1 : 0
            this.sendSetting(setting)
        } else if (prop === 'express_freeze') {
            setting.expressFreeze = mqttValue === 'ON' ? 2 : 1
            this.sendSetting(setting)
        }
    }
}
