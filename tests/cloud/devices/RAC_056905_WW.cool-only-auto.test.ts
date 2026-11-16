import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'TEST', swVersion: '1.0' }

// Real captures from a cooling-only unit: opMode (0x2c1) = 0xf, Auto is mode 3
const CAPS_RESPONSE_HEX =
    '0000040000008702011159B001B04FB0A0017CB85024B8903CB8D020B9103CBAD024BB103CB0C1B103B306B280B345B4C7B582' +
    'B541B543B6A04E2FB6F0690441B701B740BC40BD4FB5C0B61024B646B5C1B6102FB646B5C2B6102FB646B5C3B61030B6465722'

// Full state in Auto: 0x1f9=3, 0x1fe=34 (offset 0)
const AUTO_VALUES_HEX =
    '000004000000870204107A7E437DC17E847F50317F9022C85064C880C8C08340838083C0868086C0870087C18F80894088408A09' +
    '8A50588A8A8C90438CD010ACD0DBCA00D540D580C900CAD077CB1099CB40CB9012CBCACC00CC90908B40BF6002D8BFC0BFA002C' +
    'DC000BE502CBE8CCC505F1B01BED05FC340C0C0C380CCC0CD00CD40900064E8'

// Notifications while stepping through the remote's modes
const NOTIFY_COOL_23_HEX = '00000400000087020427087E407F902ECAD0775D14' // 0x1f9=0, 0x1fe=46
const NOTIFY_COOL_25_HEX = '0000040000008702042E037F9032F70C' // 0x1fe=50
const NOTIFY_AUTO_HEX = '00000400000087020428057E437F9022BDA7' // 0x1f9=3, 0x1fe=34

const MODE = 0x1f9
const FAN = 0x1fa
const TEMP = 0x1fe

function buildDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
    thinq.resetRecorder()

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(AUTO_VALUES_HEX))
    tickMockTimers(t, 6000)
    thinq.emit('data', buf(AUTO_VALUES_HEX))
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

/** TLVs of a write frame, by type */
function written(frame: Buffer) {
    return Object.fromEntries(TLV.parse(frame.subarray(11, frame.length - 2)).map(({ t, v }) => [t, v]))
}

describe('RAC_056905_WW cooling-only unit, Auto is mode 3', () => {
    test('Auto is published as auto, without a target temperature', (t) => {
        const { ha, thinq, dev } = buildDevice(t)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 'None')

        thinq.emit('data', buf(NOTIFY_COOL_23_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 23)

        thinq.emit('data', buf(NOTIFY_AUTO_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 'None')
        dev.drop()
    })

    test('writing Auto sends mode 3 at offset 0', (t) => {
        const { ha, thinq, dev } = buildDevice(t)
        thinq.emit('data', buf(NOTIFY_COOL_23_HEX))
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')

        assert.equal(thinq.outbox.length, 1)
        const w = written(thinq.outbox[0]!)
        assert.equal(w[MODE], 3)
        assert.equal(w[TEMP], 34)
        dev.drop()
    })

    test('leaving Auto writes the mode its own last setpoint, not the Auto offset', (t) => {
        const { ha, thinq, dev } = buildDevice(t)
        thinq.emit('data', buf(NOTIFY_COOL_23_HEX))
        thinq.emit('data', buf(NOTIFY_COOL_25_HEX))
        thinq.emit('data', buf(NOTIFY_AUTO_HEX))
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')

        assert.equal(thinq.outbox.length, 1)
        const w = written(thinq.outbox[0]!)
        assert.equal(w[MODE], 0)
        assert.equal(w[FAN] !== undefined, true)
        assert.equal(w[TEMP], 50)
        dev.drop()
    })

    test('leaving Auto for a mode with no known setpoint falls back to 23 C', (t) => {
        const { ha, thinq, dev } = buildDevice(t)
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')

        const w = written(thinq.outbox[0]!)
        assert.equal(w[MODE], 1)
        assert.equal(w[TEMP], 46)
        dev.drop()
    })

    test('a target temperature written in Auto is ignored: the field is an offset there', (t) => {
        const { ha, thinq, dev } = buildDevice(t)
        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '22')
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })
})
