import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import type { DeployAppInfo } from '@/cloud/thinq2/clip'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
// any ThinQ2 handler will do; this one publishes its config as soon as it is created
const META: Metadata = { modelId: 'WFV474PGV', modelName: 'WFV474PGV', swVersion: '0.0.0' }

describe('HA bridge Wi-Fi diagnostics', () => {
    test('a ThinQ2 device gets Wi-Fi signal and network sensors', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        Object.assign(thinq, { deployAppInfo: { HomeApSsid: 'test-network' } as DeployAppInfo })

        new Bridge(ha.asConnection()).newDevice(thinq)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, any>

        assert.equal(components.wifirssi.device_class, 'signal_strength')
        assert.equal(components.wifirssi.entity_category, 'diagnostic')
        assert.equal(ha.devices[DEVICE_ID]!.properties['wifissid'], 'test-network')

        thinq.onRssi!(-33)
        assert.equal(ha.devices[DEVICE_ID]!.properties['wifirssi'], -33)
    })

    test('without the deploy info only the signal sensor is added', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)

        new Bridge(ha.asConnection()).newDevice(thinq)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, any>

        assert.ok(components.wifirssi)
        assert.equal(components.wifissid, undefined)
    })
})
