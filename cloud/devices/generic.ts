import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'

// Generic capture class for unknown ThinQ2 devices. Enrolls the device so it
// stays connected and publishes raw packet hex to a diagnostic HA sensor.
export default class GenericDevice extends HADevice {
    publishCache: Record<string, string | number> = {}

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        readonly meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.thinq.on('data', (buf) => this.onData(buf))
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: meta.modelName || 'LG device (generic)' }),
                components: {
                    raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-raw',
                        state_topic: '$this/raw',
                        name: 'Raw packet',
                        icon: 'mdi:code-braces',
                        entity_category: 'diagnostic',
                    },
                    last_seen: {
                        platform: 'sensor',
                        unique_id: '$deviceid-last-seen',
                        state_topic: '$this/last_seen',
                        name: 'Last packet at',
                        icon: 'mdi:clock-outline',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    onData(buf: Buffer) {
        try {
            const hex = buf.toString('hex')
            log('status', this.id, 'generic raw packet:', hex)
            this.pub('raw', hex.slice(0, 255))
            this.pub('last_seen', new Date().toISOString())
        } catch (err) {
            log('status', this.id, 'generic onData error', String(err))
        }
    }

    pub(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return
        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }
}
