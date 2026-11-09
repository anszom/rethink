import HADevice from './base'
import AABBDevice from './aabb_device'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import {
    convertFridgeTemperature,
    convertFreezerTemperature,
    fridgeRange,
    freezerRange,
    unpackStatus,
} from './fridge_common'

// GBBSJ11ESW, captured locally with clip_ble_v1.9.225. The 95-byte
// record starts with the common fridge layout. Panel sweeps confirmed all
// Celsius setpoints, Super Freeze [3], Vacation [12], Super Cool [16], and
// fridge door [7]. Opening only the freezer produced no door event.
// The 118-byte F017 command was verified locally in both directions for
// all five controls, with appliance readback and physical panel confirmation.
const STATUS_LENGTH = 95
const COMMAND_LENGTH = 118
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

export default class Device extends AABBDevice {
    private celsius = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // This unit repeats C5/AF telemetry ten times without the shared ACK.
        super(HA, thinq, true)
        const temperature = (name: string, key: string) => ({
            platform: 'sensor' as const,
            device_class: 'temperature' as const,
            unit_of_measurement: '°C',
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
        })
        const temperatureControl = (name: string, key: string, stateKey: string, range: object) => ({
            platform: 'number' as const,
            device_class: 'temperature' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${stateKey}`,
            command_topic: `$this/${stateKey}/set`,
            name,
            step: 1,
            ...range,
        })
        const mode = (name: string, key: string, icon: string) => ({
            platform: 'switch' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            command_topic: `$this/${key}/set`,
            name,
            icon,
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Fridge', model: 'GBBSJ11ESW' }),
                components: {
                    fridge_setpoint: temperature('Fridge target temperature', 'fridge_setpoint'),
                    freezer_setpoint: temperature('Freezer target temperature', 'freezer_setpoint'),
                    // Keep the existing sensor IDs and topics; add controls separately.
                    fridge_temperature: temperatureControl(
                        'Fridge temperature',
                        'fridge_temperature',
                        'fridge_setpoint',
                        fridgeRange('C'),
                    ),
                    freezer_temperature: temperatureControl(
                        'Freezer temperature',
                        'freezer_temperature',
                        'freezer_setpoint',
                        freezerRange('C'),
                    ),
                    super_cool: mode('Super Cool', 'super_cool', 'mdi:snowflake-variant'),
                    express_freeze: mode('Super Freeze', 'express_freeze', 'mdi:snowflake'),
                    vacation: mode('Vacation', 'vacation', 'mdi:airplane'),
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Fridge door',
                    },
                },
            }),
        )
    }

    start() {
        // Existing LG fridge status request, verified against this unit.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x10, STATUS_LENGTH, this.processStatus)
    }

    processStatus(status: Buffer) {
        const s = unpackStatus(status)
        const celsius = s.tempUnit === 1
        this.celsius = celsius
        this.publishProperty(
            'fridge_setpoint',
            celsius && s.fridgeSetpoint >= 1 && s.fridgeSetpoint <= 7
                ? convertFridgeTemperature('C', s.fridgeSetpoint)
                : undefined,
        )
        this.publishProperty(
            'freezer_setpoint',
            celsius && s.freezerSetpoint >= 1 && s.freezerSetpoint <= 9
                ? convertFreezerTemperature('C', s.freezerSetpoint)
                : undefined,
        )
        this.publishProperty('door', s.anyDoorOpen === 1 ? 'ON' : s.anyDoorOpen === 2 ? 'OFF' : undefined)
        this.publishProperty('super_cool', s.expressCool === 1 ? 'ON' : s.expressCool === 0 ? 'OFF' : undefined)
        this.publishProperty('express_freeze', s.expressFreeze === 2 ? 'ON' : s.expressFreeze === 1 ? 'OFF' : undefined)
        this.publishProperty('vacation', s.ecoFriendly === 1 ? 'ON' : s.ecoFriendly === 0 ? 'OFF' : undefined)
    }

    setProperty(prop: string, mqttValue: string) {
        // Only the Celsius command path has been physically validated.
        if (!this.celsius) return
        const fields: Record<number, number> = {}
        if (prop === 'fridge_setpoint' || prop === 'freezer_setpoint') {
            // HA's number platform can serialize an integer setpoint as "4.0".
            if (!/^-?\d+(?:\.\d+)?$/.test(mqttValue)) return
            const value = Number(mqttValue)
            const range = prop === 'fridge_setpoint' ? fridgeRange('C') : freezerRange('C')
            if (!Number.isInteger(value) || value < range.min || value > range.max) return
            fields[prop === 'fridge_setpoint' ? 1 : 2] =
                prop === 'fridge_setpoint'
                    ? convertFridgeTemperature('C', value)
                    : convertFreezerTemperature('C', value)
            fields[8] = 1
        } else if (prop === 'super_cool' || prop === 'express_freeze' || prop === 'vacation') {
            if (mqttValue !== 'ON' && mqttValue !== 'OFF') return
            const on = mqttValue === 'ON'
            if (prop === 'express_freeze') fields[3] = on ? 2 : 1
            else fields[prop === 'super_cool' ? 16 : 12] = on ? 1 : 0
        } else return

        const payload = Buffer.alloc(COMMAND_LENGTH, 0xff)
        for (const [index, value] of Object.entries({ ...COMMAND_FIXED, ...fields })) payload[Number(index)] = value
        this.send(Buffer.concat([Buffer.from([0xf0, 0x17]), payload]))
    }
}
