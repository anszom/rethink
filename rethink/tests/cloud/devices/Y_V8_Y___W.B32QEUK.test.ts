import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_V8_Y___W.B32QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_V8_Y___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_V8_Y___W.B32QEUK', swVersion: '2.11.207' }

// Real packet captures from a Y_V8_Y___W.B32QEUK washer (issue #11, lg-washer-rethink-cloud-14-min-prog.txt).
// Frame: AA <unused> 20 0A 00 39 ... (53-byte inner block, total 57 bytes).

const SAMPLE_INITIAL = buf(
    'AAFF200A0039000381000100EB0027000001032603260000000000000000000000000003000011007100000000000000000000000000974EBB',
)
const SAMPLE_RUNNING_DOOR_LOCKED = buf(
    'AAFF200A0039000398000100EB0027000006000E000E0C0003020201000000014220000101001100710000010000000000000000000056D9BB',
)
const SAMPLE_RINSING = buf(
    'AAFF200A00390003C6000100EB0027000007000B000E0C000302000100000001420000010600110071000001000022000000000000004970BB',
)
const SAMPLE_SPINNING = buf(
    'AAFF200A0039000435000100EB00270000080005000E0C00000200000000000042000001070011007100000100002600000000000000AF09BB',
)
const SAMPLE_END = buf(
    'AAFF200A0039000478000100EB002700000A0000000E0C00000000000000000040000001080011007100000100002900000000000000C901BB',
)
const SAMPLE_POWER_OFF = buf(
    'AAFF200A0039000487000100EB00270000000000000E0C000000000000000000000000000A0011007100000100002900000000000000CB19BB',
)

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_OPERATION_STOP = 'AA09F02404010099BB'
const WRITE_OPERATION_WAKE_UP = 'AA08F02A010098BB'

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
            'status',
            'error',
            'operation',
            'cycles',
            'remote_start',
            'door_lock',
            'remaining_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.deepEqual(components.operation.options, ['start', 'stop', 'pause', 'power_off', 'wake_up'])
    })

    test('initial state push decodes status, time and cycles', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'initial')
        assert.equal(props.error, 'ok')
        assert.equal(props.remaining_time, 3 * 60 + 38) // 03:38
        assert.equal(props.cycles, 17)
        // flags1=0x00 = remote_start=OFF, door_lock=ON (unlocked, the inverted convention)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
    })

    test('running state with door locked + remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING_DOOR_LOCKED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'running') // 0x06
        assert.equal(props.remaining_time, 14) // 00:14
        // flags1=0x42 = 0x40 lock bit set + 0x02 remote_start bit set
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
    })

    test('rinsing state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'rinsing') // 0x07
        assert.equal(props.remaining_time, 11)
    })

    test('spinning state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'spinning') // 0x08
    })

    test('end state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'end') // 0x0A
        assert.equal(props.remaining_time, 0)
        assert.equal(props.door_lock, 'OFF') // still locked at the end-of-cycle reading
        assert.equal(props.remote_start, 'OFF')
    })

    test('power-off transition (status=0)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'power_off')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('frames with wrong inner length are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        // valid AA..BB envelope but inner is too short to be a 53-byte status
        thinq.emit('data', buf('AA08200A01020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('start() sends the F0ED initialisation packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('HA write power=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    test('HA write operation=stop', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('operation', 'stop')
        assert.equal(hex(thinq.outbox[0]), WRITE_OPERATION_STOP)
    })

    test('HA write operation=power_off', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('operation', 'power_off')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    test('HA write operation=wake_up', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('operation', 'wake_up')
        assert.equal(hex(thinq.outbox[0]), WRITE_OPERATION_WAKE_UP)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
