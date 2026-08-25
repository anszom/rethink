import { Thinq1Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as tls from 'node:tls'
import { splitter, make as makeFrame } from '@/util/length_prefixed_frame'
import fetch from 'node-fetch'
import * as HTTPS from 'node:https'
import { randomUUID } from 'node:crypto'
import log from '@/util/logging'
import { lookup } from './resolver'
import { format, isAck, Message, MessageBody } from '@/cloud/thinq1/rti'

type ConnectionEvents = {
    ready: () => void
    packet: (payload: object) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    device: Thinq1Device
    socket?: tls.TLSSocket
    aliveTimer: NodeJS.Timeout | undefined
    destroyed = false

    constructor(device: Thinq1Device, options: { reconnectPeriod?: number } = {}) {
        super()
        this.device = device
        this.start()
    }

    async start() {
        const state = this.device.state
        const url = state.httpServer + '/lgehadm/api/Device/TotalDeviceInfoSvc'

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    Accept: 'text/xml',
                    'content-type': 'text/xml;charset=utf-8',
                    'x-lgedm-userid': 'lgehadmUser',
                    'x-lgedm-password': 'bxLoLAZ+rp3oJDbEzRuIfAG4YumeqwWM9l6uUH6TupQ=',
                    'x-lgedm-deviceid': this.device.deviceId,
                    'x-lgedm-devicetype': this.device.meta.deviceType!,
                },
                body: `<lgedmRoot><countryCode>WW</countryCode><modelName>${this.device.meta.modelName}</modelName><itemList><item>THINQ_TIME_SYNC_URI</item><elementList><elementCode>pushDetailYn</elementCode><elementValue>Y</elementValue></elementList></itemList></lgedmRoot>`,
                agent: new HTTPS.Agent({ keepAlive: true, rejectUnauthorized: false, lookup }),
            })
            await resp.text()
        } catch (err) {
            log('bridge', `Failed to fetch ${url}: ${err}`)
            throw err
        }

        if (this.destroyed) return

        log('bridge', `${this.device.deviceId} connecting to ${state.rtiServer}`)
        const [host, port] = state.rtiServer.split(':')

        const sendAlive = () => {
            // DevInfo Alive
            // CmdWId: random
            this.writeJSON({
                Header: { 'x-lgedm-deviceId': this.device.deviceId },
                Body: {
                    CmdWId: randomUUID(),
                    Cmd: 'Alive',
                },
            })
        }
        this.socket = tls.connect(
            {
                host,
                port: Number(port),
                rejectUnauthorized: false /*FIXME*/,
                lookup,
            },
            () => {
                log('bridge', `${this.device.deviceId} connected`)
                this.emit('ready')
                this.aliveTimer = setInterval(sendAlive, 60000)
                sendAlive()
            },
        )

        const split = splitter((payload: Buffer) => {
            try {
                const str = payload.toString('utf-8')
                const j = JSON.parse(str) as Message
                if (typeof j.Body === 'object') {
                    log('bridge', `${this.device.deviceId} <- ${format(j.Body)}`)

                    if (j.Body.ReturnCode === undefined) {
                        // send ACK
                        // CmdWId: echo
                        // ReturnCode: 0000
                        this.writeJSON({
                            Header: { 'x-lgedm-deviceId': this.device.deviceId },
                            Body: {
                                CmdWId: j.Body.CmdWId,
                                ReturnCode: '0000',
                            },
                        })
                    }

                    // Don't forward acks downstream, we acknowledge both ends of the connection ourselves
                    if (!isAck(j.Body)) this.emit('packet', j.Body)
                }
            } catch (err) {
                console.log(err)
            }
        })

        // split() throws synchronously on a negative or oversized length prefix; uncaught, that would take down the process.
        this.socket.on('data', (data: Buffer) => {
            try {
                split(data)
            } catch (err) {
                log('bridge', `${this.device.deviceId} malformed frame, dropping the connection: ${err}`)
                this.socket?.destroy()
            }
        })

        this.socket.on('close', () => {
            log('bridge', `${this.device.deviceId} disconnected`)
            this.emit('close')
        })
        this.socket.on('error', (err) => {
            log('bridge', `Error communicating with ${state.rtiServer}: ${err}`)
            this.emit('error', err)
        })
    }

    writeJSON(json: unknown) {
        this.socket?.write(makeFrame(JSON.stringify(json)))
    }

    send(body: MessageBody) {
        log('bridge', `${this.device.deviceId} -> ${format(body)}`)

        this.writeJSON({
            Header: { 'x-lgedm-deviceId': this.device.deviceId },
            Body: body,
        })
    }

    destroy() {
        this.destroyed = true
        this.socket?.destroy()
        this.socket = undefined
        clearInterval(this.aliveTimer)
    }
}
