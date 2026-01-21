// base implementation for devices with a AA...BB payload format
import HADevice from './base.js'
import { Device as Thinq2Device } from "../thinq2/devmgr.js"
import { type Config, type Connection } from '../homeassistant.js'

export default class AABBDevice extends HADevice {
    publishCache: Record<string, string|number> =  {}

    constructor(HA: Connection, ha_class, readonly thinq: Thinq2Device) {
        super(HA, ha_class, thinq.id)
        thinq.on('data', (data) => this.processData(data))
    }

    // sends a packet of the format:
    // AA [length] ...inner [checksum] BB
    send(inner: Buffer) {
        const packet = Buffer.concat([
            Buffer.from([ 0xaa, inner.length + 4]),
            inner,
            Buffer.from([ 0x00, 0x00 ])])
        const sum = packet.reduce((pv, cv) => pv+cv, 0)
        packet[packet.length-2] = (sum & 0xff) ^ 0x55
        packet[packet.length-1] = 0xbb
        this.thinq.send(packet)
    }

    processData(buf: Buffer) {
        if(buf.length >= 4 && buf[0] == 0xAA && buf[buf.length-1] == 0xBB){
            this.processAABB(buf.subarray(2, buf.length - 2))
        }
    }

    processAABB(buf: Buffer) {
        throw new Error("To be overriden");
    }

    // to be called by processAABB
    publishProperty(prop: string, value: string|number) {
        if(this.publishCache[prop] === value)
            return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }
}