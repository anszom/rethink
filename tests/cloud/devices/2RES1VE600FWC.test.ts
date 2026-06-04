import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2RES1VE600FWC'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2RES1VE600FWC'
const META: Metadata = { modelId: MODEL_ID, modelName: '2RES1VE600FWC', swVersion: '1.0' }

// Real packet captures for a 2RES1VE600FWC fridge (LG GSB470BASZ), from the body of issue #44.
// STATUS_LENGTH = 12. Frames:
//   AA 0x1E 10 EC <12 prev> <12 cur> <cksum> BB
// We assume 10EB frames match the other fridges.

const SAMPLE_DELTA_DOOR_OPEN = buf('AA1E10EC02030501FFFFFF0001FF01FF02030501FFFFFF0101FF01FF80BB')
const SAMPLE_DELTA_DOOR_CLOSE = buf('AA1E10EC02030501FFFFFF0101FF01FF02030501FFFFFF0001FF01FF80BB')
const SAMPLE_DELTA_FRIDGE_MINUS_1 = buf('AA1E10EC02030501FFFFFF0001FF01FF02040501FFFFFF0001FF01FF80BB')
const SAMPLE_DELTA_FRIDGE_PLUS_1 = buf('AA1E10EC02040501FFFFFF0001FF01FF02030501FFFFFF0001FF01FF80BB')
const SAMPLE_DELTA_FREEZER_MINUS_1 = buf('AA1E10EC02030501FFFFFF0001FF01FF02030601FFFFFF0001FF01FF80BB')
const SAMPLE_DELTA_FREEZER_PLUS_1 = buf('AA1E10EC02030601FFFFFF0001FF01FF02030501FFFFFF0001FF01FF80BB')
const SAMPLE_DELTA_EXPRESS_FREEZE_ON = buf('AA1E10EC02030501FFFFFF0001FF01FF02030502FFFFFF0001FF01FF80BB')
const SAMPLE_DELTA_EXPRESS_FREEZE_OFF = buf('AA1E10EC02030502FFFFFF0001FF01FF02030501FFFFFF0001FF01FF80BB')

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

    test('first 0x10EC delta publishes Celsius config and decodes setpoints', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.ok(components.express_freeze)
        assert.equal(dev.properties.fridge_setpoint, 5)
        assert.equal(dev.properties.freezer_setpoint, -18)
        assert.equal(dev.properties.door, 'ON')
    })

    test('door close transition publishes door=OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_CLOSE)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('fridge setpoint transition 5C -> 4C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_MINUS_1)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 4) // 8-4
    })

    test('fridge setpoint transition 4C -> 5C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_PLUS_1)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 5)
    })

    test('freezer transition -18C -> -19C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FREEZER_MINUS_1)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -19)
    })

    test('freezer transition -19C -> -18C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FREEZER_PLUS_1)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -18)
    })

    test('express-freeze toggle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_FREEZE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_FREEZE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
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

    test('HA write fridge_setpoint=5C', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN) // unit ← C
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '5')
        const pkt = thinq.outbox[0]
        // Frame: AA <len> F0 17 [12-byte status] <cksum> BB. status[1] lands at offset 5.
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[4 + 1], 3) // 8-5
        assert.equal(pkt[4 + 8], 1) // tempUnit = C
    })

    test('HA write freezer_setpoint=-19C', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-19')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 2], 6)
    })

    test('HA write express_freeze=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 3], 0x02)
    })

    test('HA write express_freeze=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'OFF')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 3], 0x01)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        thinq.resetRecorder()

        dev.setProperty('nonsense', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
