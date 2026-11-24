import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { T2Multiplexer, Stream } from '../thinq2/multiplexer'
import { customPayload, fromRxPacket, txPacket } from '../thinq2/clip'

export default class T2Device extends HADevice {
    readonly stream: Stream
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        mux?: T2Multiplexer,
    ) {
        super(HA, thinq.id, thinq.meta.modelId)
        if (mux) this.thinq.setMux(mux)
        this.stream = this.thinq.openStream()
        this.stream.on('packet', (packet) => {
            const buf = fromRxPacket(packet)
            if (buf) this.onData(buf)
        })
    }

    onData(buf: Buffer) {
        throw new Error('To be overriden')
    }

    send_packet(data: Buffer) {
        this.stream.send(txPacket(data))
    }

    send_custom(cmd: string, type: number, data: unknown) {
        this.stream.send(customPayload(cmd, type, data))
    }

    drop() {
        this.stream.destroy()
        super.drop()
    }
}
