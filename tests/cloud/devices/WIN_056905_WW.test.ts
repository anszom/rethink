import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WIN_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { enableMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WIN_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '352200' }

describe('WIN_056905_WW', () => {
    // HA's device-discovery schema rejects unknown top-level keys
    // ("extra keys not allowed @ data['name']"), which drops the whole device.
    test('device name is published inside `device`, not at the top level', (t) => {
        enableMockTimers(t)
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)

        assert.ok(dev.config)
        assert.ok(!('name' in dev.config!))
        assert.equal((dev.config!.device as Record<string, unknown>).name, 'LG Air Conditioner')
    })
})
