import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EIDA__4'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF11EIDA__4'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REF11EIDA__4', swVersion: '1.0' }

// Real packet captures from a 2REF11EIDA__4 fridge (issue #9, complete log).
// Frame structure (AABBDevice):
//   AA <len> 10 EB <68 status bytes> <cksum> BB     - initial-status push
//   AA <len> 10 EC <68 prev> <68 cur> <cksum> BB    - status delta push (only `cur` is used)
//

// Initial state
// fridge: 35F, freezer: 0F, flex: cold drink, doors closed
const SAMPLE_INITIAL = buf(
    'AA4A10EB0209060202020400000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF000079BB',
)

// 0x10EC delta - same as initial but cur[7]=0x01 (door OPEN).
const SAMPLE_DELTA_DOOR_OPEN = buf(
    'AA8E10EC0209060202020400000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000209060202020401000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000FABB',
)

// 0x10EC delta - fridge raised to 42F (cur[1]=0x02).
const SAMPLE_DELTA_FRIDGE_42F = buf(
    'AA8E10EC0201060202020401000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000202060202020401000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000F4BB',
)

// 0x10EC delta - convertible drawer set to "Freezer" (cur[13]=0x05).
const SAMPLE_DELTA_FLEX_FREEZER = buf(
    'AA8E10EC0209060202020401000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000209060202020401000001FFFF0500FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000E7BB',
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
        assert.deepEqual(components.flex_setpoint.options, [
            'Chilled Wine',
            'Deli/Snacks',
            'Cold Drink',
            'Meat/Seafood',
            'Freezer',
        ])

        assert.equal(dev.properties.fridge_setpoint, 35) // 44 - 9
        assert.equal(dev.properties.freezer_setpoint, 0) // 6 - 6
        assert.equal(dev.properties.flex_setpoint, 'Cold Drink') // FLEX_OPTIONS[3-1]
        assert.equal(dev.properties.door, 'OFF')
    })

    test('0x10EC delta with door open publishes door=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 35)
    })

    test('0x10EC delta with fridge=42F decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_42F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 42) // 44 - 2
    })

    test('0x10EC delta with convertible=Freezer publishes flex_setpoint', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FLEX_FREEZER)
        assert.equal(ha.devices[DEVICE_ID].properties.flex_setpoint, 'Freezer')
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

    test('HA write flex_setpoint=Freezer', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('flex_setpoint', 'Freezer')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2 + 2 + 13], 5) // FLEX_OPTIONS.indexOf('Freezer')+1
    })

    test('HA write flex_setpoint with unrecognised value sends nothing', (t) => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('flex_setpoint', 'NotARealOption')
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write to an unknown property sends nothing', (t) => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
