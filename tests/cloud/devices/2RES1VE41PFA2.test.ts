import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2RES1VE41PFA2'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2RES1VE41PFA2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.03' }

// Frames captured from a live 2RES1VE41PFA2 (US, using degF) while operating it through the LG
// app, bridged through rethink. The status block is 27 bytes, the common fridge layout.

// Reconnect handshake, and the long form of the same command the sibling fridges send.
const CLOUD_CMD_START_QUERY = buf('AA0EF0ED1211010000010400EBBB')

// No 10EB was captured from this unit (it only reports on change); this is the captured closed-door
// block in the 10EB single-record form, framed like the device frames its own status.
const SAMPLE_INITIAL = AABBDevice.frame(buf('10EB0207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF0101'))

// Door toggles. Only [7] (any door open) moves; the per-door 10A8 events carry the detail.
const SAMPLE_DELTA_DOOR_OPEN = buf(
    'AA3C10EC0207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF01010207070107020501000001FFFFFF00FF0001FFFFFFFFFFFFFF010146BB',
)
const SAMPLE_DELTA_DOOR_CLOSED = buf(
    'AA3C10EC0207070107020501000001FFFFFF00FF0001FFFFFFFFFFFFFF01010207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF010146BB',
)

// Express freeze on then off: [3] 01 -> 02 -> 01.
const SAMPLE_DELTA_EXPRESS_ON = buf(
    'AA3C10EC0207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF01010207070207020500000001FFFFFF00FF0001FFFFFFFFFFFFFF010146BB',
)
const SAMPLE_DELTA_EXPRESS_OFF = buf(
    'AA3C10EC0207070207020500000001FFFFFF00FF0001FFFFFFFFFFFFFF01010207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF010146BB',
)

// Fridge setpoint 37 -> 36 -> 37 degF: [1] 07 -> 08 -> 07.
const SAMPLE_DELTA_FRIDGE_36F = buf(
    'AA3C10EC0207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF01010208070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF010146BB',
)
const SAMPLE_DELTA_FRIDGE_37F = buf(
    'AA3C10EC0208070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF01010207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF010146BB',
)

// Per-compartment door events: 1 = fridge, 2 = freezer.
const FRIDGE_DOOR_OPEN = buf('AA0810A8010139BB')
const FRIDGE_DOOR_CLOSED = buf('AA0810A801003EBB')
const FREEZER_DOOR_OPEN = buf('AA0810A8020138BB')
const FREEZER_DOOR_CLOSED = buf('AA0810A8020039BB')

// Captured cloud commands.
const CLOUD_CMD_EXPRESS_ON = buf(
    'AA2FF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEABB',
)
const CLOUD_CMD_EXPRESS_OFF = buf(
    'AA2FF017FFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEBBB',
)
const CLOUD_CMD_FRIDGE_36F = buf(
    'AA2FF017FF08FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF93BB',
)
const CLOUD_CMD_FRIDGE_37F = buf(
    'AA2FF017FF07FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF90BB',
)

// The freezer setpoint write was not captured (only the fridge one was); it is the same command
// with the value in [2] instead of [1], which is what the sibling fridges send. Kept as a test so a
// future capture that disproves the symmetry fails loudly.
const CLOUD_CMD_FREEZER_M1F = buf(
    'AA2FF017FFFF07FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF90BB',
)

// A status block the unit never emitted, built by changing only the fields under test.
function statusFrame(fields: Record<number, number>): Buffer {
    const block = buf('0207070107020500000001FFFFFF00FF0001FFFFFFFFFFFFFF0101')
    for (const [index, value] of Object.entries(fields)) block[Number(index)] = value
    return AABBDevice.frame(Buffer.concat([buf('10EB'), block]))
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('no config until a status packet reveals the temperature unit', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID]?.config, undefined)
    })

    test('start() reproduces the query the cloud sends on reconnect', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_START_QUERY))
    })

    test('the 27-byte status block decodes to the values the LG app showed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fridge_setpoint, 37) // raw 7
        assert.equal(props.freezer_setpoint, -1) // raw 7
        assert.equal(props.express_freeze, 'OFF') // raw 1
        assert.equal(props.sabbath, 'OFF') // raw 0
        assert.equal(props.water_filter_months, 5) // raw 5
        assert.equal(props.water_filter, 'OFF') // replacement starts at 6
        assert.equal(props.fridge_door, 'OFF') // all closed
        assert.equal(props.freezer_door, 'OFF')
    })

    test('config exposes only the controls confirmed on this model', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')
        assert.equal(components.fridge_setpoint.min, 33)
        assert.equal(components.fridge_setpoint.max, 43)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°F')
        assert.equal(components.freezer_setpoint.min, -7)
        assert.equal(components.freezer_setpoint.max, 5)
        assert.equal(components.water_filter.device_class, 'problem')
        assert.equal(components.sabbath.state_topic, '$this/sabbath')
        assert.equal(components.display_lock, undefined, 'the appliance has no display to lock')
        assert.equal(components.fresh_air_filter, undefined, '[4] reads 7, outside the model JSON enum')
        assert.equal(components.express_cool, undefined)
        assert.equal(components.craft_ice, undefined)
    })

    test('express freeze transitions on and off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON') // raw 2

        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF') // raw 1
    })

    test('fridge setpoint transitions 37°F -> 36°F -> 37°F', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_36F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 36) // raw 8

        thinq.emit('data', SAMPLE_DELTA_FRIDGE_37F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 37) // raw 7
    })

    test('10A8 events give per-compartment door state', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', FRIDGE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, undefined, 'freezer untouched')

        thinq.emit('data', FRIDGE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'OFF')

        thinq.emit('data', FREEZER_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'ON')

        thinq.emit('data', FREEZER_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')
    })

    test("the status block's all-closed flag resynchronises per-compartment state", () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', FRIDGE_DOOR_OPEN)
        thinq.emit('data', SAMPLE_DELTA_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')
    })

    test('the status block no longer says which door is open, so it leaves 10A8 state alone', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', FRIDGE_DOOR_CLOSED)
        thinq.emit('data', FREEZER_DOOR_CLOSED)
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'OFF', 'not clobbered')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')
    })

    test('switching the unit to Celsius reports the same setpoints in °C', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL) // °F: 37 / -1
        thinq.emit('data', statusFrame({ 1: 2, 2: 7, 8: 1 })) // °C: 8-2 = 6, -14-7 = -21

        const dev = ha.devices[DEVICE_ID]
        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)

        assert.equal(dev.properties.fridge_setpoint, 6)
        assert.equal(dev.properties.freezer_setpoint, -21)
    })

    test('the water filter health follows the month counter', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', statusFrame({ 6: 5 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 5)

        thinq.emit('data', statusFrame({ 6: 6 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 6)
    })

    test('HA write express_freeze reproduces both captured cloud commands byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_EXPRESS_ON))

        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'OFF')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_EXPRESS_OFF))
    })

    test('HA write fridge_setpoint reproduces the captured cloud commands byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        thinq.resetRecorder()
        dev.setProperty('fridge_setpoint', '36')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FRIDGE_36F))

        thinq.resetRecorder()
        dev.setProperty('fridge_setpoint', '37')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FRIDGE_37F))
    })

    test('HA write freezer_setpoint uses the same command layout as the fridge one', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        thinq.resetRecorder()
        dev.setProperty('freezer_setpoint', '-1')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FREEZER_M1F))
    })

    test('an unknown property is ignored', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        thinq.resetRecorder()

        const original = console.warn
        console.warn = () => {}
        try {
            dev.setProperty('display_lock', 'ON')
        } finally {
            console.warn = original
        }
        assert.equal(thinq.outbox.length, 0)
    })

    test('non-status frames are ignored without warnings', () => {
        const { ha, thinq } = makeDevice()
        const warnings: unknown[] = []
        const original = console.warn
        console.warn = (...args: unknown[]) => warnings.push(args)
        try {
            thinq.emit('data', buf('AA0910AF0F001ACEBB')) // 15-minute energy record
            thinq.emit('data', buf('AA13107200010A000000000000000000001FBB')) // 1072
        } finally {
            console.warn = original
        }
        assert.deepEqual(warnings, [], 'non-status frames must not warn')
        assert.equal(ha.devices[DEVICE_ID]?.config, undefined)
    })
})
