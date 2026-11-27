import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import F_C from '@/cloud/devices/F_C__Y___W.A__QEUK'
import F_V8 from '@/cloud/devices/F_V8_Y___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'e233d130-1eb2-149b-a185-44cb8bcef11f'
const MODEL_ID = 'F_V7_Y___W.A__QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.9.61' }

// Live captures from an LG WV5-1275W (F_V7_Y___W.A__QEUK) on 2026-10-18.
// Framing is the A-gen 30-byte 0xEB/0xEC layout (AA24 / AA42), not F_V8's 80-byte records.
// ha_bridge aliases this model to F_C__Y___W.A__QEUK for that reason.

// 22:58:48 — 0xEC, previous Ready / current Measuring. Cotton, 40°C, 1200 rpm, 178 min.
const SAMPLE_MEASURING = buf(
    'AA4220EC001C0100000000010000000000000000000000000001002C006400000000001C04023A023A010003090401000000000000000104002C006400000000B3BB',
)

// 23:00:01 — Measuring → Washing after load sense. Remaining/initial both 1h15 (75 min).
const SAMPLE_WASHING = buf(
    'AA4220EC001C04023A023A010003090401000000004000000104002C006400000000001C06010F010F010003090401000000004000000106002C006400000000F7BB',
)

// 23:01:19 — still Washing, remaining counted down to 1h13 (73 min), initial stays 75.
const SAMPLE_WASHING_TICK = buf(
    'AA4220EC001C06010E010F010003090401000000004000000106002C006400000000001C06010D010F010003090401000000004000000106002C0064000000001EBB',
)

// 22:58:49 — 0xBD identity dump. Must not clobber the 0xEC status.
const SAMPLE_BD_DUMP = buf(
    'AA0020BD000101900101020800010034000008000000000005000900600000640E2B000000000005CC03313132343118191A1918FFFFFFFFFF0000000000000000000000000000000000000000000000000000000000000000000000013B000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003004606000000000300000100EB00D20184FFEE010006000000E7FF011D330400DE0E3918000000000000330400F2164119000000000000320207061641190000000000003A0207061641190000000000003304015C536C200000000000003304011E2C521C000000000000340202C2224B1B0000000000003A0202C2224B1B000000000000340202EE264E1C00000000000032020646264E1C000000000000340202BE44621F0000000000003A0202BE44621F000000000000340202CC375A1D000000000000340203346878220000000000003303022468782200000000000002D000000100000000000000000000000000000000000000000000000000000000000000000000A7BB',
)

function makeDevice(DUT: typeof F_C | typeof F_V8) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('F_V8 80-byte decoder publishes nothing for these A-gen frames', () => {
        const { ha, thinq } = makeDevice(F_V8)
        thinq.emit('data', SAMPLE_MEASURING)
        thinq.emit('data', SAMPLE_WASHING)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('Measuring packet decodes Cotton 40°C 1200 rpm 178 min', () => {
        const { ha, thinq } = makeDevice(F_C)
        thinq.emit('data', SAMPLE_MEASURING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Detecting')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1200 rpm')
        assert.equal(props.remaining_time, 2 * 60 + 58)
        assert.equal(props.initial_time, 2 * 60 + 58)
        assert.equal(props.error, 'OFF')
        assert.equal(props.active, 'OFF')
        assert.equal(props.tub_clean_count, 44)
        assert.equal(props.door_lock, 'OFF')
    })

    test('Washing after load-sense publishes 75 min and active=ON', () => {
        const { ha, thinq } = makeDevice(F_C)
        thinq.emit('data', SAMPLE_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1200 rpm')
        assert.equal(props.remaining_time, 75)
        assert.equal(props.initial_time, 75)
        assert.equal(props.active, 'ON')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.door_lock, 'OFF')
    })

    test('remaining time counts down without resetting initial', () => {
        const { ha, thinq } = makeDevice(F_C)
        thinq.emit('data', SAMPLE_WASHING)
        thinq.emit('data', SAMPLE_WASHING_TICK)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.remaining_time, 73)
        assert.equal(props.initial_time, 75)
    })

    test('0xBD dump does not clobber 0xEC status', () => {
        const { ha, thinq } = makeDevice(F_C)
        thinq.emit('data', SAMPLE_MEASURING)
        thinq.emit('data', SAMPLE_BD_DUMP)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Detecting')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.remaining_time, 2 * 60 + 58)
    })
})
