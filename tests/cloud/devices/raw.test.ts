import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import RawDevice from '@/cloud/devices/raw'
import type { Metadata } from '@/cloud/thinq'
import Bridge from '@/cloud/ha_bridge'
import type { AnyDevice } from '@/cloud/devmgr'

const META: Metadata = { modelId: 'WBEY3GT', modelName: 'WBEY3GT', deviceType: '303' }

function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('dev-1', META)
    const raw = new RawDevice(ha.asConnection(), thinq, META)
    raw.start()
    return { ha, thinq, raw }
}

describe('RawDevice', () => {
    test('publishes what the appliance sends, as uppercase hex', () => {
        const { ha, thinq } = setup()
        thinq.emit('data', buf('aa6642ec0102'))

        assert.equal(ha.devices['dev-1'].properties['raw_rx'], 'AA6642EC0102')
    })

    test('publishes what is sent to the appliance too', () => {
        const { ha, thinq } = setup()
        thinq.send_packet(buf('aa12426501'))

        assert.equal(ha.devices['dev-1'].properties['raw_tx'], 'AA12426501')
    })

    test('sends a frame written to the raw topic', () => {
        const { thinq, raw } = setup()
        raw.setProperty('raw_tx', 'AA12426500')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA12426500')
    })

    test('tolerates whitespace and lower case in what it is asked to send', () => {
        const { thinq, raw } = setup()
        raw.setProperty('raw_tx', ' aa 12 42 65 00 ')

        assert.equal(hex(thinq.outbox[0]), 'AA12426500')
    })

    test('refuses anything that is not whole hex bytes rather than sending rubbish', () => {
        const { thinq, raw } = setup()
        for (const bad of ['', 'zz', 'AA1', 'AA 1', 'not hex']) raw.setProperty('raw_tx', bad)

        assert.equal(thinq.outbox.length, 0)
    })

    test('ignores properties other than raw_tx', () => {
        const { thinq, raw } = setup()
        raw.setProperty('mode', 'AA12426500')

        assert.equal(thinq.outbox.length, 0)
    })

    test('a frame written to raw_tx/set comes back on raw_tx, confirming it went out', () => {
        const { ha, raw } = setup()
        raw.setProperty('raw_tx', 'AA12426500')

        // send_packet emits sendData, which is what publishes raw_tx - so the echo is the
        // confirmation, and read and write live on the same topic as everywhere else in rethink.
        assert.equal(ha.devices['dev-1'].properties['raw_tx'], 'AA12426500')
    })

    test('the two directions are named the way the rest of the project names them', () => {
        const { ha, thinq } = setup()
        thinq.emit('data', buf('aa01'))
        thinq.send_packet(buf('aa02'))

        // rx is from the appliance, tx is to it - as on the management websocket and in the
        // capture tools. Getting these the wrong way round would silently mislead every reader.
        assert.equal(ha.devices['dev-1'].properties['raw_rx'], 'AA01')
        assert.equal(ha.devices['dev-1'].properties['raw_tx'], 'AA02')
    })

    test('publishes frames without retain, so they are not replayed as fresh to a new subscriber', () => {
        const { ha, thinq } = setup()
        thinq.emit('data', buf('aa6642ec0102'))
        thinq.send_packet(buf('aa12426501'))

        assert.deepEqual(ha.devices['dev-1'].publishOptions?.['raw_rx'], { retain: false })
        assert.deepEqual(ha.devices['dev-1'].publishOptions?.['raw_tx'], { retain: false })
    })

    test('registers no discovery config, so a long frame cannot be truncated into an entity', () => {
        const { ha } = setup()

        assert.equal(ha.devices['dev-1'].config, undefined)
        assert.equal(ha.devices['dev-1'].availability, 'online')
    })
})

describe('the raw fallback is opt-in', () => {
    test('an unhandled appliance is ignored unless publish_raw_packets is on', () => {
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(new MockThinq2Device('dev-2', META) as unknown as AnyDevice)

        assert.equal(bridge.haDevices.size, 0)
    })

    test('and gets a RawDevice when it is', () => {
        const ha = new MockHAConnection()
        const bridge = new Bridge(ha.asConnection(), true)
        bridge.newDevice(new MockThinq2Device('dev-3', META) as unknown as AnyDevice)

        assert.ok(bridge.haDevices.get('dev-3') instanceof RawDevice)
    })
})
