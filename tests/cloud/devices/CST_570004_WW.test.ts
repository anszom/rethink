import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/CST_570004_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'CST_570004_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'CST_570004_WW', swVersion: '1.0' }

// Real packet captures from a CST_570004_WW ceiling-cassette IDU (multi-split).
// NB: CST emits its async/query TLV frames with UART header byte6 = 0xA7 (not 0x87);
// the base framing check only accepts 0x87, so the handler normalizes it. These captures
// keep the 0xA7 byte so the test exercises that normalization end to end.

// Capability response (query 0x1F5/1). Contains t=0x2DA (eeprom checksum) -> isCapsResponse.
// Notably 0x2CD = 2089015 (jet bits 0/1 AND positional-swing bits 4/8 all set) and
// 0x2F1 = 1 ("no filter") — both of which CST must override.
const CAPS_RESPONSE_HEX =
    '000004000000A702010077B00AB04FB0A001D5B0C1B103B4F0401011B710FEBB81BBC0BC41BC88BCC1B37' +
    '01FE037B381B54EB2E01006B7600120B85020B8903CB8D020B9103CBD600203B5C0B646B61030B5C1B646' +
    'B61030B5C2B646B61030B5C3B646B603B69037B6F0570004D41010BD30800400DD1020B5B010000064903' +
    'EFA05EFE0'

// Comprehensive state response (query 0x1F5/2). Contains t=0x1F7 (power) -> isValuesResponse.
// Captured while the IDU was powered OFF. Ground-truth tags used below:
//      0x1F7=0   power OFF
//      0x1F9=0   mode cool (reported as 'off' because power is 0)
//      0x1FA=6   fan = high (CST scale)
//      0x1FD=52  current temp = 26.0 (raw/2)
//      0x1FE=48  target temp  = 24.0 (raw/2)
//      0x20D=0   energy saving off
//      0x20E=3   auto-dry setting = 60 min
//      0x21F=200 display = 100%
//      0x225=30  auto-dry remaining = 30 min
//      0x23F=0   comfort saving off
//      0x290..0x3D7 = 0  wind mode = off
//      0x2B3=0   power = 0 W (compressor idle)
//      0x336=811 humidity = 81 %RH (raw/10)
const QUERY_RESPONSE_HEX =
    '000004000000A7020400837DC07E407E867F50347F90307F0086808840D4C0D500C84181408180C940A38' +
    '0A3C0A400A440F540F580F5C08340838389501E83C08FC0CD40CD00CCC0CDA0032BADA01CC6ACC0AD41B54' +
    'ED56002FBD5A00960BC88D5D03CD61020C9009C40A88087D0C8AC40E9C16640668066C067006740678067C' +
    '068008F80F7407C8189501E9380D558'

// Filter priv-command reply (sub-command 0x02). Uses the normal 0x87 header. Decodes to
// used=0, life=720, changed-date=0. Emitting it lets the filter probe complete immediately
// instead of timing out.
const FILTER_REPLY_HEX = '02ff0400000087fd03010d0200000000d0020000000000003920'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Bring the device through caps -> values -> filter-probe -> initMakeSetConfig using mock
 *  timers, so the config is installed. Returns with the thinq recorder cleared. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet; discard it.
    thinq.resetRecorder()

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))

    // valuesReceived arms a 500 ms masking delay, after which the filter probe is sent.
    tickMockTimers(t, 600)
    // Answer the probe so config is built now (rather than after the 5-retry fallback).
    thinq.emit('data', buf(FILTER_REPLY_HEX))
    tickMockTimers(t, 100)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('0xA7 caps response is normalized and triggers the values query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        // A plain RAC handler would drop the 0xA7 frame and never ask for values.
        assert.equal(thinq.outbox.length, 1, 'values query sent in response to caps')
        dev.drop()
    })

    test('config drops jet/heat and exposes the CST-specific components', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const c = device.config!.components as Record<string, Record<string, unknown>>

        assert.ok(c.climate, 'climate component')
        assert.equal(c.climate.platform, 'climate')

        // The captured caps had 0x2CD with the jet bits set, yet CST is cooling-only and must
        // suppress jet — and the old binary auto-dry sensor is replaced by a select.
        assert.ok(!c.jet, 'no jet switch (suppressed despite 0x2CD jet bits)')
        assert.ok(!c.autodry, 'no binary auto-dry sensor')

        // HVAC mode list excludes heat.
        assert.deepEqual(c.climate.modes, ['off', 'cool', 'dry', 'fan_only', 'auto'])

        // Temp range read from caps 0x2E1/0x2E2 (32/60 -> 16/30), not RAC's hardcoded 18.
        assert.equal(c.climate.min_temp, 16)
        assert.equal(c.climate.max_temp, 30)

        // Energy saving comes from the 0x2CB feature bitmap (CST's relocated 0x2CC); the binary
        // auto-dry sensor (0x2CB bit2) is masked because auto-dry is exposed as a select instead.
        assert.ok(c.energysave, 'energysave present (from 0x2CB bit1)')

        // CST fan scale and on/off swing.
        assert.deepEqual(c.climate.fan_modes, ['auto', 'very low', 'low', 'medium', 'high', 'power'])
        assert.deepEqual(c.climate.swing_modes, ['on', 'off'])
        assert.deepEqual(c.climate.swing_horizontal_modes, ['on', 'off'])

        // Extra components CST adds.
        assert.equal(c.autodry_setting?.platform, 'select')
        assert.deepEqual(c.autodry_setting.options, ['off', '10 min', '30 min', '60 min', 'smart'])
        assert.equal(c.autodryremain?.unit_of_measurement, 'min', 'auto-dry remaining is minutes, not %')
        assert.equal(c.display?.platform, 'select')
        assert.equal(c.comfort_saving?.platform, 'switch')
        assert.equal(c.wind_mode?.platform, 'select')
        assert.equal(c.humidity?.device_class, 'humidity')
        assert.equal(c.energy_current?.device_class, 'power', 'power sensor always present, even idle')

        // Energy saving rendered as a plain toggle (no assumed_state buttons).
        assert.ok(c.energysave, 'energysave present')
        assert.ok(!('optimistic' in c.energysave), 'energysave optimistic flag removed')

        // Filter probe answered -> filter entities present.
        assert.ok(c.filterused && c.filterlife, 'filter entities present')

        dev.drop()
    })

    test('initial values publish the expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Re-emit the values frame now that the fields are registered.
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 100)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off') // power 0x1F7=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'high') // 0x1FA=6
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 26) // 0x1FD=52 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24) // 0x1FE=48 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 81) // 0x336=811 /10
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 0) // 0x2B3=0
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry_setting', 'state'), '60 min') // 0x20E=3
        assert.equal(ha.getProperty(DEVICE_ID, 'autodryremain', 'state'), 30) // 0x225=30
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), '100%') // 0x21F=200
        assert.equal(ha.getProperty(DEVICE_ID, 'comfort_saving', 'state'), 'OFF') // 0x23F=0
        assert.equal(ha.getProperty(DEVICE_ID, 'wind_mode', 'state'), 'off') // all wind flags 0

        dev.drop()
    })

    test('HVAC auto mode uses CST wire value 3, not RAC 6', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // READ: device reports mode wire 3 while powered on -> 'auto'. RAC's table decodes wire 3
        // as undefined, so without the CST mode table this would publish no valid mode.
        dev.raw_clip_state[0x1f7] = 1
        dev.processKeyValue(0x1f9, 3)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')

        // WRITE: selecting 'auto' in HA emits wire value 3 (RAC would send the unsupported 6).
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')
        assert.equal(thinq.outbox.length, 1)
        const frame = thinq.outbox[0]
        const mode = TLV.parse(frame.subarray(11, frame.length - 2)).find(({ t }) => t === 0x1f9)
        assert.equal(mode?.v, 3, 'auto writes 0x1f9=3')

        dev.drop()
    })

    test('writing wind_mode emits an exclusive one-hot TLV', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'wind_mode', 'command', 'manner')

        assert.equal(thinq.outbox.length, 1, 'one packet sent')
        const frame = thinq.outbox[0]
        const tlvs = TLV.parse(frame.subarray(11, frame.length - 2))
        const map = new Map(tlvs.map(({ t, v }) => [t, v]))

        // manner -> 0x3D6=1, every other wind flag explicitly 0.
        assert.equal(map.get(0x3d6), 1, 'manner flag set')
        assert.equal(map.get(0x290), 0)
        assert.equal(map.get(0x291), 0)
        assert.equal(map.get(0x3d5), 0)
        assert.equal(map.get(0x3d7), 0)

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1, 'queryCaps sent from constructor')
        dev.drop()
    })
})
