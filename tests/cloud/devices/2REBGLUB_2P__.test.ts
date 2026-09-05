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

// Real packet captures from an LG GBBS322CEV refrigerator, also validated with an LG GBBS322BEV.
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
// Fresh Converter+ Cheese mode, unit Celsius.
const SAMPLE_INITIAL = buf(
    'AA6610EB02050601FFFFFF0201FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101000EBB',
)

// Same values as SAMPLE_INITIAL, but door open.
const SAMPLE_DOOR_OPEN = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101000FBB',
)

// Fridge=3C, freezer=-23C, door open,
// Express Freeze ON, Fresh Converter+ Cheese mode.
const SAMPLE_EXPRESS_FREEZE_ON = buf(
    'AA6610EB02050902FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010000000BBB',
)

// Fridge=3C, freezer=-20C, door open,
// Express Cool ON, Express Freeze OFF,
// drawer mode Cheese.
const SAMPLE_EXPRESS_COOL_ON = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0100FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010000000EBB',
)

// Fresh Converter+ Fish mode, raw value 1.
const SAMPLE_DRAWER_FISH = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF010101010108BB',
)

// Fresh Converter+ Meat mode, raw value 2.
const SAMPLE_DRAWER_MEAT = buf(
    'AA6610EB02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010103FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101020BBB',
)

// Delta: previous state has the door open, current state has the door closed.
// Fridge remains at 3C, freezer remains at -20C, and drawer mode remains Cheese.
const SAMPLE_DELTA_DOOR_OPEN_TO_CLOSED = buf(
    'AAC610EC02050601FFFFFF0101FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF010101010002050601FFFFFF0201FFFFFF00FFFFFF0000FFFFFFFFFFFFFFFF010101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF01010101005EBB',
)

const SAMPLE_DOOR_USAGE = buf('10C5000401000200000A03000300000E11001E00006413003C000096')

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
        assert.equal(components.drawer_mode.name, 'Fresh Converter+ (Drawer temperature)')
        assert.equal(components.drawer_mode.device_class, 'enum')
        assert.deepEqual(components.drawer_mode.options, ['Cheese (2 °C)', 'Fish (0 °C)', 'Meat (-3 °C)'])
        assert.equal(components.drawer_mode_raw, undefined)

        assert.equal(dev.properties.fridge_setpoint, 3)
        assert.equal(dev.properties.freezer_setpoint, -20)
        assert.equal(dev.properties.door, 'OFF')
        assert.equal(dev.properties.express_cool, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
        assert.equal(dev.properties.drawer_mode, 'Cheese (2 °C)')
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

    test('Fresh Converter+ raw value 0 is decoded as Cheese at 2 °C', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.drawer_mode, 'Cheese (2 °C)')
    })

    test('Fresh Converter+ raw value 1 is decoded as Fish at 0 °C', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DRAWER_FISH)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.drawer_mode, 'Fish (0 °C)')
    })

    test('Fresh Converter+ raw value 2 is decoded as Meat at -3 °C', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DRAWER_MEAT)

        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.drawer_mode, 'Meat (-3 °C)')
    })

    test('unsupported Fresh Converter+ values use the Home Assistant enum fallback', () => {
        const { dev } = makeDevice()

        assert.equal(dev.drawerModeName(0xff), 'unknown')
        assert.equal(dev.drawerModeName(3), 'unknown')
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
        assert.equal(props.drawer_mode, 'Cheese (2 °C)')
    })

    test('thermal state components use the agreed enum values', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const name of ['fridge_thermal_state', 'freezer_thermal_state']) {
            assert.equal(components[name].platform, 'sensor')
            assert.equal(components[name].device_class, 'enum')
            assert.deepEqual(components[name].options, ['settled', 'unknown', 'disturbed', 'unsettled'])
            assert.equal(components[name].unique_id, `$deviceid-${name}`)
            assert.equal(components[name].state_topic, `$this/${name}`)
        }
    })

    test('0x10EB decodes thermal states for each compartment', () => {
        const { ha, dev } = makeDevice()
        const status = Buffer.from(SAMPLE_INITIAL.subarray(2, -2))
        const states = new Map([
            [1, 'settled'],
            [2, 'unknown'],
            [3, 'disturbed'],
            [5, 'unsettled'],
            [0xff, 'unknown'],
            [4, 'unknown'],
        ])

        for (const [fridge, fridgeName] of states) {
            for (const [freezer, freezerName] of states) {
                status[2 + 27] = fridge
                status[2 + 28] = freezer
                dev.processAABB(status)

                assert.equal(ha.devices[DEVICE_ID].properties.fridge_thermal_state, fridgeName)
                assert.equal(ha.devices[DEVICE_ID].properties.freezer_thermal_state, freezerName)
            }
        }
    })

    test('0x10EC thermal states come from the current block only', () => {
        const { ha, dev } = makeDevice()
        const status = Buffer.from(SAMPLE_DELTA_DOOR_OPEN_TO_CLOSED.subarray(2, -2))
        status[2 + 27] = 5
        status[2 + 28] = 2
        status[2 + 96 + 27] = 1
        status[2 + 96 + 28] = 3

        dev.processAABB(status)

        assert.equal(ha.devices[DEVICE_ID].properties.fridge_thermal_state, 'settled')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_thermal_state, 'disturbed')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', buf('001122'))

        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('door usage components expose cumulative counts and seconds', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const name of ['door_openings', 'door_time', 'freezer_openings', 'freezer_time']) {
            assert.equal(components[name].platform, 'sensor')
            assert.equal(components[name].state_class, 'total_increasing')
            assert.equal(components[name].unique_id, `$deviceid-${name}`)
            assert.equal(components[name].state_topic, `$this/${name}`)
        }
        for (const name of ['door_time', 'freezer_time']) {
            assert.equal(components[name].device_class, 'duration')
            assert.equal(components[name].unit_of_measurement, 's')
        }
        for (const name of ['door_openings', 'freezer_openings']) {
            assert.equal(components[name].device_class, undefined)
            assert.equal(components[name].unit_of_measurement, undefined)
        }
    })

    test('0x10C5 publishes cumulative door usage, not interval values', () => {
        const { ha, dev } = makeDevice()
        dev.processAABB(SAMPLE_DOOR_USAGE)

        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            door_openings: 10,
            door_time: 100,
            freezer_openings: 4,
            freezer_time: 50,
        })
    })

    test('0x10C5 repeated reports do not add to totals', (t) => {
        const { ha, dev } = makeDevice()
        const publish = t.mock.method(ha, 'publishProperty')

        for (let i = 0; i < 11; i++) dev.processAABB(SAMPLE_DOOR_USAGE)

        assert.equal(publish.mock.callCount(), 4)
        assert.equal(ha.devices[DEVICE_ID].properties.door_openings, 10)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_openings, 4)
    })

    test('0x10C5 preserves 24-bit totals across skipped reports and adapter recreation', () => {
        const first = makeDevice()
        first.dev.processAABB(SAMPLE_DOOR_USAGE)

        const next = Buffer.from(SAMPLE_DOOR_USAGE)
        next[2] = 47
        next.writeUIntBE(0x010203, 7, 3)
        next.writeUIntBE(0x020304, 13, 3)
        next.writeUIntBE(0x030405, 19, 3)
        next.writeUIntBE(0x040506, 25, 3)
        first.dev.processAABB(next)

        const restarted = makeDevice()
        restarted.dev.processAABB(next)

        const expected = {
            door_openings: 0x010203,
            door_time: 0x030405,
            freezer_openings: 0x010101,
            freezer_time: 0x010101,
        }
        assert.deepEqual(first.ha.devices[DEVICE_ID].properties, expected)
        assert.deepEqual(restarted.ha.devices[DEVICE_ID].properties, expected)
    })

    test('0x10C5 publishes the appliance accounting-window reset', () => {
        const { ha, dev } = makeDevice()
        dev.processAABB(SAMPLE_DOOR_USAGE)

        const reset = Buffer.from(SAMPLE_DOOR_USAGE)
        reset[2] = 96
        for (const offset of [5, 11, 17, 23]) reset.fill(0, offset, offset + 5)
        dev.processAABB(reset)

        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            door_openings: 0,
            door_time: 0,
            freezer_openings: 0,
            freezer_time: 0,
        })
    })

    test('0x10C5 publishes freezer differences without adjusting decreases or negative values', () => {
        const { ha, dev } = makeDevice()
        dev.processAABB(SAMPLE_DOOR_USAGE)

        const next = Buffer.from(SAMPLE_DOOR_USAGE)
        next.writeUIntBE(11, 7, 3)
        dev.processAABB(next)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_openings, 3)

        next.writeUIntBE(15, 7, 3)
        next.writeUIntBE(151, 19, 3)
        dev.processAABB(next)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_openings, -1)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_time, -1)
    })

    test('0x10C5 ignores incomplete or unsupported record layouts', () => {
        const { ha, dev } = makeDevice()
        for (let length = 0; length < SAMPLE_DOOR_USAGE.length; length++) {
            dev.processAABB(SAMPLE_DOOR_USAGE.subarray(0, length))
        }
        dev.processAABB(Buffer.concat([SAMPLE_DOOR_USAGE, Buffer.from([0])]))
        for (const offset of [0, 1, 3, 4, 10, 16, 22]) {
            const invalid = Buffer.from(SAMPLE_DOOR_USAGE)
            invalid[offset] = 0xff
            dev.processAABB(invalid)
        }

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
