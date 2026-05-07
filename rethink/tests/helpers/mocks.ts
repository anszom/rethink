import { EventEmitter } from 'node:events'
import { setFilter } from '@/util/logging'
import type { Connection, DeviceDiscovery } from '@/cloud/homeassistant'
import type { Metadata } from '@/cloud/thinq'
import { Device as Thinq2Device } from '@/cloud/thinq2/device'
import { Device as Thinq1Device } from '@/cloud/thinq1/device'
import type { Connection as Thinq1Connection } from '@/cloud/thinq1/connection'
import type { Broker } from '@/cloud/mqtt-broker'
import assert from 'node:assert/strict'

// Suppress device logging noise during tests. Imported for side effect.
setFilter(() => false)

export type DeviceInfo = {
    config?: DeviceDiscovery
    availability?: string
    properties: Record<string, string | number>
}

export class MockHAConnection extends EventEmitter {
    devices: Record<string, DeviceInfo> = {}
    isConnected = true

    publishConfig(id: string, config: DeviceDiscovery) {
        if (!this.devices[id]) this.devices[id] = { properties: {} }
        this.devices[id].config = config
    }

    publishProperty(id: string, property: string, value: string | number) {
        if (!this.devices[id]) this.devices[id] = { properties: {} }

        if (property === 'availability') {
            assert.equal(typeof value, 'string')
            this.devices[id].availability = value as string
        } else this.devices[id].properties[property] = value
    }

    lookupDevice(dev: string | DeviceInfo) {
        if (typeof dev === 'string') return this.devices[dev]
        return dev
    }

    lookupTopic(id: string | DeviceInfo, component: string, topic_id: string) {
        let dev = this.lookupDevice(id)
        let comp = dev?.config?.components[component]
        if (!comp) return undefined

        let topic = (comp as Record<string, string>)[topic_id + '_topic']
        if (!topic) return undefined

        topic = topic.replace(/^\$this\//, '')
        return topic
    }

    getProperty(id: string | DeviceInfo, component: string, topic_id: string) {
        let dev = this.lookupDevice(id)
        if (!dev) return undefined

        let topic = this.lookupTopic(dev, component, topic_id)
        if (!topic) return undefined

        return dev.properties[topic]
    }

    setProperty(id: string, component: string, topic_id: string, value: string) {
        let dev = this.lookupDevice(id)
        if (!dev) return undefined

        let topic = this.lookupTopic(dev, component, topic_id)!
        this.emit('setProperty', id, topic.replace(/\/set$/, ''), value)
    }

    /** Cast to the real Connection type for TLVDevice constructors. */
    asConnection(): Connection {
        return this as unknown as Connection
    }
}

type SentMessage = { cmd: string; type: number; data: string | object }

export class MockThinq2Device extends Thinq2Device {
    outbox: Buffer[] = []
    sent: SentMessage[] = []

    constructor(id: string, meta: Metadata) {
        // The real Device only touches `broker` from inside `send`; we override `send` so the
        // broker is never actually used.
        super(null as unknown as Broker, 'mock/topic', id, meta)
    }

    override send(cmd: string, type: number, data: string | object) {
        this.sent.push({ cmd, type, data })
    }

    override send_packet(buf: Buffer) {
        this.emit('sendData', buf)
        this.outbox.push(buf)
    }

    resetRecorder() {
        this.outbox = []
        this.sent = []
    }
}

export class MockThinq1Device extends Thinq1Device {
    sent: object[] = []

    constructor(id: string, meta: Metadata) {
        // Real Thinq1Device's constructor only uses `con` to (a) set `con.deviceObj = this` and
        // (b) attach `status`/`error`/`close` listeners. An EventEmitter satisfies both.
        const con = new EventEmitter() as unknown as Thinq1Connection
        super(con, id, meta)
    }

    override send(body: object) {
        this.emit('sendData', body)
        this.sent.push(body)
    }

    resetRecorder() {
        this.sent = []
    }
}

export function hex(b: Buffer | number[]): string {
    return Buffer.from(b).toString('hex').toUpperCase()
}

export function buf(hexStr: string): Buffer {
    return Buffer.from(hexStr.replace(/\s+/g, ''), 'hex')
}
