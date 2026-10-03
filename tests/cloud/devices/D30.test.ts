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

// Selecting, Heavy selected, 3:14 initial/remaining, door open, rinse aid ok.
const SAMPLE_EB_STARTING = buf('AA2032EB0018010000030E0200030E0000F218020000000000000000000461BB')

// Running / Washing, Heavy, 3:14 initial/remaining, door closed, rinse aid ok.
const SAMPLE_EB_RUNNING_WASHING = buf('AA2032EB0018020200030E0200030E0000F018020000000000000000000460BB')

// Real capture (2026-09-24 17:32Z): Normal course started with Energy Saver on — option bits 0x02,
// the only option set; Night Dry off.
const SAMPLE_EC_NORMAL_ENERGY_SAVER = buf(
    'AA3A32EC0018010000023205000232000072020200000000000000000004001802020002320500023200007002020000000000000000000456BB',
)

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

// Running / Rinsing, Heavy, remaining 1:32.
const SAMPLE_EC_RUNNING_RINSING = buf(
    'AA3A32EC0018020200030E020001200000F01802000000000000000000040018020300030E020001200000F0180200000000000000000004EABB',
)

// Running / Drying, Heavy, remaining 0:33, rinse aid low.
const SAMPLE_EC_RUNNING_DRYING = buf(
    'AA3A32EC0018020300030E020000210000F81802000000000000000000040018020400030E020000210000F818020000000000000000000484BB',
)

// Running (state stays 0x02) / Night Dry (process 0x06), ~8.5h post-cycle: remaining frozen
// at 0:01, course still reported (0x02 Heavy), rinse aid low.
const SAMPLE_EC_NIGHT_DRY = buf(
    'AA3A32EC0018050500030E020000010000F80002000000000000000000040018020600030E020000010000F80002000000000000000000043DBB',
)

// Second capture (2026-09-23): Delicate course, Half Load then Extra Dry selected before start.
// Half Load: option bit 0x40, estimate 1:54 -> 1:43.
const SAMPLE_EC_HALF_LOAD = buf(
    'AA3A32EC00180100000136030001360000F20002000000000000000000040818010000012B0300012B0000F24002000000000000000000046DBB',
)
// Extra Dry added: option bits 0x44, estimate 1:43 -> 2:03.
const SAMPLE_EC_HALF_LOAD_EXTRA_DRY = buf(
    'AA3A32EC0818010000012B0300012B0000F240020000000000000000000400180100000203030002030000F24402000000000000000000044DBB',
)
// Started: Running / Washing, door closed, options unchanged.
const SAMPLE_EC_DELICATE_WASHING = buf(
    'AA3A32EC00180100000203030002030000F244020000000000000000000401180202000203030002030000F04402000000000000000000049DBB',
)
// Post-cycle Night Dry (process 0x06): option bits cleared, running OFF.
const SAMPLE_EC_DELICATE_NIGHT_DRY = buf(
    'AA3A32EC00180505000203030000010000F000020000000000000000000400180206000203030000010000F000020000000000000000000417BB',
)

// Third capture (2026-09-23 22:10Z): Normal course, High Temp only (panel photo), 2:50 estimate.
const SAMPLE_EC_NORMAL_HIGH_TEMP_SELECTING = buf(
    'AA3A32EC0018010000023205000232000072080200000000000000000004081801000002320500023200007208020000000000000000000443BB',
)
// State 0x03 for 24 s just after start, door-open bit set.
const SAMPLE_EC_NORMAL_PAUSED = buf(
    'AA3A32EC0018020200023205000232000070080200000000000000000004001803020002320500023200007208020000000000000000000446BB',
)
const SAMPLE_EC_NORMAL_RESUMED = buf(
    'AA3A32EC0018030200023205000232000072080200000000000000000004001802020002320500023200007008020000000000000000000446BB',
)

// Malformed 194-byte 0xEC sent once at cycle end alongside the 0xE1 summary — must be ignored.
const SAMPLE_EC_MALFORMED_LONG = buf(
    'AAC632EC00180505000203030000010000F0000200000000000000000004AEBB000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003180505000203030000010000F000020000000000000000000445030001040000000043002902C500000000001000050436C0102002FF0000000000142E2223384631000001D1000003018600000000000000000000004D14242C180207C10276BB',
)

// Third capture (2026-09-24): Turbo with a 1-hour Delay Start, Night Dry lamp lit (panel photo).
// Selecting, Delay Start pressed: option bit 0x01.
const SAMPLE_EC_TURBO_DELAY_SELECTED = buf(
    'AA3A32EC0018010000003B0400003B0000F20002000000000000000000040018010000003B0400003B0000F20102000000000000000000044CBB',
)
// Started: state Running, process 0x01 (Delayed), delay 0:59 left of the cycle's 0:59 estimate.
const SAMPLE_EC_TURBO_DELAYED = buf(
    'AA3A32EC0018020100003B0400003B0100F00102000000000000000000040118020100003B0400003B003BF001020000000000000000000402BB',
)
// A minute later: delay 0:58.
const SAMPLE_EC_TURBO_DELAYED_LATER = buf(
    'AA3A32EC0018020100003B0400003B003BF00102000000000000000000040018020100003B0400003B003AF0010200000000000000000004DABB',
)

// Fourth capture (2026-09-24 20:16Z): Express, a hidden course, 0:34 — Washing.
const SAMPLE_EC_EXPRESS_WASHING = buf(
    'AA3A32EC00180100000022080000220000F200020000000000000000000400180202000022080000220000F0000200000000000000000004E8BB',
)

// Same Express selection, 20 s earlier: Control Lock held for ~16 s (user-confirmed), status bit 0x01.
const SAMPLE_EC_EXPRESS_CONTROL_LOCK = buf(
    'AA3A32EC00180100000022080000220000F200020000000000000000000400180100000022080000220000F3000200000000000000000004E8BB',
)

// Fifth capture (2026-09-24 20:52Z): Machine Clean, 1:22, just started washing (Night Dry bit clear).
const SAMPLE_EC_MACHINE_CLEAN_WASHING = buf(
    'AA3A32EC00180100000116090001160000720002000000000000000000040018020200011609000116000070000200000000000000000004C6BB',
)

// Sixth capture (2026-09-24 21:19Z): Rinse (hidden course), 0:12 — selected with Control Lock on
// (user-confirmed, status bit 0x01), then Rinsing a minute after the start.
const SAMPLE_EC_RINSE_CONTROL_LOCK = buf(
    'AA3A32EC0018010000000C0600000C0000720002000000000000000000040018010000000C0600000C00007300020000000000000000000434BB',
)
const SAMPLE_EC_RINSE_RINSING = buf(
    'AA3A32EC0018020200000C0600000C0000700002000000000000000000040018020300000C0600000C00007000020000000000000000000436BB',
)

// 0xD8 wash counter: 0x28 (40) at the 2026-09-22 Heavy run's drying stage, 0x2e (46) at the
// 2026-09-24 Rinse run's, one per wash in between.
const SAMPLE_D8_COUNT_40 = buf('AA0732D828B6BB')
// Reset to 0 three seconds after a completed Machine Clean (2026-09-25 02:09:53Z).
const SAMPLE_D8_RESET_AFTER_MACHINE_CLEAN = buf('AA0732D800EEBB')
const SAMPLE_D8_COUNT_46 = buf('AA0732D82EBCBB')

// ── Synthetic edge cases ──────────────────────────────────────────────────────

// state=0x07, process=0x09: both unmapped, must fall back to the numeric string.
const SAMPLE_UNMAPPED = buf('AA2032EB00180709000000000000000000000000000000000000000000005ABB')

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
            'control_lock',
            'energy_saver',
            'half_load',
            'extra_dry',
            'high_temp',
            'dual_zone',
            'night_dry',
            'delay_start',
            'delay_start_time',
            'tub_clean_counter',
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
            'steam',
            'remote_start',
        ]) {
            assert.ok(!components[c], `component ${c} removed`)
        }

        assert.equal(components.remaining_time.device_class, 'duration')
        assert.equal(components.remaining_time.unit_of_measurement, 'min')
        assert.equal(components.initial_time.device_class, 'duration')
        assert.equal(components.initial_time.unit_of_measurement, 'min')
    })

    test('0xEB Selecting publishes Selecting, Heavy, door open, plain minutes (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Selecting')
        assert.equal(props.process_state, '-')
        assert.equal(props.running, 'OFF') // course picked, not started yet
        assert.equal(props.current_course, 'Heavy')
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
        assert.equal(props.current_course, 'Heavy')
        assert.equal(props.initial_time, 194)
        assert.equal(props.remaining_time, 194)
        assert.equal(props.door_open, 'OFF')
        assert.equal(props.rinse_refill, 'OFF')
        assert.equal(props.energy_saver, 'OFF')
    })

    test('energy-saver option bit publishes ON while active (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_NORMAL_ENERGY_SAVER)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.current_course, 'Normal')
        assert.equal(props.run_state, 'Running')
        assert.equal(props.energy_saver, 'ON')
        assert.equal(props.high_temp, 'OFF')
        assert.equal(props.night_dry, 'OFF')
    })

    test('Half Load and Extra Dry option bits decode on a Delicate course (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_EC_HALF_LOAD)
        assert.equal(props.run_state, 'Selecting')
        assert.equal(props.current_course, 'Delicate')
        assert.equal(props.initial_time, 103)
        assert.equal(props.half_load, 'ON')
        assert.equal(props.extra_dry, 'OFF')

        thinq.emit('data', SAMPLE_EC_HALF_LOAD_EXTRA_DRY)
        assert.equal(props.initial_time, 123)
        assert.equal(props.half_load, 'ON')
        assert.equal(props.extra_dry, 'ON')
        assert.equal(props.door_open, 'ON')

        thinq.emit('data', SAMPLE_EC_DELICATE_WASHING)
        assert.equal(props.night_dry, 'ON') // Night Dry lamp lit in the panel photo
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.door_open, 'OFF')
        assert.equal(props.half_load, 'ON')
        assert.equal(props.extra_dry, 'ON')
        assert.equal(props.energy_saver, 'OFF')
        assert.equal(props.rinse_refill, 'OFF')

        thinq.emit('data', SAMPLE_EC_DELICATE_NIGHT_DRY)
        assert.equal(props.process_state, 'Night Dry')
        assert.equal(props.night_dry, 'ON')
        assert.equal(props.running, 'OFF')
        assert.equal(props.half_load, 'OFF')
        assert.equal(props.extra_dry, 'OFF')
    })

    test('malformed long 0xEC at cycle end is ignored and logged (real capture)', () => {
        const { ha, thinq } = makeDevice()
        const cap = captureLog()
        try {
            thinq.emit('data', SAMPLE_EC_MALFORMED_LONG)
            assert.equal(ha.devices[DEVICE_ID].properties.run_state, undefined)
            assert.equal(cap.calls.length, 1)
            assert.equal(cap.calls[0].arguments[2], 'unexpected 0xec length')
        } finally {
            cap.restore()
        }
    })

    test('Express (hidden course) is course 0x08 (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_EXPRESS_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.current_course, 'Express')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.initial_time, 34)
        assert.equal(props.running, 'ON')
    })

    test('Machine Clean is course 0x09 (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_MACHINE_CLEAN_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.current_course, 'Machine Clean')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.initial_time, 82)
        assert.equal(props.night_dry, 'OFF')
    })

    test('Rinse is course 0x06 (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = ha.devices[DEVICE_ID].properties
        thinq.emit('data', SAMPLE_EC_RINSE_CONTROL_LOCK)
        assert.equal(props.current_course, 'Rinse')
        assert.equal(props.initial_time, 12)
        assert.equal(props.control_lock, 'ON')
        thinq.emit('data', SAMPLE_EC_RINSE_RINSING)
        assert.equal(props.process_state, 'Rinsing')
        assert.equal(props.control_lock, 'OFF')
        assert.equal(props.night_dry, 'OFF')
    })

    test('Control Lock is status bit 0x01 (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = ha.devices[DEVICE_ID].properties
        thinq.emit('data', SAMPLE_EC_EXPRESS_CONTROL_LOCK)
        assert.equal(props.control_lock, 'ON')
        assert.equal(props.door_open, 'ON')
        thinq.emit('data', SAMPLE_EC_EXPRESS_WASHING)
        assert.equal(props.control_lock, 'OFF')
    })

    test('Turbo with Delay Start: Delayed phase, countdown, running OFF until it starts (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_EC_TURBO_DELAY_SELECTED)
        assert.equal(props.run_state, 'Selecting')
        assert.equal(props.current_course, 'Turbo')
        assert.equal(props.initial_time, 59)
        assert.equal(props.delay_start, 'ON')
        assert.equal(props.night_dry, 'ON') // Night Dry lamp lit in the panel photo
        assert.equal(props.delay_start_time, 0)

        thinq.emit('data', SAMPLE_EC_TURBO_DELAYED)
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Delayed')
        assert.equal(props.running, 'OFF') // waiting, not washing
        assert.equal(props.delay_start_time, 59)
        assert.equal(props.remaining_time, 59)

        thinq.emit('data', SAMPLE_EC_TURBO_DELAYED_LATER)
        assert.equal(props.delay_start_time, 58)
        assert.equal(props.delay_start, 'ON')
    })

    test('0xD8 publishes the wash counter as tub_clean_counter (real captures)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_D8_COUNT_40)
        assert.equal(ha.devices[DEVICE_ID].properties.tub_clean_counter, 40)
        thinq.emit('data', SAMPLE_D8_COUNT_46)
        assert.equal(ha.devices[DEVICE_ID].properties.tub_clean_counter, 46)
        thinq.emit('data', SAMPLE_D8_RESET_AFTER_MACHINE_CLEAN)
        assert.equal(ha.devices[DEVICE_ID].properties.tub_clean_counter, 0)
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
        assert.equal(props.night_dry, 'OFF') // bit clear once the machine is idle
    })

    test('0xEC Complete/Complete publishes both fields as Complete (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_COMPLETE_COMPLETE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Complete')
        assert.equal(props.process_state, 'Complete')
        assert.equal(props.running, 'OFF')
        assert.equal(props.current_course, '-')
        // Night Dry follows this run; the bit stays set through Complete, so it mustn't flicker OFF
        assert.equal(props.night_dry, 'ON')
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
        assert.equal(props.current_course, 'Heavy')
        assert.equal(props.remaining_time, 1)
        assert.equal(props.rinse_refill, 'ON')
    })

    test('Normal + High Temp decodes, and a brief Paused state keeps the cycle active (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_EC_NORMAL_HIGH_TEMP_SELECTING)
        assert.equal(props.night_dry, 'OFF') // Night Dry lamp off in the panel photo
        assert.equal(props.run_state, 'Selecting')
        assert.equal(props.current_course, 'Normal')
        assert.equal(props.initial_time, 170)
        assert.equal(props.high_temp, 'ON')
        assert.equal(props.dual_zone, 'OFF')
        assert.equal(props.half_load, 'OFF')
        assert.equal(props.extra_dry, 'OFF')
        assert.equal(props.energy_saver, 'OFF')

        thinq.emit('data', SAMPLE_EC_NORMAL_PAUSED)
        assert.equal(props.run_state, 'Paused')
        assert.equal(props.door_open, 'ON')
        assert.equal(props.running, 'ON')
        assert.equal(props.current_course, 'Normal')
        assert.equal(props.high_temp, 'ON')

        thinq.emit('data', SAMPLE_EC_NORMAL_RESUMED)
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.door_open, 'OFF')
    })

    test('Heavy with Dual Zone and High Temp reads option bits 0x18 (real capture, panel photo)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_RUNNING_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.high_temp, 'ON')
        assert.equal(props.dual_zone, 'ON')
    })

    test('unmapped state/process fall back to the numeric string', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UNMAPPED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, '7')
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
