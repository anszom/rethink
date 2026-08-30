import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const STATUS: Record<number, string> = {
    0x00: 'Idle',
    0x02: 'Cooking',
    0x04: 'Paused',
    0x05: 'Done',
    0x07: 'Ready to start',
}

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
                        icon: 'mdi:microwave',
                        device_class: 'enum',
                        options: Object.values(STATUS),
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
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

        this.publishProperty('status', STATUS[state] ?? 'unknown')
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
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
