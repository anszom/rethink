import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REBGLUB_2P__'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REBGLUB_2P__'
const META: Metadata = {
    modelId: MODEL_ID,
    modelName: MODEL_ID,
    swVersion: '1.0',
}

// Real packet captures from an LG GBBS322CEV refrigerator.
// ThinQ2 model ID: 2REBGLUB_2P__
// Device type: 101
//
// STATUS_LENGTH = 96. Frames:
//   AA 0x66 10 EB <96 bytes> <checksum> BB
//       Full/initial status
//
//   AA 0xC6 10 EC <96 previous> <96 current> <checksum> BB
//       Status delta; only the current status block is decoded.

// Fridge=3C, freezer=-20C, door closed,
// Express Cool OFF, Express Freeze OFF,
// drawer mode Cheese, unit Celsius.
const SAMPLE_INITIAL = buf(
    'AA6610EB02050601FFFFFF0201FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101000EBB',
)

// Same values as SAMPLE_INITIAL, but door open.
const SAMPLE_DOOR_OPEN = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101000FBB',
)

// Fridge=3C, freezer=-23C, door open,
// Express Freeze ON, drawer mode Cheese.
const SAMPLE_EXPRESS_FREEZE_ON = buf(
    'AA6610EB02050902FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010000000BBB',
)

// Fridge=3C, freezer=-20C, door open,
// Express Cool ON, Express Freeze OFF,
// drawer mode Cheese.
const SAMPLE_EXPRESS_COOL_ON = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0100FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010000000EBB',
)

// Drawer mode Fish, raw value 1.
const SAMPLE_DRAWER_FISH = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF010101010108BB',
)

// Drawer mode Meat, raw value 2.
const SAMPLE_DRAWER_MEAT = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101020BBB',
)

// Delta: previous state has the door open, current state has the door closed.
// Fridge remains at 3C, freezer remains at -20C, and drawer mode remains Cheese.
const SAMPLE_DELTA_DOOR_OPEN_TO_CLOSED = buf(
    'AAC610EC02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF010101010002050601FFFFFF0201FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101005EBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)

    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is not published until a valid status frame establishes the temperature unit', () => {
        const { ha } = makeDevice()

        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('0x10EB full status publishes Celsius configuration and decodes the appliance state', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'Home Assistant configuration published')

        const components = dev.config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)

        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)

        assert.ok(components.door, 'door component')
        assert.ok(components.express_cool, 'express_cool component')
        assert.ok(components.express_freeze, 'express_freeze component')
        assert.ok(components.drawer_mode, 'drawer_mode component')
        assert.ok(components.drawer_mode_raw, 'drawer_mode_raw component')

        assert.equal(dev.properties.fridge_setpoint, 3)
        assert.equal(dev.properties.freezer_setpoint, -20)
        assert.equal(dev.properties.door, 'OFF')
        assert.equal(dev.properties.express_cool, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
        assert.equal(dev.properties.drawer_mode, 'Cheese')
        assert.equal(dev.properties.drawer_mode_raw, '0')
    })

    test('0x10EB full status decodes an open door', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DOOR_OPEN)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.door, 'ON')
        assert.equal(props.fridge_setpoint, 3)
        assert.equal(props.freezer_setpoint, -20)
    })

    test('0x10EB full status decodes Express Freeze ON', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_EXPRESS_FREEZE_ON)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.freezer_setpoint, -23)
        assert.equal(props.express_freeze, 'ON')
        assert.equal(props.express_cool, 'OFF')
        assert.equal(props.door, 'ON')
    })

    test('0x10EB full status decodes Express Cool ON', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_EXPRESS_COOL_ON)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.express_cool, 'ON')
        assert.equal(props.express_freeze, 'OFF')
        assert.equal(props.door, 'ON')
    })

    test('drawer mode raw 0 is decoded as Cheese', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.drawer_mode_raw, '0')
        assert.equal(props.drawer_mode, 'Cheese')
    })

    test('drawer mode raw 1 is decoded as Fish', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DRAWER_FISH)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.drawer_mode_raw, '1')
        assert.equal(props.drawer_mode, 'Fish')
    })

    test('drawer mode raw 2 is decoded as Meat', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DRAWER_MEAT)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.drawer_mode_raw, '2')
        assert.equal(props.drawer_mode, 'Meat')
    })

    test('0x10EC delta decodes only the current status block', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN_TO_CLOSED)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.fridge_setpoint, 3)
        assert.equal(props.freezer_setpoint, -20)
        assert.equal(props.door, 'OFF')
        assert.equal(props.express_cool, 'OFF')
        assert.equal(props.express_freeze, 'OFF')
        assert.equal(props.drawer_mode, 'Cheese')
        assert.equal(props.drawer_mode_raw, '0')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', buf('001122'))

        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('frames with an unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()

        // Valid AA..BB frame, but the inner packet type is not 0x10EB or 0x10EC.
        thinq.emit('data', buf('AA08109901020304BB'))

        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('start() sends the F0ED status query packet', () => {
        const { thinq, dev } = makeDevice()

        thinq.resetRecorder()
        dev.start()

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA write fridge_setpoint=4C creates a 96-byte setting frame', () => {
        const { thinq, dev } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '4')

        const pkt = thinq.outbox[0]

        // Frame layout:
        // AA <length> F0 17 <96-byte status> <checksum> BB
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[4 + 1], 4)
        assert.equal(pkt[4 + 8], 1)

        // Unchanged fields use the 0xFF sentinel.
        assert.equal(pkt[4 + 0], 0xff)
        assert.equal(pkt[4 + 2], 0xff)
    })

    test('HA write freezer_setpoint=-20C creates the expected raw value', () => {
        const { thinq, dev } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')

        const pkt = thinq.outbox[0]

        assert.equal(pkt[4 + 2], 6)
        assert.equal(pkt[4 + 1], 0xff)
        assert.equal(pkt[4 + 8], 1)
    })

    test('HA write express_cool=ON sets the Express Cool field', () => {
        const { thinq, dev } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('express_cool', 'ON')

        const pkt = thinq.outbox[0]

        assert.equal(pkt[4 + 16], 1)
    })

    test('HA write express_freeze=ON sets the Express Freeze field', () => {
        const { thinq, dev } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')

        const pkt = thinq.outbox[0]

        assert.equal(pkt[4 + 3], 2)
    })

    test('HA write to an unknown property sends nothing', () => {
        const { thinq, dev } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')

        assert.equal(thinq.outbox.length, 0)
    })
})
