// base implementation for devices with a AA...BB payload format
import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'

// The cloud acks neither of these.
const FRAME_TYPE_ACK = 0x00
const FRAME_TYPE_HEARTBEAT = 0xc3
const FRAME_TYPE_ENVELOPE = 0x0a
const ENVELOPE_SEQ_OFFSET = 5
const ENVELOPE_MIN_LEN = 13

// f0 00 <type> 04 [<seq16>], sent under the MQTT `ack` command. `00` in place of `04`, or `packet` in
// place of `ack`, stops the retransmits but leaves the content sync re-running every 5 s.
const CLOUD_ACK = [0xf0, 0x00]
const CLOUD_ACK_STATUS = 0x04

export default class AABBDevice extends HADevice {
    publishCache = new Map<string, string | number | undefined>()

    // Ack every frame as the cloud would. Unacked, the appliance repeats each frame up to ten times and
    // its content sync never completes, after which it stops sending status records. Silent while
    // bridged: the cloud's own acks are forwarded then.
    protected readonly deliveryAcks: boolean = false

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
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
            if (this.deliveryAcks && !this.thinq.bridged) this.ack(inner)
            this.processAABB(inner)
        }
    }

    // Envelopes (<class> 0a ...) are acked by sequence number, whatever their delivery class; other
    // types by type.
    private ack(inner: Buffer) {
        const type = inner[1]
        if (type === FRAME_TYPE_ACK || type === FRAME_TYPE_HEARTBEAT) return
        if (type === FRAME_TYPE_ENVELOPE) {
            if (inner.length < ENVELOPE_MIN_LEN) return
            const seq = inner.subarray(ENVELOPE_SEQ_OFFSET, ENVELOPE_SEQ_OFFSET + 2)
            this.thinq.send_ack(AABBDevice.frame(Buffer.from([...CLOUD_ACK, type, CLOUD_ACK_STATUS, ...seq])))
        } else {
            this.thinq.send_ack(AABBDevice.frame(Buffer.from([...CLOUD_ACK, type, CLOUD_ACK_STATUS])))
        }
    }

    processAABB(buf: Buffer) {
        throw new Error('To be overriden')
    }

    // to be called by processAABB
    publishProperty(prop: string, value: string | number | undefined) {
        // has() first: an undefined value on a never-published property must still go out
        if (this.publishCache.has(prop) && this.publishCache.get(prop) === value) return

        this.publishCache.set(prop, value)
        this.HA.publishProperty(this.id, prop, value)
    }
}
