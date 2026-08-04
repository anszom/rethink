import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WIN_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WIN_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real packet captures from a WIN_056905_WW (LG LW6023IVSM).
// Note buf[6]=0xa7 instead of the 0x87 seen on RAC/POT — this is the firmware variant byte.

// Capability request (same wire format as RAC)
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

// Capability response captured live from the device.
// buf[6]=0xa7, buf[8]=0x01 (caps type), 81-byte TLV payload.
// TLV body contains t=0x2DA (eeprom checksum) at payload offset 24, which satisfies isCapsResponse().
const CAPS_RESPONSE_HEX =
    '000004000000a70201d251' +
    'b009b0600107b09054b0c1b103b300b340b4e05016b55060' +
    'b6a003e5b6f0352200b85020b8903cb8d020b9103c' +
    'bc600201bd30080000bd47' +
    'b5c0b61029b642b5c1b600b642b5c2b600b642b5c8b600b642' +
    '074c'

// Synthetic values response: buf[6]=0xa7, buf[8]=0x04 (values type).
// 10 TLVs: 0x1f7 power=ON, 0x1f9 mode=cool(0), 0x1fa fan=low(2),
//          0x1fd current_temp=41(20.5C), 0x1fe set_temp=38(19C), 0x322 swing=off(0),
//          plus four padding tags to satisfy isValuesResponse()'s length>=10 guard.
// CRC bytes (last 2) are ignored by processData — any value is valid.
const QUERY_RESPONSE_HEX = '000004000000a702040116' + '7dc17e407e827f50297f9026c88080008040808080c0' + '0000'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX.toUpperCase())
        dev.drop()
    })

    test('caps response (0xa7 frame) is recognized and stops the retry loop', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        // caps retry interval must be cleared
        assert.equal(dev.query_caps_timeout, undefined, 'caps retry loop cleared')
        // device should immediately fire a values query
        assert.equal(thinq.outbox.length, 1, 'values query sent after caps')

        dev.drop()
    })

    test('values response publishes expected climate properties', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 1000)

        assert.ok(ha.devices[DEVICE_ID]?.config, 'HA config published')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 20.5)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 19)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low')

        dev.drop()
    })
})
