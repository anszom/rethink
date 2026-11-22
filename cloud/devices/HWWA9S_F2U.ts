import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import crc16 from '@/util/crc16'

// LG CordZero A9K stick vacuum, matched on modelId "HWWA9S_F2U" (thinq2 deviceType 504, sold as
// A9K-CORE3S). The Wi-Fi module sits in the handle and speaks AABB with class byte 0xD2.
//
// Status is a 12-byte record, one byte per field in the modelJson's MonitoringValue order, preceded by
// its 16-bit length (00 0c):
//   d2 eb 00 0c <record>                  reply to the status request
//   d2 ec 00 0c <previous> 00 0c <current> pushed on every change
//
// After connecting, the module runs a content sync: long-framed envelopes (d2 0a ...) with inner types
// 0x85 and 0x86, both carrying the ids VC-1..VC-4. The cloud acks each one and then answers with a
// 0x87 envelope holding a single 00. Unacked, the module resends 0x85 every couple of seconds, and if
// the sync never completes after provisioning it drops off Wi-Fi after 7 minutes.

const CLASS_BYTE = 0xd2
const RECORD_LEN = 12
// a record together with its 16-bit length prefix
const BLOCK_LEN = 2 + RECORD_LEN

const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const SYNC_LAST_TYPE = 0x86
const SYNC_REPLY_TYPE = 0x87

// Status query, as the cloud sends it on connect. 0xF0ED only reads.
const STATUS_REQUEST = 'F0ED1121010000001800'

const STATUS_OFFSET = 0
const CLEAN_MODE_OFFSET = 1
const FILTER_OFFSET = 2
const CLOGGED_OFFSET = 3
const BATTERY_OFFSET = 5

const STATUS = Enum.of({
    Ready: 1,
    Cleaning: 2,
    Charging: 3,
    'Fully charged': 4,
})

const CLEAN_MODE = Enum.of({
    Off: 1,
    Normal: 2,
    High: 3,
    Turbo: 4,
    Mop: 5,
})

const BATTERY = Enum.of({
    High: 1,
    Medium: 2,
    Low: 3,
    Warning: 4,
})

// AA FF <inner> <crc16> BB, where inner[2..3] is the whole frame length and the CRC is
// CRC-16/XMODEM over everything before it.
function longFrame(inner: Buffer): Buffer {
    const packet = Buffer.concat([Buffer.from([0xaa, 0xff]), inner, Buffer.alloc(3)])
    packet.writeUInt16BE(packet.length, 4)
    packet.writeUInt16BE(crc16(packet.subarray(0, packet.length - 3)), packet.length - 3)
    packet[packet.length - 1] = 0xbb
    return packet
}

export default class Device extends AABBDevice {
    syncSeq = 0

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Stick Vacuum' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:vacuum',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    battery: {
                        platform: 'sensor',
                        unique_id: '$deviceid-battery',
                        state_topic: '$this/battery',
                        name: 'Battery',
                        icon: 'mdi:battery',
                        device_class: 'enum',
                        options: BATTERY.options,
                    },
                    clean_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-clean_mode',
                        state_topic: '$this/clean_mode',
                        name: 'Power mode',
                        icon: 'mdi:fan',
                        device_class: 'enum',
                        options: CLEAN_MODE.options,
                    },
                    filter: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-filter',
                        state_topic: '$this/filter',
                        name: 'Filter needs cleaning',
                        device_class: 'problem',
                    },
                    clogged: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-clogged',
                        state_topic: '$this/clogged',
                        name: 'Air path clogged',
                        device_class: 'problem',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (this.processCommonStatus(buf, CLASS_BYTE, BLOCK_LEN, this.processStatus)) return

        if (buf[0] === CLASS_BYTE && buf[1] === ENVELOPE_TYPE && buf[INNER_TYPE_OFFSET] === SYNC_LAST_TYPE)
            this.completeSync()
    }

    completeSync() {
        this.syncSeq = (this.syncSeq + 1) & 0xffff
        const inner = Buffer.from([0xf0, 0x0b, 0, 0, 0x00, 0, 0, 0x00, 0x01, 0x0a, SYNC_REPLY_TYPE, 0x00, 0x01, 0x00])
        inner.writeUInt16BE(this.syncSeq, 5)
        this.thinq.send_packet(longFrame(inner))
    }

    processStatus(block: Buffer) {
        const rec = block.subarray(2)
        this.publishProperty('status', STATUS.map(rec[STATUS_OFFSET]))
        this.publishProperty('clean_mode', CLEAN_MODE.map(rec[CLEAN_MODE_OFFSET]))
        this.publishProperty('battery', BATTERY.map(rec[BATTERY_OFFSET]))
        this.publishProperty('filter', rec[FILTER_OFFSET] === 2 ? 'ON' : rec[FILTER_OFFSET] === 1 ? 'OFF' : undefined)
        this.publishProperty(
            'clogged',
            rec[CLOGGED_OFFSET] === 2 ? 'ON' : rec[CLOGGED_OFFSET] === 1 ? 'OFF' : undefined,
        )
    }

    setProperty(prop: string, mqttValue: string) {}
}
