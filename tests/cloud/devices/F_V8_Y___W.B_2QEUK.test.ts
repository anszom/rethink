import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V8_Y___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V8_Y___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_V8_Y___W.B_2QEUK', swVersion: '0.0.0' }

// All SAMPLE_* hex dumps below are captured status telegrams from issue #75 (F6WV710P2S.ABLQPDG).
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

// Captured from an F4WV9009P2W (F_V__Y___W.B_2QEUK, firmware 2.11.224), which wraps the same records
// in a 20 0a envelope. Status, remaining and total time match the LG cloud (bridge mode).

// Cotton, 40°C, 1400 RPM, washing. The previous record says 180 min left, the current one 179.
const ENVELOPED_COTTON = buf(
    'aaff200a006000502b000100ec004e0000060300033a0100030a04010000000042010005020000006700000100046200000000000000000006023b033a0100030a040100000000420100050200000067000001000462000000000040000e45bb',
)

// End of a Mix cycle, in the order received: spinning with 8 min left, four other envelopes, End.
const ENVELOPED_MIX_SPINNING = buf(
    'aaff200a0060001ad1000100ec004e00000800080126070000070000000000004201000107000000670000010001db0000000000000000000800080126070000070000000000004201000107000000670000010001db0000000000c000732fbb',
)
// 0xe2 uses the status layout, but doesn't carry the live state (Detecting, 86 min).
const ENVELOPED_NOT_STATUS = [
    'aaff200a0060001b0500010102004e0a01026503fe00c9080064000701260000143f3f3e42423f3f3e4242ffffffffff000000000000000000000000000000000000000000000000000000000000000000000000014800000000000e93d1a0bb',
    'aaff200a0054001b7b000101030042080a01020803fe00cb0a000007020401020700800000670100ffe603e8fe01ff050906400ce40ab404ba02500a04b004b001000008050076060000f8012e02550058db31bb',
    'aaff200a0039001b7e00010ae2002700000401260126070003070401000000400221000101000000670000000001ec00000000000000b869bb',
    'aaff200a0058001b7f0001010400460903010100040506073900000000ff014d00fd0000021c1900032718000a05fd787400fd00fd00fdfdfd00000489012601030c00072102000464001080123cdc59569a00091a5ec0bb',
].map((hex) => buf(hex))
const ENVELOPED_MIX_END = buf(
    'aaff200a0060001b80000100ec004e00000800010126070000070000000000004201000107000000670000010001ec0000000000000000000a00000126070000000000000000004001000108000000670000010001ec00000000000000255bbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('Cotton 40°C 1600 RPM decodes with no options set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STD)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1600 rpm')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Allergy Care 60°C Steam 1600 RPM decodes steam=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ALLERGY_STEAM)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.temp, '60 °C')
        assert.equal(props.spin, '1600 rpm')
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Cotton 60°C Steam decodes steam=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STEAM)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '60 °C')
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'OFF')
    })

    test('TurboWash decodes turbowash=ON and 1000 RPM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_TURBOWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.turbowash, 'ON')
        assert.equal(props.spin, '1000 rpm')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Rinse+ decodes extra_rinse=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSE_PLUS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.extra_rinse, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Pre-wash decodes prewash=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PREWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.prewash, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Intensive Wash decodes soil=Intensive', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INTENSIVE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.soil, 'Intensive')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
    })

    test('enveloped status record decodes the current state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ENVELOPED_COTTON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1400 rpm')
        assert.equal(props.soil, 'Normal')
        assert.equal(props.remaining_time, 179)
        assert.equal(props.initial_time, 238)
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.error, 'OFF')
    })

    test('envelopes other than the status records leave the state alone', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ENVELOPED_MIX_SPINNING)
        for (const frame of ENVELOPED_NOT_STATUS) thinq.emit('data', frame)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning')
        assert.equal(props.remaining_time, 8)
        assert.equal(props.initial_time, 98)
        assert.equal(props.course, 'Mix')
        assert.equal(props.error, 'OFF')

        thinq.emit('data', ENVELOPED_MIX_END)
        assert.equal(props.status, 'End')
        assert.equal(props.remaining_time, 0)
    })
})
