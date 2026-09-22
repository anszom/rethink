import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/D30'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, captureLog } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'D30'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LDT54788D', swVersion: '1.0' }

// Packet layout: AA <len> <inner> <cksum> BB (len = total packet length)
// processAABB receives inner = raw.subarray(2, raw.length - 2), inner[0]=0x32, inner[1]=0xEB|0xEC.
// For 0xEB the single record starts at inner[2]; for 0xEC the CURRENT record is the second one,
// starting at inner[28] (record1 = prior minute is skipped). See the field-layout comment above
// D30's processAABB for exact offsets.
//
// All "real capture" samples below are taken verbatim from captures/raw-48h.log (26d9edba-...,
// class byte 0x32) and decoded by hand against the offsets documented in cloud/devices/D30.ts.

// ── Real captures — 0xEB (single record) ─────────────────────────────────────

// Starting, Intensive selected, 3:14 initial/remaining, door open, rinse aid ok.
const SAMPLE_EB_STARTING = buf('AA2032EB0018010000030E0200030E0000F218020000000000000000000461BB')

// Running / Washing, Intensive, 3:14 initial/remaining, door closed, rinse aid ok.
const SAMPLE_EB_RUNNING_WASHING = buf('AA2032EB0018020200030E0200030E0000F018020000000000000000000460BB')

// Same as SAMPLE_EB_RUNNING_WASHING but with the energy-saver option bit (0x02) also set.
// Synthetic: no real capture in raw-48h.log has this bit set, so it's derived from the
// real frame above with only optionBits changed (and checksum recomputed).
const SAMPLE_EB_ENERGY_SAVER = buf('AA2032EB0018020200030E0200030E0000F01A020000000000000000000462BB')

// ── Real captures — 0xEC (dual record, current = second) ────────────────────

// Off, no course selected.
const SAMPLE_EC_OFF = buf(
    'AA3A32EC0018040000030E0000030E0000720002000000000000000000040018000000030E0000030E0000720002000000000000000000043FBB',
)

// Done (state 0x04) right after a cycle, door open.
const SAMPLE_EC_DONE = buf(
    'AA3A32EC0018010000030E0200030E0000F21802000000000000000000040018040000030E0000030E00007200020000000000000000000450BB',
)

// Complete (state 0x05), process 'none' — remaining frozen at 0:01.
const SAMPLE_EC_COMPLETE_NONE = buf(
    'AA3A32EC0018020600030E020000010000F80002000000000000000000040018050000030E00000001000078000200000000000000000004B4BB',
)

// Complete (state 0x05), process Complete (0x05).
const SAMPLE_EC_COMPLETE_COMPLETE = buf(
    'AA3A32EC0018020400030E020000010000F81802000000000000000000040018050500030E020000010000F80002000000000000000000042BBB',
)

// Running / Rinsing, Intensive, remaining 1:32.
const SAMPLE_EC_RUNNING_RINSING = buf(
    'AA3A32EC0018020200030E020001200000F01802000000000000000000040018020300030E020001200000F0180200000000000000000004EABB',
)

// Running / Drying, Intensive, remaining 0:33, rinse aid low.
const SAMPLE_EC_RUNNING_DRYING = buf(
    'AA3A32EC0018020300030E020000210000F81802000000000000000000040018020400030E020000210000F818020000000000000000000484BB',
)

// Running (state stays 0x02) / Night Dry (process 0x06), ~8.5h post-cycle: remaining frozen
// at 0:01, course still reported (0x02 Intensive), rinse aid low.
const SAMPLE_EC_NIGHT_DRY = buf(
    'AA3A32EC0018050500030E020000010000F80002000000000000000000040018020600030E020000010000F80002000000000000000000043DBB',
)

// ── Synthetic edge cases ──────────────────────────────────────────────────────

// state=0x03, process=0x09: both unmapped, must fall back to the numeric string.
const SAMPLE_UNMAPPED = buf('AA2032EB00180309000000000000000000000000000000000000000000005EBB')

// Same as SAMPLE_EB_STARTING but with the class byte changed from 0x32 (dishwasher) to 0x30
// (dryer) — must be ignored.
const SAMPLE_WRONG_CLASS = buf('AA2030EB0018010000030E0200030E0000F218020000000000000000000461BB')

// Class 0x32 but frame type 0x99 (neither 0xEB nor 0xEC, e.g. the handshake hello) — must be
// ignored.
const SAMPLE_UNRECOGNIZED_TYPE = buf('AA04329900BB')

// 0xEB frame shorter than the minimum 28-byte record — must be ignored.
const SAMPLE_TOO_SHORT = buf('AA0432EB00BB')

// Real 0x31 serial/identity frame, sent once per reconnect — currently undecoded.
const SAMPLE_SERIAL = buf(
    'AA373231020153414134313236333730330000B6F000008000000000000253414133383636393731310000D743FFFC00000000000024BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components and drops the undecoded ones', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>

        for (const c of [
            'run_state',
            'running',
            'current_course',
            'process_state',
            'remaining_time',
            'initial_time',
            'rinse_refill',
            'door_open',
            'energy_saver',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }

        // Never-published entities that used to sit at Unknown in HA, plus the salt_refill
        // entity replaced by rinse_refill.
        for (const c of [
            'countdown_time',
            'run_completed',
            'error_state',
            'error_message',
            'salt_refill',
            'auto_door',
            'child_lock',
            'dual_zone',
            'extra_dry',
            'high_temp',
            'night_dry',
            'steam',
            'half_load',
            'tub_clean_counter',
            'delay_start',
            'remote_start',
        ]) {
            assert.ok(!components[c], `component ${c} removed`)
        }

        assert.equal(components.remaining_time.device_class, 'duration')
        assert.equal(components.remaining_time.unit_of_measurement, 'min')
        assert.equal(components.initial_time.device_class, 'duration')
        assert.equal(components.initial_time.unit_of_measurement, 'min')
    })

    test('0xEB Starting publishes Starting, Intensive, door open, plain minutes (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Starting')
        assert.equal(props.process_state, '-')
        assert.equal(props.running, 'ON')
        assert.equal(props.current_course, 'Intensive')
        assert.equal(props.initial_time, 194)
        assert.equal(props.remaining_time, 194)
        assert.equal(props.door_open, 'ON')
        assert.equal(props.rinse_refill, 'OFF')
        assert.equal(props.energy_saver, 'OFF')
    })

    test('0xEB Running/Washing publishes English labels and closed door (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_RUNNING_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.running, 'ON')
        assert.equal(props.current_course, 'Intensive')
        assert.equal(props.initial_time, 194)
        assert.equal(props.remaining_time, 194)
        assert.equal(props.door_open, 'OFF')
        assert.equal(props.rinse_refill, 'OFF')
        assert.equal(props.energy_saver, 'OFF')
    })

    test('energy-saver option bit publishes ON while active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_ENERGY_SAVER)
        assert.equal(ha.devices[DEVICE_ID].properties.energy_saver, 'ON')
    })

    test('0xEC Off publishes Off/none, running OFF, no course (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Off')
        assert.equal(props.process_state, '-')
        assert.equal(props.running, 'OFF')
        assert.equal(props.current_course, '-')
        assert.equal(props.door_open, 'ON')
    })

    test('0xEC Done publishes Done, running OFF, door open (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DONE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Done')
        assert.equal(props.process_state, '-')
        assert.equal(props.running, 'OFF')
        assert.equal(props.current_course, '-')
        assert.equal(props.initial_time, 194)
        assert.equal(props.remaining_time, 194)
        assert.equal(props.door_open, 'ON')
        assert.equal(props.rinse_refill, 'OFF')
    })

    test('0xEC Complete/none publishes Complete, running OFF, rinse aid low (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_COMPLETE_NONE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Complete')
        assert.equal(props.process_state, '-')
        assert.equal(props.running, 'OFF')
        assert.equal(props.remaining_time, 1)
        assert.equal(props.rinse_refill, 'ON')
        assert.equal(props.door_open, 'OFF')
    })

    test('0xEC Complete/Complete publishes both fields as Complete (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_COMPLETE_COMPLETE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Complete')
        assert.equal(props.process_state, 'Complete')
        assert.equal(props.running, 'OFF')
        assert.equal(props.current_course, '-')
    })

    test('0xEC Running/Rinsing publishes 92 min remaining (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RUNNING_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Rinsing')
        assert.equal(props.running, 'ON')
        assert.equal(props.remaining_time, 92)
        assert.equal(props.rinse_refill, 'OFF')
    })

    test('0xEC Running/Drying publishes 33 min remaining and rinse aid low (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RUNNING_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Drying')
        assert.equal(props.running, 'ON')
        assert.equal(props.remaining_time, 33)
        assert.equal(props.rinse_refill, 'ON')
    })

    test('0xEC Night Dry publishes running OFF despite state=Running (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_NIGHT_DRY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Night Dry')
        assert.equal(props.running, 'OFF')
        // Course is still reported during Night Dry — only `running` is overridden.
        assert.equal(props.current_course, 'Intensive')
        assert.equal(props.remaining_time, 1)
        assert.equal(props.rinse_refill, 'ON')
    })

    test('unmapped state/process fall back to the numeric string', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UNMAPPED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, '3')
        assert.equal(props.process_state, '9')
        assert.equal(props.running, 'OFF')
    })

    // ── Ignored packet tests ──────────────────────────────────────────────────

    test('frames with wrong device class byte (not 0x32) are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WRONG_CLASS)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    test('frames with an unrecognized frame type (not 0xEB/0xEC) are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UNRECOGNIZED_TYPE)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    test('frames shorter than one full record are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_TOO_SHORT)
        assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
    })

    // ── Logging (for future status-code hunting) ────────────────────────────────

    test('unrecognized frames (e.g. the 0x31 serial frame) are logged (real capture)', () => {
        const { thinq } = makeDevice()
        const cap = captureLog()
        try {
            thinq.emit('data', SAMPLE_SERIAL)
            assert.equal(cap.calls.length, 1)
            const [, topic, message, hex] = cap.calls[0].arguments
            assert.equal(topic, 'D30')
            assert.equal(message, 'unrecognized frame')
            assert.equal(hex, SAMPLE_SERIAL.subarray(2, -2).toString('hex'))
        } finally {
            cap.restore()
        }
    })
})
