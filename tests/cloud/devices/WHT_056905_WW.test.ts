import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WHT_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WHT_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real packet captures from a WHT_056905_WW water heater.

// Capability request
const CAPS_REQUEST_HEX = '01010400000065020201027D416A0D'

// Capability response (0xA7 kind byte). Contains TLV t=0x2DA (eeprom checksum),
// which triggers isCapsResponse. Also contains mode entries (0x2D7/0x2D8).
const CAPS_RESPONSE_HEX =
    '000004000000A702017E3FB01012B4901EB0C1B101B4F0020000B541B543B6A00FAEB6F0330704BD3' +
    '001FD00B701BC41BD43B5D019B61078B5D01AB61078B5D01BB61078B5D01CB6107872D1'

// Values response (0xA7 kind byte). Contains TLV t=0x1F7 (power), which triggers isValuesResponse.
//   t=0x1F9 = 25   mode = heat_pump
//   t=0x1F7 = 1    power = ON
//   t=0x255 = 119  current_temp = 59.5 °C (raw/2)
//   t=0x256 = 120  target_temp = 60 °C (raw/2)
//   t=0x221 = 0    error code (no error)
//   t=0x229 = 92   hot water remaining = 92%
//   t=0x2B3 = 50   power draw = max(5, 50-60) = 5 W (RAC family convention)
const QUERY_RESPONSE_HEX =
    '000004000000A702047F2E7E50197DC1955077959078A2407F0088408A028A505C8A808CA09CCE8CD' +
    '037ACD032D56004AAD5A010E0C900AC40D555'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Bring the device through the full caps->values flow using mock timers.
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

        // Config exposes the water_heater component.
        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.water_heater, 'water_heater component')
        assert.equal(components.water_heater.platform, 'water_heater')
        assert.equal(components.water_heater.temperature_unit, 'C')
        assert.equal(components.water_heater.min_temp, 35)
        assert.equal(components.water_heater.max_temp, 60)
        assert.equal(components.water_heater.temp_step, 0.5)

        // Status/diagnostic sensors.
        assert.equal(components.energy.platform, 'sensor')
        assert.equal(components.energy.device_class, 'power')
        assert.equal(components.energy.unit_of_measurement, 'W')
        assert.equal(components.error.platform, 'sensor')
        assert.equal(components.error.entity_category, 'diagnostic')
        assert.equal(components.water.platform, 'sensor')
        assert.equal(components.water.unit_of_measurement, '%')

        // Sensors must wire the HA schema key "state_topic" (named fields would
        // produce "<name>_state_topic", which HA ignores).
        assert.equal(components.energy.state_topic, '$this/energy-')
        assert.equal(components.error.state_topic, '$this/error-')
        assert.equal(components.water.state_topic, '$this/water-')

        // Compressor frequency sensor (0x22a, RAC family convention).
        assert.equal(components.compressor.platform, 'sensor')
        assert.equal(components.compressor.device_class, 'frequency')
        assert.equal(components.compressor.unit_of_measurement, 'Hz')
        assert.equal(components.compressor.entity_category, 'diagnostic')
        assert.equal(components.compressor.state_topic, '$this/compressor-')

        dev.drop()
    })

    test('initial state response publishes expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // allow timed events to process
        tickMockTimers(t, 1000)

        assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'current_temperature'), 59.5) // 0x255=119 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'temperature_state'), 60) // 0x256=120 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'mode_state'), 'heat_pump') // 0x1F9=25

        // Status/diagnostic sensors published from the same values response.
        assert.equal(ha.getProperty(DEVICE_ID, 'energy', 'state'), 5) // 0x2B3=50 → max(5, 50-60)
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 0) // 0x221=0, no error
        assert.equal(ha.getProperty(DEVICE_ID, 'water', 'state'), 92) // 0x229=92%
        assert.equal(ha.getProperty(DEVICE_ID, 'compressor', 'state'), 0) // 0x22A=0, idle

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

    test('mode labels are a subset of HA water_heater built-in modes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        const allowed = ['off', 'eco', 'electric', 'gas', 'heat_pump', 'high_demand', 'performance']
        for (const mode of components.water_heater.modes as string[]) {
            assert.ok(allowed.includes(mode), `mode "${mode}" is a built-in HA water_heater mode`)
        }

        // verify mapping: device codes -> standard HA labels
        for (const [code, expected] of [
            ['25', 'heat_pump'],
            ['26', 'performance'],
            ['27', 'electric'],
            ['28', 'eco'],
        ] as [string, string][]) {
            dev.raw_clip_state[0x1f7] = 1
            dev.raw_clip_state[0x1f9] = Number(code)
            dev.processKeyValue(0x1f9, Number(code))
            assert.equal(ha.getProperty(DEVICE_ID, 'water_heater', 'mode_state'), expected)
        }

        dev.drop()
    })

    test('writing standard mode label sends the correct device code', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 1
        dev.raw_clip_state[0x1f9] = 25
        dev.raw_clip_state[0x256] = 110 // target temp 55 C

        ha.setProperty(DEVICE_ID, 'water_heater', 'mode_command', 'electric')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(dev.raw_clip_state[0x1f9], 27, 'raw_clip_state updated to electric code')

        dev.drop()
    })

    test('mode=off triggers power=OFF instead of mode write', (t) => {
        const { thinq, dev, ha } = buildReadyDevice(t)
        dev.raw_clip_state[0x1f7] = 1
        dev.raw_clip_state[0x1f9] = 25

        ha.setProperty(DEVICE_ID, 'water_heater', 'mode_command', 'off')

        // Should send a power-off packet (0x1f7=0), not a mode packet.
        assert.equal(thinq.outbox.length, 1)
        const sent = hex(thinq.outbox[0])
        // The packet should contain 0x1F7=0 (power off).
        assert.ok(sent.includes('7DC0'), 'contains 0x1F7=0 (power off TLV)')

        dev.drop()
    })

    test('drop clears all timers', (t) => {
        const { dev } = buildReadyDevice(t)

        assert.ok(dev.query_caps_timeout == null, 'caps timeout cleared')
        assert.ok(dev.query_values_timeout == null, 'values timeout cleared')

        dev.start()
        assert.ok(dev.query_timer != null, 'refresh timer set after start()')

        dev.drop()

        assert.ok(dev.query_timer == null, 'refresh timer cleared')
    })
})
