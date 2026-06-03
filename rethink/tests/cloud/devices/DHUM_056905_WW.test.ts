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

// Live notify when ionizer turned off on device panel
const IONIZER_OFF_NOTIFY_HEX = '000004000000A702043F02D80085A3'

const UV_ON_NOTIFY_HEX = '000004000000A702044B02A88184D7'
const UV_OFF_NOTIFY_HEX = '000004000000A702044A08A8808C90388CD041E991'

const BUCKET_LIGHT_ON_NOTIFY_HEX = '000004000000A702048C0287817086'
const BUCKET_LIGHT_OFF_NOTIFY_HEX = '000004000000A702048A028780473E'

const OFF_TIMER_1_NOTIFY_HEX = '000004000000A70204ED0386D03BB028'
const OFF_TIMER_5_NOTIFY_HEX = '000004000000A70204F30486E0012BC8DA'
const OFF_TIMER_OFF_NOTIFY_HEX = '000004000000A70204EE0286C0AFE8'

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
        assert.deepEqual(components.humidifier.modes, ['Smart', 'Jet', 'Silent', 'Spot', 'Laundry'])
        assert.ok(components.fan_speed, 'fan_speed select')
        assert.deepEqual(components.fan_speed.options, ['low', 'high'])
        assert.ok(components.off_timer, 'off_timer number')
        assert.equal(components.off_timer.platform, 'number')
        assert.equal(components.off_timer.device_class, 'duration')
        assert.equal(components.off_timer.unit_of_measurement, 'min')
        assert.equal(components.off_timer.min, 0)
        assert.equal(components.off_timer.max, 8)
        assert.equal(components.off_timer.step, 1)
        assert.ok(components.ionizer, 'ionizer switch')
        assert.ok(components.uv_nano, 'uv_nano switch')
        assert.ok(components.bucket_light, 'bucket_light switch')
        assert.equal(components.bucket_full.device_class, 'problem')
        assert.equal(components.bucket_full.state_topic, '$this/bucket_full-')
        assert.equal(components.current_humidity.platform, 'sensor')
        assert.equal(components.current_humidity.device_class, 'humidity')
        assert.ok('target_humidity_state_topic' in components.humidifier, 'has target humidity topics')
        assert.equal(components.humidifier.current_humidity_topic, '$this/humidifier-current_humidity')
        assert.equal(components.current_humidity.state_topic, '$this/humidifier-current_humidity')
    })

    test('values packet publishes target humidity from tlv 0x253', (t) => {
        const { ha } = buildReadyDevice(t)

        const props = ha.devices[DEVICE_ID]!.properties
        assert.equal(props['humidifier-target_humidity'], 35)
        assert.equal(props['humidifier-current_humidity'], 48)
        assert.equal(props['ionizer-'], 'ON')
        assert.equal(props['uv_nano-'], 'OFF')
        assert.equal(props['fan_speed-'], 'low')
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

    test('bucket full uses 0x2b2 steady state; 0x2b1=256 clears; 0x336 ignored', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.processKeyValue(0x2b2, 1)
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_full-'], 'ON')

        dev.processKeyValue(0x336, 50)
        assert.equal(ha.devices[DEVICE_ID]!.properties['bucket_full-'], 'ON', 'humidity tag must not toggle bucket')

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

        dev.setProperty('fan_speed-', 'low')
        const lowPkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(lowPkt.includes('7E82'), 'fan low 0x1fa=2')
        assert.ok(lowPkt.includes('B642'), 'per-mode fan low table')

        thinq.resetRecorder()
        dev.setProperty('fan_speed-', 'high')
        const highPkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(highPkt.includes('7E86'), 'fan high 0x1fa=6')
        assert.ok(highPkt.includes('B646'), 'per-mode fan high table')
    })

    test('off timer notify and state use tlv 0x21b (minutes 1–8 or 0)', (t) => {
        const { ha, thinq } = buildReadyDevice(t)

        thinq.emit('data', buf(OFF_TIMER_1_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 1)

        thinq.emit('data', buf(OFF_TIMER_5_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 5)

        thinq.emit('data', buf(OFF_TIMER_OFF_NOTIFY_HEX))
        assert.equal(ha.devices[DEVICE_ID]!.properties['off_timer-'], 0)
    })

    test('off timer write encodes minutes as tlv 0x21b', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        dev.setProperty('off_timer-', '5')
        let pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86E0012C'), '5 min → 0x21b=300')

        dev.setProperty('off_timer-', '2')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86D078'), '2 min → 0x21b=120')

        thinq.resetRecorder()
        dev.setProperty('off_timer-', '1')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86D03C'), '1 min → 0x21b=60')

        thinq.resetRecorder()
        dev.setProperty('off_timer-', '0')
        pkt = hex(thinq.outbox[thinq.outbox.length - 1])
        assert.ok(pkt.includes('86C0'), '0 min → 0x21b=0')
    })

    test('entering silent mode defaults fan_speed to low; high still allowed', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.modeClipPrev = 17 // was smart
        dev.processKeyValue(0x1f9, 19) // silent
        assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], 'low')

        dev.processKeyValue(0x1fa, 6)
        assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], 'high')

        thinq.resetRecorder()
        dev.setProperty('fan_speed-', 'high')
        assert.ok(thinq.outbox.length >= 1, 'high fan write allowed in silent mode')
    })
})
