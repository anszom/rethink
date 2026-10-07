import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_VB_Y___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_VB_Y___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_VB_Y___W.B_2QEUK', swVersion: '2.10.123' }

// All hex dumps below are status telegrams captured from a real unit (Vivace V750, firmware 2.10.123).
// Each is a double block (previous + current state); the decoder reads the second one.

// Powered on, idle (Ready), no course selected, dose settings Medium/Medium.
const SAMPLE_IDLE = buf(
    'AA5420EC002600000000000000000000000000000000000000010008006400000000000002022A1E000201002601000000000000000000000000000000000000000008006400000000000002022A1E00000199BB',
)

// Cotton, 1400 RPM, 40°C, no options, dosing Off/Off.
const SAMPLE_COTTON = buf(
    'AA5420EC002601002400241B00030503010000000000000001000008006400000300000001002A1E000001002601030203020100030A04010000000000010003000008006400000400000000002A1E0080018EBB',
)

// Allergy Care, 1400 RPM, 60°C with Steam.
const SAMPLE_ALLERGY_STEAM = buf(
    'AA5420EC002601021C021C0900030504010000000000000002000008006400000500000002022A1E000201002601023002302D00030A06010000008000000004000008006400000500000002022A1E00020100BB',
)

// Easy Care, 30°C, Rinse+ and Pre-wash selected.
const SAMPLE_EASYCARE_RINSE_PREWASH = buf(
    'AA5420EC002601023502350200030A03020000000000010002000008006400000300000001002A1E000001002601030A030A0200030A03020000004000010003000008006400000400000001002A1E00000197BB',
)

// Easy Care, 40°C with Intensive wash (soilWash = 4).
const SAMPLE_INTENSIVE = buf(
    'AA5420EC002601013A013A0200030A04010000000000010002000008006400000300000001002A1E000001002601032003200200040A04010000000000010003000008006400000300000001002A1E000001E3BB',
)

// Quick 14, delayed start dialled to the maximum of 19 hours.
const SAMPLE_DELAY_19H = buf(
    'AA5420EC002601000E000E0C00030202010012000100000000000008006400000100000001002A1E000001002601000E000E0C00030202010013000100000000000008006400000100000001002A1E00000118BB',
)

// Easy Care 60°C with Steam and Rinse+, detergent dose High, softener Off.
const SAMPLE_DETERGENT_HIGH = buf(
    'AA5420EC002601031D031D0200030706020000008000010004000008006400000300000002002A1E008001002601031D031D0200030706020000008000010004000008006400000300000003002A1E000001AABB',
)

// Quick 14, softener dose High, detergent Low.
const SAMPLE_SOFTENER_HIGH = buf(
    'AA5420EC002601000E000E0C00030202010000000100000000000008006400000100000001022A1E000201002601000E000E0C00030202010000000100000000000008006400000100000001032A1E00020164BB',
)

// Washing (Quick 14), door locked, 12 min remaining of 14, 20 Wh so far.
const SAMPLE_RUNNING = buf(
    'AA5420EC002606000C000E0C00030202010000000142200001010008006400000100001301002A1E000001002606000C000E0C00030202010000000142200001010008006400000100001401002A1E00000148BB',
)

// Paused mid-rinse via the panel button (door locked, remote-start flag cleared).
const SAMPLE_PAUSED = buf(
    'AA5420EC0026070009000E0C00030200010000000142000001060008006400000100002301002A1E0000010026020009000E0C00030200010000000140000000070008006400000100002301002A1E000001A2BB',
)

// Cycle finished (End): door lock released, final energy 41 Wh.
const SAMPLE_END = buf(
    'AA5420EC00260A0000000E0C00000000000000000040000001080008006400000100002901002A1E00000100260A0000000E0C00000000000000000000000001080008006400000100002901002A1E000001E5BB',
)

// Powered off after a finished cycle; the cycle counter has advanced from 8 to 9.
const SAMPLE_POWER_OFF = buf(
    'AA5420EC002601010C010C1200030106010000000000000003000009006400000200002900002A1E000001002600010C010C1200000000000000000000000003010009006400000200002900002A1E000001D6BB',
)

// Frames the machine sends besides the status packet, and the acks the cloud returned to them while bridged.
const PAUSE_MARKER = 'AA09207200C80058BB'
const ACK_PAUSE_MARKER = 'AA08F00072044DBB'
const POWER_OFF_MARKER = 'AA0720D809E7BB'
const ACK_POWER_OFF_MARKER = 'AA08F000D8042BBB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function decode(frame: Buffer) {
    const { ha, thinq } = makeDevice()
    thinq.emit('data', frame)
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('config exposes the dosing sensors as enums', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const c of ['detergent', 'softener']) {
            assert.equal(components[c].platform, 'sensor')
            assert.equal(components[c].device_class, 'enum')
        }
        assert.equal(components.child_lock, undefined, 'child lock is not exposed until confirmed on this model')
    })

    test('idle: Ready, no course', () => {
        const props = decode(SAMPLE_IDLE)
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Medium')
    })

    test('Cotton 1400 RPM 40°C decodes with no options and dosing off', () => {
        const props = decode(SAMPLE_COTTON)
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
        assert.equal(props.initial_time, 182)
        assert.equal(props.remaining_time, 182)
        assert.equal(props.detergent, 'Off')
        assert.equal(props.softener, 'Off')
        for (const o of ['extra_rinse', 'turbowash', 'prewash', 'steam', 'intensive_wash'])
            assert.equal(props[o], 'OFF', o)
    })

    test('Allergy Care with Steam', () => {
        const props = decode(SAMPLE_ALLERGY_STEAM)
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.temp, 60)
        assert.equal(props.steam, 'ON')
        assert.equal(props.prewash, 'OFF')
    })

    test('Rinse+ and Pre-wash', () => {
        const props = decode(SAMPLE_EASYCARE_RINSE_PREWASH)
        assert.equal(props.course, 'Ease Care')
        assert.equal(props.temp, 30)
        assert.equal(props.extra_rinse, 'ON')
        assert.equal(props.prewash, 'ON')
        assert.equal(props.steam, 'OFF')
    })

    test('Intensive wash', () => {
        const props = decode(SAMPLE_INTENSIVE)
        assert.equal(props.intensive_wash, 'ON')
        assert.equal(props.extra_rinse, 'OFF')
    })

    test('delayed start hours are published as reserve_time', () => {
        const props = decode(SAMPLE_DELAY_19H)
        assert.equal(props.course, 'Quick 14')
        assert.equal(props.reserve_time, 19)
        assert.equal(props.turbowash, 'ON')
    })

    test('detergent and softener doses', () => {
        let props = decode(SAMPLE_DETERGENT_HIGH)
        assert.equal(props.detergent, 'High')
        assert.equal(props.softener, 'Off')
        props = decode(SAMPLE_SOFTENER_HIGH)
        assert.equal(props.detergent, 'Low')
        assert.equal(props.softener, 'High')
    })

    test('running: door lock engaged, times and energy', () => {
        const props = decode(SAMPLE_RUNNING)
        assert.equal(props.status, 'Washing')
        assert.equal(props.door_lock, 'OFF') // inverted logic, off=locked
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.initial_time, 14)
        assert.equal(props.remaining_time, 12)
        assert.equal(props.energy, 20)
        assert.equal(props.cycles, 8)
    })

    test('paused', () => {
        const props = decode(SAMPLE_PAUSED)
        assert.equal(props.status, 'Paused')
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'OFF')
    })

    test('end of cycle: door unlocked, final energy', () => {
        const props = decode(SAMPLE_END)
        assert.equal(props.status, 'End')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.energy, 41)
    })

    test('powered off: cycle counter has advanced', () => {
        const props = decode(SAMPLE_POWER_OFF)
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.cycles, 9)
        assert.equal(props.energy, 41)
    })

    test('acks the other frames of the machine as the cloud does, but not the status packets', () => {
        const { ha, thinq } = makeDevice()
        const acks = () => thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)

        thinq.emit('data', buf(PAUSE_MARKER))
        thinq.emit('data', buf(POWER_OFF_MARKER))
        assert.deepEqual(acks(), [ACK_PAUSE_MARKER, ACK_POWER_OFF_MARKER])

        thinq.emit('data', SAMPLE_RUNNING)
        assert.equal(acks().length, 2, 'the cloud does not ack EC status packets')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Washing', 'status is still decoded')
    })
})
