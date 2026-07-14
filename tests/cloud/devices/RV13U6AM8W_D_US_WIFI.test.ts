import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13U6AM8W_D_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13U6AM8W_D_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LG DLE7300WE', swVersion: '1.0' }

// Packet layout: AA <len> <inner> <cksum> BB  (len = total packet length)
// processAABB receives inner = raw.subarray(2, raw.length - 2)
// For 0xEB: inner is 31 bytes; record = inner[2..30] (29 bytes)
//   phase = rec[2] = inner[4], remaining_time (min) = rec[4] = inner[6]
// For 0xEC: inner is 60 bytes; current record = inner[2..30], previous = inner[31..59]

// ── Synthetic 0xEB samples ───────────────────────────────────────────────────

// Off — 0xEB, phase=0x00, mins=0
const SAMPLE_EB_OFF = buf('AA2330EB000000000000000000000000000000000000000000000000000000000000BB')

// Starting — 0xEB, phase=0x01, mins=60
const SAMPLE_EB_STARTING = buf('AA2330EB000001003C00000000000000000000000000000000000000000000000000BB')

// Drying — 0xEB, phase=0x32, mins=45
const SAMPLE_EB_DRYING = buf('AA2330EB000032002D00000000000000000000000000000000000000000000000000BB')

// Drying — 0xEC dual-record, current: phase=0x32 mins=30, previous: all-zero
const SAMPLE_EC_DRYING = buf(
    'AA4030EC000032001E000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000BB',
)

// ── Real validated captures — LG DLE7300WE (RV13U6AM8W_D_US_WIFI) ────────────
// Source: live device logs cross-referenced against LG ThinQ app and physical display.

// Post-reconnect 0xEB: phase=0x01 (Starting), mins=1. Device sends this briefly
// on every MQTT reconnect before the actual cycle state stabilises.
const SAMPLE_EB_RECONNECT = buf('AA2330EB001B010001000100000000000100000000A8000000000000006400000046BB')

// Mid-cycle Heavy Duty 0xEC: current record phase=0x32 (Drying), mins=54;
// previous record phase=0x32 (Drying), mins=53 — clean one-minute decrement.
const SAMPLE_EC_HEAVY_DUTY = buf(
    'AA4030EC001B320036003601000305000100000000A90000000100000064000000001B320035003601000305000100000000A90000530100000064000000AFBB',
)

// Manual 20-min High-heat cycle 0xEC: current record phase=0x01 (Starting), mins=20.
// Phase is 0x01 in this capture because drying officially starts at 0x32.
// rec[10]=0x05 (High) — note: earlier comment said "Low-heat" but byte decode confirms High.
const SAMPLE_EC_MANUAL_STARTING = buf(
    'AA4030EC001B010014001412000005010100000040A80000000000000064000000001B010014001412000001010100000040A8000000000000006400000001BB',
)

// Deliberately paused 0xEC from the Low-heat 60+15-min manual run: phase=0x03 (Paused),
// mins=18 (frozen during pause). rec[10]=0x02 (Low). Note: dryer pause=0x03, NOT 0x02 (washer).
const SAMPLE_EC_PAUSED = buf(
    'AA4030EC001B030012001412000002010100000040A80000743200000064000000001B320012001412000002010100000000A900007403000000640000000ABB',
)

// Synthetic 0xEC Cooldown: phase=0x33, mins=1. Constructed because the real
// cooldown capture is a 35-byte truncated packet the parser silently ignores.
const SAMPLE_EC_COOLDOWN = buf(
    'AA4030EC0000330001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000BB',
)

// Real cooldown capture (35 bytes): EC type byte but inner is only 31 bytes —
// does not satisfy the 60-byte EC condition, so the parser ignores it.
const SAMPLE_EC_COOLDOWN_TRUNCATED = buf('AA4030EC001B330001010301000305000100000040A8000BFD33000000640000000BBB')

// Power-off mid-cycle (89 bytes, three stacked records): the parser only handles
// 60-byte EC bodies, so this is silently ignored.
const SAMPLE_EC_POWER_OFF = buf(
    'AA4030EC001B320012001412000002010100000000A900007403000000640000000F001412000002010100000000A900009F0300000064000000001B00000F000F00000000000100000040A80000A13200000064000000C1BB',
)

// Device identity/info packet (cmd 0x31): sent once per MQTT reconnect, carries
// no cycle state and should pass through silently.
const SAMPLE_IDENTITY = buf(
    'AA3730310201534141333839363434323600002DF000008000000000000253414133383936343331300000AEAD000040000000000020BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of ['phase', 'remaining_time', 'power', 'drum_running', 'cycle', 'temp', 'dry_level']) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok(!components.start_time, 'start_time not present')
        assert.ok(!components.stop_time, 'stop_time not present')
        assert.ok(Array.isArray(components.phase.options))
        assert.ok((components.phase.options as string[]).includes('Drying'))
    })

    test('0xEB Off frame publishes power=OFF and Off phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.phase, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    test('0xEB Starting frame publishes power=ON, Starting phase, 60 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Starting')
        assert.equal(props.remaining_time, 60)
    })

    test('0xEB Drying frame publishes Drying phase and 45 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Drying')
        assert.equal(props.remaining_time, 45)
    })

    test('0xEC dual-record frame uses current record only', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.phase, 'Drying')
        assert.equal(props.remaining_time, 30)
    })

    // ── Real capture tests ────────────────────────────────────────────────────

    test('real post-reconnect 0xEB publishes Starting/1 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_RECONNECT)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.phase, 'Starting')
        assert.equal(props.remaining_time, 1)
        assert.equal(props.power, 'ON')
    })

    test('real heavy-duty 0xEC publishes Drying/54 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_HEAVY_DUTY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.phase, 'Drying')
        assert.equal(props.remaining_time, 54)
        assert.equal(props.power, 'ON')
    })

    test('real manual-cycle 0xEC publishes Starting/20 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_MANUAL_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.phase, 'Starting')
        assert.equal(props.remaining_time, 20)
        assert.equal(props.power, 'ON')
    })

    test('real paused 0xEC publishes Paused/18 min, power ON (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.phase, 'Paused')
        assert.equal(props.remaining_time, 18)
        assert.equal(props.power, 'ON')
    })

    test('0xEC Cooldown frame publishes Cooldown phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_COOLDOWN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.phase, 'Cooldown')
        assert.equal(props.remaining_time, 1)
        assert.equal(props.power, 'ON')
    })

    // ── Settings cluster tests ────────────────────────────────────────────────

    test('real heavy-duty EC (auto-sense) reports cycle, temp, dry_level (real capture)', () => {
        // rec[7]=0x01 (Heavy Duty), rec[9]=0x03 (Normal), rec[10]=0x05 (High)
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_HEAVY_DUTY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.cycle, 'Heavy Duty')
        assert.equal(props.temp, 'High')
        assert.equal(props.dry_level, 'Normal')
    })

    test('manual cycle reports cycle=Manual and dry_level=None; temp varies by heat selection (real captures)', () => {
        // EC_MANUAL_STARTING: rec[7]=0x12, rec[9]=0x00, rec[10]=0x05 (High-heat 20-min run)
        const { ha: ha1, thinq: thinq1 } = makeDevice()
        thinq1.emit('data', SAMPLE_EC_MANUAL_STARTING)
        assert.equal(ha1.devices[DEVICE_ID].properties.cycle, 'Manual')
        assert.equal(ha1.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha1.devices[DEVICE_ID].properties.temp, 'High')

        // EC_PAUSED: rec[7]=0x12, rec[9]=0x00, rec[10]=0x02 (Low-heat 60+15-min run)
        const { ha: ha2, thinq: thinq2 } = makeDevice()
        thinq2.emit('data', SAMPLE_EC_PAUSED)
        assert.equal(ha2.devices[DEVICE_ID].properties.cycle, 'Manual')
        assert.equal(ha2.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha2.devices[DEVICE_ID].properties.temp, 'Low')
    })

    // rec[17]: 0xa9 = drum/blower turning, 0xa8 = stopped. Confirmed via deliberate pause testing.
    // Note: EC_MANUAL_STARTING also shows 0xa8 — drum is not yet spinning at the start of the
    // Starting phase, only during active drying and cooldown.
    test('drum_running=ON during active drying, OFF when paused (real captures)', () => {
        const { ha: ha1, thinq: thinq1 } = makeDevice()
        thinq1.emit('data', SAMPLE_EC_HEAVY_DUTY)
        assert.equal(ha1.devices[DEVICE_ID].properties.drum_running, 'ON')

        const { ha: ha2, thinq: thinq2 } = makeDevice()
        thinq2.emit('data', SAMPLE_EC_PAUSED)
        assert.equal(ha2.devices[DEVICE_ID].properties.drum_running, 'OFF')
    })

    test('drum_running=OFF during Starting phase before drum spins up (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_MANUAL_STARTING)
        assert.equal(ha.devices[DEVICE_ID].properties.drum_running, 'OFF')
    })

    // ── Ignored packet tests ──────────────────────────────────────────────────

    test('frames with wrong device byte (not 0x30) are ignored', () => {
        const { ha, thinq } = makeDevice()
        // Same as SAMPLE_EB_OFF but with 0x20 (washer) instead of 0x30
        thinq.emit('data', buf('AA2320EB000000000000000000000000000000000000000000000000000000000000BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('frames that are too short are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA0430EB00BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('real cooldown capture (truncated 35-byte EC) is ignored', () => {
        // Inner is 31 bytes with type=EC; parser requires 60 bytes for EC → ignored.
        // This documents a known parser limitation: the dryer sends a shorter EC
        // packet for the cooldown phase that the current parser cannot decode.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_COOLDOWN_TRUNCATED)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('real power-off capture (89-byte three-record EC) is ignored', () => {
        // Parser only handles two-record (60-byte inner) EC packets.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_POWER_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('identity/info packet (cmd 0x31) is ignored without error', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDENTITY)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('unknown phase value publishes hex fallback string', () => {
        const { ha, thinq } = makeDevice()
        // phase=0xFF at inner[4]
        thinq.emit('data', buf('AA2330EB0000FF000000000000000000000000000000000000000000000000000000BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Unknown (0xff)')
    })
})
