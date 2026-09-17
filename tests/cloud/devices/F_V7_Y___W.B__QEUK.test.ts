import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V7_Y___W.B__QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V7_Y___W.B__QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_V7_Y___W.B__QEUK', swVersion: '0.0.0' }

// All hex dumps below are captured messages from my physical washer via the rethink management panel's monitor.

// Cotton, 40°C, 1400 RPM — no extra options selected.
const SAMPLE_COTTON_STD = buf(
    'aa5420ec002501023502350100030504010000000000000003000028006400000400000000000000000000002501033b033b0100030a04010000000000000003000028006400000400000000000000000000d2bb',
)

// Allergy Care, 60°C, Intensive, 1400 RPM.
const SAMPLE_ALLERGY_INTENSIVE = buf(
    'aa5420ec002501023002302d00030a06010000008000000004000028006400000500000000000000000000002501030303032d00040a0601000000800000000400002800640000050000000000000000000026bb',
)

// Cotton, 60°C, 800 RPM.
const SAMPLE_COTTON_SLOW = buf(
    'aa5420ec002501030803080100030106010000000000000003000028006400000400000000000000000000002501030d030d01000305060100000000000000040000280064000004000000000000000000009abb',
)

// Cotton with Rinse+ pressed (extra rinse count -> 2).
const SAMPLE_RINSE_PLUS = buf(
    'aa5420ec002501033b033b0100030a04010000000000000003000028006400000400000000000000000000002501040c040c0100030a0402000000000000000300002800640000050000000000000000000015bb',
)

// Cotton with Pre-wash pressed.
const SAMPLE_PREWASH = buf(
    'aa5420ec002501041d041d0100030a04020000004000000003000028006400000500000000000000000000002501041004100100030a04010000004000000003000028006400000500000000000000000000dabb',
)

// Cotton with Intensive Wash pressed (wash intensity -> 4).
const SAMPLE_INTENSIVE = buf(
    'aa5420ec002501033b033b0100030a04010000000000000003000028006400000400000000000000000000002501032103210100040a0401000000000000000300002800640000040000000000000000000032bb',
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
        for (const c of ['extra_rinse', 'prewash', 'intensive_wash']) {
            assert.ok(components[c], `component ${c} present`)
            assert.equal(components[c].platform, 'binary_sensor')
        }
    })

    test('Cotton 40°C 1400 RPM decodes with no options set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STD)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, 40)
        assert.equal(props.spin, 1400)
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Allergy Care 60°C Intensive 1400 RPM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ALLERGY_INTENSIVE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 1400)
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.intensive_wash, 'ON')
    })

    test('Cotton 60°C 800 RPM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_SLOW)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 800)
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Rinse+ decodes extra_rinse=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSE_PLUS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.extra_rinse, 'ON')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Pre-wash decodes prewash=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PREWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.prewash, 'ON')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.intensive_wash, 'OFF')
    })

    test('Intensive Wash decodes intensive_wash=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INTENSIVE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.intensive_wash, 'ON')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
    })
})
