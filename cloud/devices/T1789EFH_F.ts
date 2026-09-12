import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

const STATUS = Enum.of({
    Off: 0x00,
    'Fill / Sense': 0x01,
    Paused: 0x02,
    'Wash (initial)': 0x03,
    'Wash (main)': 0x05,
    'Rinse / Drain': [0x06, 0x07],
    Spin: 0x08,
})

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
                        options: STATUS.options,
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

        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS.map(phase))
        this.publishProperty('remaining_time', mins)
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return

        if (buf[1] === 0xec && buf.length === 56) {
            // 0xEC: two back-to-back 27-byte records (current + previous); use current
            this.processRecord(buf.subarray(2, 29))
        } else if (buf[1] === 0xeb && buf.length === 29) {
            // 0xEB: single record sent after reconnect
            this.processRecord(buf.subarray(2, 29))
        }
    }
}
