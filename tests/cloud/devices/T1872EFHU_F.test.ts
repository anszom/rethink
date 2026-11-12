import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/T1789EFH_F'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'T1872EFHU_F'
const META: Metadata = { modelId: MODEL_ID, modelName: 'T1872EFHU_F', swVersion: '2.10.93' }

// Real frames from an LG WT7800CV on a Bedding cycle, run locally.

// The 0xEB reply to the status query: rec[3]=1, rec[4]=0, one hour left.
const SAMPLE_EB_ONE_HOUR = buf('AA2120EB0019030100003B0800030104000000000410000000010000006400E2BB')

// The next frame: previous record 1h 0m, current record 0h 59m.
const SAMPLE_EC_59_MIN = buf(
    'AA3C20EC0019030100003B0800030104000000000410000000010000006400001905003B003A0800030104000000000414000000030000006400A0BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    return { thinq, props: () => ha.devices[DEVICE_ID].properties }
}

describe(MODEL_ID, () => {
    test('remaining time counts the hours in rec[3] (real captures)', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', SAMPLE_EB_ONE_HOUR)
        assert.equal(props().remaining_time, 60)
        thinq.emit('data', SAMPLE_EC_59_MIN)
        assert.equal(props().remaining_time, 59)
    })
})
