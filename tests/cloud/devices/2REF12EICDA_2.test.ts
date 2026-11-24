import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF12EICDA_2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF12EICDA_2'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REF12EICDA_2', swVersion: '1.0' }

// Real packet captures from a 2REF12EICDA_2 fridge
// Frame structure (AABBDevice):
//   AA <len> 10 EB <68 status bytes> <cksum> BB     - initial-status push
//   AA <len> 10 EC <68 prev> <68 cur> <cksum> BB    - status delta push (only `cur` is used)
//

// Initial state
// fridge: 36F, freezer: -2F, ice plus: off, doors closed, display_lock: off, sabbath: off, craft_ice: 6,
const SAMPLE_INITIAL = buf(
    'AA3A10EC0208080104020601000000FFFFFF00FFFF00FFFFFFFFFFFFFF020208080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF025EBB',
)

// 0x10EC delta - door OPEN
const SAMPLE_DELTA_DOOR_OPEN = buf(
    'AA3A10EC0208080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF020208080104020601000000FFFFFF00FFFF00FFFFFFFFFFFFFF025EBB',
)

// 0x10EC delta - fridge raised to 42F
const SAMPLE_DELTA_FRIDGE_42F = buf(
    'AA3A10EC0208080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF020202080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF0251BB',
)

// 0x10EC delta - ice plus enabled
const SAMPLE_DELTA_ICE_PLUS = buf(
    'AA3A10EC0208080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF020208080204020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF025EBB',
)

// 0x10EC delta - display lock enabled
const SAMPLE_DELTA_DISPLAY_LOCK = buf(
    'AA3A10EC0208080204020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF020208080204020600000001FFFFFF00FFFF00FFFFFFFFFFFFFF0258BB',
)

// 0x10EC delta - sabbath enabled
const SAMPLE_DELTA_SABBATH = buf(
    'AA3A10EC0208080204020600000001FFFFFF00FFFF00FFFFFFFFFFFFFF020208080104020600000000FFFFFF01FFFF00FFFFFFFFFFFFFF0258BB',
)

// 0x10EC delta - craft ice set to 3
const SAMPLE_DELTA_CRAFT_ICE = buf(
    'AA3A10EC0208080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF020208080104020600000000FFFFFF00FFFF00FFFFFFFFFFFFFF015CBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is not published until a status frame establishes the temperature unit', () => {
        const { ha } = makeDevice()
        // The base HADevice constructor doesn't publish config; the device first needs the unit.
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('0x10EB initial status publishes config (Fahrenheit) and decodes setpoints', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev, 'device entry created')
        assert.ok(dev.config, 'config published once unit is known')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        // Range comes from fridgeRange/freezerRange for unit=F.
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')
        assert.equal(components.fridge_setpoint.min, 33)
        assert.equal(components.fridge_setpoint.max, 43)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°F')
        assert.equal(components.freezer_setpoint.min, -7)
        assert.equal(components.freezer_setpoint.max, 5)
        assert.deepEqual(components.craft_ice_mode.options, ['3 balls', '6 balls'])

        assert.equal(dev.properties.fridge_setpoint, 36)
        assert.equal(dev.properties.freezer_setpoint, -2)
        assert.equal(dev.properties.ice_plus, 'OFF')
        assert.equal(dev.properties.sabbath_mode, 'OFF')
        assert.equal(dev.properties.display_lock, 'OFF')
        assert.equal(dev.properties.craft_ice_mode, '6 balls')
        assert.equal(dev.properties.door, 'OFF')
    })

    test('0x10EC delta with door open publishes door=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 36)
    })

    test('0x10EC delta with ice plus publishes ice_plus=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_ICE_PLUS)
        assert.equal(ha.devices[DEVICE_ID].properties.ice_plus, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 36)
    })

    test('0x10EC delta with sabbath on decodes publishes sabbath', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_SABBATH)
        assert.equal(ha.devices[DEVICE_ID].properties.sabbath_mode, 'ON')
    })

    test('0x10EC delta with fridge=42F decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_42F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 42)
    })

    test('0x10EC delta with craft_ice=3 publishes craft_ice_mode', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_CRAFT_ICE)
        assert.equal(ha.devices[DEVICE_ID].properties.craft_ice_mode, '3 balls')
    })

    test('suppresses duplicate publishes when the cur block is unchanged', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        let publishCalls = 0
        const realPublish = ha.publishProperty.bind(ha)
        ha.publishProperty = (id, prop, value) => {
            publishCalls++
            return realPublish(id, prop, value)
        }
        thinq.emit('data', SAMPLE_INITIAL)
        assert.equal(publishCalls, 0, 'no republishes when nothing changed')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        // Valid AA..BB envelope but inner-byte 0x10/0x99 is not 0xEB or 0xEC.
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('start() sends the F0ED status-query packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        // From the rethink.log capture: AA 0E F0 ED 12 11 01 00 00 01 04 00 EB BB
        assert.equal(hex(pkt), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA write fridge_setpoint=42F', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '42')
        const pkt = thinq.outbox[0]
        // pkt layout: AA <len> F0 17 ...baseMessage[2..end]... <cksum> BB
        // baseMessage[2 + 1] holds the encoded fridge value, which lands at frame offset 2 + 2 + 1 = 5.
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[5], 2) // 44 - 42
        assert.equal(pkt[2 + 2 + 8], 0) // unit byte = 0 (Fahrenheit)
    })

    test('HA write freezer_setpoint=-5F', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-5')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[2 + 2 + 2], 11) // 6 - (-5) = 11
    })

    test('HA write craft_ice_mode=3 balls', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('craft_ice_mode', '3 balls')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2 + 2 + 25], 1)
    })

    test('HA write to an unknown property sends nothing', (t) => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
