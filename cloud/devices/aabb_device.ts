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

// A write sent to the appliance: by us, or by the LG cloud while bridged
export type AwaitedWrite = { type: number; own: boolean; inner: Buffer }

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
        thinq.on('sendData', this.onSendData)
    }

    drop() {
        this.thinq.off('sendData', this.onSendData)
        clearTimeout(this.writeTimer)
        this.writeTimer = undefined
        this.writeQueue.length = 0
        this.awaiting.length = 0
        super.drop()
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
    // still being applied with result 0x13 (busy). While bridged, the LG cloud's writes pass through
    // send_packet too, so they are tracked like ours. The next write of ours goes out once every write sent
    // has been answered, or WRITE_TIMEOUT_MS after the last one went out. Entries build their bytes when
    // sent; undefined skips one.
    private readonly writeQueue: (() => Buffer | undefined)[] = []
    // Writes sent and not yet answered, oldest first, with their inner bytes. The replies carry no sequence
    // number, so each is taken to answer the oldest write of its type.
    private readonly awaiting: AwaitedWrite[] = []
    private writeTimer?: NodeJS.Timeout
    private sendingOwn = false
    static readonly WRITE_TIMEOUT_MS = 3000

    // The type of write an outgoing frame's inner bytes carry, if it is one the device answers; devices
    // that call queueWrite override this.
    protected writeType(inner: Buffer): number | undefined {
        return undefined
    }

    protected queueWrite(build: () => Buffer | undefined) {
        this.writeQueue.push(build)
        this.nextWrite()
    }

    // Call on a reply to a write of `type`: returns the write it answers, or undefined if none awaits one.
    // The next write goes out once processAABB returns, so a bundle built then includes what this one
    // changed.
    protected writeAnswered(type: number): AwaitedWrite | undefined {
        const i = this.awaiting.findIndex((w) => w.type === type)
        if (i < 0) return undefined
        const [write] = this.awaiting.splice(i, 1)
        if (this.awaiting.length === 0) {
            clearTimeout(this.writeTimer)
            this.writeTimer = undefined
        }
        return write
    }

    private nextWrite() {
        if (this.awaiting.length > 0) return
        let frame: Buffer | undefined
        while (frame === undefined && this.writeQueue.length > 0) frame = this.writeQueue.shift()!()
        if (frame === undefined) return
        this.sendingOwn = true
        try {
            this.send(frame)
        } finally {
            this.sendingOwn = false
        }
    }

    private readonly onSendData = (type: 'packet' | 'ack', buf: Buffer) => {
        if (type !== 'packet' || buf.length < 4 || buf[0] !== 0xaa || buf[buf.length - 1] !== 0xbb) return
        const inner = buf.subarray(2, buf.length - 2)
        const writeType = this.writeType(inner)
        if (writeType === undefined) return
        this.awaiting.push({ type: writeType, own: this.sendingOwn, inner: Buffer.from(inner) })
        clearTimeout(this.writeTimer)
        this.writeTimer = setTimeout(() => {
            this.awaiting.length = 0
            this.writeTimer = undefined
            this.nextWrite()
        }, AABBDevice.WRITE_TIMEOUT_MS).unref()
    }

    processData(buf: Buffer) {
        if (buf.length >= 4 && buf[0] == 0xaa && buf[buf.length - 1] == 0xbb) {
            const inner = buf.subarray(2, buf.length - 2)
            if (this.autoAck) this.ack(inner, buf[1] === LONG_FRAME)
            this.processAABB(inner)
            this.nextWrite()
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
