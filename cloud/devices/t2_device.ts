import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { T2Multiplexer, Stream } from '../thinq2/multiplexer'
import { customPayload, fromRxPacket, txPacket, type ClipRxMessage } from '../thinq2/clip'

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
            // every message from the device carries its Wi-Fi signal in the envelope
            const rssi = (packet as ClipRxMessage).rssi
            if (typeof rssi === 'number') this.publishProperty('wifirssi', rssi)

            const buf = fromRxPacket(packet)
            if (buf) this.onData(buf)
        })
    }

    setConfig(config: DeviceDiscovery) {
        const ssid = this.thinq.deployAppInfo?.HomeApSsid
        const rssiSensor = {
            platform: 'sensor',
            unique_id: '$deviceid-wifirssi',
            state_topic: '$this/wifirssi',
            name: 'Wi-Fi signal',
            device_class: 'signal_strength',
            unit_of_measurement: 'dBm',
            state_class: 'measurement',
            entity_category: 'diagnostic',
        }
        const ssidSensor = {
            platform: 'sensor',
            unique_id: '$deviceid-wifissid',
            state_topic: '$this/wifissid',
            name: 'Wi-Fi network',
            icon: 'mdi:wifi',
            entity_category: 'diagnostic',
        }
        config.components['wifirssi'] = rssiSensor
        if (ssid) config.components['wifissid'] = ssidSensor
        super.setConfig(config)
        if (ssid) this.publishProperty('wifissid', ssid)
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
