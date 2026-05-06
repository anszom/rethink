import { Thinq1Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as tls from 'node:tls'
import { splitter, make as makeFrame } from '@/util/length_prefixed_frame'
import fetch from 'node-fetch'
import * as HTTPS from 'node:https'
import { randomUUID } from 'node:crypto'
import log from '@/util/logging'

type ConnectionEvents = {
    data: (payload: object) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    device: Thinq1Device
    socket?: tls.TLSSocket
    lastState?: Buffer
    isLive: boolean = false

    constructor(device: Thinq1Device, options: { reconnectPeriod?: number } = {}) {
        super()
        this.device = device
        this.start()
    }

    async start() {
        const state = this.device.state

        const resp = await fetch(state.httpServer + '/lgehadm/api/Device/TotalDeviceInfoSvc', {
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
            agent: new HTTPS.Agent({ keepAlive: true, rejectUnauthorized: false }),
        })
        await resp.text()

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
            },
            () => {
                log('bridge', `${this.device.deviceId} connected`)
                setInterval(sendAlive, 60000)
                sendAlive()

                if (this.lastState) {
                    // DevInfo message
                    // CmdWId: random
                    this.writeJSON({
                        Header: { 'x-lgedm-deviceId': this.device.deviceId },
                        Body: {
                            CmdWId: randomUUID(),
                            Cmd: 'DevInfo',
                            Format: 'B64',
                            Data: this.lastState.toString('base64'),
                        },
                    })
                }
            },
        )

        this.socket.on(
            'data',
            splitter((payload: Buffer) => {
                try {
                    const str = payload.toString('utf-8')
                    const j = JSON.parse(str)
                    if (typeof j.Body === 'object') {
                        if (j.Body.CmdOpt === 'Start') {
                            this.isLive = true
                            if (this.lastState) this.send(this.lastState)

                            // don't forward upstream Start & Stop to the actual device
                            return
                        }

                        if (j.Body.CmdOpt === 'Stop') {
                            this.isLive = false
                            // don't forward upstream Start & Stop to the actual device
                            return
                        }

                        log('bridge', `${this.device.deviceId} <- ${JSON.stringify(j.Body)}`)
                        this.emit('data', j.Body)

                        if (j.Body.ReturnCode === undefined) {
                            // ACK
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
                    }
                } catch (err) {
                    console.log(err)
                }
            }),
        )

        this.socket.on('close', () => {
            log('bridge', `${this.device.deviceId} disconnected`)
            this.emit('close')
        })
        this.socket.on('error', (err) => this.emit('error', err))
    }

    writeJSON(json: unknown) {
        this.socket?.write(makeFrame(JSON.stringify(json)))
    }

    send(data: Buffer) {
        // device status message
        // CmdWId: n-$DevideID
        // ReturnCode: 0000
        this.lastState = data
        log('bridge', `${this.device.deviceId} -> ${data.toString('hex')}`)

        if (this.isLive)
            this.writeJSON({
                Header: { 'x-lgedm-deviceId': this.device.deviceId },
                Body: {
                    CmdWId: `n-${this.device.deviceId}`,
                    ReturnCode: '0000',
                    Format: 'B64',
                    Data: data.toString('base64'),
                },
            })
    }

    destroy() {
        this.socket?.destroy()
        this.socket = undefined
    }
}
