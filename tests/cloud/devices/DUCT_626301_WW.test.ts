import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DUCT_626301_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DUCT_626301_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '626301' }

// Real packet captures from a DUCT_626301_WW ducted air conditioner.

const CAPS_RESPONSE_HEX =
    '000004000000A702010076' +
    'B005B05057B09054B0C1B103B4D011B710FEBB82BBC0BC41BC89BCC1B340B380B54EB2C4B740' +
    'B85020B8903CB8D020B9103CBAD024BB103CBD41B5C0B642B61034B5C1B642B61034B5C2B642' +
    'B61034B5C6B642B61034B5C4B642B61034B69036B6F0626301E5E0AE5AE5E05C97D400BD308' +
    '00000DD006EC7'

// Captured state:
//   power=OFF
//   mode=fan_only
//   fan=low
//   current_temperature=25.5 C
//   target_temperature=26 C
const QUERY_RESPONSE_HEX =
    '000004000000A702040056' +
    '7DC07E427E827F50337F90347F0086808840D4C0D500C84081408180C9408340838083C08FC0' +
    'CD40CD00CCC0CD80ADA01995ACD01AAD5035B54ED5600457D5A00960BC89D5D03CD61020C900' +
    '9C4087CCA880AC40E9C08F08'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)

    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })

    return { ha, thinq, dev }
}

function buildReadyDevice() {
    const { ha, thinq, dev } = makeDevice()

    thinq.resetRecorder()
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    thinq.resetRecorder()

    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('captured state publishes the climate configuration', () => {
        const { ha, dev } = buildReadyDevice()

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        const climate = device.config!.components.climate as Record<string, unknown>

        assert.equal(climate.platform, 'climate')
        assert.equal(climate.temp_step, 1)
        assert.equal(climate.precision, 0.5)
        assert.deepEqual(climate.fan_modes, ['low', 'medium', 'high', 'auto'])

        dev.drop()
    })

    test('captured state publishes expected climate values', () => {
        const { ha, thinq, dev } = buildReadyDevice()

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 25.5)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 26)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off')

        dev.drop()
    })

    test('fan mode mapping matches the device values', () => {
        const { ha, dev } = buildReadyDevice()

        dev.processKeyValue(0x1fa, 2)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low')

        dev.processKeyValue(0x1fa, 4)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')

        dev.processKeyValue(0x1fa, 6)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'high')

        dev.processKeyValue(0x1fa, 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'auto')

        dev.drop()
    })
})
