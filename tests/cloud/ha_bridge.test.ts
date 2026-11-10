import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'WTDN3', modelName: 'WTDN3', swVersion: '1.0' }
const DRYER_META: Metadata = { modelId: 'RC90U2_WW', modelName: 'RC90U2_WW', swVersion: 'QC_Modem_1.2.80' }
// A ThinQ1 status push from a real RC90U2: Cotton, Extra, Time, running, Anti crease off.
const DRYER_RUNNING = buf('02 0228 0228 07 00 04 03 02 00000000 00 04 00 0000 01 000000 6b')

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

    test('choices made in HA survive a reconnect', () => {
        const { ha, bridge } = makeBridge()
        const first = new MockThinq1Device(DEVICE_ID, DRYER_META)
        bridge.newDevice(first)
        ha.emit('discovery')
        first.emit('data', DRYER_RUNNING)
        ha.emit('setProperty', DEVICE_ID, 'anti_crease', 'Yes')
        ha.emit('setProperty', DEVICE_ID, 'start_delay_end', '4')
        const props = ha.devices[DEVICE_ID].properties

        const published: string[] = []
        const publish = ha.publishProperty
        ha.publishProperty = (id, property, value) => {
            published.push(`${property}=${value}`)
            publish(id, property, value)
        }
        const second = new MockThinq1Device(DEVICE_ID, DRYER_META)
        bridge.newDevice(second)
        first.emit('close')
        // The panel has not changed since the first connection saw it.
        second.emit('data', DRYER_RUNNING)

        assert.equal(props.anti_crease, 'Yes')
        assert.equal(props.start_delay_end, 4)
        assert.ok(!published.includes('anti_crease=No'), published.join(', '))
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
