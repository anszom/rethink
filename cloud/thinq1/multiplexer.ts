import { TypedEmitter } from 'tiny-typed-emitter'
import { Device } from './device'
import { isDevInfo, isMonStart, isMonStop, isStatus, MessageBody, MON_START, MON_STOP } from './rti'
import type { CommonMultiplexer, CommonStream, StreamEvents } from '../common'

export type Stream = CommonStream<MessageBody, MessageBody>

// Both a default implementation and a base for custom implementations.
// The default implementation:
// - coalesces mon start/stop requests from multiple streams into one
// - delivers the cached DevInfo & status message for late-starting streams (bridge)
export class StreamImpl extends TypedEmitter<StreamEvents<MessageBody>> implements Stream {
    readonly onPacketBound: (body: MessageBody) => void
    isLive: boolean = false // between the 'Start' & 'Stop' command
    initMessage?: NodeJS.Immediate

    constructor(readonly mux: Multiplexer) {
        super()
        this.onPacketBound = this.onData.bind(this)
        mux.dev.on('rawPacket', this.onPacketBound)

        // send the devInfo packet at startup, but defer it so that the caller can bind the signal
        const devInfo = mux.devInfo
        if (devInfo) this.initMessage = setImmediate(() => this.emit('packet', devInfo))
    }

    onData(body: MessageBody) {
        if (!isStatus(body) || this.isLive) this.emit('packet', body)
    }

    send(body: MessageBody) {
        if (isMonStart(body)) {
            if (!this.isLive) {
                this.isLive = true
                const lastStatus = this.mux.start()

                if (lastStatus) this.emit('packet', lastStatus)
            }
        } else if (isMonStop(body)) {
            if (this.isLive) {
                this.isLive = false
                this.mux.stop()
            }
        } else {
            this.mux.send(body)
        }
    }

    destroy() {
        if (this.isLive) {
            this.mux.stop()
            this.isLive = false
        }

        if (this.initMessage) clearImmediate(this.initMessage)

        this.mux.dev.removeListener('rawPacket', this.onPacketBound)
    }
}

// No destroy(), the Connection is not supposed to outlive the mux
export class Multiplexer implements CommonMultiplexer<MessageBody, MessageBody> {
    constructor(readonly dev: Device) {
        this.dev.on('rawPacket', (body) => {
            // record the devInfo packet
            if (isDevInfo(body)) this.devInfo = body
            // record the last status received - but only while monitor mode is enabled
            if (this.monitoringStreams > 0 && isStatus(body)) this.lastStatus = body
        })
    }

    devInfo: MessageBody | undefined
    lastStatus: MessageBody | undefined

    openStream() {
        return new StreamImpl(this)
    }

    send(body: MessageBody) {
        this.dev.sendRaw(body)
    }

    monitoringStreams: number = 0

    // returns an optional pre-recorded status message to be injected into the stream
    start() {
        if (this.monitoringStreams++ === 0) {
            this.send(MON_START)
            // no pre-recorded message, we're requesting the first one now
        } else return this.lastStatus
    }

    stop() {
        if (--this.monitoringStreams === 0) {
            this.send(MON_STOP)
            this.lastStatus = undefined
        }
    }
}
