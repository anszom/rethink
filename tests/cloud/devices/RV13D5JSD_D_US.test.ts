import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13D5JSD_D_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, captureLog } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13D5JSD_D_US'
const META: Metadata = { modelId: MODEL_ID, modelName: 'RV13D5JSD_D_US', swVersion: '0.0.0' }

// This dryer's real traffic over a ~2-day capture (device 89711260-...) was only 0x31 (serial),
// 0x72 (heartbeat) and 0xE2 (end-of-cycle summary) — never the 0xEC/0xEB status records the handler
// was originally written for. All frames below are REAL, taken verbatim from that capture.

// 0x72 heartbeat: buf[3] flips between 0xC9 (running) and 0xC8 (paused/stopped), with a single
// transient 0x00 observed immediately before a 0xC8 at cycle end.
const HB_RUNNING = buf('AA09307200C9004BBB')
const HB_STOPPED = buf('AA09307200C80048BB')
const HB_TRANSIENT_ZERO = buf('AA09307200000000BB')

// 0xE2 end-of-cycle summary — not decoded (buf[6]/buf[8]/buf[9] are ambiguous candidates for
// temp/dry_level; see the header comment in the source file).
const E2_END_OF_CYCLE = buf('AA2330E2031B320103010303000304000000000000AB0001870100000072000000B2BB')

// A real 0xEB single-record frame for the sibling RV13U6AM8W_D_US_WIFI model (identical processRecord
// offsets) — this dryer never actually sends these, but the dispatcher must still route them.
const EB_STARTING = buf('AA2330EB000001003C00000000000000000000000000000000000000000000000000BB')

// Same as HB_RUNNING but with the class byte changed from 0x30 (dryer) to 0x20 (washer) — must be
// ignored.
const HB_WRONG_CLASS = buf('AA09207200C9004BBB')

// Real 0x31 serial/identity frame, sent once per reconnect — currently undecoded.
const SERIAL = buf(
    'AA373031020153414133383936343432300000A814000080000000000002534141333839363433313400001FF200008000000000005DBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes power alongside the existing status/cycle/temp entities', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of ['power', 'status', 'remaining_time', 'drum_running', 'cycle', 'temp', 'dry_level']) {
            assert.ok(components[c], `component ${c} present`)
        }
    })

    test('0x72 heartbeat publishes power ON for 0xC9 and OFF for 0xC8 (real captures)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HB_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')

        thinq.emit('data', HB_STOPPED)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('0x72 transient 0x00 value is treated as not-running (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HB_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')

        thinq.emit('data', HB_TRANSIENT_ZERO)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('0xE2 end-of-cycle summary is not decoded — no properties published (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', E2_END_OF_CYCLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, undefined)
        assert.equal(props.temp, undefined)
        assert.equal(props.dry_level, undefined)
        assert.equal(props.power, undefined)
    })

    test('the pre-existing 0xEB/0xEC dispatch still works after adding 0x72 (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Starting')
        assert.equal(props.remaining_time, 60)
        assert.equal(props.power, 'ON')
    })

    // ── Ignored packet tests ──────────────────────────────────────────────────

    test('frames with wrong device class byte (not 0x30) are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HB_WRONG_CLASS)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    // ── Logging (for future status-code hunting) ────────────────────────────────

    test('undecoded frame types (0x31 serial, 0xE2 end-of-cycle) are logged (real captures)', () => {
        const { thinq } = makeDevice()
        const cap = captureLog()
        try {
            thinq.emit('data', SERIAL)
            thinq.emit('data', E2_END_OF_CYCLE)
            assert.equal(cap.calls.length, 2)
            for (const call of cap.calls) {
                const [, topic, message] = call.arguments
                assert.equal(topic, 'RV13D5JSD_D_US')
                assert.equal(message, 'unrecognized frame')
            }
            assert.equal(cap.calls[0].arguments[3], SERIAL.subarray(2, -2).toString('hex'))
            assert.equal(cap.calls[1].arguments[3], E2_END_OF_CYCLE.subarray(2, -2).toString('hex'))
        } finally {
            cap.restore()
        }
    })
})
