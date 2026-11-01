import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/HWWA9S_F2U'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'HWWA9S_F2U'
const META: Metadata = { modelId: MODEL_ID, modelName: 'HWWA9S_F2U', swVersion: '4.5' }

// Real captures from an A9K-CORE3S.
// Docked: charging, power mode off, filter and air path fine, battery low.
const SAMPLE_INITIAL = buf('AA14D2EB000C03010101FF03010101020101C3BB')
// Battery taken out: ready, power mode off, battery unknown.
const SAMPLE_DELTA_BATTERY_OUT = buf('AA22D2EC000C03010101FF03010101020101000C01010101FF00010101020101EEBB')
// Running: power mode stepped up from High to Turbo, battery medium.
const SAMPLE_DELTA_TURBO = buf('AA22D2EC000C02030101FF02010101020101000C02040101FF0201010102010194BB')
// Last content sync envelope, seq 0003, listing VC-1..VC-4.
const SAMPLE_SYNC_LAST = buf('AAFFD20A002B00000300010A860019040456432D31000456432D32000456432D33000456432D34000645BB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('start requests status', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(thinq.outbox.map(hex), ['AA0EF0ED1121010000001800B5BB'])
    })

    test('initial status', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            status: 'Charging',
            clean_mode: 'Off',
            battery: 'Low',
            filter: 'OFF',
            clogged: 'OFF',
        })
    })

    test('status delta uses the current record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_BATTERY_OUT)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Ready')
        assert.equal(props.battery, 'None')
    })

    test('running', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_TURBO)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Cleaning')
        assert.equal(props.clean_mode, 'Turbo')
        assert.equal(props.battery, 'Medium')
    })

    test('status frames are not acked', () => {
        const { thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        assert.deepEqual(thinq.sent, [])
    })

    test('content sync is acked and answered with 0x87', () => {
        const { thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SYNC_LAST)
        assert.deepEqual(thinq.sent, [{ cmd: 'ack', type: 1, data: 'AA0AF0000A040003E0BB' }])
        assert.equal(thinq.outbox.length, 1)
    })

    test('0x87 reply matches the cloud byte for byte', () => {
        const { thinq, dev } = makeDevice()
        dev.syncSeq = 0xaedd
        thinq.emit('data', SAMPLE_SYNC_LAST)
        assert.deepEqual(thinq.outbox.map(hex), ['AAFFF00B001300AEDE00010A870001005CF8BB'])
    })
})
