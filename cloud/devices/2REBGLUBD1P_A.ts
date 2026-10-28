import HADevice from './base'
import AABBDevice from './aabb_device'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { convertFridgeTemperature, convertFreezerTemperature } from './fridge_common'

// GBBSJ11ESW, captured locally with clip_ble_v1.9.225. The 95-byte
// record starts with the usual fridge fields. Only Celsius and door
// values observed on this appliance are exposed. Temperatures are setpoints.
// Offsets: [1] fridge target, [2] freezer target, [7] door (1=open,
// 2=closed), [8] unit (1=Celsius). A 10 EC frame holds old + new records.
// Confirmed at 3 C / -18 C, including a physical fridge-door open/close.
const STATUS_LENGTH = 95

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        const temperature = (name: string, key: string) => ({
            platform: 'sensor' as const,
            device_class: 'temperature' as const,
            unit_of_measurement: '°C',
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Fridge', model: 'GBBSJ11ESW' }),
                components: {
                    fridge_setpoint: temperature('Fridge target temperature', 'fridge_setpoint'),
                    freezer_setpoint: temperature('Freezer target temperature', 'freezer_setpoint'),
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

    processData(buf: Buffer) {
        if (buf.length < 6 || buf[0] !== 0xaa || buf[1] !== buf.length || buf[buf.length - 1] !== 0xbb) return
        const checksum = (buf.subarray(0, -2).reduce((sum, byte) => sum + byte, 0) & 0xff) ^ 0x55
        if (checksum !== buf[buf.length - 2]) return
        super.processData(buf)
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x10, STATUS_LENGTH, this.processStatus)
    }

    processStatus(status: Buffer) {
        const celsius = status[8] === 1
        this.publishProperty(
            'fridge_setpoint',
            celsius && status[1] >= 1 && status[1] <= 7 ? convertFridgeTemperature('C', status[1]) : undefined,
        )
        this.publishProperty(
            'freezer_setpoint',
            celsius && status[2] >= 1 && status[2] <= 9 ? convertFreezerTemperature('C', status[2]) : undefined,
        )
        this.publishProperty('door', status[7] === 1 ? 'ON' : status[7] === 2 ? 'OFF' : undefined)
    }

    // No control commands are exposed until their wire format is captured.
    setProperty(_prop: string, _value: string) {}
}
