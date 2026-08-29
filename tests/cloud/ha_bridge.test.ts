import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import RAC_056905_WW from '@/cloud/devices/RAC_056905_WW'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

describe('ha_bridge AC model matching', () => {
    const testCases = [
        { modelId: 'WZ12AWN', modelName: 'WZ12AWN SNU3', deviceType: '401' },
        { modelId: 'WZ12AWN SNU3', modelName: 'S3NW12TZXBB', deviceType: '401' },
        { modelId: 'S3NW12TZXBB', modelName: 'WZ12AWN', deviceType: '401' },
        { modelId: 'WZ18AWN', modelName: 'WZ18AWN SNU1', deviceType: '401' },
        { modelId: 'WZ18AWN SNU1', modelName: 'S3NW18TZXBA', deviceType: '401' },
        { modelId: 'S3NW18TZXBA', modelName: 'WZ18AWN', deviceType: '401' },
        { modelId: 'RAC_CUSTOM_01', modelName: 'LG Inverter AC', deviceType: '401' },
        { modelId: 'UNKNOWN_ID', modelName: 'S3NW12TZXBB', deviceType: '401' },
        { modelId: 'UNKNOWN_ID', modelName: 'Unknown AC', deviceType: '401' },
    ]

    for (const tc of testCases) {
        test(`maps ${tc.modelId} (${tc.modelName}) to RAC_056905_WW`, () => {
            const ha = new MockHAConnection()
            const bridge = new Bridge(ha.asConnection())
            const thinq = new MockThinq2Device('ac-test-1', {
                modelId: tc.modelId,
                modelName: tc.modelName,
                deviceType: tc.deviceType,
            })

            bridge.newDevice(thinq as any)
            const hadev = bridge.haDevices.get('ac-test-1')
            assert.ok(hadev, `Device should be registered for ${tc.modelId}`)
            assert.ok(hadev instanceof RAC_056905_WW, `Device should be instance of RAC_056905_WW for ${tc.modelId}`)
        })
    }
})
