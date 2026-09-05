// LG GBBS322CEV and GBBS322BEV refrigerators
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

const DRAWER_MODES: Record<number, string> = {
    0: 'Cheese (2 °C)',
    1: 'Fish (0 °C)',
    2: 'Meat (-3 °C)',
}

const THERMAL_STATES: Record<number, string> = {
    1: 'settled',
    2: 'unknown',
    3: 'disturbed',
    5: 'unsettled',
}

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
                    open_door_alarm: {
                        platform: 'event',
                        unique_id: '$deviceid-open_door_alarm',
                        state_topic: '$this/open_door_alarm',
                        name: 'Open door alarm',
                        event_types: ['triggered'],
                    },
                    door_openings: {
                        platform: 'sensor',
                        unique_id: '$deviceid-door_openings',
                        state_topic: '$this/door_openings',
                        name: 'Fridge door openings',
                        state_class: 'total_increasing',
                    },
                    door_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-door_time',
                        state_topic: '$this/door_time',
                        name: 'Fridge door open time',
                        device_class: 'duration',
                        state_class: 'total_increasing',
                        unit_of_measurement: 's',
                    },
                    freezer_openings: {
                        platform: 'sensor',
                        unique_id: '$deviceid-freezer_openings',
                        state_topic: '$this/freezer_openings',
                        name: 'Freezer door openings',
                        state_class: 'total_increasing',
                    },
                    freezer_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-freezer_time',
                        state_topic: '$this/freezer_time',
                        name: 'Freezer door open time',
                        device_class: 'duration',
                        state_class: 'total_increasing',
                        unit_of_measurement: 's',
                    },
                    fridge_thermal_state: {
                        platform: 'sensor',
                        device_class: 'enum',
                        options: Object.values(THERMAL_STATES),
                        unique_id: '$deviceid-fridge_thermal_state',
                        state_topic: '$this/fridge_thermal_state',
                        name: 'Fridge thermal state',
                    },
                    freezer_thermal_state: {
                        platform: 'sensor',
                        device_class: 'enum',
                        options: Object.values(THERMAL_STATES),
                        unique_id: '$deviceid-freezer_thermal_state',
                        state_topic: '$this/freezer_thermal_state',
                        name: 'Freezer thermal state',
                    },
                    drawer_mode: {
                        platform: 'sensor',
                        device_class: 'enum',
                        options: Object.values(DRAWER_MODES),
                        unique_id: '$deviceid-drawer_mode',
                        state_topic: '$this/drawer_mode',
                        icon: 'mdi:food',
                        name: 'Fresh Converter+ (Drawer temperature)',
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

        if (
            buf.length === 28 &&
            buf[0] == 0x10 &&
            buf[1] == 0xc5 &&
            buf[3] == 4 &&
            buf[4] == 0x01 &&
            buf[10] == 0x03 &&
            buf[16] == 0x11 &&
            buf[22] == 0x13
        ) {
            const doorOpenings = buf.readUIntBE(7, 3)
            const doorTime = buf.readUIntBE(19, 3)

            this.publishProperty('door_openings', doorOpenings)
            this.publishProperty('door_time', doorTime)
            this.publishProperty('freezer_openings', buf.readUIntBE(13, 3) - doorOpenings)
            this.publishProperty('freezer_time', buf.readUIntBE(25, 3) - doorTime)
        }

        if (buf.length === 15 && buf[0] == 0x10 && buf[1] == 0x72) {
            this.HA.publishProperty(this.id, 'open_door_alarm', JSON.stringify({ event_type: 'triggered' }), {
                retain: false,
            })
        }
    }

    drawerModeName(raw: number): string {
        return DRAWER_MODES[raw] ?? 'unknown'
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
        this.publishProperty('drawer_mode', this.drawerModeName(drawerModeRaw))
        this.publishProperty('fridge_thermal_state', THERMAL_STATES[curStatus[27]] ?? 'unknown')
        this.publishProperty('freezer_thermal_state', THERMAL_STATES[curStatus[28]] ?? 'unknown')
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
