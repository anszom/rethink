import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_V8_Y___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_V8_Y___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.207' }

// Captured locally from an LG F2WR709S2W on 2026-10-24 while powered on and idle.
// The physical panel showed no programme selected and the door and child locks were off.
const SAMPLE_IDLE = buf(
    'AAFF200A0039009D73000100EB0027000001000000000000000000000000000000000000000002006400000000000000000000000000EF0FBB',
)

// Captured from the same washer on 2026-10-25 after starting Cotton / Cold /
// No spin / Normal rinse / Normal soil through rethink. The physical appliance
// first measured the empty load, then entered Washing with a 39-minute estimate.
const SAMPLE_MEASURING = buf(
    'AAFF200A006000D4FA000100EC004E0000010112011200000000000000000000000000010000030064000000000000000000000000000000040112011201000301010100000000002000010100030064000000000000000000000000004B97BB',
)
const SAMPLE_WASHING = buf(
    'AAFF200A006000D50B000100EC004E000004011201120100030101010000000040200001010003006400000000000000000000000000000006002700270100030101010000000040200001040003006400000000000000000000000000C3C0BB',
)

// Guarded empty-cycle testing on 2026-10-25. These are the exact transitions
// around a physical pause, a physical resume and a remote pause made while the
// appliance still reported Remote Start armed.
const SAMPLE_PHYSICAL_PAUSE = buf(
    'AAFF200A006000DFA7000100EC004E000006011201120100030101010000000040200001040003006400000000000000000000000000000002011201120100030101010000000040000001060003006400000400000000000000000000BB64BB',
)
const SAMPLE_PHYSICAL_RESUME = buf(
    'AAFF200A006000DFBE000100EC004E000002011201120100030101010000000040000001060003006400000400000000000000000000000006011201120100030101010000000002200001020003006400000400000000000000000000DA3BBB',
)
const SAMPLE_RESUME_DOOR_LOCK = buf(
    'AAFF200A006000DFC0000100EC004E00000601120112010003010101000000000220000102000300640000040000000000000000000000000601120112010003010101000000004220000102000300640000040000000000000000000009BABB',
)
const SAMPLE_REMOTE_PAUSE_ARMED = buf(
    'AAFF200A006000DFC8000100EC004E000006011101120100030101010000000042200001020003006400000400000000000000000000000002011101120100030101010000000042000001060003006400000400000000000000000000C90CBB',
)

// These appliance-to-cloud event markers appeared around the guarded control
// session. C9 coincided with physical resume; C8 appeared in the later power-off
// sequence. They must not be mistaken for commands that can safely be sent in
// the other direction.
const EVENT_MARKER_C8 = buf('AA09207200C80058BB')
const PHYSICAL_RESUME_MARKER = buf('AA09207200C9005BBB')

// Immediate appliance responses observed after the inherited Pause and Start
// packets. 00 accompanied a working armed Pause; FF accompanied every rejected
// Start/resume attempt. The driver intentionally does not infer more semantics
// from these short response records.
const COMMAND_ACCEPTED = buf('AA0820002400A3BB')
const COMMAND_REJECTED = buf('AA08200024FFA0BB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('exposes validated core controls and withholds unconfirmed controls', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        for (const key of ['power', 'set_course', 'set_temp', 'set_spin', 'set_rinse', 'set_soil', 'run_programme']) {
            assert.ok(components[key].command_topic, `${key} has a command topic`)
        }

        for (const key of [
            'start',
            'pause',
            'set_delay_end',
            'set_steam',
            'set_prewash',
            'set_turbowash',
            'set_crease_care',
            'set_steam_softener',
            'set_medic_rinse',
        ]) {
            assert.deepEqual(Object.keys(components[key]), ['platform'], `${key} is a removal tombstone only`)
        }
    })

    test('real powered-on idle frame matches the physical panel', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Not selected')
        assert.equal(props.temp, 'Not selected')
        assert.equal(props.spin, 'Not selected')
        assert.equal(props.cycles, 2)
        assert.equal(props.remaining_time, 0)
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        // This protocol uses the inverted lock convention: ON means unlocked.
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.remote_start, 'OFF')
    })

    test('real empty-cycle frames decode Measuring then Washing with the selected programme', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_MEASURING)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Measuring')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, 'Cold')
        assert.equal(props.spin, 'No spin')
        assert.equal(props.rinse, 'Normal')
        assert.equal(props.soil, 'Normal')

        thinq.emit('data', SAMPLE_WASHING)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.initial_time, 39)
        assert.equal(props.remaining_time, 39)
        assert.equal(props.error_message, 'OK')
    })

    test('real physical pause and resume frames preserve the arming and lock transitions', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_PHYSICAL_PAUSE)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Paused')
        assert.equal(props.remaining_time, 78)
        assert.equal(props.remote_start, 'OFF')

        thinq.emit('data', SAMPLE_PHYSICAL_RESUME)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'ON') // transiently unlocked

        thinq.emit('data', SAMPLE_RESUME_DOOR_LOCK)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF') // locked once motion/water resumes
    })

    test('real armed remote Pause transitions to Paused while Remote Start remains armed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_PAUSE_ARMED)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.status, 'Paused')
        assert.equal(props.remaining_time, 77)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
    })

    test('physical action markers are acknowledged but do not change decoded state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.resetRecorder()

        thinq.emit('data', EVENT_MARKER_C8)
        thinq.emit('data', PHYSICAL_RESUME_MARKER)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
        assert.deepEqual(
            thinq.sent.filter((message) => message.cmd === 'ack').map((message) => message.data),
            ['AA08F00072044DBB', 'AA08F00072044DBB'],
        )
    })

    test('observed command response records do not mutate appliance properties', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING)
        const before = { ...ha.devices[DEVICE_ID].properties }

        thinq.emit('data', COMMAND_ACCEPTED)
        thinq.emit('data', COMMAND_REJECTED)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('encodes the commands accepted by the real appliance', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('power', 'ON')
        assert.equal(hex(thinq.outbox[thinq.outbox.length - 1]), 'AA08F02A010098BB')

        dev.setProperty('set_course', 'Cotton')
        dev.setProperty('set_soil', 'Normal')
        dev.setProperty('set_spin', 'No spin')
        dev.setProperty('set_temp', 'Cold')
        dev.setProperty('set_rinse', 'Normal')
        dev.setProperty('run_programme', '')
        assert.equal(hex(thinq.outbox[thinq.outbox.length - 1]), 'AA16F02601030101010000000000030000000000B5BB')

        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox[thinq.outbox.length - 1]), 'AA09F0240101009CBB')
    })
})
