import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/POT_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'POT_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LP1022FVSM', swVersion: '115100' }

// Real packet captures from an LG LP1022FVSM portable air conditioner.

// Capability request sent by rethink after the device connected.
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

// Initial values request sent after the capability response.
const QUERY_REQUEST_HEX = '01010400000065020201027D425A6E'

// Capability response from the device. Unlike RAC_056905_WW / WIN_056905_WW,
// this model uses TLV marker 0xA7 for device-to-cloud packets.
const CAPS_RESPONSE_HEX =
    '000004000000A702019946' +
    'B01011B047B09054B0C1B103B35010B4E04006B55060B6A0046FB6F0115100BD01B85020B8903C' +
    'B8D020B9103CBC41BD47B5C0B61020B642B5C1B61029B642B5C2B61029B642AD3A'

// Initial values response from the device while physically set to Dry mode.
// Contains:
//      t=0x1f7 l=0 v=0x1 (1)   power=ON
//      t=0x1f9 l=0 v=0x1 (1)   mode=dry
//      t=0x1fa l=0 v=0x2 (2)   fan=low
//      t=0x1fd l=1 v=0x27 (39) current_temp=19.5
//      t=0x1fe l=1 v=0x29 (41) set_temp=20.5
const QUERY_RESPONSE_HEX =
    '000004000000A702049C47' +
    '7E417DC17E827F50277F9029C840868086C08700884089408A10188A50688A8F8CA002E88CD01BA' +
    'CE00258D55092D590FACAD04BCB10B0CB8CCBCFCC1048CC907C1B01C0C0AC403F51'

// Bytes sent in response to specific HA setProperty calls.
const WRITE_MODE_DRY_HEX = '01010400000065020101097E417DC17E827F902AC337'
const WRITE_MODE_FAN_ONLY_HEX = '01010400000065020101097E427DC17E827F90293B21'
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'

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

    // Constructor sent the queryCaps packet, discard it.
    thinq.resetRecorder()

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    assert.equal(thinq.outbox.length, 1)
    assert.equal(hex(thinq.outbox[0]), QUERY_REQUEST_HEX)

    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 1000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected climate component', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.climate, 'climate component')
        assert.equal(components.climate.platform, 'climate')
        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only'])
        assert.deepEqual(components.climate.fan_modes, ['low', 'medium', 'high'])
        assert.deepEqual(components.climate.swing_modes, ['on', 'off'])
        assert.equal(components.climate.temp_step, 1)
        assert.equal(components.climate.precision, 1)

        dev.drop()
    })

    test('initial state response publishes all expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry') // 0x1F9=1 with power=ON
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low') // 0x1FA=2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 19.5) // 0x27 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 20.5) // 0x29 / 2

        // The captured values response contains 0x321=0, but this wrapper uses 0x322 for swing_mode,
        // so swing state should not be published from this packet.
        assert.ok(!ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'swing mode absent from capture')

        dev.drop()
    })

    test('HA write climate-mode=dry from off emits expected bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Pre-state observed while testing mode changes from off.
        dev.raw_clip_state[0x1f7] = 0
        dev.raw_clip_state[0x1f9] = 0
        dev.raw_clip_state[0x1fa] = 2
        dev.raw_clip_state[0x1fe] = 42

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_DRY_HEX)

        dev.drop()
    })

    test('HA write climate-mode=fan_only emits expected bytes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_MODE_FAN_ONLY_HEX)

        dev.drop()
    })

    test('HA write climate-mode=off triggers power=OFF instead of mode write', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX)

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
