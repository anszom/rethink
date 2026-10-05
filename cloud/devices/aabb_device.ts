// base implementation for devices with a AA...BB payload format
import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'

// Frame types the cloud does not ack: the appliance's own acks, the c3 heartbeat, and the eb/ec status
// records outside an envelope. Checked against the cloud, bridged as FAFXU22007 and Y_VB_Y___W.B32QEUK.
const UNACKED_TYPES = new Set([0x00, 0xc3, 0xeb, 0xec])
const FRAME_TYPE_ENVELOPE = 0x0a
const ENVELOPE_SEQ_OFFSET = 5
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
        super(HA, thinq.id)
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

    // One write at a time: the LG laundry machines answer a write that arrives while the previous one is
    // still being applied with result 0x13 (busy). The next write goes out on the reply to the last, or
    // after WRITE_TIMEOUT_MS. Entries build their bytes when sent; undefined skips one.
    private readonly writeQueue: (() => Buffer | undefined)[] = []
    private writeTimer?: NodeJS.Timeout
    static readonly WRITE_TIMEOUT_MS = 3000

    protected queueWrite(build: () => Buffer | undefined) {
        this.writeQueue.push(build)
        if (!this.writeTimer) this.nextWrite()
    }

    protected writeAnswered() {
        clearTimeout(this.writeTimer)
        this.writeTimer = undefined
        this.nextWrite()
    }

    private nextWrite() {
        let frame: Buffer | undefined
        while (frame === undefined && this.writeQueue.length > 0) frame = this.writeQueue.shift()!()
        if (frame === undefined) return
        this.send(frame)
        this.writeTimer = setTimeout(() => this.writeAnswered(), AABBDevice.WRITE_TIMEOUT_MS).unref()
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
}
