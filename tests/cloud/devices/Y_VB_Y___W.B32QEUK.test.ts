import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_VB_Y___W.B32QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_VB_Y___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_VB_Y___W.B32QEUK', swVersion: '2.11.207' }

// Frame: AA <length> 20 0A 00 <actual_length> ... 2-byte CRC16 BB.
// SAMPLE_INITIAL/SAMPLE_POWER_OFF are real 93-byte (dual-block) captures from a Y_VB_Y___W.B32QEUK
// washer: a neutral start state with no program selected, and the same machine powered off.
const SAMPLE_INITIAL = buf(
    'aaff200a006000f52c000100ec004e00000100000000000000000000000000000000000000001f006400000000000002022a1e00800100000100000000000000000000000000000000000000001f006400000000000002022a1e0000010ee4bb',
)
const SAMPLE_POWER_OFF = buf(
    'aaff200a006000f531000100ec004e00000100000000000000000000000000000000000000001f006400000000000002022a1e00000100000000000000000000000000000000000000000001001f006400000000000002022a1e000001605cbb',
)
const SAMPLE_MEASURING = buf(
    'aaff200a00600008b5000100ec004e000001000000000000000000000000000000000000000020006400000000012402022a1e004001000004010c010c1200030106010000000042000001010020006400000200000000002a1e0000019db0bb',
)
const SAMPLE_RUNNING_DOOR_LOCKED = buf(
    'aaff200a006000f98f000100ec004e0000060219021b0400030a0401000000004220000104001f006400000200000103012a1e0040010000060219021b0400030a0401000000004220000104001f006400000200000103012a1e00000164afbb',
)
const SAMPLE_RINSING = buf(
    'AAFF200A00600002DA000100EC004E0000070022021B0400030A0001000000004200000106001F00640000020000B903012A1E0000010000070022021B0400030A0001000000004200000106001F00640000020000BA03012A1E000001CE60BB',
)
const SAMPLE_SPINNING = buf(
    'aaff200a006000cc44000100ec004e000007001d021b0400030a0001000000004200000106001100640000020000c102002a1e004001000008001c021b0400000a0000000000004200000107001100640000020000c202002a1e000001dc6cbb',
)
// A single-block (57-byte, no payload_b) capture. Same status layout as payload_a in the dual-block
// frames above; the device falls back to payload_a when there's no second block to read.
const SAMPLE_SINGLE_BLOCK_WASHING = buf(
    'aaff200a003900c2a6000100eb00270000060216021b0400030a04010000000042200001040011006400000200000602002a1e00400189a4bb',
)
// A valid AA..BB frame with a correct CRC16 and the same payload_length/payload_type as a status
// push, but message_type=0x0a instead of 0x00
// This looks like raw sensor data for some unknown purpose
const SAMPLE_UNKNOWN_MESSAGE_TYPE = buf(
    'aaff200a003900ce8600010ae20027000004032603260400030a04010000000002200001010011006400000200011602002a1e000001dbabbb',
)

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'start',
            'pause',
            'status',
            'error',
            'error_message',
            'course',
            'temp',
            'spin',
            'cycles',
            'remote_start',
            'door_lock',
            'child_lock',
            'energy',
            'initial_time',
            'remaining_time',
            'delay_end',
            'detergent',
            'softener',
            'turbowash',
            'eco_hybrid',
            'prewash',
            'steam',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.status.options as string[]).includes('Error'))
        assert.ok((components.detergent.options as string[]).includes('Medium'))
        assert.ok((components.softener.options as string[]).includes('Medium'))
    })

    test('initial state: neutral start, no program selected', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        // no program selected yet: course/spin/temp all fall back to 'unknown'
        assert.equal(props.course, 'unknown')
        assert.equal(props.spin, 'unknown')
        assert.equal(props.temp, 'unknown')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.cycles, 31)
        assert.equal(props.energy, 0)
        assert.equal(props.delay_end, 0)
        // lock_status=0x00: remote_start=OFF, door_lock=ON (unlocked, the inverted convention), child_lock=OFF
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Medium')
        // options=0x00: no optional cycle features active
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.eco_hybrid, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
    })

    test('power-off transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
    })

    test('measuring state: Drum Clean, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_MEASURING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Measuring')
        assert.equal(props.course, 'Drum Clean')
        assert.equal(props.spin, 0)
        assert.equal(props.temp, 60)
        assert.equal(props.initial_time, 72)
        assert.equal(props.remaining_time, 72)
        assert.equal(props.cycles, 32)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        // no detergent/softener dosed yet during the measuring phase
        assert.equal(props.detergent, 'Off')
        assert.equal(props.softener, 'Off')
    })

    test('running state: Eco 40-60, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING_DOOR_LOCKED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
        assert.equal(props.initial_time, 147)
        assert.equal(props.remaining_time, 145)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.detergent, 'High')
        assert.equal(props.softener, 'Low')
    })

    test('rinsing state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing')
        assert.equal(props.course, 'Eco 40-60')
        // temp isn't reported during the rinse phase
        assert.equal(props.temp, 'unknown')
        assert.equal(props.remaining_time, 34)
        assert.equal(props.energy, 186)
        assert.equal(props.initial_time, 147)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
    })

    test('spinning state: Eco 40-60, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.spin, 1400)
        // temp isn't reported during the spin phase
        assert.equal(props.temp, 'unknown')
        assert.equal(props.initial_time, 147)
        assert.equal(props.remaining_time, 28)
        assert.equal(props.energy, 194)
        assert.equal(props.cycles, 17)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Off')
    })

    test('single-block (no payload_b) frame still decodes via payload_a', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SINGLE_BLOCK_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
        assert.equal(props.initial_time, 147)
        assert.equal(props.remaining_time, 142)
        assert.equal(props.cycles, 17)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Off')
    })

    test('a well-formed frame with an unrecognized message_type is ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UNKNOWN_MESSAGE_TYPE)
        assert.equal(ha.devices[DEVICE_ID]?.properties.power, undefined)
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('frames with a bad CRC16 are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        // valid AA..BB envelope, but the trailing checksum doesn't match the payload
        thinq.emit('data', buf('AA08200A01020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('a real frame with a corrupted checksum byte is ignored', () => {
        const { ha, thinq } = makeDevice()
        const corrupted = Buffer.from(SAMPLE_INITIAL)
        corrupted[corrupted.length - 3] ^= 0x01 // flip a bit in the CRC16 high byte
        thinq.emit('data', corrupted)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('start() sends the F0ED initialisation packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('HA write power=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_ON)
    })

    test('HA write power=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    test('HA write pause button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_PAUSE)
    })

    test('HA write start button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_START)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
