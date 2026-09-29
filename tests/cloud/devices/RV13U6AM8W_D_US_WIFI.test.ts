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
// For 0xEC: inner is 60 bytes; previous record = inner[2..30], current record = inner[31..59]
//   (each frame's first record repeats the previous frame's second, so the second is the live state)

// ── Synthetic 0xEB samples ───────────────────────────────────────────────────

// Off — 0xEB, phase=0x00, mins=0
const SAMPLE_EB_OFF = buf('AA2330EB000000000000000000000000000000000000000000000000000000000000BB')

// Starting — 0xEB, phase=0x01, mins=60
const SAMPLE_EB_STARTING = buf('AA2330EB000001003C00000000000000000000000000000000000000000000000000BB')

// Drying — 0xEB, phase=0x32, mins=45
const SAMPLE_EB_DRYING = buf('AA2330EB000032002D00000000000000000000000000000000000000000000000000BB')

// Drying — 0xEC dual-record, previous: all-zero, current: phase=0x32 mins=30
const SAMPLE_EC_DRYING = buf(
    'AA4030EC0000000000000000000000000000000000000000000000000000000000000032001E00000000000000000000000000000000000000000000000003BB',
)

// ── Real validated captures — LG DLE7300WE (RV13U6AM8W_D_US_WIFI) ────────────
// Source: live device logs cross-referenced against LG ThinQ app and physical display.

// Post-reconnect 0xEB: phase=0x01 (Starting), mins=1. Device sends this briefly
// on every MQTT reconnect before the actual cycle state stabilises.
const SAMPLE_EB_RECONNECT = buf('AA2330EB001B010001000100000000000100000000A8000000000000006400000046BB')

// Mid-cycle Heavy Duty 0xEC: previous record phase=0x32 (Drying), mins=54;
// current record phase=0x32 (Drying), mins=53 — the countdown ticks from the first record to the second.
const SAMPLE_EC_HEAVY_DUTY = buf(
    'AA4030EC001B320036003601000305000100000000A90000000100000064000000001B320035003601000305000100000000A90000530100000064000000AFBB',
)

// Manual 20-min cycle 0xEC, sent as the temperature was changed before starting: both records
// phase=0x01 (Starting), mins=20; rec[10] goes 0x05 (High) in the previous record -> 0x01 (Ultra Low)
// in the current one. Phase is 0x01 because drying officially starts at 0x32.
const SAMPLE_EC_MANUAL_STARTING = buf(
    'AA4030EC001B010014001412000005010100000040A80000000000000064000000001B010014001412000001010100000040A8000000000000006400000001BB',
)

// Resume 0xEC from the Low-heat 60+15-min manual run: previous record phase=0x03 (Paused), current
// record phase=0x32 (Drying), mins=18 in both (frozen during the pause). rec[10]=0x02 (Low).
// Note: dryer pause=0x03, NOT 0x02 (washer).
// The paused record from SAMPLE_EC_RESUME, as the single-record 0xEB the dryer sends in that state.
const SAMPLE_EB_PAUSED = buf('AA2330EB001B030012001412000002010100000040A8000074320000006400000061BB')

const SAMPLE_EC_RESUME = buf(
    'AA4030EC001B030012001412000002010100000040A80000743200000064000000001B320012001412000002010100000000A900007403000000640000000ABB',
)

// Synthetic 0xEC Cooldown: phase=0x33, mins=1. Constructed because the real
// cooldown capture is a 35-byte truncated packet the parser silently ignores.
const SAMPLE_EC_COOLDOWN = buf(
    'AA4030EC000000000000000000000000000000000000000000000000000000000000003300010000000000000000000000000000000000000000000000006FBB',
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
        for (const c of ['status', 'remaining_time', 'power', 'drum_running', 'cycle', 'temp', 'dry_level']) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok(!components.start_time, 'start_time not present')
        assert.ok(!components.stop_time, 'stop_time not present')
        assert.ok(Array.isArray(components.status.options))
        assert.ok((components.status.options as string[]).includes('Drying'))
    })

    test('0xEB Off frame publishes power=OFF and Off phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    test('0xEB Starting frame publishes power=ON, Starting phase, 60 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Starting')
        assert.equal(props.remaining_time, 60)
    })

    test('0xEB Drying frame publishes Drying phase and 45 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Drying')
        assert.equal(props.remaining_time, 45)
    })

    test('0xEC dual-record frame uses current record only', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.remaining_time, 30)
    })

    // ── Real capture tests ────────────────────────────────────────────────────

    test('real post-reconnect 0xEB publishes Starting/1 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_RECONNECT)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Starting')
        assert.equal(props.remaining_time, 1)
        assert.equal(props.power, 'ON')
    })

    test('real heavy-duty 0xEC publishes its current record: Drying/53 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_HEAVY_DUTY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.remaining_time, 53)
        assert.equal(props.power, 'ON')
    })

    test('real manual-cycle 0xEC publishes Starting/20 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_MANUAL_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Starting')
        assert.equal(props.remaining_time, 20)
        assert.equal(props.power, 'ON')
    })

    test('real resume 0xEC publishes its current record: Drying/18 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RESUME)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.remaining_time, 18)
        assert.equal(props.power, 'ON')
    })

    test('paused record publishes Paused/18 min, power ON (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Paused')
        assert.equal(props.remaining_time, 18)
        assert.equal(props.power, 'ON')
    })

    test('0xEC Cooldown frame publishes Cooldown phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_COOLDOWN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Cooldown')
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
        // EC_MANUAL_STARTING: rec[7]=0x12, rec[9]=0x00, current rec[10]=0x01 (changed from High to Ultra Low)
        const { ha: ha1, thinq: thinq1 } = makeDevice()
        thinq1.emit('data', SAMPLE_EC_MANUAL_STARTING)
        assert.equal(ha1.devices[DEVICE_ID].properties.cycle, 'Manual')
        assert.equal(ha1.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha1.devices[DEVICE_ID].properties.temp, 'Ultra Low')

        // EC_RESUME: rec[7]=0x12, rec[9]=0x00, rec[10]=0x02 (Low-heat 60+15-min run)
        const { ha: ha2, thinq: thinq2 } = makeDevice()
        thinq2.emit('data', SAMPLE_EC_RESUME)
        assert.equal(ha2.devices[DEVICE_ID].properties.cycle, 'Manual')
        assert.equal(ha2.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha2.devices[DEVICE_ID].properties.temp, 'Low')
    })

    // rec[17] bit 0x01: drum/blower turning (0xa9, 0xab), clear when stopped (0xa8). Confirmed via
    // deliberate pause testing and a live Normal cycle (0xab).
    // Note: EC_MANUAL_STARTING also shows 0xa8 — drum is not yet spinning at the start of the
    // Starting phase, only during active drying and cooldown.
    test('drum_running=ON during active drying, OFF when paused (real captures)', () => {
        const { ha: ha1, thinq: thinq1 } = makeDevice()
        thinq1.emit('data', SAMPLE_EC_HEAVY_DUTY)
        assert.equal(ha1.devices[DEVICE_ID].properties.drum_running, 'ON')

        const { ha: ha2, thinq: thinq2 } = makeDevice()
        thinq2.emit('data', SAMPLE_EB_PAUSED)
        assert.equal(ha2.devices[DEVICE_ID].properties.drum_running, 'OFF')
    })

    test('drum_running=OFF during Starting phase before drum spins up (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_MANUAL_STARTING)
        assert.equal(ha.devices[DEVICE_ID].properties.drum_running, 'OFF')
    })

    // ── Live DLE7300WE, provisioned locally without bridge (Normal cycle, Med High, mid-run) ──
    // Before the status request the dryer sent only its 0x31 identity and a 0x72 heartbeat, even
    // mid-cycle. After it: a 0xEB snapshot within the same second, then 0xEC updates every ~4 s.
    const LIVE_EB = 'AA2330EB001B32001E002603000304000400000000AB0002090100000064000000F7BB'
    const LIVE_EC = [
        'AA4030EC001B32001E002603000304000400000000AB0002090100000064000000001B32001E002603000304000400000000AB00020A01000000640000002EBB',
        'AA4030EC001B32001E002603000304000400000000AB00020A0100000064000000001B32001D002603000304000400000000AB00020A01000000640000002EBB',
        'AA4030EC001B32001D002603000304000400000000AB00020A0100000064000000001B32001D002603000304000400000000AB00020B01000000640000002EBB',
    ]

    test('start() asks the dryer for its state with the read-only 0xF0ED request', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            ['AA0EF0ED1121010000001800B5BB'],
        )
    })

    test('acks the identity and heartbeat frames, not its own 0xEB/0xEC status records (real captures)', () => {
        const { thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDENTITY)
        thinq.emit('data', buf('AA09307200C9004BBB'))
        thinq.emit('data', buf(LIVE_EB))
        for (const f of LIVE_EC) thinq.emit('data', buf(f))
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, ['AA08F000310482BB', 'AA08F00072044DBB'])
    })

    test('consecutive 0xEC frames chain: each first record repeats the previous second (real captures)', () => {
        const recs = LIVE_EC.map((f) => buf(f).subarray(2, -2))
        for (let i = 1; i < recs.length; i++) {
            assert.deepEqual(recs[i].subarray(2, 31), recs[i - 1].subarray(31, 60))
        }
    })

    test('live snapshot then updates publish Normal / Med High / Normal and count down 30 -> 29 (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties
        thinq.emit('data', buf(LIVE_EB))
        assert.deepEqual(
            [
                props().status,
                props().remaining_time,
                props().cycle,
                props().temp,
                props().dry_level,
                props().drum_running,
            ],
            ['Drying', 30, 'Normal', 'Med High', 'Normal', 'ON'],
        )
        const mins: unknown[] = []
        for (const f of LIVE_EC) {
            thinq.emit('data', buf(f))
            mins.push(props().remaining_time)
        }
        assert.deepEqual(mins, [30, 29, 29])
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

    test('undecoded status value publishes the "None" fallback', () => {
        const { ha, thinq } = makeDevice()
        // phase=0xFF at inner[4]
        thinq.emit('data', buf('AA2330EB0000FF000000000000000000000000000000000000000000000000000000BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'None')
    })
})
