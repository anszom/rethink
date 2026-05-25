import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RH90V9_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RH90V9_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'RH90V9_WW', swVersion: '2.10.123' }

// ─── Test packets ──────────────────────────────────────────────────────────────
// All packets are real AABB state frames built from confirmed wire captures.
// Inner structure: header(4: 30 EC 00 19) + A block(26) + B block(26)
// B block: 0x19 marker + Bd[0..24] current state

// Dryer off, no cycle selected
const SAMPLE_OFF = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001900000000000000000000000000000000000000000000000000D3BB',
)

// Initial state — Mixed Fabric selected, Cupboard Dry, Time eco hybrid
const SAMPLE_INITIAL = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001901000000000600030300000000000000000000000000000000C6BB',
)

// Running — Mixed Fabric, Cupboard Dry, Time, 48min remaining, remote start armed
const SAMPLE_RUNNING = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001902003000300600030302000000000001000000000000000000A2BB',
)

// Paused — Mixed Fabric, 30min remaining
const SAMPLE_PAUSED = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001903001E00000600030300000000000000000000000000000000E6BB',
)

// End state
const SAMPLE_END = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001904000000000600000000000000000000000000000000000000C5BB',
)

// Error state — door open (error code 15 = 0x0F)
const SAMPLE_ERROR = buf(
    'AA3830EC00190000000000000000000000000000000000000000000000000000190500000000060F000000000000000000000000000000000000F5BB',
)

// Anti-crease flag set (Bd[14] bit 0x02)
const SAMPLE_ANTI_CREASE = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001902000000000600000000000000000200000000000000000000C5BB',
)

// Remote start armed (Bd[15] bit 0x01)
const SAMPLE_REMOTE_START = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001901000000000600000000000000000001000000000000000000DBBB',
)

// Reservation 4h (Bd[10] = 4)
const SAMPLE_RESERVATION = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001901000000000600000000040000000000000000000000000000C4BB',
)

// Downloaded cycle — Sports Wear base + Gym Clothes SmartCourse (Bd[23]=0x66)
const SAMPLE_DOWNLOADED = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001902000000000800000000000000000000000000000000006600A3BB',
)

// Speed 30 — no dry level, Time eco hybrid
const SAMPLE_SPEED30 = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001901000000000900000300000000000000000000000000000000C6BB',
)

// Towels with stale dry level from previous cycle (Bd[7]=3 but Towels has no dry level)
const SAMPLE_TOWELS_STALE_DRY = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001901000000000200030300000000000000000000000000000000DABB',
)

// Expected outgoing command bytes
const WRITE_POLL = 'F0ED1121010000001804131400005A' // F0 ED handshake
const WRITE_POWER_ON = 'F02A0100' // confirmed: aa08f02a010098bb
const WRITE_POWER_OFF = 'F024010100' // confirmed: aa09f0240101009cbb
const WRITE_PAUSE = 'F024040100' // confirmed: aa09f02404010099bb

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    // ── Config ────────────────────────────────────────────────────────────────

    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'safety_lock',
            'power',
            'remote_start',
            'cycle',
            'dry_level',
            'eco_hybrid',
            'anti_crease',
            'reservation',
            'start',
            'pause',
            'ping',
            'run_state',
            'process_state',
            'remaining_time',
            'initial_time',
            'run_completed',
            'error',
            'error_message',
            'downloaded_cycle_id',
        ]) {
            assert.ok(components[c], `component '${c}' present`)
        }
    })

    test('safety lock starts enabled', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID].properties.safety_lock, 'Enabled')
    })

    test('cycle selector contains all 15 base courses', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config!
        const options = (cfg.components as any).cycle.options as string[]
        for (const c of [
            'Towels',
            'Duvet',
            'Easy Care',
            'Mixed Fabric',
            'Cotton',
            'Sports Wear',
            'Speed 30',
            'Delicates',
            'Wool',
            'Rack Dry',
            'Warm Air',
            'Allergy Care',
            'Condenser Care',
            'Drum Care',
            'Eco (Cotton+)',
        ]) {
            assert.ok(options.includes(c), `cycle options includes '${c}'`)
        }
    })

    // ── State packet decoding ─────────────────────────────────────────────────

    test('off state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.run_state, 'Off')
        assert.equal(props.run_completed, 'OFF')
        assert.equal(props.error, 'OFF')
    })

    test('initial state decodes run state, cycle, dry level, eco hybrid', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.run_state, 'Initial')
        assert.equal(props.cycle, 'Mixed Fabric')
        assert.equal(props.dry_level, 'Cupboard Dry')
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.error, 'OFF')
    })

    test('running state decodes remaining time and remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Running')
        assert.equal(props.remaining_time, 48) // 0h 48min
        assert.equal(props.initial_time, 48)
        assert.equal(props.remote_start, 'ON') // Bd[15] bit 0x01
        assert.equal(props.process_state, 'Dry')
    })

    test('paused state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Paused')
        assert.equal(props.remaining_time, 30)
    })

    test('end state sets run_completed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'End')
        assert.equal(props.run_completed, 'ON')
        assert.equal(props.remaining_time, 0)
    })

    test('error state decodes error code', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ERROR)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.run_state, 'Error')
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'dE (door open)') // error code 15
    })

    test('anti-crease flag decoded from Bd[14]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ANTI_CREASE)
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease, 'ON')
    })

    test('remote start flag decoded from Bd[15]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
    })

    test('reservation decoded from Bd[10]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RESERVATION)
        assert.equal(ha.devices[DEVICE_ID].properties.reservation, '4h')
    })

    test('downloaded cycle ID decoded from Bd[20]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOWNLOADED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.downloaded_cycle_id, '0x66 (Gym Clothes)')
        // Base course (Sports Wear) still shows in cycle selector
        assert.equal(props.cycle, 'Sports Wear')
    })

    // ── Schema enforcement ────────────────────────────────────────────────────

    test('Speed 30 — dry level forced to None (not supported)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPEED30)
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Time')
    })

    test('Towels — stale dry level from previous cycle corrected to None', () => {
        const { ha, thinq } = makeDevice()
        // Packet has Bd[7]=3 (Cupboard Dry) but Towels has no dry level support
        thinq.emit('data', SAMPLE_TOWELS_STALE_DRY)
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'None')
    })

    test('updateCycleOptions — Mixed Fabric shows correct dry level options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL) // Mixed Fabric
        const cfg = ha.devices[DEVICE_ID].config!
        const options = (cfg.components as any).dry_level.options as string[]
        assert.ok(options.includes('Iron Dry'))
        assert.ok(options.includes('Cupboard Dry'))
        assert.ok(options.includes('Extra Dry'))
        assert.ok(!options.includes('None'))
    })

    test('unknown cycle IDs (0x00, 0x01) are not published to cycle selector', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF) // cycle=0x00
        // cycle selector should not be updated with unknown values
        const props = ha.devices[DEVICE_ID].properties
        assert.ok(!props.cycle || !props.cycle.startsWith('unknown'))
    })

    // ── Commands ──────────────────────────────────────────────────────────────

    test('ping sends F0 ED handshake', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('ping', '')
        assert.equal(thinq.outbox.length, 1)
        assert.ok(hex(thinq.outbox[0]).includes(WRITE_POLL))
    })

    test('power OFF sends confirmed command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.ok(hex(thinq.outbox[0]).includes(WRITE_POWER_OFF))
    })

    test('power ON blocked when safety lock enabled', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON') // safety lock is enabled by default
        assert.equal(thinq.outbox.length, 0)
    })

    test('power ON allowed when safety lock disabled', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty(
            'safety_lock',
            'Disabled (I accept the safety/fire risk, not recommended, use with caution, see docs for details)',
        )
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.ok(hex(thinq.outbox[0]).includes(WRITE_POWER_ON))
    })

    test('pause sends confirmed command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 1)
        assert.ok(hex(thinq.outbox[0]).includes(WRITE_PAUSE))
    })

    test('start with no cycle selected sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('start after cycle selected sends F0 26 command with correct fields', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Mixed Fabric') // cycle ID 0x06
        dev.setProperty('dry_level', 'Cupboard Dry') // dry level 3
        dev.setProperty('eco_hybrid', 'Time') // eco hybrid 3
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 1)
        // outbox[0] is the raw inner buffer passed to send()
        // find F0 26 opcode — either raw inner or AABB-wrapped
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[0], 0xf0) // opcode
        assert.equal(inner[1], 0x26)
        assert.equal(inner[2], 0x06) // Mixed Fabric
        assert.equal(inner[3], 3) // Cupboard Dry
        assert.equal(inner[4], 3) // Time
        assert.equal(inner[12], 0x03) // start operation
    })

    test('start with reservation sets inner[8]', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Mixed Fabric')
        dev.setProperty('reservation', '4h')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[8], 4) // 4h delayed end
    })

    test('start with anti-crease sets inner[11]', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Mixed Fabric')
        dev.setProperty('anti_crease', 'ON')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[11], 0x02) // anti-crease on
    })

    test('start enforces schema — Speed 30 corrects invalid dry level', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Speed 30') // no dry level support
        dev.setProperty('dry_level', 'Cupboard Dry') // invalid for Speed 30
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[3], 0) // corrected to None
    })

    test('unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })

    // ── Selector lock ─────────────────────────────────────────────────────────

    test('selector lock prevents state packet from overwriting user edit', () => {
        const { ha, thinq, dev } = makeDevice()
        // Set cycle first (so cycle lock doesn't interfere with dry_level)
        thinq.emit('data', SAMPLE_INITIAL) // Mixed Fabric — sets cycle, locks it
        // User then picks Extra Dry — locks dry_level
        dev.setProperty('dry_level', 'Extra Dry')
        // Another state packet arrives with Cupboard Dry — should be ignored while locked
        thinq.emit('data', SAMPLE_INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Extra Dry')
    })

    // ── setProperty string parsing ────────────────────────────────────────────

    test('setProperty cycle — string to ID and back', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Cotton')
        assert.equal(ha.devices[DEVICE_ID].properties.cycle, 'Cotton')
        // Confirm cycle ID was set correctly by starting and checking inner[2]
        thinq.resetRecorder()
        dev.setProperty('start', '')
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[2], 0x07) // Cotton = 0x07
    })

    test('setProperty dry_level — string to ID and back', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Mixed Fabric')
        dev.setProperty('dry_level', 'Iron Dry')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Iron Dry')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[3], 1) // Iron Dry = 1
    })

    test('setProperty eco_hybrid — string to ID and back', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Mixed Fabric')
        dev.setProperty('eco_hybrid', 'Energy')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Energy')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[4], 1) // Energy = 1
    })

    test('setProperty reservation — string to hours and back', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('cycle', 'Mixed Fabric')
        dev.setProperty('reservation', '7h')
        assert.equal(ha.devices[DEVICE_ID].properties.reservation, '7h')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[8], 7) // 7h
    })

    // ── Cycle timing ──────────────────────────────────────────────────────────

    test('cycle_start_time set when state transitions to Running', () => {
        const { ha, thinq } = makeDevice()
        const before = Date.now()
        thinq.emit('data', SAMPLE_RUNNING)
        const startTime = ha.devices[DEVICE_ID].properties.cycle_start_time
        assert.ok(startTime && startTime !== '-', 'cycle_start_time published')
        const parsed = new Date(startTime).getTime()
        assert.ok(parsed >= before, 'start time is recent')
    })

    test('cycle_end_time derived from remaining time', () => {
        const { ha, thinq } = makeDevice()
        const before = Date.now()
        thinq.emit('data', SAMPLE_RUNNING) // 48min remaining
        const endTime = ha.devices[DEVICE_ID].properties.cycle_end_time
        assert.ok(endTime && endTime !== '-', 'cycle_end_time published')
        const parsed = new Date(endTime).getTime()
        const expectedEnd = before + 48 * 60 * 1000
        assert.ok(Math.abs(parsed - expectedEnd) < 5000, 'end time ≈ now + 48min')
    })

    test('cycle_duration is non-negative while running', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        const duration = ha.devices[DEVICE_ID].properties.cycle_duration
        assert.ok(Number(duration) >= 0)
    })

    test('cycle timing cleared on End state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        thinq.emit('data', SAMPLE_END)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_duration, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_end_time, '-')
    })

    test('cycle timing cleared on Off state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        thinq.emit('data', SAMPLE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_duration, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_end_time, '-')
    })

    test('start_time not reset on subsequent Running packets', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        const first = ha.devices[DEVICE_ID].properties.cycle_start_time
        thinq.emit('data', SAMPLE_RUNNING)
        const second = ha.devices[DEVICE_ID].properties.cycle_start_time
        assert.equal(first, second, 'start time unchanged on repeat Running packets')
    })

    // ── Process state ─────────────────────────────────────────────────────────

    test('process state shows - when dryer is off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.process_state, '-')
    })

    test('process state shows Dry when running', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.process_state, 'Dry')
    })

    // ── None states ───────────────────────────────────────────────────────────

    test('cycle shows None when dryer is off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle, 'None')
    })

    test('selecting None from cycle selector is a no-op', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('cycle', 'None')
        assert.equal(thinq.outbox.length, 0)
    })

    // ── Power on wake sequence ────────────────────────────────────────────────

    test('power ON with known downloaded cycle sends F0 25 wake first', (t, done) => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DOWNLOADED) // loads Gym Clothes 0x66 as lastDownloadedCycleId
        dev.setProperty(
            'safety_lock',
            'Disabled (I accept the safety/fire risk, not recommended, use with caution, see docs for details)',
        )
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        // F0 25 sent immediately
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[0], 0xf0)
        assert.equal(inner[1], 0x25) // wake opcode
        assert.equal(inner[15], 0x66) // Gym Clothes
        // F0 2A follows after 500ms
        setTimeout(() => {
            assert.equal(thinq.outbox.length, 2)
            const raw2 = thinq.outbox[1]
            const inner2 = raw2[0] === 0xaa ? raw2.subarray(2, raw2.length - 2) : raw2
            assert.equal(inner2[0], 0xf0)
            assert.equal(inner2[1], 0x2a)
            done()
        }, 600)
    })

    test('power ON with no downloaded cycle sends F0 2A directly', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty(
            'safety_lock',
            'Disabled (I accept the safety/fire risk, not recommended, use with caution, see docs for details)',
        )
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[0], 0xf0)
        assert.equal(inner[1], 0x2a) // F0 2A directly
    })

    // ── Packet filtering ──────────────────────────────────────────────────────

    test('non-state packets are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        const before = ha.devices[DEVICE_ID].properties.power

        // Send junk packet
        thinq.emit('data', buf('AA083000250052BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })
})
