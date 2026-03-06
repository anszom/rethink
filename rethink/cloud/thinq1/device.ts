import { TypedEmitter } from 'tiny-typed-emitter';
import { Duplex } from 'node:stream'
import { Connection } from './connection.js'
import { getDeviceMetadata } from './http.js'
import { Metadata } from '../thinq.js'
import { randomUUID } from 'node:crypto';

type ConWithExtra = Connection & {
    deviceObj?: Device
}

type DeviceEvents = {
    data: (packet: Buffer) => void;
    close: () => void;
}

export class Device extends TypedEmitter<DeviceEvents> {
    readonly platform = 'thinq1'

    constructor(readonly con: ConWithExtra, readonly id: string, readonly meta: Metadata) {
        super();
        con.deviceObj = this
        con.on('status', (packet) => {
            this.emit('data', packet)
        })
        con.on('error', console.log)
        con.on('close', () => {
            if(con.deviceObj === this) {
                this.emit('close')
                con.deviceObj = undefined
            }
        })
    }

    send(body: object) {
        this.con.json({
            Header: { 'x-lgedm-deviceId': this.id },
            Body: {
                ...body,
                CmdWId: `n-${randomUUID()}`
            }
        })
    }
}

type DeviceAcceptorEvents = {
    newDevice: (dev: Device) => void;
    dropDevice: (id: string) => void;
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
            console.log('here', deviceId)
            const meta = getDeviceMetadata(deviceId)
            if(!meta) {
                console.warn(`device ${deviceId} metadata not known, send HTTP POST first!`)
                con.destroy()
                return
            }

            if(this.connectionsById[deviceId]) {
                console.warn(`device ${deviceId} already connected, dropping the old one`)
                this.connectionsById[deviceId].destroy()
            }

            this.connectionsById[deviceId] = con

            con.on('close', () => {
                if(this.connectionsById[deviceId] === con) {
                    delete this.connectionsById[deviceId]
                    this.emit('dropDevice', deviceId)
                }
            })
            con.removeAllListeners('error')

            const dev = new Device(con, deviceId, meta)
            this.emit('newDevice', dev)
        })
    }
}