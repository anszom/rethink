// For AABB appliances that take one write at a time: the LG laundry machines answer a write that arrives while
// the previous one is still being applied with result 0x13 (busy). The driver and the bridge each have a stream
// and their writes share one queue, so neither can trip over the other's.
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { StreamBase, type Stream } from '../thinq2/multiplexer'
import AABBDevice, { AABBMultiplexer } from './aabb_device'
import { ClipPayload, fromRxPacket, fromTxPacket, txPacket } from '../thinq2/clip'

// All frames here are the inner bytes, between the AA [length] and the [checksum] BB.
export type WriteProtocol = {
    // Whether the appliance answers this outgoing frame. Anything else goes straight out.
    isWrite(inner: Buffer): boolean
    // Whether an incoming frame answers `write`. Replies carry no sequence number, but only one write is ever out.
    isReply(inner: Buffer, write: Buffer): boolean
}

type ReplyCallback = (reply?: Buffer) => void

export class WriteQueueStream extends StreamBase implements Stream {
    constructor(readonly mux: WriteQueueMultiplexer) {
        super()
    }

    // The callback gets the reply's inner bytes, or nothing if the write timed out or wasn't one.
    send(packet: ClipPayload) {
        this.mux.send(this, packet)
    }

    // As send(), for a body to be built when its turn comes, from what the writes ahead of it changed.
    // undefined skips it, and the callback isn't called.
    sendDeferred(build: () => ClipPayload | undefined, callback?: ReplyCallback) {
        this.mux.enqueue(this, build, callback)
    }

    // A write already sent is still waited for, as the appliance is still applying it.
    destroy() {
        this.mux.removeStream(this)
    }
}

type InFlightWrite = {
    stream: WriteQueueStream
    inner: Buffer
    timeout: NodeJS.Timeout
    callback?: ReplyCallback
}

type QueuedWrite = {
    stream: WriteQueueStream
    build: () => ClipPayload | undefined
    callback?: ReplyCallback
}

// The next write goes out when the the last is answered/timed out. A reply reaches, as `packet`, only the stream
// that sent the write, or no stream if that one is gone; everything else the appliance sends goes to all streams,
// as with the default multiplexer. Writes injected from the management interface bypass the multiplexer.
export class WriteQueueMultiplexer extends AABBMultiplexer {
    static readonly WRITE_TIMEOUT_MS = 3000

    private readonly streams = new Set<WriteQueueStream>()
    private queue: QueuedWrite[] = []
    private inFlight?: InFlightWrite
    private delivering = false

    constructor(
        dev: Thinq2Device,
        autoAck: boolean,
        readonly protocol: WriteProtocol,
    ) {
        super(dev, autoAck)
        dev.on('rawPacket', (packet) => this.onRawPacket(packet))
        dev.on('close', () => {
            this.queue.length = 0
            this.takeInFlight()
        })
    }

    openStream() {
        const stream = new WriteQueueStream(this)
        this.streams.add(stream)
        return stream
    }

    removeStream(stream: WriteQueueStream) {
        this.streams.delete(stream)
        this.queue = this.queue.filter((el) => el.stream !== stream)
        if (this.inFlight?.stream === stream) this.inFlight.callback = undefined
    }

    send(stream: WriteQueueStream, packet: ClipPayload) {
        if (!this.streams.has(stream)) return

        const inner = AABBDevice.unframe(fromTxPacket(packet))
        if (inner && this.protocol.isWrite(inner)) {
            // add to write queue
            this.enqueue(stream, () => packet)
        } else {
            // pass through directly
            this.dev.sendRaw(packet)
        }
    }

    enqueue(stream: WriteQueueStream, build: () => ClipPayload | undefined, callback?: ReplyCallback) {
        if (!this.streams.has(stream)) return
        this.queue.push({ stream, build, callback })
        this.pump()
    }

    private pump() {
        while (!this.inFlight && !this.delivering && this.queue.length > 0) {
            const { stream, build, callback } = this.queue.shift()!
            const packet = build()
            if (packet === undefined) continue

            const inner = AABBDevice.unframe(fromTxPacket(packet))
            const isWrite = inner !== undefined && this.protocol.isWrite(inner)
            if (isWrite) {
                const timeout = setTimeout(() => {
                    this.takeInFlight()?.callback?.()
                    this.pump()
                }, WriteQueueMultiplexer.WRITE_TIMEOUT_MS).unref()

                this.inFlight = {
                    stream,
                    inner: Buffer.from(inner),
                    callback,
                    timeout,
                }
            }
            this.dev.sendRaw(packet)
            if (!isWrite) callback?.()
        }
    }

    private takeInFlight() {
        const write = this.inFlight
        this.inFlight = undefined
        if (write) clearTimeout(write.timeout)
        return write
    }

    // The next write goes out only once the frame has been delivered, so one built then includes what the
    // answered write changed.
    private onRawPacket(packet: ClipPayload) {
        let buf = fromRxPacket(packet)
        if (!buf) return

        this.delivering = true
        try {
            const inner = AABBDevice.unframe(buf)
            if (inner && this.inFlight && this.protocol.isReply(inner, this.inFlight.inner)) {
                const write = this.takeInFlight()!
                write.callback?.(inner)
                if (this.streams.has(write.stream)) write.stream.emit('packet', packet)
            } else {
                for (const stream of this.streams) stream.emit('packet', packet)
            }
        } finally {
            this.delivering = false
            this.pump()
        }
    }
}

export default class WriteQueueDevice extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, protocol: WriteProtocol) {
        super(HA, thinq, new WriteQueueMultiplexer(thinq, true, protocol))
    }

    private get writes() {
        return this.stream as WriteQueueStream
    }

    drop() {
        this.stream.destroy()
        super.drop()
    }

    // `build` runs when the write's turn comes, so it can use what the writes ahead of it changed; undefined
    // skips it. The callback runs on the reply to this write alone.
    protected queueWrite(build: () => Buffer | undefined, callback?: ReplyCallback) {
        this.writes.sendDeferred(() => {
            const inner = build()
            return inner && txPacket(AABBDevice.frame(inner))
        }, callback)
    }
}
