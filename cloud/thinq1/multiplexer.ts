import { TypedEmitter } from 'tiny-typed-emitter'
import { Device } from './device'
import { isDevInfo, isMonStart, isMonStop, isStatus, MessageBody, MON_START, MON_STOP } from './connection'

type StreamEvents = {
    data: (body: MessageBody) => void
}

export interface Stream extends TypedEmitter<StreamEvents> {
    // the callback will be called when a protocol-specific response is received (or timed out)
    send(body: object, callback?: (response?: MessageBody) => void): void
    destroy(): void
}

// Both a default implementation and a base for custom implementations.
// The default implementation:
// - coalesces mon start/stop requests from multiple streams into one
// - delivers the cached DevInfo & status message for late-starting streams (bridge)
export class StreamImpl extends TypedEmitter<StreamEvents> implements Stream {
    readonly onDataBound: (body: MessageBody) => void
    isLive: boolean = false // between the 'Start' & 'Stop' command
    initMessage?: NodeJS.Immediate

    constructor(readonly mux: Multiplexer) {
        super()
        this.onDataBound = this.onData.bind(this)
        mux.dev.on('rawData', this.onDataBound)

        // send the devInfo packet at startup, but defer it so that the caller can bind the signal
        const devInfo = mux.devInfo
        if (devInfo) this.initMessage = setImmediate(() => this.emit('data', devInfo))
    }

    onData(body: MessageBody) {
        if (!isStatus(body) || this.isLive) this.emit('data', body)
    }

    send(body: object, callback?: () => void) {
        if (isMonStart(body)) {
            if (!this.isLive) {
                this.isLive = true
                const lastStatus = this.mux.start()

                if (lastStatus) this.emit('data', lastStatus)
            }
        } else if (isMonStop(body)) {
            if (this.isLive) {
                this.isLive = false
                this.mux.stop()
            }
        } else {
            this.mux.send(body)
        }

        if (callback) callback()
    }

    destroy() {
        if (this.isLive) {
            this.mux.stop()
            this.isLive = false
        }

        if (this.initMessage) clearImmediate(this.initMessage)

        this.mux.dev.removeListener('rawData', this.onDataBound)
    }
}

// No destroy(), the Connection is not supposed to outlive the mux
export class Multiplexer {
    constructor(readonly dev: Device) {
        this.dev.on('rawData', (body) => {
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

    send(body: object) {
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
