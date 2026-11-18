import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WFV474PGV'
import type { Metadata } from '@/cloud/thinq'
import type { DeployAppInfo } from '@/cloud/thinq2/clip'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
// any ThinQ2 handler will do; this one publishes its config as soon as it is created
const META: Metadata = { modelId: 'WFV474PGV', modelName: 'WFV474PGV', swVersion: '0.0.0' }

describe('ThinQ2 Wi-Fi diagnostics', () => {
    test('adds Wi-Fi signal and network sensors and publishes the envelope RSSI', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        Object.assign(thinq, { deployAppInfo: { HomeApSsid: 'test-network' } as DeployAppInfo })

        new DUT(ha.asConnection(), thinq, META)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, any>

        assert.equal(components.wifirssi.device_class, 'signal_strength')
        assert.equal(components.wifirssi.entity_category, 'diagnostic')
        assert.equal(components.wifissid.entity_category, 'diagnostic')
        assert.equal(ha.devices[DEVICE_ID]!.properties['wifissid'], 'test-network')

        thinq.emit('rawPacket', { cmd: 'device_packet', type: 1, data: '', rssi: -60 } as any)
        assert.equal(ha.devices[DEVICE_ID]!.properties['wifirssi'], -60)
    })

    test('without the deploy info only the signal sensor is added', () => {
        const ha = new MockHAConnection()
        new DUT(ha.asConnection(), new MockThinq2Device(DEVICE_ID, META), META)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, any>

        assert.ok(components.wifirssi)
        assert.equal(components.wifissid, undefined)
    })
})
