import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_V8_F___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_V8_F___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_V8_F___W.B_2QEUK', swVersion: '0.0.0' }

// All hex dumps below are telegrams captured from an LG W4WR70E61 washer/dryer combo
// (firmware clip_hna 2.11.207) across full wash+dry cycles, see issue #98.
// Status frames are 92-byte double blocks (previous + current state, current block at 54).

// Wash+Dry, 30°C, 1400 RPM, auto drying, armed for remote start, ready to run (250 min).
const SAMPLE_ARMED_READY = buf(
    'aaff200a0060007f7f000100ec004e000001040a040a1300030a03010200000042000004000010000000000400000000000000000000000001040a040a1300030a0301020000004200000400001000000000040000000000000000c0007a96bb',
)

// Same cycle running, rinse phase, 159 min remaining, energy counter at 152 Wh.
const SAMPLE_RINSING = buf(
    'aaff200a006000823e000100ec004e000006022803131300030a03010200000042200001040010000000000400009800000000000000000007022703131300030a000102000000420000010600100000000004000098000000000000001066bb',
)

// Drying phase of the same cycle, 89 min remaining, energy counter at 1001 Wh.
const SAMPLE_DRYING = buf(
    'aaff200a0060008a6a000100ec004e000009011d031d130000000000020000004200000104001000000000040003e800000000000000000009011d031d130000000000020000004200000104001000000000040003e9000000000000005a45bb',
)

// Machine turned off after the finished cycle, total energy 2162 Wh.
const SAMPLE_OFF = buf(
    'aaff200a0060009437000100ec004e00000b0000031d13000000000002000000400000020a00100000000004000872000000000000000000000000031d13000000000000000000400000040b00100000000004000872000000000000008feabb',
)

// 79-byte configuration frame (byte 8 = 0x02) carrying the wash cycle counter at byte 19.
const SAMPLE_CONFIG = buf(
    'aaff200a005300c807000201030018120a0102120134000807001d00000000000000000000000001050025595f56385f465f5f5f572e425f325145554b00000102d51ced6f0104000000000000000000b596bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes the drying mode and energy sensors', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        assert.equal(components.drying_mode.platform, 'sensor')
        assert.equal(components.energy.platform, 'sensor')
        assert.equal(components.cycles.platform, 'sensor')
    })

    test('armed ready state decodes course, spin, temp, drying mode and remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ARMED_READY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Wash + Dry')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 30)
        assert.equal(props.drying_mode, 'Auto')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.initial_time, 250)
        assert.equal(props.remaining_time, 250)
        assert.equal(props.energy, 0)
    })

    test('rinse phase decodes remaining time and the running energy counter', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing')
        assert.equal(props.course, 'Wash + Dry')
        assert.equal(props.remaining_time, 159)
        assert.equal(props.initial_time, 199)
        assert.equal(props.energy, 152)
    })

    test('drying phase decodes status=Drying with the energy counter advancing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.drying_mode, 'Auto')
        assert.equal(props.remaining_time, 89)
        assert.equal(props.energy, 1001)
    })

    test('powered-off frame decodes power=OFF and the final cycle energy', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.energy, 2162)
    })

    test('configuration frame decodes the wash cycle counter', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_CONFIG)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cycles, 52)
    })
})
