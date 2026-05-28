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

// Speed 30 — no dry level (Bd[7]=0), Time eco hybrid
const SAMPLE_SPEED30 = buf(
    'AA3830EC001900000000000000000000000000000000000000000000000000001901000000000900000300000000000000000000000000000000C6BB',
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

    test('cycle is a read-only sensor (no command_topic)', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config!
        const cycle = (cfg.components as any).cycle
        assert.equal(cycle.platform, 'sensor')
        assert.ok(!cycle.command_topic, 'no command_topic on cycle sensor')
    })

    test('cycle sensor lists all 15 base courses', () => {
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

    test('downloaded cycle ID decoded from Bd[23]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOWNLOADED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.downloaded_cycle_id, '0x66 (Gym Clothes)')
        // Base course (Sports Wear) still shown in cycle sensor
        assert.equal(props.cycle, 'Sports Wear')
    })

    test('Speed 30 — dry level published as None (Bd[7]=0)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPEED30)
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Time')
    })

    test('cycle shows None when dryer is off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle, 'None')
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

    test('pause sends confirmed command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 1)
        assert.ok(hex(thinq.outbox[0]).includes(WRITE_PAUSE))
    })

    test('start with no cycle known sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '') // lastBdCycle=0, no cycle known
        assert.equal(thinq.outbox.length, 0)
    })

    test('start with JSON payload sends F0 26 command with correct fields', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty(
            'start',
            JSON.stringify({ cycle: 'Mixed Fabric', dry_level: 'Cupboard Dry', eco_hybrid: 'Time' }),
        )
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[0], 0xf0) // opcode
        assert.equal(inner[1], 0x26)
        assert.equal(inner[2], 0x06) // Mixed Fabric
        assert.equal(inner[3], 3) // Cupboard Dry
        assert.equal(inner[4], 3) // Time
        assert.equal(inner[12], 0x03) // start operation
    })

    test('start falls back to last Bd values when payload is empty', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL) // Mixed Fabric, Cupboard Dry, Time
        thinq.resetRecorder()
        dev.setProperty('start', '') // no JSON — use Bd fallback
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[2], 0x06) // Mixed Fabric
        assert.equal(inner[3], 3) // Cupboard Dry
        assert.equal(inner[4], 3) // Time
    })

    test('start with JSON reservation sets inner[8]', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', JSON.stringify({ cycle: 'Mixed Fabric', reservation: '4h' }))
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[8], 4) // 4h delayed end
    })

    test('start with JSON anti_crease sets inner[11]', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', JSON.stringify({ cycle: 'Mixed Fabric', anti_crease: true }))
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[11], 0x02) // anti-crease on
    })

    test('anti_crease switch toggle used as start fallback', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('anti_crease', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease, 'ON')
        thinq.resetRecorder()
        dev.setProperty('start', JSON.stringify({ cycle: 'Mixed Fabric' })) // no anti_crease in payload
        assert.equal(thinq.outbox.length, 1)
        const raw = thinq.outbox[0]
        const inner = raw[0] === 0xaa ? raw.subarray(2, raw.length - 2) : raw
        assert.equal(inner[11], 0x02) // anti-crease from switch state
    })

    test('start enforces schema — Speed 30 corrects invalid dry level to None', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', JSON.stringify({ cycle: 'Speed 30', dry_level: 'Cupboard Dry' })) // invalid for Speed 30
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

    // ── Power on wake sequence ────────────────────────────────────────────────

    test('power ON with known downloaded cycle sends F0 25 wake first', (t, done) => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DOWNLOADED) // loads Gym Clothes 0x66 as lastDownloadedCycleId
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
