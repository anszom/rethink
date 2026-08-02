import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DHUM_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DHUM_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST DHUM', swVersion: '9439' }

const CAPS_RESPONSE_HEX = '000004000000A70201000AB6A00A7CB541B5A004023220'

const QUERY_RESPONSE_HEX = '00000400000087020400117DC17E50117E827F503094D023D801A8803F5E'

/* The same values response with 0x2a2 and 0x360 taken out — a unit on this
 * platform that has neither UVnano nor the ionizer, as the DHUM_056905_WW in
 * this house turned out to be. */
const QUERY_RESPONSE_NO_EXTRAS_HEX = '000004000000870204000D7DC17E50117E827F503094D0236D1B'

/*
 * Both captured off a running DHUM_056905_WW on 2026-07-28, minutes apart, while
 * the LG cloud reported airState.humidity.current = 55 and
 * airState.tempState.current = -18 for the same appliance.
 */
const HUMIDITY_55_NOTIFY_HEX = '000004000000A702045303CD903770A2' // 0x336=55
const TEMPERATURE_238_NOTIFY_HEX = '000004000000A702044D037F50EE67CF' // 0x1fd=238, int8 -18

// Live notify when ionizer turned off on device panel
const IONIZER_OFF_NOTIFY_HEX = '000004000000A702043F02D80085A3'

const UV_ON_NOTIFY_HEX = '000004000000A702044B02A88184D7'
const UV_OFF_NOTIFY_HEX = '000004000000A702044A08A8808C90388CD041E991'

const BUCKET_LIGHT_ON_NOTIFY_HEX = '000004000000A702048C0287817086'
const BUCKET_LIGHT_OFF_NOTIFY_HEX = '000004000000A702048A028780473E'

// Sleep timer (0x21b) countdown notifies: remaining seconds in tlv
const SLEEP_TIMER_59S_NOTIFY_HEX = '000004000000A70204ED0386D03BB028' // ~1 h displayed
const SLEEP_TIMER_299S_NOTIFY_HEX = '000004000000A70204F30486E0012BC8DA' // ~5 h displayed
const SLEEP_TIMER_OFF_NOTIFY_HEX = '000004000000A70204EE0286C0AFE8'

// Bucket emptied and reinstalled (panel / LG app "water" clear); 0x2b1=256, 0x2b2=0
const BUCKET_EMPTIED_NOTIFY_HEX = '000004000000A702046706AC600100AC807407'

const BUCKET_FULL_NOTIFY_HEX = '000004000000A70204EE02AC811E20' // 0x2b2=1

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
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 6000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('caps and values responses triggers humidifier config publish', (t) => {
        enableMockTimers(t)
        const { ha, thinq } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        tickMockTimers(t, 6000)
        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.humidifier, 'humidifier component')
        assert.equal(components.humidifier.device_class, 'dehumidifier')
        assert.deepEqual(components.humidifier.modes, ['Smart', 'Jet', 'Silent', 'Intensive', 'Laundry'])
        assert.ok(components.fan_speed, 'fan_speed select')
        assert.deepEqual(components.fan_speed.options, ['Low', 'High'])
        assert.ok(components.off_timer, 'sleep timer number')
        assert.equal(components.off_timer.name, 'Sleep timer')
        assert.equal(components.off_timer.platform, 'number')
        assert.equal(components.off_timer.device_class, 'duration')
        assert.equal(components.off_timer.unit_of_measurement, 'h')
        assert.equal(components.off_timer.mode, 'slider')
        assert.equal(components.off_timer.min, 0)
        assert.equal(components.off_timer.max, 9)
        assert.equal(components.off_timer.step, 1)
        assert.ok(components.ionizer.platform, 'ionizer switch — this values packet reports 0x360')
        assert.ok(components.uv_nano.platform, 'uv_nano switch — this values packet reports 0x2a2')
        assert.ok(components.bucket_light, 'bucket_light switch')
        assert.equal(components.bucket_full.device_class, 'problem')
        assert.equal(components.bucket_full.state_topic, '$this/bucket_full-')
        assert.equal(components.current_humidity.platform, 'sensor')
        assert.equal(components.current_humidity.device_class, 'humidity')
        assert.ok('target_humidity_state_topic' in components.humidifier, 'has target humidity topics')
        assert.equal(components.humidifier.current_humidity_topic, '$this/humidifier-current_humidity')
        assert.equal(components.current_humidity.state_topic, '$this/humidifier-current_humidity')
    })

    test('a unit that reports neither 0x2a2 nor 0x360 gets no UVnano or ionizer switch', (t) => {
        enableMockTimers(t)
        const { ha, thinq } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_NO_EXTRAS_HEX))
        tickMockTimers(t, 6000)

        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, Record<string, unknown>>
        // A component carrying nothing but its platform is device-discovery's
        // "remove this entity". It has to be published rather than merely
        // omitted, or an entity an earlier build created stays behind — and it
        // must keep 'platform', or Home Assistant rejects the whole device
        // payload and stops updating every other entity on the appliance.
        assert.deepEqual(components.uv_nano, { platform: 'switch' }, 'uv_nano removed')
        assert.deepEqual(components.ionizer, { platform: 'switch' }, 'ionizer removed')
        // Everything the appliance did report is still there.
        assert.ok(components.humidifier.platform, 'humidifier kept')
        assert.ok(components.fan_speed.platform, 'fan_speed kept')
        assert.ok(components.bucket_light.platform, 'bucket_light kept')
    })

    test('a held switch appears as soon as its tag turns up later', (t) => {
        enableMockTimers(t)
        const { ha, thinq } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_NO_EXTRAS_HEX))
        tickMockTimers(t, 6000)

        thinq.emit('data', buf(UV_ON_NOTIFY_HEX))
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.uv_nano.platform, 'switch', 'uv_nano published on first 0x2a2')
        assert.equal(ha.devices[DEVICE_ID]!.properties['uv_nano-'], 'ON')
    })

    test('values packet publishes target humidity from tlv 0x253', (t) => {
        const { ha } = buildReadyDevice(t)

        const props = ha.devices[DEVICE_ID]!.properties
        assert.equal(props['humidifier-target_humidity'], 35)
        assert.equal(props['ionizer-'], 'ON')
        assert.equal(props['uv_nano-'], 'OFF')
        assert.equal(props['fan_speed-'], 'Low')
    })

    test('current humidity comes from 0x336, never from the 0x1fd temperature tag', (t) => {
        const { ha, thinq } = buildReadyDevice(t)
        const props = ha.devices[DEVICE_ID]!.properties

        // The values packet carries 0x1fd=48 and no 0x336. Reading the
        // temperature tag as humidity is what published 238 % for a live unit.
        assert.equal(props['humidifier-current_humidity'], undefined)

        thinq.emit('data', buf(HUMIDITY_55_NOTIFY_HEX))
        assert.equal(props['humidifier-current_humidity'], 55)

        thinq.emit('data', buf(TEMPERATURE_238_NOTIFY_HEX))
        assert.equal(props['humidifier-current_humidity'], 55, '0x1fd must not move humidity')
    })

    test('uv on/off notify uses tlv 0x2a2', (t) => {
        const { ha, thinq } = buildReadyDevice(t)

        thinq.emit('data', buf(UV_ON_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['uv_nano-'], 'ON')

        thinq.emit('data', buf(UV_OFF_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['uv_nano-'], 'OFF')
    })

    test('ionizer off notify uses tlv 0x360', (t) => {
        const { ha, thinq } = buildReadyDevice(t)

        thinq.emit('data', buf(IONIZER_OFF_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['ionizer-'], 'OFF')
    })

    test('bucket full uses 0x2b2 steady state; 0x2b1=256 clears; 0x336 is humidity', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.processKeyValue(0x2b2, 1)
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_full-'], 'ON')

        dev.processKeyValue(0x336, 50)
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_full-'], 'ON', 'humidity tag must not toggle bucket')
        assert.equal(ha.devices[DEVICE_ID]!.properties['humidifier-current_humidity'], 50)

        thinq.emit('data', buf(BUCKET_EMPTIED_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_full-'], 'OFF')

        thinq.emit('data', buf(BUCKET_FULL_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_full-'], 'ON')
    })

    test('bucket light on/off notify uses tlv 0x21e', (t) => {
        const { ha, thinq } = buildReadyDevice(t)

        thinq.emit('data', buf(BUCKET_LIGHT_ON_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_light-'], 'ON')

        thinq.emit('data', buf(BUCKET_LIGHT_OFF_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_light-'], 'OFF')
    })

    test('target humidity write uses tlv 0x253', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('humidifier-target_humidity', '45')
        const pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('94D02D'), 'target humidity 45 encoded as tlv 0x253')
    })

    test('ionizer toggle write uses tlv 0x360', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('ionizer-', 'ON')
        const pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('D801'), 'ionizer tlv 0x360=1 present')
        assert.ok(pkt.includes('7DC1'), 'power+mode attached to ionizer write')
    })

    test('uv_nano toggle write uses tlv 0x2a2', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('uv_nano-', 'ON')
        const pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('A881'), 'uv_nano tlv 0x2a2=1 present')
        assert.ok(pkt.includes('7DC1'), 'power+mode attached to uv write')
    })

    test('bucket light write uses tlv 0x21e only', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('bucket_light-', 'ON')
        const pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('8781'), 'bucket light tlv 0x21e=1')
        assert.ok(!pkt.includes('7DC1'), 'panel-style write has no power/mode attach')
    })

    test('fan_speed write sends per-mode tlv table like device panel', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('fan_speed-', 'Low')
        const lowPkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(lowPkt.includes('7E82'), 'fan low 0x1fa=2')
        assert.ok(lowPkt.includes('B642'), 'per-mode fan low table')

        thinq.resetRecorder()
        dev.setProperty('fan_speed-', 'High')
        const highPkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(highPkt.includes('7E86'), 'fan high 0x1fa=6')
        assert.ok(highPkt.includes('B646'), 'per-mode fan high table')
    })

    test('sleep timer countdown notify uses tlv 0x21b seconds', (t) => {
        const { ha, thinq } = buildReadyDevice(t)

        thinq.emit('data', buf(SLEEP_TIMER_59S_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 1)

        thinq.emit('data', buf(SLEEP_TIMER_299S_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 5)

        thinq.emit('data', buf(SLEEP_TIMER_OFF_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 0)
    })

    test('sleep timer setpoint read uses minutes in tlv 0x21b', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        dev.processKeyValue(0x21b, 540)
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 9)

        dev.processKeyValue(0x21b, 180)
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 3)
    })

    test('sleep timer write encodes whole hours as minutes in tlv 0x21b', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('off_timer-', '9')
        let pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86E0021C'), '9 h → 0x21b=540')

        dev.setProperty('off_timer-', '5')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86E0012C'), '5 h → 0x21b=300')

        dev.setProperty('off_timer-', '2')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86D078'), '2 h → 0x21b=120')

        thinq.resetRecorder()
        dev.setProperty('off_timer-', '1')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86D03C'), '1 h → 0x21b=60')

        thinq.resetRecorder()
        dev.setProperty('off_timer-', '0')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86C0'), '0 h → 0x21b=0')
    })

    test('entering silent mode defaults fan_speed to low; high still allowed', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.modeClipPrev = 17 // was smart
        dev.processKeyValue(0x1f9, 19) // silent
        assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], 'Low')

        dev.processKeyValue(0x1fa, 6)
        assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], 'High')

        thinq.resetRecorder()
        dev.setProperty('fan_speed-', 'High')
        assert.ok(thinq.outbox.length >= 1, 'high fan write allowed in silent mode')
    })
})

/*
 * The fields LG's own modelJSON declares for this platform but PR #64 never covered. Each id is
 * that model's `..._state_tlv_<id>` label; the values are its `value_mapping`, in the Korean of
 * LG's own ko-KR language pack.
 */
describe('DHUM LG-declared field set', () => {
    test('the temperature tag is half-degrees, as the 231006 unit proved against the cloud', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        dev.processKeyValue(0x1fd, 58)
        assert.equal(ha.devices[DEVICE_ID]!.properties['temperature-'], 29)
    })

    test('display and buzzer are inverted, and are read that way', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const props = ha.devices[DEVICE_ID]!.properties

        dev.processKeyValue(0x21f, 0)
        assert.equal(props['display-'], 'On')
        dev.processKeyValue(0x21f, 1)
        assert.equal(props['display-'], 'Off')

        dev.processKeyValue(0x3a0, 0)
        assert.equal(props['bell_sound-'], 'On')

        thinq.resetRecorder()
        dev.setProperty('bell_sound-', 'Off')
        assert.ok(hex(thinq.outbox[thinq.outbox.length - 1]).includes('E801'), '0x3a0=1 is buzzer off')
    })

    test('auto dry carries LG’s 253 for its smart step', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        dev.processKeyValue(0x20e, 253)
        assert.equal(ha.devices[DEVICE_ID]!.properties['auto_dry-'], 'Smart dry')

        thinq.resetRecorder()
        dev.setProperty('auto_dry-', 'Smart dry')
        assert.ok(hex(thinq.outbox[thinq.outbox.length - 1]).includes('8390FD'), '0x20e=253')
    })

    test('the water tank reports LG’s three states', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const props = ha.devices[DEVICE_ID]!.properties
        for (const [wire, label] of [
            [0, 'Normal'],
            [1, 'Full (stopped)'],
            [2, 'Full (fan)'],
        ] as const) {
            dev.processKeyValue(0x186, wire)
            assert.equal(props['watertank_state-'], label)
        }
    })

    test('a declared field stays held until the appliance reports its tag', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = () => ha.devices[DEVICE_ID]!.config!.components as Record<string, unknown>
        // A held component is published as the removal stub — platform and nothing else.
        assert.deepEqual(components().melody, { platform: 'select' }, 'not offered before the tag arrives')
        dev.processKeyValue(0x3b9, 4)
        assert.ok((components().melody as { options?: unknown }).options, 'offered once the tag arrives')
        assert.equal(ha.devices[DEVICE_ID]!.properties['melody-'], 'Beethoven Pastoral')
    })
})
