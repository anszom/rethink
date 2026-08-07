import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RAC_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real packet captures from a RAC_056905_WW air conditioner.

// Capability request
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

// Capability response (response to query 0x1F5/1). Contains TLV t=0x2DA (eeprom checksum),
// which triggers `isCapsResponse`
const CAPS_RESPONSE_HEX =
    '0000040000008702010249' +
    'B001B05057B0A0017CB0C1B103B306B34FB4C7B582B541B543B6A04D81B6F0690409B701BC40BD47' +
    'B5C0B61024B643B5C1B600B643B5C2B600B643B5C4B61026B643B5C6B6102CB643' +
    '44E1'

// Comprehensive state response (response to query 0x1F5/2).
// Contains TLV t=0x1f7 (power), which triggers `isValuesResponse`
//      t=0x1f9 l=0 v=0x4 (4)   mode=heat
//      t=0x1f7 l=0 v=0x1 (1)   power=ON
//      t=0x1fa l=0 v=0x3 (3)   fan=low
//      t=0x1fd l=1 v=0x29 (41) current_temp=20.5
//      t=0x1fe l=1 v=0x26 (38) set_temp=19
//      ...
const QUERY_RESPONSE_HEX =
    '00000400000087020415' +
    '777E447DC17E837F50297F9026C840C880C8C08340838083C0868086C0870087C0894088408A1011' +
    '8A505A8A8F8CA0C0BA8CD010ACE00164D540D580C900CAD0A0CB1040CB40CB8CCBCFCC1032CC504F' +
    'CC90438B40BF600155BFE00271BFA00155C0200271BE509FBE90A01B01BED050C300C340C0C0C380' +
    '3E6B'

// Bytes that the cloud sends for HA setProperty calls (includes 0x1f7 power-on with mode writes).
const WRITE_MODE_FAN_ONLY_HEX = '01010400000065020101087E427DC17E837F80E609'
const WRITE_MODE_HEAT_HEX = '01010400000065020101097E447DC17E837F902AFD3D'
const WRITE_MODE_COOL_FROM_OFF_HEX = '01010400000065020101097E407DC17E887F902C8C89'
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'

// Caps with eeprom tag only (no 0x2CC/0x2CD/0x2D3 feature bits) — models that unlock via state tags.
const MINIMAL_CAPS_HEX = '0000040000008702010002b6819989'

// Live CST_570004_WW values reply (kind 0xa7). Unlocks humidity/autodry/airclean/etc. from tags alone.
// Includes 0x336=850 (85.0% RH), 0x20e/0x20f/0x20d=0, 0x21a=0, 0x321=0, power on cool.
const CST_VALUES_HEX =
    '000004000000a70204004b7dc17e407e887f502d7f902a7f0086808840d4c0d500c84081408180c940' +
    '8340838083c08fc0cd40cd00ccc0cda00352d56007f3d5a00960bc9089d5d03cd61020c9009c4087cb' +
    'ac40e9c1ad27'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Bring the device through the full caps->values->initMakeSetConfig flow using mock timers.
 *  Returns the device with config installed and thinq recorder cleared. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet, discard it.
    thinq.resetRecorder()

    // Respond & give other timeouts a chance to fire.
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 6000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('caps and values responses triggers config publish', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder() // discard the queryCaps from the constructor

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 6000)
        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        // Config exposes the climate component with all five base fields registered.
        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.climate, 'climate component')
        assert.equal(components.climate.platform, 'climate')

        // Capability bits from the captured caps response unlocked these optional components.
        assert.ok(components.jet, 'jet (because 0x2CD bits 0x1|0x2)')
        assert.ok(components.energysave, 'energysave (because 0x2CC bit 0x2)')
        assert.ok(components.autodry, 'autodry (because 0x2CC bit 0x4)')
        assert.ok(components.sleeptimer, 'sleeptimer (because 0x2D3 bit 0x1)')
        assert.ok(components.starttimer, 'starttimer (because 0x2D3 bit 0x4)')
        assert.ok(components.stoptimer, 'stoptimer (because 0x2D3 bit 0x4)')
        // airclean: 0x2CC bit 0x1 is unset on this caps capture, but values include tag 0x20f=0,
        // so tag-based unlock still registers the entity.
        assert.ok(components.airclean, 'airclean from values tag 0x20f')

        // Swing modes registered because 0x2CD has both 0x4 and 0x8.
        assert.deepEqual(components.climate.swing_modes, ['1', '2', '3', '4', '5', '6', 'on', 'off'])
        assert.deepEqual(components.climate.swing_horizontal_modes, [
            '1',
            '2',
            '3',
            '4',
            '5',
            '1-3',
            '3-5',
            'on',
            'off',
        ])

        dev.drop()
    })

    test('initial state response publishes all expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 20.5) // 0x29 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 19) // 0x26 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low') // 0x1FA=3
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'heat') // 0x1F9=4 with power=ON
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'off') // 0x321=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'off') // 0x322=0
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'OFF') // 0x20E=0
        assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 0) // 0x21A=0
        assert.equal(ha.getProperty(DEVICE_ID, 'starttimer', 'state'), 0) // 0x21C=0
        assert.equal(ha.getProperty(DEVICE_ID, 'stoptimer', 'state'), 0) // 0x21B=0
        assert.equal(ha.getProperty(DEVICE_ID, 'jet', 'state'), 'OFF')

        // energysave is mode-dependent (cool only). With mode=heat its read_callback returns false,
        // so it must NOT have been published.
        assert.ok(!ha.getProperty(DEVICE_ID, 'energysave', 'state'), 'energysave suppressed in heat mode')

        dev.drop()
    })

    test('HA write climate-mode=fan_only emits expected bytes', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Pre-state observed in the capture at the moment of this write.
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 0

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_FAN_ONLY_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=heat emits expected bytes', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Pre-state observed in the capture at the moment of this write.
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 42 // 21C

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'heat')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_HEAT_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=off triggers power=OFF instead of mode write', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 1
        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fa] = 3
        dev.raw_clip_state[0x1fe] = 42

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX.toUpperCase())

        dev.drop()
    })

    test('HA write climate-mode=cool from OFF includes power=ON', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        // Off-state matching a CST_570004_WW capture: power=0, last mode=cool, fan=auto, set=22C
        dev.raw_clip_state[0x1f7] = 0
        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fa] = 8
        dev.raw_clip_state[0x1fe] = 44

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_COOL_FROM_OFF_HEX.toUpperCase())
        assert.equal(dev.raw_clip_state[0x1f7], 1)

        dev.drop()
    })

    // CST capture: autodry toggles as unsolicited 0x20e 1↔0; write is a single-tag TLV.
    const WRITE_AUTODRY_ON_HEX = '010104000000650201010283816D5D'
    const WRITE_AUTODRY_OFF_HEX = '010104000000650201010283807D7C'

    test('HA write autodry ON/OFF emits 0x20e TLV', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x20e] = 0

        ha.setProperty(DEVICE_ID, 'autodry', 'command', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_AUTODRY_ON_HEX.toUpperCase())
        assert.equal(dev.raw_clip_state[0x20e], 1)

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'autodry', 'command', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_AUTODRY_OFF_HEX.toUpperCase())
        assert.equal(dev.raw_clip_state[0x20e], 0)

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), CAPS_REQUEST_HEX.toUpperCase())
        dev.drop()
    })

    test('CST values without feature-cap bits unlock humidity and diagnostics from state tags', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(MINIMAL_CAPS_HEX))
        thinq.emit('data', buf(CST_VALUES_HEX))
        // filter probe times out (no priv reply on this path)
        tickMockTimers(t, 6000)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const components = device.config!.components as Record<string, Record<string, unknown>>

        assert.ok(components.humidity, 'humidity sensor from tag 0x336')
        assert.equal(components.humidity.device_class, 'humidity')
        assert.equal(components.climate.current_humidity_topic, '$this/humidity-')
        assert.ok(components.autodry, 'autodry from tag 0x20e')
        assert.ok(components.airclean, 'air purify from tag 0x20f')
        assert.ok(components.energysave, 'energy save from tag 0x20d')
        assert.ok(components.sleeptimer, 'sleep timer from tag 0x21a')
        assert.ok(components.climate.swing_modes, 'vertical swing from tag 0x321')
        // Horizontal swing tag absent on this capture
        assert.ok(!components.climate.swing_horizontal_modes)

        // Re-feed values so registered fields publish (initial pass was before config)
        thinq.emit('data', buf(CST_VALUES_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 85)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 22.5)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'airclean', 'state'), 'OFF')
        // Energy save only publishes while in cool (mode=0) and powered on
        assert.equal(ha.getProperty(DEVICE_ID, 'energysave', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'off')

        dev.drop()
    })
})
