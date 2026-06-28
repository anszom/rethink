import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'

// Generic "loose capture" device class. Used as the fallback when a connecting device's
// modelId has no specific class in ha_bridge's registry. Goal: let onboarding COMPLETE for
// ANY device (so it stops timing out at "connecting to wifi" and shows up in HA) and stream
// every raw packet to a diagnostic sensor, so the protocol can be reverse-engineered and the
// device later reassigned ("binned") to a model-specific class.
//
// Deliberately protocol-agnostic: it hooks the raw thinq2 'data' events (no AA..BB / TLV
// assumption) and never throws out of the handler, to keep the device session stable.
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
                ...HADevice.config(meta, { name: meta.modelName || meta.modelId || 'LG device (generic)' }),
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
            this.pub('raw', hex.slice(0, 255)) // HA sensor state caps at 255 chars
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
