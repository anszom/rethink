import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2RES1VE61NFA2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2RES1VE61NFA2'
const META: Metadata = { modelId: MODEL_ID, modelName: '2RES1VE61NFA2', swVersion: '1.0' }

// Real packet captures from a 2RES1VE61NFA2 fridge (issue #9, rethink.log).
// STATUS_LENGTH = 27. Frames:
//   AA 0x21 10 EB <27 bytes> <cksum> BB                       - initial-status
//   AA 0x3C 10 EC <27 prev> <27 cur> <cksum> BB               - status delta (only `cur` used)

// fridge=6C, freezer=-18C, doors closed, no express, unit=C.
const SAMPLE_INITIAL = buf('AA2110EB0202040107000000010001FFFFFF00FF0001FFFFFFFFFFFFFF020085BB')

// Delta - door OPEN and express-cool ON.
const SAMPLE_DELTA_DOOR_OPEN_EXPRESS_COOL_ON = buf(
    'AA3C10EC0201040102000001010001FFFFFF00FF0100FFFFFFFFFFFFFF02060202040102000001010001FFFFFF00FF0100FFFFFFFFFFFFFF0206ACBB',
)

// Delta - door closed, express-cool OFF (nothing on).
const SAMPLE_DELTA_QUIESCENT = buf(
    'AA3C10EC0202040102000000010001FFFFFF00FF0000FFFFFFFFFFFFFF02010202040102000000010001FFFFFF00FF0000FFFFFFFFFFFFFF0202B8BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config not published until a status frame establishes the unit', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('0x10EB initial status: publishes Celsius config and decodes setpoints', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
        assert.ok(components.express_cool, 'express_cool component')
        assert.ok(components.express_freeze, 'express_freeze component')

        assert.equal(dev.properties.fridge_setpoint, 6) // 8 - 2
        assert.equal(dev.properties.freezer_setpoint, -18) // -14 - 4
        assert.equal(dev.properties.door, 'OFF')
        assert.equal(dev.properties.express_cool, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
    })

    test('0x10EC delta with door open + express-cool ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN_EXPRESS_COOL_ON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.door, 'ON')
        assert.equal(props.express_cool, 'ON')
        assert.equal(props.express_freeze, 'OFF')
    })

    test('0x10EC delta back to quiescent state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_QUIESCENT)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.door, 'OFF')
        assert.equal(props.express_cool, 'OFF')
        assert.equal(props.express_freeze, 'OFF')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        // Valid AA..BB but inner byte[1] is not 0xEB or 0xEC.
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('start() sends the F0ED status-query packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA write fridge_setpoint=4C', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL) // unit becomes C
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '4')
        const pkt = thinq.outbox[0]
        // Frame layout: AA <len> F0 17 [27-byte status] <cksum> BB
        // index 0 of the 27-byte status sits at offset 4 in the packet.
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[4 + 1], 4) // fridgeSetpoint
        assert.equal(pkt[4 + 8], 1) // tempUnit = C
        // Other status bytes left at the 0xFF sentinel.
        assert.equal(pkt[4 + 0], 0xff) // monStatus
        assert.equal(pkt[4 + 2], 0xff) // freezerSetpoint
    })

    test('HA write freezer_setpoint=-20C', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 2], 6) // freezerSetpoint
        assert.equal(pkt[4 + 1], 0xff) // fridgeSetpoint untouched
        assert.equal(pkt[4 + 8], 1) // unit = C
    })

    test('HA write express_cool=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('express_cool', 'ON')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 16], 1)
    })

    test('HA write express_freeze=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 3], 2) // expressFreeze field
    })

    test('HA write to an unknown property sends nothing', (t) => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
