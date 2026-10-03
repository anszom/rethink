import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/T1789EFH_F'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'T1789EFH_F'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LG WT7300CW', swVersion: '1.0' }

// Packet layout: AA <len> <inner> <cksum> BB  (len = total packet length)
// processAABB receives inner = raw.subarray(2, raw.length - 2)
// For 0xEB: inner is 29 bytes; record = inner[2..28] (27 bytes)
// For 0xEC: inner is 56 bytes; previous record = inner[2..28], current record = inner[29..55]
//   phase = rec[2], remaining_time (min) = rec[4]; for the current record that is inner[31] / inner[33]

// ── Synthetic samples ────────────────────────────────────────────────────────

// Off — 0xEB, phase=0x00, mins=0
const SAMPLE_EB_OFF = buf('AA2120EB00000000000000000000000000000000000000000000000000000000BB')

// Wash (main) — 0xEB, phase=0x05, mins=30
const SAMPLE_EB_WASH = buf('AA2120EB000005001E0000000000000000000000000000000000000000000000BB')

// Off — 0xEC dual-record, both all-zero
const SAMPLE_EC_OFF = buf(
    'AA3C20EC00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000BB',
)

// ── Real validated captures — LG WT7300CW (T1789EFH_F) ──────────────────────
// Source: live device logs cross-referenced against LG ThinQ app and physical display.

// Idle just after provisioning — EC, phase=0x00 in both records.
const SAMPLE_EC_IDLE = buf(
    'AA3C20EC0019000000011A00000000000000000000100000040800000064000019000000011A000000000000000000001000000408000000640037BB',
)

// Heavy Duty mid-cycle — EC, previous record Wash (main)/24 min, current record Rinse / Drain/29 min.
const SAMPLE_EC_HEAVY_DUTY = buf(
    'AA3C20EC0019050018011A0200050304000000000410000000050000006400001906001D011E0200000304000000000410000000050000006400FABB',
)

// Bedding cycle, the frame sent as it paused — EC, previous record Wash (main), current record Paused, mins=43.
const SAMPLE_EC_RUNNING = buf(
    'AA3C20EC001905002B00340800030104000000000410000000030000006400001902002B0034080003010400000000041000000005000000640054BB',
)

// Paused (deliberate lid-open pause) — EC, phase=0x02 (Paused), mins=43 (frozen).
// Note: washer pause=0x02, NOT 0x03 (dryer).
const SAMPLE_EC_PAUSED = buf(
    'AA3C20EC001902002B00340800030104000000000410000000050000006400001902002B00340800030104000000000010000000050000006400A9BB',
)

// Resumed (immediately after unpausing) — EC, previous record Paused, current record Wash (main), mins=43.
const SAMPLE_EC_RESUMED = buf(
    'AA3C20EC001902002B00340800030104000000000010000000050000006400001905002B00340800030104000000000010000000020000006400ADBB',
)

// Spin transition — EC, previous record Rinse / Drain (0x07)/1 min, current record Spin (0x08)/0 min.
const SAMPLE_EC_SPIN = buf(
    'AA3C20EC00190700010019010000030000000000440000000006000000640000190800000019010000030000000000440000000107000000640099BB',
)

// Short idle/ack packet (7 bytes, cmd 0xD8) — sent around reconnects and end-of-cycle.
const SAMPLE_SHORT_ACK = buf('AA0720D80EE2BB')

// Device identity/info packet (cmd 0x31) — sent once per reconnect, no cycle state.
const SAMPLE_IDENTITY = buf(
    'AA372031020153414133393935353130330000D05F0000800000000000025341413339393534393033000044FC000040000000000008BB',
)

// 0xE2 settings-echo packet — ignored by parser (not EB or EC).
const SAMPLE_E2_SETTINGS = buf('AA2120E20319030102003A010003030100000000400000000101000000640082BB')

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
        for (const c of ['power', 'status', 'remaining_time']) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok(!components.remaining_time_min, 'remaining_time_min not present')
        assert.ok(!components.remaining_time_sec, 'remaining_time_sec not present')
        assert.ok(!components.start_time, 'start_time not present')
        assert.ok(!components.stop_time, 'stop_time not present')
        assert.ok(Array.isArray(components.status.options))
        assert.ok((components.status.options as string[]).includes('Wash (main)'))
    })

    test('0xEB Off frame publishes power=OFF, Off phase, 0 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    test('0xEB Wash (main) frame publishes power=ON, Wash phase, 30 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_WASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Wash (main)')
        assert.equal(props.remaining_time, 30)
    })

    test('0xEC dual-record Off frame publishes power=OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    // ── Real capture tests ────────────────────────────────────────────────────

    test('real idle EC publishes power=OFF, Off phase, 0 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    test('real heavy-duty EC publishes its current record: Rinse / Drain/29 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_HEAVY_DUTY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Rinse / Drain')
        assert.equal(props.remaining_time, 29)
    })

    test('real pause-transition EC publishes Paused/43 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Paused')
        assert.equal(props.remaining_time, 43)
    })

    test('real paused EC publishes Paused/43 min, power ON (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Paused')
        assert.equal(props.remaining_time, 43)
    })

    test('pause → paused → resume reads Paused, Paused, Wash (main) with 43 min frozen (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties
        thinq.emit('data', SAMPLE_EC_RUNNING)
        assert.deepEqual([props().status, props().remaining_time], ['Paused', 43])
        thinq.emit('data', SAMPLE_EC_PAUSED)
        assert.deepEqual([props().status, props().remaining_time], ['Paused', 43])
        thinq.emit('data', SAMPLE_EC_RESUMED)
        assert.deepEqual([props().status, props().remaining_time], ['Wash (main)', 43])
    })

    test('real spin EC publishes Spin, 0 min remaining (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_SPIN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Spin')
        assert.equal(props.remaining_time, 0)
    })

    // ── Auto-ack (real captures, LG WT7300CW, firmware 2.10.95, provisioned locally without bridge) ──
    // Unacked, this washer sent 0x72, then 0xD8 x10 and 0xE2 x10, re-deployed, and never reported a
    // 0xEC status record for the rest of the cycle.

    test('acks the heartbeat and settings frames the washer repeats when unacked (real captures)', () => {
        const { thinq } = makeDevice()
        thinq.emit('data', buf('AA09207200000010BB'))
        thinq.emit('data', buf('AA0720D8219FBB'))
        thinq.emit('data', buf('AA2120E2031903003B003A010003030400000000400000000201000000640046BB'))
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, ['AA08F00072044DBB', 'AA08F000D8042BBB', 'AA08F000E204DDBB'])
        assert.deepEqual(thinq.outbox, [], 'acks do not go out as packets')
    })

    test('does not ack its own 0xEC status records', () => {
        const { thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RUNNING)
        assert.deepEqual(
            thinq.sent.filter((m) => m.cmd === 'ack'),
            [],
        )
    })

    test('start() asks the washer for its state with the read-only 0xF0ED request', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            ['AA0EF0ED1121010000001800B5BB'],
        )
    })

    // ── Record order (real captures, WT7300CW fw 2.10.95, Rinse + Spin start, local rethink) ──
    // Seven consecutive 0xEC frames. Each frame's first record equals the previous frame's second, so
    // the second record is the live state; reading the first leaves HA one change behind.
    const CYCLE_START = [
        'AA3C20EC00190000000000000000000000000000000000000000000000640000190100000000000000000000000000008000000000000000640038BB',
        'AA3C20EC001901000000000000000000000000000080000000000000006400001901011D003A010003030400000000402000000000000000640167BB',
        'AA3C20EC001901011D003A0100030304000000004020000000000000006401001901001C001C07000103040000000040000000000000000064006CBB',
        'AA3C20EC001901001C001C07000103040000000040000000000000000064000019010021002011000003010000000000100000000000000064008EBB',
        'AA3C20EC001901002100201100000301000000000010000000000000006400001903002100201100000301000000000010000000010000006400E8BB',
        'AA3C20EC00190300210020110000030100000000001000000001000000640000190300210020110000030100000000041000000001000000640091BB',
        'AA3C20EC001903002100201100000301000000000410000000010000006400001906001D001C110000030100000000041000000003000000640090BB',
    ].map(buf)

    test('consecutive 0xEC frames chain: each first record repeats the previous second (real captures)', () => {
        for (let i = 1; i < CYCLE_START.length; i++) {
            const prevCurrent = CYCLE_START[i - 1].subarray(2 + 29, 2 + 56)
            const thisPrevious = CYCLE_START[i].subarray(2 + 2, 2 + 29)
            assert.deepEqual(thisPrevious, prevCurrent, `frame ${i}`)
        }
    })

    test('a cycle start publishes each change as it happens, not one frame late (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const seen = CYCLE_START.map((f) => {
            thinq.emit('data', f)
            const p = ha.devices[DEVICE_ID].properties
            return `${p.status}/${p.remaining_time}`
        })
        assert.deepEqual(seen, [
            'Fill / Sense/0',
            'Fill / Sense/29',
            'Fill / Sense/28',
            'Fill / Sense/33',
            'Wash (initial)/33',
            'Wash (initial)/33',
            'Rinse / Drain/29',
        ])
    })

    // ── Ignored packet tests ──────────────────────────────────────────────────

    test('frames with wrong device byte (not 0x20) are ignored', () => {
        const { ha, thinq } = makeDevice()
        // Same as SAMPLE_EB_OFF but with 0x30 (dryer) instead of 0x20
        thinq.emit('data', buf('AA2130EB00000000000000000000000000000000000000000000000000000000BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('0xE2 settings-echo packet is ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_E2_SETTINGS)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('short idle/ack packet (0xD8) is ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SHORT_ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('identity/info packet (cmd 0x31) is ignored without error', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_IDENTITY)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('frames that are too short are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA0420EB00BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('undecoded status value publishes the "None" fallback', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA2120EB0000FF00000000000000000000000000000000000000000000000000BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'None')
    })
})
