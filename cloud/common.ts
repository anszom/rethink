import { TypedEmitter } from 'tiny-typed-emitter'
import { Metadata } from './thinq'

export type StreamEvents<Rx> = {
    // raw transport-layer packets, some kind of JSON
    packet: (body: Rx) => void
}

// This is a generic interface to be used by the bridge or simple drivers
// Advanced drivers can use their own interface for more complex operations
// such as write-with-acknowledgement-callback etc.
export interface CommonStream<Rx, Tx> extends TypedEmitter<StreamEvents<Rx>> {
    send(body: Tx): void
    destroy(): void
}

export interface CommonMultiplexer<Rx, Tx> {
    openStream: () => CommonStream<Rx, Tx>
}

type DeviceEvents<Rx, Tx> = {
    // `raw` events should only be used for diagnostics or by the multiplexer class,
    // Device drivers should only use them as a last resort, if they need to tap into
    // exchanges done by the bridge module.
    rawPacket: (body: Rx) => void
    sendRawPacket: (body: Tx) => void
    // Only ThinQ1 emits this (HTTP diagnostics reports); declared here so that code handling either
    // platform can subscribe without a type check.
    diagmon: (diagMonType: string, decoded: unknown) => void

    close: () => void
}

export class CommonDevice<Rx, Tx> extends TypedEmitter<DeviceEvents<Rx, Tx>> {
    managed: boolean = false // set to true if any rethink handler is assigned to the device

    private mux: CommonMultiplexer<Rx, Tx> | undefined

    constructor(
        readonly id: string,
        readonly meta: Metadata,
    ) {
        super()
    }

    setMux(mux: CommonMultiplexer<Rx, Tx>) {
        if (this.mux) throw new Error('Multiplexer already set')

        this.mux = mux
    }

    protected createDefaultMux(): CommonMultiplexer<Rx, Tx> {
        throw new Error('To be overriden')
    }

    private getMux(): CommonMultiplexer<Rx, Tx> {
        if (!this.mux) this.mux = this.createDefaultMux()

        return this.mux!
    }

    openStream() {
        return this.getMux().openStream()
    }

    ensureMux() {
        this.getMux()
    }
}
