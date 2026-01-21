import { TypedEmitter } from 'tiny-typed-emitter';
import { splitter, make as makeFrame } from '../../util/length_prefixed_frame.js'
import { Duplex } from 'node:stream'
import log from '../../util/logging.js'


type ConnectionEvents = {
    init: (id: string) => void;
    status: (buffer: Buffer) => void;
    close: () => void;
    error: (error: Error) => void;
}
export class Connection extends TypedEmitter<ConnectionEvents> {
    id: string | undefined

    constructor(readonly socket: Duplex) {
        super()
        this.socket.on('data', splitter((payload: Buffer) => {
            try {
                const str = payload.toString('utf-8')
                log('incoming', str)
                const request = JSON.parse(str)
                const id = request.Header['x-lgedm-deviceId']
                if(!this.id) {
                    this.id = id
                    this.emit('init', id)
                }

                if(request?.Body?.Format === 'B64' && typeof(request.Body.Data) === 'string') {
                    this.emit('status', Buffer.from(request.Body.Data, 'base64'))
                }

                if(request?.Body?.ReturnCode === undefined) {
                    // send ack
                    this.json({
                        Header: {},
                        Body: { CmdWId: request?.Body?.CmdWid, ReturnCode: '0000' }
                    })
                }
            } catch(err) {
                console.log(err)
            }
        }))

        this.socket.on('close', () => {
            this.emit('close')
        })
        this.socket.on('error', (err) => this.emit('error', err))
    }

    json(json: unknown) {
        this.socket.write(makeFrame(JSON.stringify(json)))
    }

    destroy() {
        this.socket.destroy()
    }
}