import { TypedEmitter } from 'tiny-typed-emitter'
import { splitter, make as makeFrame } from '@/util/length_prefixed_frame'
import { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'

import log from '@/util/logging'

type ConnectionEvents = {
    init: (id: string) => void
    data: (body: MessageBody) => void
    close: () => void
    error: (error: Error) => void
}

// the device sends 'alive' packets every 60s
const IDLE_TIMEOUT = 90 * 1000

// Thinq1 device-side message bodies:
//
// DevInfo:
//  {"CmdWId":"7f6816e0-99a3-11f0-b166-7c1c4ec8cc53","Cmd":"DevInfo","Format":"B64","Data":"UnVsZVZlcj0xLjMsRndWZXI9UUNfTW9kZW1fMS4yLjgwLHJlZ0ZhaWw9Tg=="}}
// Response:
//  {"CmdWId":"7f6816e0-99a3-11f0-b166-7c1c4ec8cc53","ReturnCode":"0000"}
//
// Alive:
//  {"CmdWId":"8571a6f0-99a3-11f0-856f-7c1c4ec8cc53","Cmd":"Alive"}
// Response:
//  {"CmdWId":"8571a6f0-99a3-11f0-856f-7c1c4ec8cc53","ReturnCode":"0000"}
//
// Status (sent between Start & Stop):
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","ReturnCode":"0000","Format":"B64","Data":"AQAAAAAAAAAAAAAAAAAAAAAAAAAABgBkAAAAAA=="}
// No response.
//
// Server-side messages:
// Start:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","Cmd":"Mon","CmdOpt":"Start"}
// Response:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","ReturnCode":"0000"}
// Stop:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","Cmd":"Mon","CmdOpt":"Stop"}
// Response:
//  {"CmdWId":"n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53","ReturnCode":"0000"}

export const MON_START = { Cmd: 'Mon', CmdOpt: 'Start' }
export const MON_STOP = { Cmd: 'Mon', CmdOpt: 'Stop' }

export type MessageBody = {
    CmdWId?: string
    Cmd?: string
    CmdOpt?: string
    Format?: string
    Data?: string
    ReturnCode?: string
}

export type Message = {
    Header?: {
        'x-lgedm-deviceId'?: string
    }
    Body?: MessageBody
}

export function isAck(body: MessageBody) {
    return 'CmdWId' in body && 'ReturnCode' in body && Object.keys(body).length === 2
}

export function isAlive(body: MessageBody) {
    return body.Cmd === 'Alive'
}

export function isMonStart(body: MessageBody) {
    return body.Cmd === 'Mon' && body.CmdOpt === 'Start'
}

export function isMonStop(body: MessageBody) {
    return body.Cmd === 'Mon' && body.CmdOpt === 'Stop'
}

export function isStatus(body: MessageBody) {
    return body.Cmd === undefined && body?.Format === 'B64' && typeof body.Data === 'string'
}

export function isDevInfo(body: MessageBody) {
    return body.Cmd === 'DevInfo'
}

export function statusMessage(deviceId: string, buf: Buffer): MessageBody {
    // device status message
    // CmdWId: n-$DevideID
    // ReturnCode: 0000
    return {
        CmdWId: `n-${deviceId}`,
        ReturnCode: '0000',
        Format: 'B64',
        Data: buf.toString('base64'),
    }
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    id: string | undefined
    private failed = false

    constructor(readonly socket: Duplex) {
        super()
        let timeout: NodeJS.Timeout

        const onTimeout = () => this.socket.destroy()

        timeout = setTimeout(onTimeout, IDLE_TIMEOUT)

        const split = splitter((payload: Buffer) => {
            try {
                clearTimeout(timeout)
                timeout = setTimeout(onTimeout, IDLE_TIMEOUT)

                const str = payload.toString('utf-8')
                log('incoming', str)
                const request = JSON.parse(str) as Message
                const id = request?.Header?.['x-lgedm-deviceId']
                if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid ThinQ1 device id')
                if (!this.id) {
                    this.id = id
                    this.emit('init', id)
                }

                if (request?.Body?.ReturnCode === undefined) {
                    // send ack
                    this.json({
                        Header: { 'x-lgedm-deviceId': id },
                        Body: { CmdWId: request?.Body?.CmdWId, ReturnCode: '0000' },
                    })
                }

                // Don't forward acks downstream, we acknowledge both ends of the connection ourselves.
                // Don't forward 'alive' packets for the same reason
                if (typeof request?.Body === 'object' && !isAck(request.Body) && !isAlive(request.Body))
                    this.emit('data', request.Body)
            } catch (err) {
                this.fail(err)
            }
        })

        this.socket.on('data', (data: Buffer) => {
            try {
                split(data)
            } catch (err) {
                this.fail(err)
            }
        })
        this.socket.on('end', () => {
            try {
                split.end()
            } catch (err) {
                this.fail(err)
            }
        })

        this.socket.on('close', () => {
            clearTimeout(timeout)
            this.emit('close')
        })
        this.socket.on('error', (err) => this.emit('error', err))
    }

    json(json: unknown) {
        const str = JSON.stringify(json)
        log('outgoing', str)
        this.socket.write(makeFrame(str))
    }

    send(body: MessageBody) {
        this.json({
            Header: { 'x-lgedm-deviceId': this.id },
            Body: {
                ...body,
                CmdWId: `n-${randomUUID()}`,
            },
        })
    }

    destroy() {
        this.socket.destroy()
    }

    private fail(error: unknown) {
        if (this.failed) return
        this.failed = true
        const normalized = error instanceof Error ? error : new Error(String(error))
        this.emit('error', normalized)
        this.socket.destroy()
    }
}
