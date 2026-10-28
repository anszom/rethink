import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge, { AVAILABILITY_GRACE_MS } from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'e233d130-1eb2-149b-a185-44cb8bcef11f'
const META: Metadata = {
    modelId: 'F_C__Y___W.A__QEUK',
    modelName: 'F_C__Y___W.A__QEUK',
    swVersion: '2.9.61',
}

function makeBridge() {
    const ha = new MockHAConnection()
    const availability: string[] = []
    const inner = ha.publishProperty.bind(ha)
    ha.publishProperty = (id, prop, value) => {
        if (prop === 'availability') availability.push(String(value))
        inner(id, prop, value)
    }
    return { ha, bridge: new Bridge(ha.asConnection()), availability }
}

function connect(bridge: Bridge) {
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    bridge.newDevice(thinq)
    return thinq
}

describe('HA bridge availability across reconnects', () => {
    test('a replacement session within the grace period never publishes offline', (t) => {
        enableMockTimers(t)
        const { ha, bridge, availability } = makeBridge()

        const first = connect(bridge)
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
        first.emit('close')
        assert.equal(availability[availability.length - 1], 'online', 'offline is deferred')

        connect(bridge)
        tickMockTimers(t, AVAILABILITY_GRACE_MS)

        assert.deepEqual(
            availability.filter((v) => v === 'offline'),
            [],
        )
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
    })

    test('a disconnect with no replacement publishes offline after the grace period', (t) => {
        enableMockTimers(t)
        const { ha, bridge } = makeBridge()

        const thinq = connect(bridge)
        thinq.emit('close')
        tickMockTimers(t, AVAILABILITY_GRACE_MS - 1)
        assert.equal(ha.devices[DEVICE_ID].availability, 'online')
        tickMockTimers(t, 1)
        assert.equal(ha.devices[DEVICE_ID].availability, 'offline')
    })
})
