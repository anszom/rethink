import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/VENT_725601_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'VENT_725601_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Z-H0151B2SR', swVersion: '725601' }

// Real captured packets from LG Residential ERV unit (Z-H0151B2SR)
const CAPS_RESPONSE_HEX =
    '000004000000A702010049B004B4A001C0B0A001C4B4D011B710B4BC81B2C0B330400002B77001F01EBD43D401BC600601BD200410B5D025B642B600B5D026B642B600B5D027B642B600B69042B6F0725601FA0156CC'

const QUERY_RESPONSE_HEX =
    '000004000000A7020400327DC17F502F7E827E502786808840CD47CD06CCC5D3101AD2D015D29013CD8096C1CAA00188A8818580D5501CE340BC81C900DEBF'

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
    tickMockTimers(t, 1000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected fan and sensor components', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.fan, 'fan component present')
        assert.equal(components.fan.platform, 'fan')
        assert.equal(components.fan.speed_range_min, 1)
        assert.equal(components.fan.speed_range_max, 3)
        assert.deepEqual(components.fan.preset_modes, ['ventilation', 'auto', 'bypass', 'saving'])

        assert.equal(components.power, undefined, 'no redundant power switch component')

        assert.ok(components.temp_indoor, 'indoor temperature sensor present')
        assert.equal(components.temp_indoor.platform, 'sensor')
        assert.ok(components.temp_exhaust, 'exhaust temperature sensor present')
        assert.equal(components.temp_exhaust.platform, 'sensor')
        assert.ok(components.temp_outdoor, 'outdoor temperature sensor present')
        assert.equal(components.temp_outdoor.platform, 'sensor')
        assert.ok(components.air_quality, 'air quality sensor present')
        assert.equal(components.air_quality.platform, 'sensor')

        dev.drop()
    })

    test('query response publishes all expected HA properties', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'percentage_state'), 1)
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'preset_mode_state'), 'auto')
        assert.equal(ha.getProperty(DEVICE_ID, 'temp_indoor', 'state'), 26)
        assert.equal(ha.getProperty(DEVICE_ID, 'temp_exhaust', 'state'), 21)
        assert.equal(ha.getProperty(DEVICE_ID, 'temp_outdoor', 'state'), 19)
        assert.equal(ha.getProperty(DEVICE_ID, 'air_quality', 'state'), 6)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['fan-power'], 'ON')
        assert.equal(props['fan-speed'], 1)
        assert.equal(props['fan-mode'], 'auto')
        assert.equal(props['sensor-temp_indoor'], 26)
        assert.equal(props['sensor-temp_exhaust'], 21)
        assert.equal(props['sensor-temp_outdoor'], 19)
        assert.equal(props['sensor-air_quality'], 6)

        dev.drop()
    })

    test('HA write fan power=OFF emits expected TLV packet', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'fan', 'command', 'OFF')

        assert.equal(thinq.outbox.length, 1)
        const out = thinq.outbox[0]
        const tlvs = TLV.parse(out.subarray(11, out.length - 2))
        assert.equal(tlvs.length, 1)
        assert.equal(tlvs[0].t, 0x1f7)
        assert.equal(tlvs[0].v, 0)
        assert.equal(ha.devices[DEVICE_ID].properties['fan-power'], 'OFF')

        dev.drop()
    })

    test('HA write fan power=ON emits combined packet with default speed and mode', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Set explicit mode and turn OFF first
        ha.setProperty(DEVICE_ID, 'fan', 'preset_mode_command', 'auto')
        ha.setProperty(DEVICE_ID, 'fan', 'command', 'OFF')
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'fan', 'command', 'ON')

        assert.equal(thinq.outbox.length, 1)
        const out = thinq.outbox[0]
        const tlvs = TLV.parse(out.subarray(11, out.length - 2))
        assert.equal(tlvs.find((x) => x.t === 0x1f7)?.v, 1)
        assert.equal(tlvs.find((x) => x.t === 0x1f9)?.v, 1)
        assert.equal(tlvs.find((x) => x.t === 0x1fa)?.v, 2)
        assert.equal(ha.devices[DEVICE_ID].properties['fan-power'], 'ON')

        dev.drop()
    })

    test('HA write fan percentage=2 emits speed TLV asserting power ON', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'fan', 'percentage_command', '2')

        assert.equal(thinq.outbox.length, 1)
        const out = thinq.outbox[0]
        const tlvs = TLV.parse(out.subarray(11, out.length - 2))
        assert.equal(tlvs.find((x) => x.t === 0x1f7)?.v, 1)
        assert.equal(tlvs.find((x) => x.t === 0x1fa)?.v, 4)
        assert.equal(ha.devices[DEVICE_ID].properties['fan-power'], 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties['fan-speed'], 2)

        dev.drop()
    })

    test('HA write fan percentage=0 turns off power', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'fan', 'percentage_command', '0')

        assert.equal(thinq.outbox.length, 1)
        const out = thinq.outbox[0]
        const tlvs = TLV.parse(out.subarray(11, out.length - 2))
        assert.equal(tlvs.length, 1)
        assert.equal(tlvs[0].t, 0x1f7)
        assert.equal(tlvs[0].v, 0)
        assert.equal(ha.devices[DEVICE_ID].properties['fan-power'], 'OFF')

        dev.drop()
    })

    test('HA write fan preset_mode=saving emits mode TLV asserting power ON', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'fan', 'preset_mode_command', 'saving')

        assert.equal(thinq.outbox.length, 1)
        const out = thinq.outbox[0]
        const tlvs = TLV.parse(out.subarray(11, out.length - 2))
        assert.equal(tlvs.find((x) => x.t === 0x1f7)?.v, 1)
        assert.equal(tlvs.find((x) => x.t === 0x1f9)?.v, 3)
        assert.equal(ha.devices[DEVICE_ID].properties['fan-mode'], 'saving')

        dev.drop()
    })
})
