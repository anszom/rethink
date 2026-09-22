import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REFTBDII4P_U'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REFTBDII4P_U'
const META: Metadata = {
    modelId: MODEL_ID,
    modelName: MODEL_ID,
    swVersion: '1.0',
}

// Real packets captured from the appliance while bridged to the LG cloud.
// LG's decoded MQTT notifications confirmed every label.
const SAMPLE_DOOR_OPEN = buf(
    'AA8E10EC0207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000207040102FF0201010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000EABB',
)
const SAMPLE_DOOR_CLOSED = buf(
    'AA8E10EC0207040102FF0201010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000EABB',
)
const SAMPLE_EXPRESS_ON = buf(
    'AA8E10EC0207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000207040202FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000EABB',
)
const SAMPLE_FRIDGE_2C = buf(
    'AA8E10EC0207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000206040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000E8BB',
)
const SAMPLE_FREEZER_MINUS_17C = buf(
    'AA8E10EC0207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000207030102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000E8BB',
)
const SAMPLE_ICE_FULL = buf(
    'AA8E10EC0207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000001FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000207040102FF0200010001FFFFFFFFFFFF00FFFFFFFFFFFFFFFF620101FF000002FFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000EABB',
)

const COMMAND_FRIDGE_2C =
    'AA7CF017FF06FFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA4BB'
const COMMAND_FREEZER_MINUS_17C =
    'AA7CF017FFFF03FFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBBBB'
const COMMAND_EXPRESS_ON =
    'AA7CF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('configuration waits for a status packet to establish the temperature unit', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('captured door-open packet publishes the complete Celsius state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_OPEN)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device?.config)
        const components = device.config.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
        assert.deepEqual(components.ice_maker_status.options, ['Off', 'Making ice', 'Full', 'Quiet mode'])
        assert.deepEqual(components.fresh_air_filter_status.options, ['Good', 'Replace'])
        assert.deepEqual(components.water_filter_status.options, ['Good', 'Replace'])
        assert.deepEqual(components.fridge_temperature_status.options, [
            'Off',
            'Well maintained',
            'Very high',
            'High',
            'Low',
            'Stabilizing',
            'Sensor error',
            'Uncertain',
        ])
        assert.deepEqual(components.freezer_temperature_status.options, components.fridge_temperature_status.options)
        assert.equal(components.water_filter_months.unit_of_measurement, 'months')
        assert.equal(components.night_view, undefined)
        assert.equal(components.quiet_time, undefined)
        assert.equal(components.smart_learner, undefined)

        assert.equal(device.properties.fridge_setpoint, 1)
        assert.equal(device.properties.freezer_setpoint, -18)
        assert.equal(device.properties.door, 'ON')
        assert.equal(device.properties.express_freeze, 'OFF')
        assert.equal(device.properties.ice_maker_status, 'Making ice')
        assert.equal(device.properties.fresh_air_filter_status, 'Good')
        assert.equal(device.properties.water_filter_status, 'Good')
        assert.equal(device.properties.water_filter_months, 2)
        assert.equal(device.properties.fridge_temperature_status, 'Well maintained')
        assert.equal(device.properties.freezer_temperature_status, 'Well maintained')
    })

    test('captured door-close packet publishes door=OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('captured Express Freeze packet publishes ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EXPRESS_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
    })

    test('captured temperature packets decode their LG-cloud-confirmed values', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_FRIDGE_2C)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 2)

        thinq.emit('data', SAMPLE_FREEZER_MINUS_17C)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -17)
    })

    test('captured ice-maker transition publishes Full', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ICE_FULL)
        assert.equal(ha.devices[DEVICE_ID].properties.ice_maker_status, 'Full')
    })

    test('modelJSON replacement thresholds publish Replace', () => {
        const { ha, dev } = makeDevice()
        const status = Buffer.alloc(68, 0xff)
        status[4] = 3
        status[6] = 6
        status[8] = 1
        dev.processStatus(status)

        assert.equal(ha.devices[DEVICE_ID].properties.fresh_air_filter_status, 'Replace')
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_status, 'Replace')
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 6)
    })

    test('frames with unrecognised shapes are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('start requests a complete status snapshot', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA fridge-temperature write reproduces the captured LG command', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        thinq.resetRecorder()
        dev.setProperty('fridge_setpoint', '2')
        assert.equal(hex(thinq.outbox[0]), COMMAND_FRIDGE_2C)
    })

    test('HA freezer-temperature write reproduces the captured LG command', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        thinq.resetRecorder()
        dev.setProperty('freezer_setpoint', '-17')
        assert.equal(hex(thinq.outbox[0]), COMMAND_FREEZER_MINUS_17C)
    })

    test('HA Express Freeze write reproduces the captured LG command', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'ON')
        assert.equal(hex(thinq.outbox[0]), COMMAND_EXPRESS_ON)
    })

    test('unknown HA writes send no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
