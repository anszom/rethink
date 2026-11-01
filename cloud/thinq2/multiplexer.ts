import { TypedEmitter } from 'tiny-typed-emitter'
import { Device } from './device'
import { ClipPayload } from './clip'
import { CommonMultiplexer, CommonStream, StreamEvents } from '../common'

export const StreamBase = TypedEmitter<StreamEvents<ClipPayload>>
export type Stream = CommonStream<ClipPayload, ClipPayload>

// Both a default implementation and a base for custom implementations.
// The default implementation performs no processing, it forwards data
// between the device and all streams simultaneously.
export class StreamImpl extends StreamBase implements Stream {
    readonly onPacketBound: (packet: ClipPayload) => void

    constructor(readonly mux: T2Multiplexer) {
        super()
        this.onPacketBound = this.onPacket.bind(this)
        mux.dev.on('rawPacket', this.onPacketBound)
    }

    onPacket(buf: ClipPayload) {
        this.emit('packet', buf)
    }

    send(body: ClipPayload) {
        this.mux.dev.sendRaw(body)
    }

    destroy() {
        this.mux.dev.removeListener('rawPacket', this.onPacketBound)
    }
}

// No destroy(), the Connection is not supposed to outlive the mux
export class T2Multiplexer implements CommonMultiplexer<ClipPayload, ClipPayload> {
    constructor(readonly dev: Device) {}

    openStream(): Stream {
        return new StreamImpl(this)
    }
}
