import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'WTDN3', modelName: 'WTDN3', swVersion: '1.0' }

function makeBridge() {
    const ha = new MockHAConnection()
    const availability: string[] = []
    const publish = ha.publishProperty.bind(ha)
    ha.publishProperty = (id, property, value) => {
        if (property === 'availability') availability.push(String(value))
        publish(id, property, value)
    }
    return { ha, availability, bridge: new Bridge(ha.asConnection()) }
}

describe('HA bridge', () => {
    // A module that loses Wi-Fi opens a new connection before the old socket times out; the acceptor
    // then closes the old one. Seen on a real RC90U2 several times a day.
    test('a reconnecting appliance stays available', () => {
        const { ha, availability, bridge } = makeBridge()
        const first = new MockThinq1Device(DEVICE_ID, META)
        bridge.newDevice(first)
        ha.emit('discovery')
        availability.length = 0

        const second = new MockThinq1Device(DEVICE_ID, META)
        bridge.newDevice(second)
        first.emit('close')
        ha.emit('discovery')

        assert.ok(!availability.includes('offline'), `published ${availability.join(', ')}`)
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
    })

    test('a disconnected appliance goes offline', () => {
        const { ha, bridge } = makeBridge()
        const dev = new MockThinq1Device(DEVICE_ID, META)
        bridge.newDevice(dev)
        ha.emit('discovery')

        dev.emit('close')

        assert.equal(ha.devices[DEVICE_ID].availability, 'offline')
    })
})
