import { TypedEmitter } from 'tiny-typed-emitter'
import { Duplex } from 'node:stream'
import { Connection, MessageBody } from './connection'
import { getDeviceMetadata } from './http'
import { Metadata } from '../thinq'
import { Multiplexer } from './multiplexer'

type ConWithExtra = Connection & {
    deviceObj?: Device
}

type DeviceEvents = {
    // `raw` events should only be used for diagnostics or by the multiplexer class
    rawData: (body: object) => void
    sendRawData: (body: object) => void

    close: () => void
}

export class Device extends TypedEmitter<DeviceEvents> {
    readonly platform = 'thinq1'
    managed: boolean = false // set to true if any rethink handler is assigned to the device

    private mux: Multiplexer | undefined

    constructor(
        private readonly con: ConWithExtra,
        readonly id: string,
        readonly meta: Metadata,
    ) {
        super()
        con.deviceObj = this
        con.on('data', (packet) => this.emit('rawData', packet))
        con.on('error', console.log)
        con.on('close', () => {
            if (con.deviceObj === this) {
                this.emit('close')
                con.deviceObj = undefined
            }
        })
    }

    // To be used only by the multiplexer or debug management interface, not directly by appliance drivers
    sendRaw(body: object) {
        this.emit('sendRawData', body)
        this.con.send(body)
    }

    setMux(mux: Multiplexer) {
        if (this.mux) throw new Error('Multiplexer already set')

        this.mux = mux
    }

    private getMux(): Multiplexer {
        if (!this.mux) this.mux = new Multiplexer(this)

        return this.mux!
    }

    openStream() {
        return this.getMux().openStream()
    }

    ensureMux() {
        this.getMux()
    }
}

type DeviceAcceptorEvents = {
    newDevice: (dev: Device) => void
    dropDevice: (id: string) => void
}

export class DeviceAcceptor extends TypedEmitter<DeviceAcceptorEvents> {
    connectionsById: Record<string, Connection> = {}
    constructor() {
        super()
    }

    accept(socket: Duplex) {
        const con = new Connection(socket) as ConWithExtra
        con.on('error', () => {}) // ignore errors at this stage
        con.on('init', (deviceId) => {
            const meta = getDeviceMetadata(deviceId)
            if (!meta) {
                console.warn(`device ${deviceId} metadata not known, send HTTP POST first!`)
                con.destroy()
                return
            }

            if (this.connectionsById[deviceId]) {
                console.warn(`device ${deviceId} already connected, dropping the old one`)
                this.connectionsById[deviceId].destroy()
            }

            this.connectionsById[deviceId] = con

            con.on('close', () => {
                if (this.connectionsById[deviceId] === con) {
                    delete this.connectionsById[deviceId]
                    this.emit('dropDevice', deviceId)
                }
            })
            con.removeAllListeners('error')

            const dev = new Device(con, deviceId, meta)
            this.emit('newDevice', dev) // driver selection will assign a multiplexer here

            // T1 multiplexer needs to see all messages, so we instantiate it ASAP
            dev.ensureMux()
        })
    }
}
