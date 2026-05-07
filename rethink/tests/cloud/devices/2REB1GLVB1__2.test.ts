import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REB1GLVB1__2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REB1GLVB1__2'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REB1GLVB1__2', swVersion: '1.0' }

// Real packet captures from a 2REB1GLVB1__2 fridge (issue #39, log.txt - single capture available).
// STATUS_LENGTH = 17. Frame:
//   AA 0x17 10 EB <17 status bytes> <cksum> BB

// All existing data appears to indicate that the 17 bytes match other fridges' data.

// Initial status - fridge=3C, freezer=-18C, unit=C, expressFreeze=1 (off), door closed (encoded as 2!).
const SAMPLE_INITIAL = buf('AA1710EB020504010000000201000100000000000099BB')

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

        assert.equal(dev.properties.fridge_setpoint, 3) // 8 - 5
        assert.equal(dev.properties.freezer_setpoint, -18) // -14 - 4
        assert.equal(dev.properties.door, 'OFF') // captured byte [7]=2 - also closed
        assert.equal(dev.properties.express_cool, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
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
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '4')
        const pkt = thinq.outbox[0]
        // Frame layout: AA <len> F0 17 [17-byte status] <cksum> BB.
        // Status index 0 lands at packet offset 4.
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[4 + 1], 4) // fridgeSetpoint
        assert.equal(pkt[4 + 8], 1) // tempUnit = C
        assert.equal(pkt[4 + 2], 0xff) // freezerSetpoint untouched
    })

    test('HA write freezer_setpoint=-20C', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 2], 6)
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

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('nonsense', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
