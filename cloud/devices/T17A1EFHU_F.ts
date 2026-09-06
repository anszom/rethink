import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x02: 'Paused',
    0x03: 'Sensing',
    0x05: 'Wash',
    0x06: 'Rinse',
    0x07: 'Spin',
    0x08: 'End',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: [...new Set(Object.values(STATUS))],
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        const mins = rec[4]
        const running = phase !== 0x00 && phase !== 0x08

        this.publishProperty('power', running ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS[phase] ?? 'unknown')
        this.publishProperty('remaining_time', running ? mins : 0)
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return

        // 0xDE: single status record (this model's equivalent of T1789's 0xEB/0xEC)
        if (buf[1] === 0xde && buf.length >= 29) {
            this.processRecord(buf.subarray(2, 29))
        }
    }
}
