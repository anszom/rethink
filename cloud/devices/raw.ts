import { type Metadata } from '../thinq'
import type { Connection } from '../homeassistant'
import HADevice from './base'
import { Device as T2Device } from '../thinq2/device'
import log from '@/util/logging'

/**
 * What an appliance rethink has no handler for gets instead of nothing.
 *
 * Writing a handler means learning what the bytes mean, and that means watching them change while
 * operating the appliance and comparing against what the official app shows. Until now the only
 * way to see them was rethink's own log, which mixes every device together and cannot be correlated
 * with anything, or a rebuild with a stub handler in it — a redeploy per guess.
 *
 * So publish them. Every frame the appliance sends goes to `<prefix>/<id>/raw_rx` as uppercase hex,
 * everything sent to it appears on `<prefix>/<id>/raw_tx`, and whatever is written to
 * `<prefix>/<id>/raw_tx/set` is sent to it - which then comes back on `raw_tx`, so a write is
 * confirmed by the same topic that reports the traffic. rx and tx are which way round they are on
 * the management websocket and in the capture tools: rx is from the appliance, tx is to it. That is enough to work out
 * a protocol from anything that can subscribe to MQTT, with no rebuild between guesses, and it is
 * also enough to drive an appliance from a script long before it has a handler.
 *
 * Deliberately not registered for discovery, and published without retain. A frame can be several
 * hundred bytes and Home Assistant truncates a sensor state at 255 characters, so an entity would
 * silently lie about the longer ones; and a frame is a moment rather than a state, so a retained
 * one would be handed to every new subscriber as though the appliance had just said it. The topics
 * carry the whole frame, and anything reading MQTT directly sees it.
 */
export default class RawDevice extends HADevice {
    constructor(
        readonly HA: Connection,
        readonly thinq: T2Device,
        readonly meta: Metadata,
    ) {
        super(HA, thinq.id)

        // Not retained. A property is worth keeping because it describes how the appliance *is*;
        // a frame describes a moment, and a retained one would be replayed to every new subscriber
        // as though the appliance had just said it.
        thinq.on('data', (buf) => this.publish('raw_rx', buf))
        // Both directions, because a reply only means something next to the command that caused it.
        thinq.on('sendData', (buf) => this.publish('raw_tx', buf))
    }

    publish(property: string, frame: Buffer) {
        this.HA.publishProperty(this.id, property, frame.toString('hex').toUpperCase(), { retain: false })
    }

    start() {
        this.HA.publishProperty(this.id, 'availability', 'online')
        log(
            'status',
            this.id,
            `no handler for ${this.meta.modelId} - publishing raw frames to <prefix>/${this.id}/raw_rx` +
                ` and /raw_tx, writable at <prefix>/${this.id}/raw_tx/set`,
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop !== 'raw_tx') return

        const hex = mqttValue.trim().replace(/\s+/g, '')
        if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
            log('status', this.id, `ignoring raw frame that is not whole hex bytes: ${mqttValue.slice(0, 40)}`)
            return
        }

        log('status', this.id, `sending raw frame ${hex.toUpperCase()}`)
        this.thinq.send_packet(Buffer.from(hex, 'hex'))
    }
}
