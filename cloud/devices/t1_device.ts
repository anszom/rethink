import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { Metadata } from '../thinq'
import { Multiplexer, Stream } from '../thinq1/multiplexer'
import { isStatus, MessageBody, MON_START } from '../thinq1/rti'

export default class T1Device extends HADevice {
    readonly stream: Stream
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
        mux?: Multiplexer,
    ) {
        super(HA, thinq.id, meta.modelId)
        if (mux) this.thinq.setMux(mux)
        this.stream = this.thinq.openStream()
        this.stream.on('packet', (body: MessageBody) => {
            if (isStatus(body)) this.onStatus(Buffer.from(body.Data!, 'base64'))
        })
    }

    onStatus(buf: Buffer) {
        throw new Error('To be overriden')
    }

    sendCommand(body: MessageBody) {
        this.stream.send({ Cmd: 'Control', ...body })
    }

    start() {
        this.stream.send(MON_START)
    }

    drop() {
        this.stream.destroy()
        super.drop()
    }
}
