import { TypedEmitter } from 'tiny-typed-emitter'
import { splitter, make as makeFrame } from '@/util/length_prefixed_frame'
import { Duplex } from 'node:stream'
import log from '@/util/logging'

type ConnectionEvents = {
    init: (id: string) => void
    status: (buffer: Buffer) => void
    close: () => void
    error: (error: Error) => void
}

// the device sends 'alive' packets every 60s
const IDLE_TIMEOUT = 90 * 1000

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
                const request = JSON.parse(str)
                const id = request?.Header?.['x-lgedm-deviceId']
                if (typeof id !== 'string' || id.length === 0) throw new Error('Invalid ThinQ1 device id')
                if (!this.id) {
                    this.id = id
                    this.emit('init', id)
                }

                if (request?.Body?.Format === 'B64' && typeof request.Body.Data === 'string') {
                    this.emit('status', Buffer.from(request.Body.Data, 'base64'))
                }

                if (request?.Body?.ReturnCode === undefined) {
                    // send ack
                    this.json({
                        Header: { 'x-lgedm-deviceId': id },
                        Body: { CmdWId: request?.Body?.CmdWId, ReturnCode: '0000' },
                    })
                }
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
