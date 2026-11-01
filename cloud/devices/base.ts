import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'
import log from '@/util/logging'

export default class HADevice {
    config: DeviceDiscovery | undefined
    // ThinQ2 only, see enableWifiDiagnostics
    wifiDiagnostics: boolean = false
    wifiSsid: string | undefined

    static config(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
        return {
            availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        }
    }

    constructor(
        readonly HA: Connection,
        readonly id: string,
        readonly modelId: string,
    ) {}

    // Logs under the device's model ID, so the `log` config can filter on it
    log(...args: any) {
        log(this.modelId, this.id, ...args)
    }

    setConfig(config: DeviceDiscovery) {
        this.config = config
        if (this.wifiDiagnostics) this.addWifiComponents(config)
        this.publishConfig()
        if (this.wifiSsid !== undefined) this.publishProperty('wifissid', this.wifiSsid)
    }

    // Wi-Fi signal and network sensors, for devices whose messages carry them. Called by the bridge
    // after the handler is created; the RSSI values arrive through publishProperty('wifirssi', ...).
    enableWifiDiagnostics(ssid: string | undefined) {
        this.wifiDiagnostics = true
        this.wifiSsid = ssid
        if (this.config) this.setConfig(this.config)
    }

    addWifiComponents(config: DeviceDiscovery) {
        const rssi = {
            platform: 'sensor',
            unique_id: '$deviceid-wifirssi',
            state_topic: '$this/wifirssi',
            name: 'Wi-Fi signal',
            device_class: 'signal_strength',
            unit_of_measurement: 'dBm',
            state_class: 'measurement',
            entity_category: 'diagnostic',
        }
        const ssid = {
            platform: 'sensor',
            unique_id: '$deviceid-wifissid',
            state_topic: '$this/wifissid',
            name: 'Wi-Fi network',
            icon: 'mdi:wifi',
            entity_category: 'diagnostic',
        }
        config.components['wifirssi'] = rssi
        if (this.wifiSsid !== undefined) config.components['wifissid'] = ssid
    }

    drop() {
        this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    start() {}

    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        throw new Error('To be overriden')
    }

    publishCache = new Map<string, string | number | undefined>()

    // This deduplicates published values via `publishCache`. Callers can bypass it by calling
    // `this.HA.publishProperty` directly
    publishProperty(prop: string, value: string | number | undefined) {
        // has() first: an undefined value on a never-published property must still go out
        if (this.publishCache.has(prop) && this.publishCache.get(prop) === value) return

        this.publishCache.set(prop, value)
        this.HA.publishProperty(this.id, prop, value)
    }
}
