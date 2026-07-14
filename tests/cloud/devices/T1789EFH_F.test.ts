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
// For 0xEC: inner is 56 bytes; current record = inner[2..28], previous = inner[29..55]
//   phase = rec[2] = inner[4], remaining_time (min) = rec[4] = inner[6]

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

// Heavy Duty mid-cycle — EC, current record phase=0x05 (Wash main), mins=24.
// Matches the 0xE2 packet's corroborated "~24 min remaining" reading.
const SAMPLE_EC_HEAVY_DUTY = buf(
    'AA3C20EC0019050018011A0200050304000000000410000000050000006400001906001D011E0200000304000000000410000000050000006400FABB',
)

// Running (Bedding cycle) — EC, phase=0x05 (Wash main), mins=43.
const SAMPLE_EC_RUNNING = buf(
    'AA3C20EC001905002B00340800030104000000000410000000030000006400001902002B0034080003010400000000041000000005000000640054BB',
)

// Paused (deliberate lid-open pause) — EC, phase=0x02 (Paused), mins=43 (frozen).
// Note: washer pause=0x02, NOT 0x03 (dryer).
const SAMPLE_EC_PAUSED = buf(
    'AA3C20EC001902002B00340800030104000000000410000000050000006400001902002B00340800030104000000000010000000050000006400A9BB',
)

// Resumed (immediately after unpausing) — EC, phase=0x02 still in current slot,
// mins=43 still frozen; previous slot has flipped to 0x05 (Wash main).
const SAMPLE_EC_RESUMED = buf(
    'AA3C20EC001902002B00340800030104000000000010000000050000006400001905002B00340800030104000000000010000000020000006400ADBB',
)

// Spin transition — EC, current phase=0x07 (Rinse / Drain entry into spin), mins=1.
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
        for (const c of ['power', 'phase', 'remaining_time']) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok(!components.remaining_time_min, 'remaining_time_min not present')
        assert.ok(!components.remaining_time_sec, 'remaining_time_sec not present')
        assert.ok(!components.start_time, 'start_time not present')
        assert.ok(!components.stop_time, 'stop_time not present')
        assert.ok(Array.isArray(components.phase.options))
        assert.ok((components.phase.options as string[]).includes('Wash (main)'))
    })

    test('0xEB Off frame publishes power=OFF, Off phase, 0 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.phase, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    test('0xEB Wash (main) frame publishes power=ON, Wash phase, 30 min remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_WASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Wash (main)')
        assert.equal(props.remaining_time, 30)
    })

    test('0xEC dual-record Off frame publishes power=OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.phase, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    // ── Real capture tests ────────────────────────────────────────────────────

    test('real idle EC publishes power=OFF, Off phase, 0 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.phase, 'Off')
        assert.equal(props.remaining_time, 0)
    })

    test('real heavy-duty EC publishes Wash (main)/24 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_HEAVY_DUTY)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Wash (main)')
        assert.equal(props.remaining_time, 24)
    })

    test('real running EC publishes Wash (main)/43 min (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Wash (main)')
        assert.equal(props.remaining_time, 43)
    })

    test('real paused EC publishes Paused/43 min, power ON (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Paused')
        assert.equal(props.remaining_time, 43)
    })

    test('remaining_time stays frozen at 43 min across running→paused→resumed (real captures)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 43)
        thinq.emit('data', SAMPLE_EC_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 43)
        thinq.emit('data', SAMPLE_EC_RESUMED)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 43)
    })

    test('real spin EC publishes Rinse / Drain phase, 1 min remaining (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_SPIN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.phase, 'Rinse / Drain')
        assert.equal(props.remaining_time, 1)
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

    test('unknown phase value publishes hex fallback string', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA2120EB0000FF00000000000000000000000000000000000000000000000000BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Unknown (0xff)')
    })
})
