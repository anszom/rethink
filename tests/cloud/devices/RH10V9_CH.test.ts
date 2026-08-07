import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RH10V9_CH'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RH10V9_CH'
const META: Metadata = { modelId: MODEL_ID, modelName: 'RH10V9_CH', swVersion: '2.10.114' }

// Live captures from RH10V9_CH (heat-pump dryer) after F0ED monitor enable.

// 0xEB poll reply: phase=0x01 (Initial), remaining 0h25m, flags=0
const SAMPLE_EB_IDLE = buf('AA2130EB00190100000000000000000000000000000000000000000000750020BB')

// 0xEB after flag change: phase=0x01, remaining 25m, flags=0x08
const SAMPLE_EB_FLAGS = buf('AA2130EB00190100000000000000000000000000000800000000000000750028BB')

// 0xEC dual: prev flags=0, curr flags=0x08; both phase=Initial, 25m remaining
const SAMPLE_EC = buf(
    'AA3C30EC001901000000000000000000000000000000000000000000007500' +
        '0019010000000000000000000000000000080000000000000075007DBB',
)

// Synthetic 0xEB: phase=0x32 (Drying), remaining 1h05m=65 (checksum not validated by driver)
const SAMPLE_EB_DRYING = buf(
    'AA2130EB' + '010532' + '00'.repeat(22) + '7500' + '00BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('start sends laundry monitor-enable F0ED', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1121010000001800B5BB')
        dev.drop()
    })

    test('0xEB idle publishes Initial, 25 min remaining, power ON', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EB_IDLE)
        assert.equal(ha.getProperty(DEVICE_ID, 'status', 'state'), 'Initial')
        assert.equal(ha.getProperty(DEVICE_ID, 'remaining_time', 'state'), 25)
        assert.equal(ha.getProperty(DEVICE_ID, 'power', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'flags', 'state'), 0)
        dev.drop()
    })

    test('0xEB publishes flags byte when set', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EB_FLAGS)
        assert.equal(ha.getProperty(DEVICE_ID, 'flags', 'state'), 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'remaining_time', 'state'), 25)
        dev.drop()
    })

    test('0xEC uses current (second) record', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EC)
        assert.equal(ha.getProperty(DEVICE_ID, 'status', 'state'), 'Initial')
        assert.equal(ha.getProperty(DEVICE_ID, 'remaining_time', 'state'), 25)
        assert.equal(ha.getProperty(DEVICE_ID, 'flags', 'state'), 8)
        dev.drop()
    })

    test('0xEB drying phase and hour:minute remaining', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EB_DRYING)
        assert.equal(ha.getProperty(DEVICE_ID, 'status', 'state'), 'Drying')
        assert.equal(ha.getProperty(DEVICE_ID, 'remaining_time', 'state'), 65)
        assert.equal(ha.getProperty(DEVICE_ID, 'power', 'state'), 'ON')
        dev.drop()
    })

    test('0x31 identity frame is ignored', () => {
        const { ha, thinq, dev } = makeDevice()
        const idFrame = buf(
            'AA373031020153414133383439303532370146129B000040000000000002534141333939333439353600000AC20000400000000000D2BB',
        )
        thinq.emit('data', idFrame)
        assert.equal(ha.getProperty(DEVICE_ID, 'status', 'state'), undefined)
        dev.drop()
    })

    test('monitor retries then stops', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        tickMockTimers(t, 15_000 * 8)
        // initial + 8 interval fires
        assert.ok(thinq.outbox.length >= 9)
        const after = thinq.outbox.length
        tickMockTimers(t, 15_000 * 3)
        assert.equal(thinq.outbox.length, after, 'no more polls after 8 retries')
        dev.drop()
    })
})
