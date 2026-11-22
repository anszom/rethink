import HADevice from './base'
import AABBDevice from './aabb_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'

// LG LSEL6333F slide-in electric range, reporting WLSEL6333F (deviceType 301).
// It uses 75-byte records, unlike the 62-byte WLREL6323S layout.
// Physical-panel captures establish Bake, setpoints, door, lock and cooktop.
// Monitoring and writes are limited to captured WLSEL6333F operations.
const STATUS_LENGTH = 75
const OVEN_STATE = 14
const OVEN_MODE = 15
const TARGET_TEMPERATURE = 21
const CURRENT_TEMPERATURE = 23
const DOOR_FLAGS = 27
const DOOR_OPEN = 0x04
const CONTROL_LOCK = 11
// Every tested element toggled the same slot. Other slots have only reported
// idle/locked; do not present them as independently identified burners.
const COOKTOP_STATE = 60
const STATES = Enum.of({ Idle: 0, Preheating: 1, Cooking: 2 })
const MODES = Enum.of({ None: 0, Bake: 1 })
const CLOCK_FORMATS = Enum.of({ '24-hour': 0, '12-hour': 1 })
const TEMPERATURE_UNITS = Enum.of({ '°F': 0, '°C': 1 })
const BEEPER_VOLUMES = Enum.of({ High: 2, Low: 1, Mute: 0 })
// Captured full preference write; zero/FF defaults differ from the short clock command.
const PREFERENCE_TEMPLATE = Buffer.from('8080808080808080808080ff8080800000808080808000000000000080', 'hex')

export default class Device extends AABBDevice {
    private clockFormat: number | undefined
    private temperatureUnit: number | undefined
    private autoRemote: number | undefined
    private remoteTemperature = 350
    private remoteCookTime = 15
    private remoteKeepWarm = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Electric Range' }),
                components: {
                    oven_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:stove',
                        unique_id: '$deviceid-oven_status',
                        state_topic: '$this/oven_status',
                        name: 'Oven Status',
                        options: STATES.options,
                    },
                    oven_mode: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:chef-hat',
                        unique_id: '$deviceid-oven_mode',
                        state_topic: '$this/oven_mode',
                        name: 'Oven Mode',
                        options: MODES.options,
                    },
                    oven_set_temperature: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        icon: 'mdi:thermometer-chevron-up',
                        unique_id: '$deviceid-oven_set_temperature',
                        state_topic: '$this/oven_set_temperature',
                        name: 'Oven Set Temperature',
                        unit_of_measurement: '°F',
                    },
                    oven_temperature: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        icon: 'mdi:thermometer',
                        unique_id: '$deviceid-oven_temperature',
                        state_topic: '$this/oven_temperature',
                        name: 'Oven Temperature',
                        unit_of_measurement: '°F',
                    },
                    oven_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-oven_door',
                        state_topic: '$this/oven_door',
                        name: 'Oven Door',
                    },
                    control_lock: {
                        platform: 'binary_sensor',
                        icon: 'mdi:lock',
                        unique_id: '$deviceid-control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control Lock',
                    },
                    cooktop_status: {
                        platform: 'binary_sensor',
                        icon: 'mdi:stove',
                        unique_id: '$deviceid-cooktop_status',
                        state_topic: '$this/cooktop_status',
                        name: 'Cooktop',
                    },
                    preheat_alarm_light: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb-on-outline',
                        unique_id: '$deviceid-preheat_alarm_light',
                        state_topic: '$this/preheat_alarm_light',
                        command_topic: '$this/preheat_alarm_light/set',
                        name: 'Preheating Alarm Light',
                    },
                    auto_conversion: {
                        platform: 'switch',
                        icon: 'mdi:thermometer-auto',
                        unique_id: '$deviceid-auto_conversion',
                        state_topic: '$this/auto_conversion',
                        command_topic: '$this/auto_conversion/set',
                        name: 'Auto Conversion',
                    },
                    auto_remote: {
                        platform: 'switch',
                        icon: 'mdi:cellphone-wireless',
                        unique_id: '$deviceid-auto_remote',
                        state_topic: '$this/auto_remote',
                        command_topic: '$this/auto_remote/set',
                        name: 'Auto Remote',
                    },
                    remote_keep_warm: {
                        platform: 'switch',
                        icon: 'mdi:heat-wave',
                        unique_id: '$deviceid-remote_keep_warm',
                        state_topic: '$this/remote_keep_warm',
                        command_topic: '$this/remote_keep_warm/set',
                        name: 'Remote Keep Warm',
                    },
                    keep_warm: {
                        platform: 'binary_sensor',
                        icon: 'mdi:heat-wave',
                        unique_id: '$deviceid-keep_warm',
                        state_topic: '$this/keep_warm',
                        name: 'Keep Warm',
                    },
                    remote_temperature: {
                        platform: 'number',
                        device_class: 'temperature',
                        icon: 'mdi:thermometer-chevron-up',
                        unique_id: '$deviceid-remote_temperature',
                        state_topic: '$this/remote_temperature',
                        command_topic: '$this/remote_temperature/set',
                        name: 'Remote Temperature',
                        mode: 'box',
                        unit_of_measurement: '°F',
                        min: 170,
                        max: 550,
                        step: 5,
                    },
                    remote_cook_time: {
                        platform: 'number',
                        icon: 'mdi:timer-outline',
                        unique_id: '$deviceid-remote_cook_time',
                        state_topic: '$this/remote_cook_time',
                        command_topic: '$this/remote_cook_time/set',
                        name: 'Remote Cook Time',
                        device_class: 'duration',
                        mode: 'box',
                        unit_of_measurement: 'min',
                        min: 0,
                        max: 719,
                        step: 1,
                    },
                    start: {
                        platform: 'button',
                        icon: 'mdi:play-circle-outline',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        name: 'Start Bake',
                        payload_press: 'PRESS',
                        availability: [
                            { topic: '$this/availability' },
                            { topic: '$rethink/availability' },
                            { topic: '$this/remote_start', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                        availability_mode: 'all',
                    },
                    cancel: {
                        platform: 'button',
                        icon: 'mdi:stop',
                        unique_id: '$deviceid-cancel',
                        command_topic: '$this/cancel/set',
                        name: 'Cancel Oven',
                        payload_press: 'PRESS',
                    },
                    remote_started: {
                        platform: 'binary_sensor',
                        icon: 'mdi:cellphone-check',
                        unique_id: '$deviceid-remote_started',
                        state_topic: '$this/remote_started',
                        name: 'Started remotely',
                        entity_category: 'diagnostic',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        device_class: 'duration',
                        icon: 'mdi:timer-outline',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining Cook Time',
                        unit_of_measurement: 's',
                    },
                    cook_time: {
                        platform: 'sensor',
                        device_class: 'duration',
                        icon: 'mdi:timer-outline',
                        unique_id: '$deviceid-cook_time',
                        state_topic: '$this/cook_time',
                        name: 'Cook Time',
                        unit_of_measurement: 's',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:cellphone-wireless',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        entity_category: 'diagnostic',
                    },
                    temperature_adjustment: {
                        platform: 'number',
                        icon: 'mdi:thermometer-plus',
                        unique_id: '$deviceid-temperature_adjustment',
                        state_topic: '$this/temperature_adjustment',
                        command_topic: '$this/temperature_adjustment/set',
                        name: 'Temperature Adjustment',
                        // A calibration difference, not an absolute temperature.
                        unit_of_measurement: '°F',
                        min: -35,
                        max: 35,
                        step: 1,
                    },
                    clock_format: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:clock-outline',
                        unique_id: '$deviceid-clock_format',
                        state_topic: '$this/clock_format',
                        name: 'Clock format',
                        options: CLOCK_FORMATS.options,
                        entity_category: 'diagnostic',
                    },
                    temperature_unit: {
                        platform: 'select',
                        icon: 'mdi:thermometer',
                        unique_id: '$deviceid-temperature_unit',
                        state_topic: '$this/temperature_unit',
                        command_topic: '$this/temperature_unit/set',
                        options: TEMPERATURE_UNITS.options,
                        name: 'Temperature Unit',
                    },
                    oven_beeper_volume: {
                        platform: 'select',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-oven_beeper_volume',
                        state_topic: '$this/oven_beeper_volume',
                        command_topic: '$this/oven_beeper_volume/set',
                        name: 'Oven Beeper Volume',
                        options: BEEPER_VOLUMES.options,
                    },
                    cooktop_beeper_volume: {
                        platform: 'select',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-cooktop_beeper_volume',
                        state_topic: '$this/cooktop_beeper_volume',
                        command_topic: '$this/cooktop_beeper_volume/set',
                        name: 'Cooktop Beeper Volume',
                        options: BEEPER_VOLUMES.options,
                    },
                    clock_sync: {
                        platform: 'button',
                        unique_id: '$deviceid-clock_sync',
                        command_topic: '$this/clock_sync/set',
                        payload_press: 'PRESS',
                        name: 'Sync Clock',
                        icon: 'mdi:clock-check-outline',
                    },
                },
            }),
        )
        for (const [property, component] of Object.entries(this.config!.components)) {
            if ('state_topic' in component) this.publishProperty(property, undefined)
        }
        this.publishProperty('remote_temperature', this.remoteTemperature)
        this.publishProperty('remote_cook_time', this.remoteCookTime)
        this.publishProperty('remote_keep_warm', 'OFF')
    }

    // The appliance sends a 40EB record after reconnect; no guessed startup query.
    processAABB(buf: Buffer) {
        if (this.processCommonStatus(buf, 0x40, STATUS_LENGTH, this.processStatus)) return

        // Periodic 40CF snapshots update the measured temperature between EC
        // state changes. Only the captured 00 45 / 01 03 04 layout is decoded.
        if (
            buf.length === 73 &&
            buf[0] === 0x40 &&
            buf[1] === 0xcf &&
            buf.subarray(2, 7).equals(Buffer.from('0045010304', 'hex'))
        ) {
            const target = buf.readUInt16BE(12)
            const temperature = buf.readUInt16BE(14)
            this.publishProperty(
                'oven_temperature',
                (target & 0x8000) === 0 && this.temperatureUnit !== 1 && temperature !== 0 ? temperature : undefined,
            )
        }
    }

    processStatus(current: Buffer) {
        // Confirmed by clock writes in both formats and the resulting status transitions.
        this.clockFormat = current[0] === 0 || current[0] === 1 ? current[0] : undefined
        this.temperatureUnit = current[2] === 0 || current[2] === 1 ? current[2] : undefined
        this.autoRemote = current[10] === 0 || current[10] === 1 ? current[10] : undefined
        this.publishProperty('clock_format', CLOCK_FORMATS.map(current[0]))
        this.publishProperty('preheat_alarm_light', current[5] === 1 ? 'ON' : current[5] === 0 ? 'OFF' : undefined)
        this.publishProperty('auto_conversion', current[1] === 1 ? 'ON' : current[1] === 0 ? 'OFF' : undefined)
        this.publishProperty('auto_remote', current[10] === 1 ? 'ON' : current[10] === 0 ? 'OFF' : undefined)
        this.publishProperty('keep_warm', current[DOOR_FLAGS] & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('remote_started', current[OVEN_MODE] & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('remaining_time', current[16] + current[17] * 60 + current[18] * 3600)
        this.publishProperty('cook_time', current[19] * 60 + current[20] * 3600)
        this.publishProperty('remote_start', current[31] & 1 ? 'ON' : 'OFF')
        this.publishProperty('temperature_adjustment', this.temperatureUnit === 0 ? current.readInt8(3) : undefined)
        this.publishProperty('temperature_unit', TEMPERATURE_UNITS.map(current[2]))
        this.publishProperty('oven_beeper_volume', BEEPER_VOLUMES.map(current[6]))
        this.publishProperty('cooktop_beeper_volume', BEEPER_VOLUMES.map(current[9]))
        this.publishProperty('oven_status', STATES.map(current[OVEN_STATE]))
        this.publishProperty('oven_mode', MODES.map(current[OVEN_MODE] & 0x7f))
        const target = current.readUInt16BE(TARGET_TEMPERATURE)
        const temperature = current.readUInt16BE(CURRENT_TEMPERATURE)
        // Celsius preferences are captured, but active Celsius temperature records are not.
        const fahrenheit = (target & 0x8000) === 0 && this.temperatureUnit === 0
        this.publishProperty('oven_set_temperature', fahrenheit && target !== 0 ? target : undefined)
        this.publishProperty('oven_temperature', fahrenheit && temperature !== 0 ? temperature : undefined)
        this.publishProperty('oven_door', current[DOOR_FLAGS] & DOOR_OPEN ? 'ON' : 'OFF')
        this.publishProperty(
            'control_lock',
            current[CONTROL_LOCK] === 1 ? 'ON' : current[CONTROL_LOCK] === 0 ? 'OFF' : undefined,
        )
        const cooktop = current[COOKTOP_STATE]
        // 3 means locked, not heating. Unobserved values remain unknown.
        this.publishProperty(
            'cooktop_status',
            cooktop === 1 ? 'ON' : cooktop === 0 || cooktop === 3 ? 'OFF' : undefined,
        )
    }

    setProperty(property: string, value: string) {
        if (property === 'remote_keep_warm' && (value === 'ON' || value === 'OFF')) {
            this.remoteKeepWarm = value === 'ON'
            this.publishProperty(property, value)
            return
        }
        if (property === 'remote_temperature' || property === 'remote_cook_time') {
            if (!/^\d+$/.test(value.trim())) return
            const number = Number(value)
            if (property === 'remote_temperature') {
                if (number < 170 || number > 550 || number % 5 !== 0) return
                this.remoteTemperature = number
            } else {
                if (number > 719) return
                this.remoteCookTime = number
            }
            this.publishProperty(property, number)
            return
        }
        if (property === 'start' && value === 'PRESS') {
            // HA availability follows physical Remote Start; the appliance enforces its interlock.
            const payload = Buffer.alloc(15)
            payload[0] = 1 // Captured Bake operation.
            payload[4] = this.remoteKeepWarm ? 2 : 0
            payload.writeUInt16BE(this.remoteTemperature, 5)
            payload[7] = Math.floor(this.remoteCookTime / 60)
            payload[8] = this.remoteCookTime % 60
            this.send(Buffer.concat([Buffer.from([0xf0, 0x43, 0x20, 0x0b]), payload]))
            return
        }
        if (property === 'cancel' && value === 'PRESS') {
            this.send(Buffer.from([0xf0, 0x44, 0]))
            return
        }
        if (
            (property === 'preheat_alarm_light' || property === 'auto_conversion' || property === 'auto_remote') &&
            (value === 'ON' || value === 'OFF')
        ) {
            const payload = Buffer.from(PREFERENCE_TEMPLATE)
            const enabled = value === 'ON' ? 1 : 0
            payload[property === 'preheat_alarm_light' ? 7 : property === 'auto_conversion' ? 3 : 13] = enabled
            // Both fields change together in the app's Auto Remote commands.
            if (property === 'auto_remote') payload[28] = enabled
            this.send(Buffer.concat([Buffer.from([0xf0, 0x43, 0x21, 0x0e]), payload]))
            return
        }
        if (property === 'temperature_adjustment') {
            const adjustment = Number(value)
            if (value.trim() === '' || !Number.isInteger(adjustment) || adjustment < -35 || adjustment > 35) return
            const payload = Buffer.from(PREFERENCE_TEMPLATE)
            // The app's Off command selects 1 with a zero trim; nonzero °F trims select 0.
            payload[4] = adjustment === 0 ? 1 : 0
            payload[5] = adjustment & 0xff
            this.send(Buffer.concat([Buffer.from([0xf0, 0x43, 0x21, 0x0e]), payload]))
            return
        }
        if (property === 'temperature_unit') {
            const unit = TEMPERATURE_UNITS.unmap(value)
            if (unit === undefined) return
            const payload = Buffer.from(PREFERENCE_TEMPLATE)
            payload[9] = unit
            this.send(Buffer.concat([Buffer.from([0xf0, 0x43, 0x21, 0x0e]), payload]))
            return
        }
        if (property === 'oven_beeper_volume' || property === 'cooktop_beeper_volume') {
            const volume = BEEPER_VOLUMES.unmap(value)
            if (volume === undefined) return
            const payload = Buffer.from(PREFERENCE_TEMPLATE)
            payload[property === 'oven_beeper_volume' ? 8 : 12] = volume
            this.send(Buffer.concat([Buffer.from([0xf0, 0x43, 0x21, 0x0e]), payload]))
            return
        }
        if (property !== 'clock_sync' || value !== 'PRESS') return
        const now = new Date()
        this.sendClock(now.getHours(), now.getMinutes())
    }

    sendClock(hours: number, minutes: number) {
        if (this.clockFormat === undefined || this.autoRemote === undefined) return
        // Short clock writes enable Auto Remote on this model. Send the full preference
        // record and preserve both Auto Remote fields from the reported setting.
        const payload = Buffer.from(PREFERENCE_TEMPLATE)
        payload[0] = this.clockFormat === 1 ? hours % 12 || 12 : hours
        payload[1] = minutes
        payload[2] = this.clockFormat
        payload[13] = this.autoRemote
        payload[28] = this.autoRemote
        this.send(Buffer.concat([Buffer.from([0xf0, 0x43, 0x21, 0x0e]), payload]))
    }
}
