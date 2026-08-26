import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/SDH_GVX5_6211'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'SDH_GVX5_6211'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '3.0.97' }

// Real captures from an LG RHX5009NHB (protocolVer 7, clip_ble_v1.9.237), 2026-08-26.

// 0xEB reply to the F0ED status request, appliance powered off.
const SAMPLE_EB_OFF = buf(
    'AAFF300A00440008A2000100EB00320A000000000000000000000000010000000000040000008F20000000050000000600000000000000000000000000000000006B0DBB',
)

// Power button pressed, no course selected yet: block still all zeroes except the power bit.
const SAMPLE_EC_POWERED_IDLE = buf(
    'AAFF300A00760008A9000100EC00640A000000000000000000000000010000000000040000008F20000000050000000600000000000000000000000000000000000A000000000000000000000000010000000000040000008F2000008005000000060000000000000000000000000000000000CD40BB',
)

// Cotton / Cupboard / Turbo idle, delay start armed at 8 h (previous block shows 6 h).
const SAMPLE_EC_DELAY_8H = buf(
    'AAFF300A00760008CD000100EC00640A030300000700016800960096010000020000040700008F00000880050000000600000000000000000000000000000000000A03030000070001E000960096010000020000040700008F0000088005000000060000000000000000000000000000000000DFD6BB',
)

// Remote start armed with the door ajar: the panel showed dE1 in parallel.
const SAMPLE_EC_ERROR_DE1 = buf(
    'AAFF300A00760008DB000100EC00640A030300000700000000960096010000020000040700008F00000080050000000600000000000000000000000000000000000A030300000700000000960096050110020000040700008F00000080050000000600000000000000000000000000000000002472BB',
)

// Sound (beeper) switched off on the Condenser Cleaning course: rec[19] loses its default 0x04.
const SAMPLE_EC_SOUND_OFF = buf(
    'AAFF300A0076000037000100EC00640A000300001200000000410041010000030000041200008F00004080050000000600000000000000000000000000000000000A000300001200000000410041010000030000001200008F0000408005000000060000000000000000000000000000000000B31ABB',
)

// Child lock armed: rec[26] gains 0x10 next to the remote-start 0x40.
const SAMPLE_EC_CHILD_LOCK = buf(
    'AAFF300A0076000039000100EC00640A000300001200000000410041010000030000041200008F00004080050000000600000000000000000000000000000000000A000300001200000000410041010000030000041200008F0000508005000000060000000000000000000000000000000000A304BB',
)

// Anti-crease toggled on (0x08 joins the drum light bit 0x20 in rec[24]).
const SAMPLE_EC_ANTI_CREASE = buf(
    'AAFF300A00760008E9000100EC00640A030300000700000000960096010000020000040700008F20000080050000000600000000000000000000000000000000000A030300000700000000960096010000020000040700008F2800008005000000060000000000000000000000000000000000DFF9BB',
)

// Remote start armed cleanly (door closed), appliance idle on Cotton.
const SAMPLE_EC_REMOTE_START = buf(
    'AAFF300A00760008F1000100EC00640A030300000700000000960096010000020000040700008F00000080050000000600000000000000000000000000000000000A030300000700000000960096010000020000040700008F000040800500000006000000000000000000000000000000000005F7BB',
)

// Time Dry running, 19 of 20 minutes remaining. rec[26] 0x40 is set for the whole run, which
// is why remote_start must not be derived from it while drying.
const SAMPLE_EC_DRYING = buf(
    'AAFF300A0076000901000100EC00640A000300001500000000140014070100020000041500008F00004080050000000600000000000000000000000000000000000A000300001500000000130014070100020000041500008F0000408005000000060000000000000000000000000000000000F59CBB',
)

// Pause pressed mid-run: phase 0x03 with the replaced phase 0x07 in rec[14].
const SAMPLE_EC_PAUSED = buf(
    'AAFF300A0076000913000100EC00640A00030000150000000011001407010002000D041500008F00004080050000000600000000000000000000000000000000000A00030000150000000011001403070002000D041500008F20000080050000000600000000000000000000000000000000003498BB',
)

// Powered off after use: the phase byte drops to 0x00 but rec[27] keeps its latched 0x80.
const SAMPLE_EC_OFF_AFTER_USE = buf(
    'AAFF300A00760009AC000100EC00640A000000000000000000000000010000000000040000008F20000080050000000600000000000000000000000000000000000A000000000000000000000000000100000000040000008F00000080050000000600000000000000000000000000000000001912BB',
)

const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_PRESS = 'AA08F02A010098BB'

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
            'power_button',
            'status',
            'error',
            'error_message',
            'course',
            'dry_level',
            'dry_mode',
            'remaining_time',
            'initial_time',
            'delay',
            'anti_crease',
            'moisture_alert',
            'drum_light',
            'sound',
            'child_lock',
            'remote_start',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.equal(components.power.platform, 'binary_sensor')
        assert.equal(components.power_button.platform, 'button')
        assert.equal(components.power_button.state_topic, undefined)
    })

    test('start() sends the F0ED status request', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('single 0xEB frame decodes the powered-off state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.error, 'OFF')
    })

    test('powered on with no course selected: power bit alone flips ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_POWERED_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Initial') // the phase byte reads 0x01 even before a course is picked
        assert.equal(props.course, 'unknown')
    })

    test('powered off after use: the latched rec[27] bit does not fake power ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_OFF_AFTER_USE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
    })

    test('doubled 0xEC frame decodes the LAST (current) block, not the stale previous one', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DELAY_8H)
        const props = ha.devices[DEVICE_ID].properties
        // previous block holds the 6 h delay; the current one 8 h
        assert.equal(props.delay, 480)
        assert.equal(props.course, 'Cotton')
        assert.equal(props.dry_level, 'Cupboard')
        assert.equal(props.dry_mode, 'Turbo')
        assert.equal(props.remaining_time, 150)
        assert.equal(props.initial_time, 150)
    })

    test('dE1 (door) error is reported with its message', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_ERROR_DE1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'dE1 (door)')
        assert.equal(props.status, 'Error')
    })

    test('anti-crease bit is isolated from the drum light bit', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_ANTI_CREASE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.anti_crease, 'ON')
        assert.equal(props.moisture_alert, 'OFF')
        assert.equal(props.drum_light, 'ON')
    })

    test('sound (beeper) reads rec[19] bit 0x04, default on', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_SOUND_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.sound, 'OFF')
        assert.equal(props.course, 'Condenser Cleaning')
    })

    test('child lock reads rec[26] bit 0x10 independently of remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_CHILD_LOCK)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.sound, 'ON')
    })

    test('remote start reads rec[26] bit 0x40 while idle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_REMOTE_START)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
    })

    test('running cycle: Drying phase, countdown, and no remote_start from the run bit', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.course, 'Time Dry')
        assert.equal(props.remaining_time, 19)
        assert.equal(props.initial_time, 20)
        // rec[26] 0x40 is set during the run; remote_start must not have been published
        assert.equal(props.remote_start, undefined)
    })

    test('pause mid-run reports the Pause phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Pause')
        assert.equal(props.remaining_time, 17)
    })

    test('the power button sends the F02A press and unknown props send nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power_button', '')
        dev.setProperty('start', '')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_POWER_PRESS])
    })

    test('frames that are not 0x30-family are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08F02A010098BB'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
