import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { Multiplexer, Stream } from '../thinq2/multiplexer'

export default class T2Device extends HADevice {
    readonly stream: Stream
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        mux?: Multiplexer,
    ) {
        super(HA, thinq.id, thinq.meta.modelId)
        if (mux) this.thinq.setMux(mux)
        this.stream = this.thinq.openStream()
        this.stream.on('data', (buf) => this.onData(buf))
    }

    onData(buf: Buffer) {
        throw new Error('To be overriden')
    }

    send_packet(data: Buffer) {
        this.stream.send(Thinq2Device.packet(data))
    }

    send_custom(cmd: string, type: number, data: unknown) {
        this.stream.send(Thinq2Device.custom(cmd, type, data))
    }
}
