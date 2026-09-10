import { Thinq1Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as tls from 'node:tls'
import { splitter, make as makeFrame } from '@/util/length_prefixed_frame'
import fetch, { type RequestInit, type Response } from 'node-fetch'
import * as HTTPS from 'node:https'
import { randomUUID } from 'node:crypto'
import log from '@/util/logging'

type ConnectionEvents = {
    data: (payload: object) => void
    close: () => void
    error: (error: Error) => void
}

type FetchTransport = (url: string, options: RequestInit) => Promise<Response>
type TlsConnector = (options: tls.ConnectionOptions) => tls.TLSSocket

export type Thinq1ConnectionOptions = {
    /** Explicit compatibility escape hatch for appliances/endpoints with an invalid certificate chain. */
    allowInsecureTls?: boolean
    httpTimeoutMs?: number
    tlsConnectTimeoutMs?: number
    heartbeatIntervalMs?: number
    httpsAgent?: HTTPS.Agent
    fetchTransport?: FetchTransport
    tlsConnector?: TlsConnector
}

const HTTP_TIMEOUT_MS = 10_000
const TLS_CONNECT_TIMEOUT_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 60_000

export class Connection extends TypedEmitter<ConnectionEvents> {
    device: Thinq1Device
    socket?: tls.TLSSocket
    lastState?: Buffer
    isLive = false
    readonly ready: Promise<void>

    private readonly options: Thinq1ConnectionOptions
    private readonly abortController = new AbortController()
    private ownedAgent?: HTTPS.Agent
    private heartbeat?: NodeJS.Timeout
    private destroyed = false
    private closeEmitted = false
    private socketErrorSeen = false

    constructor(device: Thinq1Device, options: Thinq1ConnectionOptions = {}) {
        super()
        this.device = device
        this.options = options
        this.ready = this.start()
        void this.ready.catch((error) => this.handleStartupFailure(error))
    }

    private async start() {
        const state = this.device.state
        const rejectUnauthorized = !this.options.allowInsecureTls
        const agent = this.options.httpsAgent ?? new HTTPS.Agent({ keepAlive: true, rejectUnauthorized })
        const ownsAgent = this.options.httpsAgent === undefined
        if (ownsAgent) this.ownedAgent = agent
        const timeout = setTimeout(
            () => this.abortController.abort(new Error('ThinQ1 HTTP startup timed out')),
            this.options.httpTimeoutMs ?? HTTP_TIMEOUT_MS,
        )
        timeout.unref()

        try {
            const resp = await (this.options.fetchTransport ?? fetch)(
                state.httpServer + '/lgehadm/api/Device/TotalDeviceInfoSvc',
                {
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
                    agent,
                    signal: this.abortController.signal,
                },
            )
            if (!resp.ok) throw new Error(`ThinQ1 HTTP startup failed with status ${resp.status}`)
            await resp.text()
        } finally {
            clearTimeout(timeout)
            if (ownsAgent) agent.destroy()
            if (this.ownedAgent === agent) this.ownedAgent = undefined
        }

        if (this.destroyed || this.abortController.signal.aborted)
            throw new Error('ThinQ1 connection destroyed during startup')

        const endpoint = new URL(state.rtiServer.includes('://') ? state.rtiServer : `tls://${state.rtiServer}`)
        const host = endpoint.hostname
        const port = Number(endpoint.port)
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error(`Invalid ThinQ1 RTI endpoint: ${state.rtiServer}`)

        log('bridge', `${this.device.deviceId} connecting to ${state.rtiServer}`)
        const socket = (this.options.tlsConnector ?? tls.connect)({
            host,
            port,
            servername: host,
            rejectUnauthorized,
        })
        if (this.destroyed) {
            socket.destroy()
            throw new Error('ThinQ1 connection destroyed during startup')
        }
        this.socket = socket
        this.attachSocket(socket)

        await new Promise<void>((resolve, reject) => {
            const connectTimeout = setTimeout(() => {
                socket.destroy(new Error('ThinQ1 RTI TLS connection timed out'))
            }, this.options.tlsConnectTimeoutMs ?? TLS_CONNECT_TIMEOUT_MS)
            connectTimeout.unref()

            const cleanup = () => {
                clearTimeout(connectTimeout)
                socket.removeListener('secureConnect', onSecureConnect)
                socket.removeListener('error', onStartupError)
                socket.removeListener('close', onStartupClose)
                this.abortController.signal.removeEventListener('abort', onAbort)
            }
            const onSecureConnect = () => {
                cleanup()
                if (this.destroyed) {
                    socket.destroy()
                    reject(new Error('ThinQ1 connection destroyed during startup'))
                    return
                }
                log('bridge', `${this.device.deviceId} connected`)
                this.startHeartbeat()
                this.sendAlive()
                if (this.lastState) this.sendDeviceInfo(this.lastState)
                resolve()
            }
            const onStartupError = (error: Error) => {
                cleanup()
                reject(error)
            }
            const onStartupClose = () => {
                cleanup()
                if (this.destroyed) reject(new Error('ThinQ1 connection destroyed during startup'))
                else reject(new Error('ThinQ1 RTI TLS connection closed before secure connect'))
            }
            const onAbort = () => {
                cleanup()
                socket.destroy()
                reject(new Error('ThinQ1 connection destroyed during startup'))
            }
            socket.once('secureConnect', onSecureConnect)
            socket.once('error', onStartupError)
            socket.once('close', onStartupClose)
            this.abortController.signal.addEventListener('abort', onAbort, { once: true })
            if (this.abortController.signal.aborted) onAbort()
        })
    }

    private attachSocket(socket: tls.TLSSocket) {
        const split = splitter((payload: Buffer) => this.handlePayload(payload))
        socket.on('data', (data) => {
            try {
                split(data)
            } catch (error) {
                this.failSocket(error)
            }
        })
        socket.on('end', () => {
            try {
                split.end()
            } catch (error) {
                this.failSocket(error)
            }
        })
        socket.on('close', () => {
            this.stopHeartbeat()
            if (this.socket === socket) this.socket = undefined
            log('bridge', `${this.device.deviceId} disconnected`)
            this.emitClose()
        })
        socket.on('error', (error) => {
            if (!this.destroyed) {
                this.socketErrorSeen = true
                this.emit('error', error)
            }
        })
    }

    private handlePayload(payload: Buffer) {
        try {
            const j = JSON.parse(payload.toString('utf-8'))
            if (!j || typeof j.Body !== 'object' || j.Body === null) return
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
                    Body: { CmdWId: j.Body.CmdWId, ReturnCode: '0000' },
                })
            }
        } catch (error) {
            this.failSocket(error)
        }
    }

    private sendAlive() {
        // DevInfo Alive
        // CmdWId: random
        this.writeJSON({
            Header: { 'x-lgedm-deviceId': this.device.deviceId },
            Body: { CmdWId: randomUUID(), Cmd: 'Alive' },
        })
    }

    private sendDeviceInfo(data: Buffer) {
        // DevInfo message
        // CmdWId: random
        this.writeJSON({
            Header: { 'x-lgedm-deviceId': this.device.deviceId },
            Body: {
                CmdWId: randomUUID(),
                Cmd: 'DevInfo',
                Format: 'B64',
                Data: data.toString('base64'),
            },
        })
    }

    private sendStatus(data: Buffer) {
        // device status message
        // CmdWId: n-$DeviceID
        // ReturnCode: 0000
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

    private startHeartbeat() {
        this.stopHeartbeat()
        this.heartbeat = setInterval(() => this.sendAlive(), this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
        this.heartbeat.unref()
    }

    private stopHeartbeat() {
        if (this.heartbeat) clearInterval(this.heartbeat)
        this.heartbeat = undefined
    }

    private failSocket(error: unknown) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        if (!this.destroyed) this.emit('error', normalized)
        this.socket?.destroy()
    }

    private handleStartupFailure(error: unknown) {
        if (this.destroyed) return
        const normalized = error instanceof Error ? error : new Error(String(error))
        if (!this.socketErrorSeen) this.emit('error', normalized)
        if (this.socket) this.socket.destroy()
        else this.emitClose()
    }

    private emitClose() {
        if (this.closeEmitted) return
        this.closeEmitted = true
        this.emit('close')
    }

    writeJSON(json: unknown) {
        if (!this.destroyed) this.socket?.write(makeFrame(JSON.stringify(json)))
    }

    send(data: Buffer) {
        this.lastState = data
        log('bridge', `${this.device.deviceId} -> ${data.toString('hex')}`)
        if (this.isLive) this.sendStatus(data)
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.isLive = false
        this.abortController.abort(new Error('ThinQ1 connection destroyed'))
        this.stopHeartbeat()
        this.ownedAgent?.destroy()
        this.ownedAgent = undefined
        const socket = this.socket
        this.socket = undefined
        socket?.destroy()
    }
}
