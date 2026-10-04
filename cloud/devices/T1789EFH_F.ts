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

// Status query, as the other US washers send it on every connect (F3L7CYK5W_US_WIFI). 0xF0ED is the
// family-wide "report your state" request; actuating commands are 0xF0E5, so this only ever reads.
// Without it this washer never volunteers its 0xEB/0xEC records to a locally provisioned rethink.
const STATUS_REQUEST = 'F0ED1121010000001800'

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // The WT7300CW needs the cloud's acks: unacked, it repeats every frame ~10x, re-deploys, and never
        // streams its 0xEC status records - so a locally provisioned washer stays 'unknown' through a cycle.
        super(HA, thinq, true)
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

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        const mins = rec[4]

        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('status', STATUS.map(phase))
        this.publishProperty('remaining_time', mins)
    }

    processAABB(buf: Buffer) {
        // 27-byte records; 0xEB is sent after reconnect
        this.processCommonStatus(buf, 0x20, 27, this.processRecord)
    }
}
