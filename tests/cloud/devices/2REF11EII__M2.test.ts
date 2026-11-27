import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EII__M2'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF11EII__M2'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REF11EII__M2', swVersion: '1.0' }

// Bytes were captured from a live 2REF11EII__M2 unit (US, using degF), via playing around
// with the app.

// Ice Plus off: cur[3] 2 -> 1. Baseline fridge raw 12 = 35 degF, freezer raw 8 = 0 degF.
const SAMPLE_DELTA_EXPRESS_OFF = buf('AA1810EC020C08020202040000020C08010202040000A8BB')

// Fridge setpoint 35 degF -> 36 degF in the app: cur[1] 12 -> 11.
const SAMPLE_DELTA_FRIDGE_36F = buf('AA1810EC020C08010202040000020B08010202040000AEBB')

// Sample cloud commands for setting things
const CLOUD_CMD_EXPRESS_OFF = buf(
    'AA2FF017FFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEBBB',
)
const CLOUD_CMD_FRIDGE_36F = buf(
    'AA2FF017FF0BFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9CBB',
)

// Freezer 0 degF -> -3 degF
const SAMPLE_DELTA_FREEZER_M3F = buf('AA1810EC020B08010202040000020B0B010202040000A8BB')
const CLOUD_CMD_FREEZER_M3F = buf(
    'AA2FF017FFFF0BFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9CBB',
)

// Freezer setpoint back to 0 degF.
const CLOUD_CMD_FREEZER_0F = buf(
    'AA2FF017FFFF08FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF93BB',
)

// Turning on the fresh air filter from the app.
const SAMPLE_DELTA_FRESH_AIR_POWER = buf('AA1810EC020B08010202040000020B08010302040000AEBB')
const CLOUD_CMD_FRESH_AIR_POWER = buf(
    'AA2FF017FFFFFFFF03FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF95BB',
)

// Turning off (auto?) the fresh air filter from the app.
const SAMPLE_DELTA_FRESH_AIR_AUTO = buf('AA1810EC020B08010302040000020B08010202040000AEBB')
const CLOUD_CMD_FRESH_AIR_AUTO = buf(
    'AA2FF017FFFFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEABB',
)

// Turning off smart grid mode from the app
const SAMPLE_DELTA_SMART_GRID_OFF = buf('AA1810EC020B08010202040000020B08010200040000ADBB')
const CLOUD_CMD_SMART_GRID_OFF = buf(
    'AA2FF017FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFE8BB',
)

// Turning on smart grid mode via the fridge itself.
const SAMPLE_DELTA_SMART_GRID_PEAK = buf('AA1810EC020C08010200040000020C08010203040000AEBB')

// Turning on smart grid mode via the app.
const SAMPLE_DELTA_SMART_GRID_SEASONAL = buf('AA1810EC020B08010200040000020B08010202040000ADBB')
const CLOUD_CMD_SMART_GRID_SEASONAL = buf(
    'AA2FF017FFFFFFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEABB',
)

// Door open/close.
const SAMPLE_DELTA_DOOR_OPEN = buf('AA1810EC020B08010202040000020B08010202040100AEBB')
const SAMPLE_DELTA_DOOR_CLOSED = buf('AA1810EC020B08010202040100020B08010202040000AEBB')

// Door events
const FRIDGE_DOOR_OPEN = buf('AA0810A8010139BB')
const FRIDGE_DOOR_CLOSED = buf('AA0810A801003EBB')
const FREEZER_DOOR_OPEN = buf('AA0810A8020138BB')
const FREEZER_DOOR_CLOSED = buf('AA0810A8020039BB')

// Changing to celsius
const SAMPLE_DELTA_CELSIUS = buf('AA1810EC020B08010202040000020C09010202040001A8BB')

// Reconnect handshake.
const CLOUD_CMD_START_QUERY = buf('AA0EF0ED1211010000010400EBBB')
const SAMPLE_INITIAL = buf('AA0F10EB020C0801020204000086BB')

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

    test('10EB initial status is a single 9-byte block', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fridge_setpoint, 35) // raw 12
        assert.equal(props.freezer_setpoint, 0) // raw 8
        assert.equal(props.express_freeze, 'OFF') // raw 1
        assert.equal(props.fresh_air_filter, 'Auto') // raw 2
        assert.equal(props.water_filter, 'OFF') // raw 4, replacement starts at 6
        assert.equal(props.water_filter_months, 4)
        assert.equal(props.fresh_air_filter_replace, 'OFF') // raw 2 = Auto
        assert.equal(props.smart_grid, 'Seasonal Energy Saver') // raw 2
        assert.equal(props.fridge_door, 'OFF') // all closed
        assert.equal(props.freezer_door, 'OFF')
    })

    test('Fahrenheit config comes from the model-JSON tables, not a linear range', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')
        assert.equal(components.fridge_setpoint.min, 33)
        assert.equal(components.fridge_setpoint.max, 46)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°F')
        assert.equal(components.freezer_setpoint.min, -6)
        assert.equal(components.freezer_setpoint.max, 8)
        assert.deepEqual(components.fresh_air_filter.options, ['Auto', 'Power'], 'only the settable modes')
        assert.equal(components.water_filter.device_class, 'problem')
        assert.equal(components.fresh_air_filter_replace.device_class, 'problem')
        assert.equal(components.flex_setpoint, undefined, 'no flex drawer on this model')
    })

    test('baseline state decodes to the values the LG app showed (35°F / 0°F)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)

        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fridge_setpoint, 35) // raw 12
        assert.equal(props.freezer_setpoint, 0) // raw 8
        assert.equal(props.express_freeze, 'OFF') // raw 1
        assert.equal(props.fridge_door, 'OFF')
        assert.equal(props.freezer_door, 'OFF')
    })

    test('fridge setpoint transition 35°F -> 36°F', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_36F)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 36) // raw 11
    })

    // No test for express_freeze reading back as ON: Ice Plus was only ever switched off
    // while capturing, so its ON code appears solely in a `prev` half, which is ignored.

    test("the status block's door-open flag doesn't say which door, so it changes nothing", () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, undefined)

        thinq.emit('data', FRIDGE_DOOR_OPEN)
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'ON', 'not clobbered')
    })

    test('10A8 events give per-compartment door state', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', FREEZER_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, undefined, 'fridge untouched')

        thinq.emit('data', FREEZER_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')

        thinq.emit('data', FRIDGE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')

        thinq.emit('data', FRIDGE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'OFF')
    })

    test("the status block's all-closed flag resynchronises per-compartment state", () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', FRIDGE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'ON')

        thinq.emit('data', SAMPLE_DELTA_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door, 'OFF')
    })

    // No test for an unknown 10A8 compartment: this appliance has no third compartment to
    // produce one.

    test('switching the panel to Celsius reports the same temperatures in the other unit', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF) // °F: 35°F / 0°F
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_36F) // °F: 36°F
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 36)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, 0)

        thinq.emit('data', SAMPLE_DELTA_CELSIUS)

        const dev = ha.devices[DEVICE_ID]
        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 8)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -21)
        assert.equal(components.freezer_setpoint.max, -13)

        assert.equal(dev.properties.fridge_setpoint, 2) // FRIDGE_C raw 12
        assert.equal(dev.properties.freezer_setpoint, -18) // FREEZER_C raw 9
    })

    // Both replacement states were confirmed by injection ([4]=4, [6]=6), not capture: [6] is a
    // month timer that reads 4 in every packet, and [4] never reported 4 on its own.
    //
    // Also untested, for want of real packets: a temperature raw with no code in the
    // active table (the appliance rescales rather than emit one), and an over-length
    // status block (none exists - see the 10EB above).

    test('HA write fridge_setpoint=36°F reproduces the cloud command byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF) // establish °F
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '36')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FRIDGE_36F))
    })

    test('HA write express_freeze=OFF reproduces the cloud command byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_EXPRESS_OFF))
    })

    test('freezer setpoint transition 0°F -> -3°F (linear formula would say -5°F)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FREEZER_M3F)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -3) // raw 11
    })

    test('HA write freezer_setpoint=-3°F reproduces the cloud command byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF) // establish °F
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-3')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FREEZER_M3F))
    })

    test('10AF telemetry and 10AB diagnostics are ignored without warnings', () => {
        const { ha, thinq } = makeDevice()
        const warnings: unknown[] = []
        const original = console.warn
        console.warn = (...args: unknown[]) => warnings.push(args)
        try {
            thinq.emit('data', buf('AA0B10AF2700130B0894BB'))
            thinq.emit('data', buf('AA06F014E1BB'))
        } finally {
            console.warn = original
        }
        assert.deepEqual(warnings, [], 'non-status frames must not warn')
        assert.equal(ha.devices[DEVICE_ID]?.config, undefined)
    })

    test('HA write freezer_setpoint=0°F reproduces the cloud command byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '0')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FREEZER_0F))
    })

    test('fresh air filter transition Auto -> Power', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRESH_AIR_POWER)
        assert.equal(ha.devices[DEVICE_ID].properties.fresh_air_filter, 'Power') // raw 3
        assert.equal(ha.devices[DEVICE_ID].properties.fresh_air_filter_replace, 'OFF')
    })

    test('HA write fresh_air_filter=Power reproduces the cloud command byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.resetRecorder()

        dev.setProperty('fresh_air_filter', 'Power')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FRESH_AIR_POWER))
    })

    test('the app\'s fresh-air "off" is really Auto', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRESH_AIR_AUTO)
        assert.equal(ha.devices[DEVICE_ID].properties.fresh_air_filter, 'Auto') // raw 2

        thinq.resetRecorder()
        dev.setProperty('fresh_air_filter', 'Auto')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_FRESH_AIR_AUTO))
    })

    test('fresh air filter mode holds its last value through Off and Replace', () => {
        // Synthetic: no captured packet reports [4]=1 or [4]=4 (see the note above), so these
        // are the Power capture with only cur[4] changed.
        const withFreshAir = (code: number) => {
            const inner = Buffer.from('10EC020B08010302040000020B08010302040000', 'hex')
            inner[2 + 9 + 4] = code
            return AABBDevice.frame(inner)
        }
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_DELTA_FRESH_AIR_POWER)
        assert.equal(props().fresh_air_filter, 'Power')

        thinq.emit('data', withFreshAir(4))
        assert.equal(props().fresh_air_filter, 'Power', 'Replace is not a mode')
        assert.equal(props().fresh_air_filter_replace, 'ON')

        thinq.emit('data', withFreshAir(1))
        assert.equal(props().fresh_air_filter, 'Power', 'Off is not a mode')
        assert.equal(props().fresh_air_filter_replace, 'OFF')
    })

    test('smart grid decodes the three usable modes, not the model JSON enum codes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF) // cur[5] = 2
        assert.equal(ha.devices[DEVICE_ID].properties.smart_grid, 'Seasonal Energy Saver')

        thinq.emit('data', SAMPLE_DELTA_SMART_GRID_OFF) // cur[5] = 0
        assert.equal(ha.devices[DEVICE_ID].properties.smart_grid, 'Not In Use')

        thinq.emit('data', SAMPLE_DELTA_SMART_GRID_SEASONAL) // cur[5] = 2
        assert.equal(ha.devices[DEVICE_ID].properties.smart_grid, 'Seasonal Energy Saver')

        thinq.emit('data', SAMPLE_DELTA_SMART_GRID_PEAK) // cur[5] = 3
        assert.equal(ha.devices[DEVICE_ID].properties.smart_grid, 'Peak Energy Saver')
    })

    test('HA write smart_grid reproduces both captured cloud commands byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)

        thinq.resetRecorder()
        dev.setProperty('smart_grid', 'Not In Use')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_SMART_GRID_OFF))

        thinq.resetRecorder()
        dev.setProperty('smart_grid', 'Seasonal Energy Saver')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_SMART_GRID_SEASONAL))
    })

    test('fresh air filter states the appliance only reports are refused as writes', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.resetRecorder()

        const original = console.warn
        console.warn = () => {}
        try {
            // reported states, not settings: a toDevice write of Off was acked and ignored
            dev.setProperty('fresh_air_filter', 'Replace filter')
            dev.setProperty('fresh_air_filter', 'Off')
        } finally {
            console.warn = original
        }
        assert.equal(thinq.outbox.length, 0)
    })

    test('a Fahrenheit freezer value with no code is refused, not approximated', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.resetRecorder()

        const original = console.warn
        console.warn = () => {}
        try {
            dev.setProperty('freezer_setpoint', '7') // FREEZER_F jumps 8 -> 6
        } finally {
            console.warn = original
        }
        assert.equal(thinq.outbox.length, 0)
    })

    test('an unknown property is ignored', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        thinq.resetRecorder()

        const original = console.warn
        console.warn = () => {}
        try {
            dev.setProperty('does-not-exist', '1')
        } finally {
            console.warn = original
        }
        assert.equal(thinq.outbox.length, 0)
    })
})
