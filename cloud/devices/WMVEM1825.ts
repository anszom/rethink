import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

const STATUS = Enum.of({
    Idle: 0x00,
    Cooking: 0x02,
    Paused: 0x04,
    Done: 0x05,
    'Ready to start': 0x07,
})

// Preference write: the same F0 43 21 frame and payload layout as the WFV474PGV oven's, where every
// field the write does not set goes out as the 0x80 "no change" sentinel and index 11 as 0xFF.
// Verified on a live MVEM1825: indices 0-2 set the displayed clock, and index 3 is the beeper, which
// the oven keeps at index 8 (writing index 8 here is acknowledged but changes nothing).
const PREFERENCE_COMMAND_PREFIX = [0xf0, 0x43, 0x21, 0x0e]
const PREFERENCE_PAYLOAD_LENGTH = 13
const PREFERENCE_NO_CHANGE = 0x80
const PREFERENCE_FF_INDEX = 11
const PREFERENCE_FF_NO_CHANGE = 0xff
const CLOCK_HOURS_INDEX = 0
const CLOCK_MINUTES_INDEX = 1
const CLOCK_HOUR_FORMAT_INDEX = 2
// 0x00 carries a 0-23 hour. It is the form the oven handler writes, and the one verified here.
const CLOCK_HOUR_FORMAT_24H = 0x00
const BEEPER_INDEX = 3
// Writing 1, 2 or 3 all read back as the same status, so the appliance offers only on and off.
const BEEPER_ON = 0x01
const BEEPER_OFF = 0x00
// Unlike the oven, the microwave reports the setting: rec[35]'s low two bits read 3 while the keys
// beep and 0 once muted.
const BEEPER_STATUS_OFFSET = 35
const BEEPER_STATUS_MASK = 0x03

export default class Device extends AABBDevice {
    fanSpeed = 0
    lightLevel = 0

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Microwave' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 's',
                    },
                    power_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-power_level',
                        state_topic: '$this/power_level',
                        name: 'Power level',
                        icon: 'mdi:gauge',
                        unit_of_measurement: '%',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    fan_power: {
                        platform: 'fan',
                        unique_id: '$deviceid-fan',
                        state_topic: '$this/fan_power',
                        command_topic: '$this/fan_power/set',
                        percentage_state_topic: '$this/fan_speed',
                        percentage_command_topic: '$this/fan_speed/set',
                        speed_range_min: 1,
                        speed_range_max: 2,
                        name: 'Vent fan',
                        icon: 'mdi:fan',
                    },
                    light_power: {
                        platform: 'light',
                        unique_id: '$deviceid-light',
                        state_topic: '$this/light_power',
                        command_topic: '$this/light_power/set',
                        brightness_state_topic: '$this/light_level',
                        brightness_command_topic: '$this/light_level/set',
                        brightness_scale: 2,
                        name: 'Cooktop light',
                        icon: 'mdi:lightbulb',
                    },
                    clock_sync: {
                        platform: 'button',
                        icon: 'mdi:clock-check-outline',
                        unique_id: '$deviceid-clock_sync',
                        command_topic: '$this/clock_sync/set',
                        payload_press: 'PRESS',
                        name: 'Sync clock',
                    },
                    beeper: {
                        platform: 'switch',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-beeper',
                        state_topic: '$this/beeper',
                        command_topic: '$this/beeper/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Beeper',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('f0ed114101000000181a0207080c14191a1e262b30353a00000000000000000000000000', 'hex'))
    }

    private processStatus(rec: Buffer) {
        const state = rec[0]
        // Confirmed independently of target seconds with a 20-second level-5 cook.
        const powerLevel = rec[10]
        const remainingSeconds = rec[15] * 3600 + rec[16] * 60 + rec[17]
        const hood = rec[36]
        const fanSpeed = hood & 0x0f
        const lightLevel = (hood >> 4) & 0x07

        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('remaining_time', remainingSeconds)
        if (powerLevel <= 10) this.publishProperty('power_level', powerLevel * 10)
        if (fanSpeed <= 2) {
            this.fanSpeed = fanSpeed
            this.publishProperty('fan_power', fanSpeed > 0 ? 'ON' : 'OFF')
            this.publishProperty('fan_speed', fanSpeed)
        }
        if (lightLevel <= 2) {
            this.lightLevel = lightLevel
            this.publishProperty('light_power', lightLevel > 0 ? 'ON' : 'OFF')
            this.publishProperty('light_level', lightLevel)
        }
        this.publishProperty('beeper', (rec[BEEPER_STATUS_OFFSET] & BEEPER_STATUS_MASK) !== 0 ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        if (buf.length === 48 && buf[0] === 0x41 && buf[1] === 0xeb) {
            this.processStatus(buf.subarray(2, 48))
            return
        }

        if (buf.length === 94 && buf[0] === 0x41 && buf[1] === 0xec) {
            this.processStatus(buf.subarray(48, 94))
            return
        }

        // Door changes use a short event packet rather than the regular status record.
        if (
            buf.length === 12 &&
            buf[0] === 0x41 &&
            buf[1] === 0xb2 &&
            buf.subarray(2, 11).equals(Buffer.from('000f070a0103000000', 'hex'))
        ) {
            if (buf[11] === 0 || buf[11] === 1) this.publishProperty('door', buf[11] === 1 ? 'ON' : 'OFF')
        }
    }

    private sendHoodCommand() {
        // The ThinQ app clears the other hood control on every change. Sending the complete
        // desired state avoids that behavior; the combined form was verified on live hardware.
        this.send(
            Buffer.from([
                0xf0,
                0x43,
                0x22,
                0x04,
                this.fanSpeed > 0 ? 1 : 0,
                this.fanSpeed,
                this.lightLevel > 0 ? 1 : 0,
                this.lightLevel,
                0x80,
                0x80,
            ]),
        )
    }

    static preferencePayload() {
        const payload = Buffer.alloc(PREFERENCE_PAYLOAD_LENGTH, PREFERENCE_NO_CHANGE)
        payload[PREFERENCE_FF_INDEX] = PREFERENCE_FF_NO_CHANGE
        return payload
    }

    sendPreference(payload: Buffer) {
        this.send(Buffer.concat([Buffer.from(PREFERENCE_COMMAND_PREFIX), payload]))
    }

    sendClock(hours: number, minutes: number) {
        const payload = Device.preferencePayload()
        payload[CLOCK_HOURS_INDEX] = hours
        payload[CLOCK_MINUTES_INDEX] = minutes
        payload[CLOCK_HOUR_FORMAT_INDEX] = CLOCK_HOUR_FORMAT_24H
        this.sendPreference(payload)
    }

    sendBeeper(on: boolean) {
        const payload = Device.preferencePayload()
        payload[BEEPER_INDEX] = on ? BEEPER_ON : BEEPER_OFF
        this.sendPreference(payload)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fan_power') {
            this.fanSpeed = mqttValue === 'ON' ? this.fanSpeed || 1 : 0
            this.sendHoodCommand()
        } else if (prop === 'fan_speed') {
            const value = Number(mqttValue)
            if (!Number.isFinite(value)) return
            this.fanSpeed = Math.min(2, Math.max(0, Math.round(value)))
            this.sendHoodCommand()
        } else if (prop === 'light_power') {
            this.lightLevel = mqttValue === 'ON' ? this.lightLevel || 1 : 0
            this.sendHoodCommand()
        } else if (prop === 'light_level') {
            const value = Number(mqttValue)
            if (!Number.isFinite(value)) return
            this.lightLevel = Math.min(2, Math.max(0, Math.round(value)))
            this.sendHoodCommand()
        } else if (prop === 'clock_sync') {
            if (mqttValue !== 'PRESS') return
            const now = new Date()
            this.sendClock(now.getHours(), now.getMinutes())
        } else if (prop === 'beeper') {
            if (mqttValue === 'ON' || mqttValue === 'OFF') this.sendBeeper(mqttValue === 'ON')
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
