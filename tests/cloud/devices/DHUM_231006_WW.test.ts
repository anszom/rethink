import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DHUM_231006_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DHUM_231006_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST DHUM', swVersion: '311' }

// Captured from DHUM_231006_WW cf69d18f on 2026-07-27.
const VALUES_RESPONSE_HEX =
    '000004000000A7020470707DC17E50567E8894D02D7F503686C087008980C900D80187806150B4CD90308840CE80AB00A88187C1E801EE40618089408380EA406241F8008C901B8CD024B5D056B600B648B5D013B600B642B5D055B600B647B5D014B600B648B5D016B600B6485CF05614135D301500FFFA80CDC05DC3'
const HIGH_RESPONSE_HEX = '000004000000A702047D177E86B5D056B600B646B5D014B600B646B5D016B600B64648F8'

const MODES = [
    ['Smart Plus', 86],
    ['Silent', 19],
    ['Intensive', 20],
    ['Quick', 85],
] as const

const FANS = [
    ['auto', 8],
    ['low', 2],
    ['medium', 4],
    ['high', 6],
    ['turbo', 7],
] as const

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

function writtenFields(thinq: MockThinq2Device) {
    const packet = thinq.outbox[thinq.outbox.length - 1]
    assert.ok(packet)
    return TLV.parse(packet.subarray(11, packet.length - 2)).map(({ t, v }) => ({ t, v }))
}

describe(MODEL_ID, () => {
    test('discovery exposes only confirmed entities and derives model enum options', () => {
        const { ha, dev } = makeDevice()
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, Record<string, unknown>>

        assert.deepEqual(
            components.humidifier.modes,
            MODES.map(([label]) => label),
        )
        assert.deepEqual(
            components.fan_speed.options,
            FANS.map(([label]) => label),
        )
        assert.ok(components.ionizer)
        assert.ok(components.uv_nano)
        assert.ok(components.bucket_light)
        assert.ok(components.off_timer)
        assert.equal(components.bucket_full, undefined)
        dev.drop()
    })

    test('real initial response completes startup and decodes the confirmed 231006 state', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(VALUES_RESPONSE_HEX))
        const properties = ha.devices[DEVICE_ID]!.properties

        assert.equal(dev.query_caps_timeout, undefined)
        assert.equal(dev.query_values_timeout, undefined)
        assert.equal(properties['humidifier-power'], 'ON')
        assert.equal(properties['humidifier-mode'], 'Smart Plus')
        assert.equal(properties['fan_speed-'], 'auto')
        assert.equal(properties['humidifier-target_humidity'], 45)
        assert.equal(properties['humidifier-current_humidity'], 48)
        assert.equal(properties['ionizer-'], 'ON')
        assert.equal(properties['uv_nano-'], 'ON')
        assert.equal(properties['bucket_light-'], 'OFF')
        assert.equal(properties['off_timer-'], 0)
        dev.drop()
    })

    test('real fan response decodes high and ignores repeated capability rows as state', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(VALUES_RESPONSE_HEX))
        thinq.emit('data', buf(HIGH_RESPONSE_HEX))

        assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], 'high')
        assert.equal(dev.raw_clip_state[0x2d7], undefined)
        assert.equal(dev.raw_clip_state[0x2d8], undefined)
        assert.equal(dev.raw_clip_state[0x2d9], undefined)
        dev.drop()
    })

    test('fan writes use the bare 0x1fa shape from captured cloud writes', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('fan_speed-', 'high')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x1fa, v: 6 }])
        thinq.resetRecorder()
        dev.setProperty('fan_speed-', 'auto')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x1fa, v: 8 }])
        dev.drop()
    })

    test('derived inverse tables encode every advertised mode and fan', () => {
        const { thinq, dev } = makeDevice()

        for (const [label, wire] of MODES) {
            thinq.resetRecorder()
            dev.setProperty('humidifier-mode', label)
            assert.deepEqual(writtenFields(thinq), [
                { t: 0x1f9, v: wire },
                { t: 0x1f7, v: 1 },
            ])
        }
        for (const [label, wire] of FANS) {
            thinq.resetRecorder()
            dev.setProperty('fan_speed-', label)
            assert.deepEqual(writtenFields(thinq), [{ t: 0x1fa, v: wire }])
        }
        dev.drop()
    })

    test('unknown enum values publish HA unknown and unknown commands are rejected', () => {
        const { ha, thinq, dev } = makeDevice()

        dev.processKeyValue(0x1f9, 999)
        dev.processKeyValue(0x1fa, 999)
        assert.equal(ha.devices[DEVICE_ID]!.properties['humidifier-mode'], 'unknown')
        assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], 'unknown')

        thinq.resetRecorder()
        dev.setProperty('humidifier-mode', 'not-a-mode')
        dev.setProperty('fan_speed-', 'not-a-fan')
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })
})
