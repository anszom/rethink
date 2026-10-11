import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'

export default class HADevice {
    config: DeviceDiscovery | undefined

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
    ) {}

    setConfig(config: DeviceDiscovery) {
        this.config = config
        this.publishConfig()
    }

    // `replaced`: the appliance reconnected and a new instance takes over the same id. Going offline
    // here would only flash every entity Unavailable in HA for a few milliseconds.
    drop(replaced = false) {
        if (!replaced) this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    // Called before start() when this instance replaces `previous` after a reconnect, to carry over
    // state that only lives in rethink (choices made in HA but not sent yet).
    takeOver(previous: HADevice) {}

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
