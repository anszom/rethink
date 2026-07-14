import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V8_Y___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V8_Y___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_V8_Y___W.B_2QEUK', swVersion: '0.0.0' }

// All hex dumps below are captured status telegrams from issue #75 (F6WV710P2S.ABLQPDG).
// The decoder parses the second record (starting at buf[42]); the option state lives at
// buf[50] (wash intensity), buf[53] (extra rinse count) and the buf[57] options bitfield.

// Cotton, 40°C, 1600 RPM — no extra options selected.
const SAMPLE_COTTON_STD = buf(
    'aa5420ec002501000000000000000000000000000000000000000001006400000000000000000000000000002501033a033a0100030b04010000000000010002000001006400000400000000000000000000e0bb',
)

// Allergy Care, 60°C, Steam, 1600 RPM.
const SAMPLE_ALLERGY_STEAM = buf(
    'aa5420ec002501021c021c0900030504010000000000000002000001006400000500000000000000000000002501023002302d00030b06010000008000000003000001006400000500000000000000000000f2bb',
)

// Cotton, 60°C, Steam, 1600 RPM.
const SAMPLE_COTTON_STEAM = buf(
    'aa5420ec002501031c031c0100030b03010000000000010002000001006400000400000000000000000000002501041104110100030b0601000000800001000300000100640000040000000000000000000015bb',
)

// Cotton with TurboWash pressed (auto-adjusts to 1000 RPM).
const SAMPLE_TURBOWASH = buf(
    'aa5420ec002501041104110100030b06010000008000010003000001006400000400000000000000000000002501031d031d010003070601000000010001000300000100640000040000000000000000000016bb',
)

// Cotton with Rinse+ pressed (extra rinse count -> 2).
const SAMPLE_RINSE_PLUS = buf(
    'aa5420ec002501033703370100030706010000000000010004000001006400000400000000000000000000002501040c040c0100030706020000000000010004000001006400000500000000000000000000b9bb',
)

// Cotton with Pre-wash pressed.
const SAMPLE_PREWASH = buf(
    'aa5420ec002501033703370100030706010000000000010004000001006400000400000000000000000000002501040c040c01000307060100000040000100040000010064000005000000000000000000007ebb',
)

// Cotton with Intensive Wash pressed (wash intensity -> 4).
const SAMPLE_INTENSIVE = buf(
    'aa5420ec002501033703370100030706010000000000010004000001006400000400000000000000000000002501041604160100040706010000000000010004000001006400000400000000000000000000aabb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes the option binary sensors', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of ['extra_rinse', 'turbowash', 'prewash', 'steam', 'intensive_wash']) {
            assert.ok(components[c], `component ${c} present`)
            assert.equal(components[c].platform, 'binary_sensor')
        }
    })

    test('Cotton 40°C 1600 RPM decodes with no options set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STD)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, 40)
        assert.equal(props.spin, 1600)
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Allergy Care 60°C Steam 1600 RPM decodes steam=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ALLERGY_STEAM)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 1600)
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Cotton 60°C Steam decodes steam=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STEAM)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, 60)
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'OFF')
    })

    test('TurboWash decodes turbowash=ON and 1000 RPM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_TURBOWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.turbowash, 'ON')
        assert.equal(props.spin, 1000)
        assert.equal(props.steam, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Rinse+ decodes extra_rinse=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSE_PLUS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.extra_rinse, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Pre-wash decodes prewash=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PREWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.prewash, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Intensive Wash decodes intensive_wash=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INTENSIVE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.intensive_wash, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
    })
})
