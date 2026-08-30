import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3L2CNV4W_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3L2CNV4W_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.8' }

// Synthetic frames built from the confirmed field layout (LG's own modelJson for this
// model — see the class header comment), not from a real capture yet. Byte offsets and
// enum values match modelJson.Monitoring.protocol / modelJson.Value exactly; the frames
// themselves are hand-assembled to exercise that mapping. Replace/extend with real
// tools/rethink-capture.ts samples once available.

// All-zero: power off, idle.
const SAMPLE_STATE_OFF = buf(`
    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
`)

// Running, Normal course (id 5): Soil=Normal, Spin=Extra High, Temp=Warm, one extra
// rinse, Steam + TurboWash on, FreshCare + RemoteStart armed, PreState=Initial,
// remaining/initial time 1h05/1h10, 12 cycles since last tub clean.
const SAMPLE_STATE_RUNNING_NORMAL = buf(`
    17 01 05 01 0a 05 00 03 05 04 10 00 00 00 84 81 00 00 00 05 00 0c 06 00
`)

// Door-open error (DE1, id 17) interrupting a cycle set to the Normal course.
const SAMPLE_STATE_ERROR_DE1 = buf(`
    07 00 00 00 00 05 11 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
`)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'pause',
            'status',
            'pre_state',
            'error',
            'error_message',
            'course',
            'soil',
            'spin',
            'temp',
            'dry_level',
            'rinse_count',
            'extra_rinse_count',
            'child_lock',
            'steam',
            'prewash',
            'turbowash',
            'coldwash',
            'fresh_care',
            'remote_start',
            'tub_clean_count',
            'reserve_time',
            'initial_time',
            'remaining_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok(Array.isArray(components.status.options))
        assert.ok((components.status.options as string[]).includes('Running'))
        assert.ok((components.status.options as string[]).includes('Error auto-off'))
    })

    test('OFF state publishes power=OFF and idle defaults', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.soil, '-')
        assert.equal(props.spin, '-')
        assert.equal(props.temp, '-')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.tub_clean_count, 0)
    })

    test('Running Normal course decodes course/soil/spin/temp/options/time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_RUNNING_NORMAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Running')
        assert.equal(props.pre_state, 'Initial')
        assert.equal(props.course, 'Normal')
        assert.equal(props.soil, 'Normal')
        assert.equal(props.spin, 'Extra high')
        assert.equal(props.temp, 'Warm')
        assert.equal(props.rinse_count, '0')
        assert.equal(props.extra_rinse_count, '1')
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'ON')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.fresh_care, 'ON')
        assert.equal(props.coldwash, 'OFF')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.tub_clean_count, 12)
        assert.equal(props.initial_time, 70)
        assert.equal(props.remaining_time, 65)
        assert.equal(props.error, 'OFF')
    })

    test('Door-open error publishes error binary + descriptive message', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_ERROR_DE1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Error auto-off')
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door open error (DE1)')
        assert.equal(props.course, 'Normal')
    })

    test('Frames shorter than the 24-byte layout are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AABBCC'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('HA write power=OFF sends the modelJson PowerOff envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' }])
    })

    test('HA write power=ON sends nothing (no PowerOn action in the modelJson)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.deepEqual(thinq.sent, [])
    })

    test('HA write pause sends the modelJson OperationStop envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' }])
    })

    test('start() sends a Mon/Start subscription on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
    })

    // No test for starting a cycle (OperationStart) — not implemented yet, see the class
    // header comment: the course-parameter array encoding isn't confirmed against a real
    // captured command.
})
