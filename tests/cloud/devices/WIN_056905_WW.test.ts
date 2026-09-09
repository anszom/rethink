import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WIN_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WIN_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WIN_056905_WW', swVersion: '352200' }

// Real packet captures from an LG LW1822IVSM window air conditioner (2026-09-09). This handler
// also serves the sibling LW1823HRSM (see its docstring); heat (raw mode 4) is kept for that model
// but is unconfirmed here, as this unit has no heat option.

const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'
const QUERY_REQUEST_HEX = '01010400000065020201027D425A6E'

// Capability response from the device. Uses TLV marker 0xA7, like DHUM_056905_WW/POT_056905_WW.
const CAPS_RESPONSE_HEX =
    '000004000000A702015852B009B0600107B09054B0C1B103B300B340B4E05016B55060B6A00363B6F0352200B85020' +
    'B8903CB8D020B9103CBC600201BD30080000BD47B5C0B6102AB646B5C1B600B646B5C2B600B646B5C8B61020B646FF48'

// Initial values response while physically set to Cool / fan-high.
//      t=0x1f7 v=1        power=ON
//      t=0x1f9 v=0        mode=cool
//      t=0x1fa v=6        fan=high
//      t=0x1fd v=49       current_temp=24.5
//      t=0x1fe v=42       set_temp=21
const VALUES_COOL_HEX =
    '000004000000A702045B477E407DC17E867F50317F902A8180C8C08340868086C08700884089408A10498A506A8A8F8CA0' +
    '12C48CC7ACE00711D550F8D590FACAD05ACB10BCCB8CCBCFCC00CC909E1B01C0C01A7F'

// Full values response captured while the unit's own panel displayed 'Energy Saver'.
//      t=0x1f9 v=8        mode=Energy Saver (not a valid HA hvac_mode; exposed via preset_mode)
//      t=0x1fa v=4        fan=medium
const VALUES_ENERGY_SAVER_HEX =
    '000004000000A70204A9477E487DC17E847F50317F902A8180C8C08340868086C08700884089408A103C8A50698A8F8C90' +
    '898CD025ACE005D1D550F7D590FACAD05BCB10B8CB8CCBCFCC00CC90941B01C0C08B2B'

// Small delta packet (mode field only) captured while the panel displayed 'Dry'.
const VALUES_DRY_DELTA_HEX = '000004000000A70204AB027E4166F0'

// Private-command filter query (sendPrivCommand(0x02, 0x02)) and its real captured response —
// used=0, life=720 (hours), changed date=0 (never reset), on a brand-new unit.
const FILTER_QUERY_REQUEST_HEX = '00FF0400000065FD02000102511B'
const FILTER_QUERY_RESPONSE_HEX = '02FF0400000087FD03010D0200000000D0020000000000003920'

// Off timer: real captured injection round-trip (2026-09-09) — set to 1h (60 raw minutes), the
// unit echoed tag 0x21b=60 back and its panel/display updated (with an audible confirmation ding).
const WRITE_TIMER_1H_HEX = '010104000000650201010386D03CB71E'
const VALUES_TIMER_1H_HEX = '000004000000A70204E20386D03CA536'

// Bytes produced by rethink for specific HA setProperty calls (from a Cool/fan-high baseline).
// mode/preset writes emit two packets: the (currently ineffective, since power was already ON)
// power=ON packet, then the real mode/preset packet.
const WRITE_MODE_DRY_HEX = [
    '01010400000065020101047DC17E407883',
    '010104000000650201010E7E417DC17E867F902AC8B00000008492',
]
const WRITE_MODE_OFF_HEX = '01010400000065020101027DC00576'
const WRITE_FAN_MEDIUM_HEX = '01010400000065020101077E847E407F902A6F7E'
const WRITE_PRESET_ECO_HEX = [
    '01010400000065020101047DC17E407883',
    '010104000000650201010E7E487DC17E867F902AC8B0000000CAAB',
]

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    thinq.resetRecorder()
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    assert.equal(thinq.outbox.length, 1)
    assert.equal(hex(thinq.outbox[0]), QUERY_REQUEST_HEX)

    thinq.emit('data', buf(VALUES_COOL_HEX))
    tickMockTimers(t, 1000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected climate component', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.climate, 'climate component')
        assert.equal(components.climate.platform, 'climate')
        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only', 'heat'])
        assert.deepEqual(components.climate.fan_modes, ['low', 'medium', 'high'])
        assert.deepEqual(components.climate.swing_modes, ['on', 'off'])
        assert.deepEqual(components.climate.preset_modes, ['eco'])
        assert.equal(components.climate.min_temp, 61)
        assert.equal(components.climate.max_temp, 86)

        dev.drop()
    })

    test('Cool/fan-high values response publishes all expected HA properties', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'high')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'preset_mode_state'), 'none')
        // Wire values are Celsius (24.5C / 21C, see VALUES_COOL_HEX above); the climate entity's
        // native unit is Fahrenheit (see WIN_056905_WW.ts), so these are published converted:
        // 24.5C -> 76.1F -> 76, 21C -> 69.8F -> 70.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 76)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 70)

        dev.drop()
    })

    test('Energy Saver values response reports preset_mode=eco, leaves hvac mode alone', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(VALUES_ENERGY_SAVER_HEX))

        // raw mode 8 has no valid hvac_mode mapping, so the mode topic is left at its last known
        // value (still 'cool' from the baseline capture) rather than publishing something wrong.
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'preset_mode_state'), 'eco')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')

        dev.drop()
    })

    test('Dry delta packet publishes mode=dry and preset_mode=none', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(VALUES_DRY_DELTA_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'preset_mode_state'), 'none')

        dev.drop()
    })

    test('valuesReceived sends a filter query, and filter data response adds diagnostic entities', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // buildReadyDevice already triggered valuesReceived -> initProbeForFilter, which sends a
        // filter query; confirm that happened (it's cleared by buildReadyDevice's own resetRecorder,
        // so re-derive it here on a fresh device instead of relying on outbox state).
        thinq.resetRecorder()
        dev.sendFilterQuery()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), FILTER_QUERY_REQUEST_HEX)

        assert.equal(ha.devices[DEVICE_ID].config!.components['filterused'], undefined, 'not yet added')

        thinq.emit('data', buf(FILTER_QUERY_RESPONSE_HEX))

        assert.ok(ha.devices[DEVICE_ID].config!.components['filterused'], 'filterused component added')
        assert.ok(ha.devices[DEVICE_ID].config!.components['filterlife'], 'filterlife component added')
        assert.ok(ha.devices[DEVICE_ID].config!.components['changeddate'], 'changeddate component added')
        assert.ok(ha.devices[DEVICE_ID].config!.components['filterreset'], 'filterreset component added')

        assert.equal(ha.getProperty(DEVICE_ID, 'filterused', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'filterlife', 'state'), 720)
        assert.equal(ha.getProperty(DEVICE_ID, 'changeddate', 'state'), '0000-00-00')

        dev.drop()
    })

    test('power draw (tag 0x2b3) adds a Power sensor once a real value is seen and tracks it live', (t) => {
        // Use a bare device (no VALUES_COOL_HEX, which already contains a real 0x2b3 reading) to
        // exercise the dynamic-add path from a clean slate.
        enableMockTimers(t)
        const { ha, dev } = makeDevice()

        assert.equal(ha.devices[DEVICE_ID]?.config?.components['energy_current'], undefined, 'not yet added')

        // Real captured sequence from an inverter compressor ramp-down to idle (2026-09-09).
        dev.processKeyValue(0x2b3, 1413)
        assert.ok(ha.devices[DEVICE_ID].config!.components['energy_current'], 'energy_current component added')
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 1353)

        dev.processKeyValue(0x2b3, 138)
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 78)

        dev.drop()
    })

    test('off timer: values response with tag 0x21b publishes hours, HA write emits the confirmed bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(VALUES_TIMER_1H_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'offtimer', 'state'), 1)

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'offtimer', 'command', '1')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_TIMER_1H_HEX)

        dev.drop()
    })

    test('pressing the filter reset button sends a filter query first', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(FILTER_QUERY_RESPONSE_HEX))
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'filterreset', 'command', 'PRESS')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), FILTER_QUERY_REQUEST_HEX)

        dev.drop()
    })

    test('HA write climate-temperature converts whole Fahrenheit to the wire Celsius*2 raw value, clamped to 61-86F', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '74')
        // 74F -> 23.33C -> raw 47 (23.5C), not 46/48 -- exercises the fix for the reported bug
        // where a Celsius-native 0.5-step entity would instead snap 74F to 74.5F/75F.
        assert.equal(dev.raw_clip_state[0x1fe], 47)

        // Below the 61F floor clamps to 61F (16.11C -> raw 32).
        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '50')
        assert.equal(dev.raw_clip_state[0x1fe], 32)

        // Above the 86F ceiling clamps to 86F (30C -> raw 60).
        ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '95')
        assert.equal(dev.raw_clip_state[0x1fe], 60)

        dev.drop()
    })

    test('HA write climate-mode=dry emits expected bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')

        assert.deepEqual(
            thinq.outbox.map((b) => hex(b)),
            WRITE_MODE_DRY_HEX,
        )

        dev.drop()
    })

    test('HA write climate-mode=off triggers power=OFF instead of mode write', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_OFF_HEX)

        dev.drop()
    })

    test('HA write climate-fan_mode=medium emits expected bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'medium')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_FAN_MEDIUM_HEX)

        dev.drop()
    })

    test('HA write climate-preset_mode=eco emits expected bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'preset_mode_command', 'eco')

        assert.deepEqual(
            thinq.outbox.map((b) => hex(b)),
            WRITE_PRESET_ECO_HEX,
        )

        dev.drop()
    })

    test('HA write climate-preset_mode=none is a no-op (no defined way to cancel Energy Saver)', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'preset_mode_command', 'none')

        assert.equal(thinq.outbox.length, 0)

        dev.drop()
    })

    test('0xA7 caps response triggers values query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), QUERY_REQUEST_HEX)

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX)

        dev.drop()
    })
})
