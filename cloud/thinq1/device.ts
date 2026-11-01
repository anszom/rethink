import { TypedEmitter } from 'tiny-typed-emitter'
import { Duplex } from 'node:stream'
import { Connection } from './connection'
import { getDeviceMetadata } from './http'
import { Metadata } from '../thinq'
import { Multiplexer } from './multiplexer'
import { CommonDevice } from '../common'
import { MessageBody } from './rti'

type ConWithExtra = Connection & {
    deviceObj?: Device
}

export class Device extends CommonDevice<MessageBody, MessageBody> {
    readonly platform = 'thinq1'

    constructor(
        private readonly con: ConWithExtra,
        id: string,
        meta: Metadata,
    ) {
        super(id, meta)
        con.deviceObj = this
        con.on('packet', (packet) => this.emit('rawPacket', packet))
        con.on('error', console.log)
        con.on('close', () => {
            if (con.deviceObj === this) {
                this.emit('close')
                con.deviceObj = undefined
            }
        })
    }

    sendRaw(body: MessageBody) {
        this.emit('sendRawPacket', body)
        this.con.send(body)
    }

    protected createDefaultMux() {
        return new Multiplexer(this)
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
