// base implementation for devices with a AA...BB payload format
import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'

// Frame types the cloud does not ack: the appliance's own acks, the c3 heartbeat, and the eb/ec status
// records outside an envelope. Checked against the cloud, bridged as FAFXU22007 and Y_VB_Y___W.B32QEUK.
const UNACKED_TYPES = new Set([0x00, 0xc3, 0xeb, 0xec])
const FRAME_TYPE_ENVELOPE = 0x0a
const ENVELOPE_SEQ_OFFSET = 5
const ENVELOPE_INNER_TYPE_OFFSET = 10
const ENVELOPE_INNER_LEN_OFFSET = 11
// the envelope header, up to and including the 16-bit inner length; the cloud ignores anything shorter
const ENVELOPE_MIN_LEN = 13
// AA FF marks the long framing, whose 16-bit checksum leaves one byte on the end of `inner`
const LONG_FRAME = 0xff

// f0 00 <type> 04 [<seq16>], sent under the MQTT `ack` command. `00` in place of `04`, or `packet` in
// place of `ack`, stops the retransmits but leaves the content sync re-running every 5 s.
const CLOUD_ACK = [0xf0, 0x00]
const CLOUD_ACK_STATUS = 0x04

export default class AABBDevice extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        // Ack every frame as the cloud would. Unacked, some appliances repeat each frame up to ten times and
        // the content sync never completes. Recommended: `true` for all new devices.
        readonly autoAck: boolean,
    ) {
        super(HA, thinq.id, thinq.meta.modelId)
        thinq.on('data', (data) => this.processData(data))
    }

    // AA [length] ...inner [checksum] BB
    static frame(inner: Buffer): Buffer {
        const packet = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0x00])])
        const sum = packet.reduce((pv, cv) => pv + cv, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        packet[packet.length - 1] = 0xbb
        return packet
    }

    send(inner: Buffer) {
        this.thinq.send_packet(AABBDevice.frame(inner))
    }

    processData(buf: Buffer) {
        if (buf.length >= 4 && buf[0] == 0xaa && buf[buf.length - 1] == 0xbb) {
            const inner = buf.subarray(2, buf.length - 2)
            if (this.autoAck) this.ack(inner, buf[1] === LONG_FRAME)
            this.processAABB(inner)
        }
    }

    // Envelopes (<class> 0a ...) are acked by sequence number, whatever their delivery class; other
    // types by type.
    private ack(inner: Buffer, longFrame: boolean) {
        const type = inner[1]
        if (UNACKED_TYPES.has(type)) return
        if (type === FRAME_TYPE_ENVELOPE) {
            if (inner.length - (longFrame ? 1 : 0) < ENVELOPE_MIN_LEN) return
            const seq = inner.subarray(ENVELOPE_SEQ_OFFSET, ENVELOPE_SEQ_OFFSET + 2)
            this.thinq.send_ack(AABBDevice.frame(Buffer.from([...CLOUD_ACK, type, CLOUD_ACK_STATUS, ...seq])))
        } else {
            this.thinq.send_ack(AABBDevice.frame(Buffer.from([...CLOUD_ACK, type, CLOUD_ACK_STATUS])))
        }
    }

    processAABB(buf: Buffer) {
        throw new Error('To be overriden')
    }

    // 0xEB/0xEC is a pattern used in nearly all AABB devices. Call this in your processAABB handler
    // `handler` will commonly be this.processStatus, so it is called with `this` bound.
    processCommonStatus(buf: Buffer, classByte: number, statusLength: number, handler: (status: Buffer) => void) {
        // XX EB [status block]
        if (buf[0] === classByte && buf[1] == 0xeb && buf.length === 2 + statusLength) {
            handler.call(this, buf.subarray(2))
            return true
        }

        // XX EC [previous block] [status block]
        if (buf[0] === classByte && buf[1] == 0xec && buf.length === 2 + statusLength * 2) {
            handler.call(this, buf.subarray(2 + statusLength))
            return true
        }

        return false
    }

    // Some appliances wrap the EB/EC records in an envelope instead; same `handler` contract as above.
    processEnvelopedStatus(buf: Buffer, classByte: number, statusLength: number, handler: (status: Buffer) => void) {
        // XX 0a [len16] [seq16] .. .. .. [EB/EC] [inner len16] [records] (+ the long framing's checksum byte)
        if (buf.length < ENVELOPE_MIN_LEN || buf[0] !== classByte || buf[1] !== FRAME_TYPE_ENVELOPE) return false

        const innerLen = buf.readUInt16BE(ENVELOPE_INNER_LEN_OFFSET)
        // anything past the records, other than that one checksum byte, means the layout isn't what we think
        const trailing = buf.length - ENVELOPE_MIN_LEN - innerLen
        if (trailing !== 0 && trailing !== 1) return false
        const records = buf.subarray(ENVELOPE_MIN_LEN, ENVELOPE_MIN_LEN + innerLen)

        const type = buf[ENVELOPE_INNER_TYPE_OFFSET]
        if (type === 0xeb && innerLen === statusLength) {
            handler.call(this, records)
            return true
        }

        if (type === 0xec && innerLen === statusLength * 2) {
            handler.call(this, records.subarray(statusLength))
            return true
        }

        return false
    }
}
