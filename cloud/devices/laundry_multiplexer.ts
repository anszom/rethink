import AABBDevice, { AABBMultiplexer } from './aabb_device'
import { Device } from '../thinq2/device'
import { StreamImpl, type Stream } from '../thinq2/multiplexer'
import crc16 from '@/util/crc16'

type Callback = (response?: Buffer) => void
type Write = { stream: LaundryStream; inner: Buffer; body: object; callback?: Callback }
type Pending = { stream: LaundryStream; build: () => { inner: Buffer; body: object } | undefined; callback?: Callback }

// A timeout leaves replies without an owner. Only a new physical session can restore attribution.
const failedSessions = new WeakSet<Device>()
const WRITE_TIMEOUT = 3000

function unframe(packet: Buffer): Buffer | undefined {
    if (packet.length < 6 || packet[0] !== 0xaa || packet[packet.length - 1] !== 0xbb) return
    if (packet[1] === 0xff) {
        if (packet.length < 9 || packet.readUInt16BE(4) !== packet.length) return
        if (crc16(packet.subarray(0, -3)) !== packet.readUInt16BE(packet.length - 3)) return
        return packet.subarray(2, -3)
    }
    if (packet[1] !== packet.length) return
    const sum = packet.subarray(0, -2).reduce((a, b) => a + b, 0)
    if (((sum & 0xff) ^ 0x55) !== packet[packet.length - 2]) return
    return packet.subarray(2, -2)
}

// E5 values are byte-wide except for the dry/reservation time fields in captured bundles.
function properties(inner: Buffer): number[] | undefined {
    if (inner.length < 7 || !inner.subarray(2, 6).equals(Buffer.from([0, 2, 1, 0xff]))) return
    const props: number[] = []
    let at = 7
    for (let i = 0; i < inner[6]; i++) {
        const prop = inner[at]
        if (prop === undefined || props.includes(prop)) return
        props.push(prop)
        at += prop === 0x70 || prop === 0x7f ? 3 : 2
    }
    if (at !== inner.length) return
    return props
}

export class LaundryStream extends StreamImpl {
    destroyed = false

    constructor(readonly mux: LaundryMultiplexer) {
        super(mux)
        mux.dev.removeListener('rawData', this.onDataBound)
    }

    send(body: object, callback?: Callback) {
        if (this.destroyed) return callback?.()
        this.mux.send(this, body, callback)
    }

    queueWrite(builder: () => Buffer | undefined, callback?: Callback) {
        if (this.destroyed) return callback?.()
        this.mux.enqueue({
            stream: this,
            build: () => {
                const inner = builder()
                return inner && { inner: Buffer.from(inner), body: Device.packet(AABBDevice.frame(inner)) }
            },
            callback,
        })
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.mux.remove(this)
        this.removeAllListeners()
    }
}

/** The two laundry protocols have no transaction IDs: bridge and HA must share one FIFO. */
export class LaundryMultiplexer extends AABBMultiplexer {
    private streams = new Set<LaundryStream>()
    private queue: Pending[] = []
    private active?: Write
    private completed?: Write
    private timer?: ReturnType<typeof setTimeout>
    private delivering = false
    private draining = false
    private closed = false

    constructor(
        dev: Device,
        readonly classByte: number,
    ) {
        super(dev, true)
        dev.on('rawData', this.onData)
        dev.on('close', this.onClose)
    }

    override openStream(): LaundryStream {
        const stream = new LaundryStream(this)
        if (!this.closed) this.streams.add(stream)
        else stream.destroyed = true
        return stream
    }

    writeAnswered(type: number): { stream: Stream; inner: Buffer } | undefined {
        if (this.completed?.inner[1] === type) return this.completed
    }

    private tracked(inner: Buffer) {
        return (
            inner[0] === 0xf0 &&
            (inner[1] === 0xe5 || inner[1] === 0x24 || (this.classByte === 0x30 && inner[1] === 0xed))
        )
    }

    send(stream: LaundryStream, body: object, callback?: Callback) {
        const message = body as { cmd?: string; data?: unknown }
        const packet =
            message.cmd === 'packet' && typeof message.data === 'string' ? Buffer.from(message.data, 'hex') : undefined
        const inner = packet && unframe(packet)
        // A malformed tracked packet must not bypass serialization and reach the appliance.
        if (packet && this.tracked(packet.subarray(2)) && !inner) return callback?.()
        if (inner && this.tracked(inner)) {
            // Retain the bridge body verbatim; never rebuild it from HA's state.
            this.enqueue({ stream, build: () => ({ inner: Buffer.from(inner), body }), callback })
        } else {
            if (!this.closed) this.dev.sendRaw(body)
            callback?.()
        }
    }

    enqueue(pending: Pending) {
        if (this.closed || failedSessions.has(this.dev)) return pending.callback?.()
        this.queue.push(pending)
        this.drain()
    }

    remove(stream: LaundryStream) {
        this.streams.delete(stream)
        const cancelled = this.queue.filter((pending) => pending.stream === stream)
        this.queue = this.queue.filter((pending) => pending.stream !== stream)
        for (const pending of cancelled) pending.callback?.()
        // An already-sent write keeps its original owner until reply or timeout.
    }

    private drain() {
        if (this.draining) return
        this.draining = true
        try {
            while (
                this.queue.length &&
                !this.delivering &&
                !this.active &&
                !this.closed &&
                !failedSessions.has(this.dev)
            ) {
                const pending = this.queue.shift()!
                const built = pending.build()
                if (!built || this.closed || failedSessions.has(this.dev) || pending.stream.destroyed) {
                    pending.callback?.()
                    continue
                }
                this.active = { ...built, stream: pending.stream, callback: pending.callback }
                this.timer = setTimeout(() => this.fail(), WRITE_TIMEOUT)
                this.timer.unref()
                this.dev.sendRaw(built.body)
            }
        } finally {
            this.draining = false
        }
    }

    private matches(inner: Buffer, request: Buffer) {
        if (inner[0] !== this.classByte) return false
        if (request[1] === 0x24) return inner.length === 4 && inner[1] === 0 && inner[2] === 0x24
        if (request[1] === 0xed) {
            return inner.length === 13 + 42 && inner[1] === 0x0a && inner[10] === 0xeb && inner.readUInt16BE(11) === 42
        }
        if (request[1] !== 0xe5 || inner[1] !== 0xe6 || inner.length < 7) return false
        const props = properties(request)
        if (!props || inner[6] !== props.length || !inner.subarray(2, 6).equals(request.subarray(2, 6))) return false
        const recordLength = this.classByte === 0x30 ? 42 : 51
        if (inner.length !== 7 + props.length * 2 + recordLength) return false
        return props.every((prop, i) => inner[7 + 2 * i] === prop)
    }

    private onData = (packet: Buffer) => {
        const inner = unframe(packet)
        const answered = this.active && inner && this.matches(inner, this.active.inner) ? this.active : undefined
        if (answered) {
            clearTimeout(this.timer)
            this.timer = undefined
            this.active = undefined
        }
        this.delivering = true
        this.completed = answered
        // Busy replies can repeat for seconds. Quarantine before calling any external listener.
        const busy =
            answered &&
            inner?.[1] === 0xe6 &&
            Array.from({ length: inner[6] }, (_, i) => inner[8 + 2 * i]).includes(0x13)
        if (busy) failedSessions.add(this.dev)
        try {
            for (const stream of [...this.streams]) {
                if (!stream.destroyed) stream.emit('data', packet)
            }
            answered?.callback?.(packet)
        } finally {
            this.completed = undefined
            this.delivering = false
            if (busy) this.fail()
            this.drain()
        }
    }

    private fail() {
        failedSessions.add(this.dev)
        const cancelled = this.queue
        const active = this.active
        this.active = undefined
        this.queue = []
        clearTimeout(this.timer)
        this.timer = undefined
        active?.callback?.()
        for (const pending of cancelled) pending.callback?.()
    }

    private onClose = () => {
        this.closed = true
        this.dev.removeListener('rawData', this.onData)
        this.dev.removeListener('close', this.onClose)
        this.fail()
        for (const stream of this.streams) stream.destroy()
    }
}
