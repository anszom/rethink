import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DHUM_231006_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DHUM_231006_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST DHUM', swVersion: '1.0' }

// Real DHUM_056905 platform captures used by the shared driver initialization path.
const CAPS_RESPONSE_HEX = '000004000000A70201000AB6A00A7CB541B5A004023220'
const QUERY_RESPONSE_HEX = '00000400000087020400117DC17E50117E827F503094D023D801A8803F5E'

const MODES = [
    ['Smart Plus', 86],
    ['Silent', 19],
    ['Intensive', 20],
    ['Quick', 85],
] as const

const FANS = [
    ['Auto', 8],
    ['Low', 2],
    ['Mid', 4],
    ['High', 6],
    ['Turbo', 7],
] as const

function writtenFields(thinq: MockThinq2Device) {
    const packet = thinq.outbox[thinq.outbox.length - 1]
    assert.ok(packet, 'a packet was sent')
    return TLV.parse(packet.subarray(11, packet.length - 2)).map(({ t, v }) => ({ t, v }))
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()
    thinq.resetRecorder()
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 6000)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes the four measured modes and five measured fan speeds', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(
            components.humidifier.modes,
            MODES.map(([label]) => label),
        )
        assert.deepEqual(
            components.fan_speed.options,
            FANS.map(([label]) => label),
        )
        dev.drop()
    })

    test('all four measured mode codes decode to their Korean labels', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        for (const [label, wire] of MODES) {
            dev.processKeyValue(0x1f9, wire)
            assert.equal(ha.devices[DEVICE_ID]!.properties['humidifier-mode'], label)
        }
        dev.drop()
    })

    test('all four Korean mode labels write their measured wire codes', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        for (const [label, wire] of MODES) {
            thinq.resetRecorder()
            dev.setProperty('humidifier-mode', label)
            assert.deepEqual(writtenFields(thinq), [
                { t: 0x1f9, v: wire },
                { t: 0x1f7, v: 1 },
            ])
        }
        dev.drop()
    })

    test('all five measured fan codes decode to their Korean labels', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        for (const [label, wire] of FANS) {
            dev.processKeyValue(0x1fa, wire)
            assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], label)
        }
        dev.drop()
    })

    test('all five fan writes send only 0x1fa without the 056905 per-mode table', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        for (const [label, wire] of FANS) {
            thinq.resetRecorder()
            dev.setProperty('fan_speed-', label)
            assert.deepEqual(writtenFields(thinq), [{ t: 0x1fa, v: wire }])
        }
        dev.drop()
    })
})
