import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF12EJDD__2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF12EJDD__2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: 'clip_hna_v1.9.230' }

// Real packets captured from an LG LRFDS3006D. Panel changes were checked against the physical
// display. App writes were captured while bridged, then the same commands were verified locally
// with the bridge disabled.

// Reconnect handshake and initial Fahrenheit status: fridge 36°F, freezer -4°F, Ice Plus off,
// Smart Grid not in use, both filters healthy, and all doors closed.
const CLOUD_CMD_START_QUERY = buf('AA0EF0ED1211010000010400EBBB')
const SAMPLE_INITIAL_FAHRENHEIT = buf('AA1810EB02080A01020002000000FFFFFFFF00FFFF0085BB')

// Aggregate door status changed closed -> open -> closed.
const SAMPLE_DELTA_DOOR_OPEN = buf(
    'AA2A10EC02080A01020002000000FFFFFFFF00FFFF0002080A01020002010000FFFFFFFF00FFFF00A2BB',
)
const SAMPLE_DELTA_DOOR_CLOSED = buf(
    'AA2A10EC02080A01020002010000FFFFFFFF00FFFF0002080A01020002000000FFFFFFFF00FFFF00A2BB',
)

// Ice Plus was toggled off -> on -> off at the panel. Smart Grid was Seasonal in these captures.
const SAMPLE_INITIAL_SEASONAL = buf('AA1810EB02080A01020202000000FFFFFFFF00FFFF0087BB')
const SAMPLE_DELTA_EXPRESS_ON = buf(
    'AA2A10EC02080A01020202000000FFFFFFFF00FFFF0002080A02020202000000FFFFFFFF00FFFF00AEBB',
)
const SAMPLE_DELTA_EXPRESS_OFF = buf(
    'AA2A10EC02080A02020202000000FFFFFFFF00FFFF0002080A01020202000000FFFFFFFF00FFFF00AEBB',
)

// Smart Grid changed Seasonal -> Not In Use -> Seasonal at the panel.
const SAMPLE_DELTA_SMART_GRID_OFF = buf(
    'AA2A10EC02080A01020202000000FFFFFFFF00FFFF0002080A01020002000000FFFFFFFF00FFFF00ADBB',
)
const SAMPLE_DELTA_SMART_GRID_SEASONAL = buf(
    'AA2A10EC02080A01020002000000FFFFFFFF00FFFF0002080A01020202000000FFFFFFFF00FFFF00ADBB',
)

// Sabbath mode on, captured after enabling it from ThinQ.
const SAMPLE_SABBATH_ON = buf('AA1810EB02080A01020202000000FFFFFFFF01FFFF0086BB')

const CLOUD_CMD_EXPRESS_ON = buf(
    'AA2FF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEABB',
)
const CLOUD_CMD_EXPRESS_OFF = buf(
    'AA2FF017FFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEBBB',
)
const CLOUD_CMD_FRIDGE_37F = buf(
    'AA2FF017FF07FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF90BB',
)
const CLOUD_CMD_FRIDGE_36F = buf(
    'AA2FF017FF08FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF93BB',
)
const CLOUD_CMD_FREEZER_M3F = buf(
    'AA2FF017FFFF09FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF92BB',
)
const CLOUD_CMD_FREEZER_M4F = buf(
    'AA2FF017FFFF0AFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9DBB',
)
const CLOUD_CMD_SABBATH_ON = buf(
    'AA2FF017FFFFFFFFFFFFFFFFFFFFFFFFFFFF01FFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEBBB',
)
const CLOUD_CMD_SABBATH_OFF = buf(
    'AA2FF017FFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFE8BB',
)
const CLOUD_CMD_SMART_GRID_OFF = buf(
    'AA2FF017FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFE8BB',
)
const CLOUD_CMD_SMART_GRID_SEASONAL = buf(
    'AA2FF017FFFFFFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEABB',
)

// Celsius round trips, all verified locally with the bridge disabled.
const SAMPLE_INITIAL_CELSIUS = buf('AA1810EB02090A01020202000100FFFFFFFF00FFFF0081BB')
const SAMPLE_FRIDGE_3C = buf('AA1810EB02070A01020202000100FFFFFFFF00FFFF0087BB')
const SAMPLE_FRIDGE_2C = SAMPLE_INITIAL_CELSIUS
const SAMPLE_FREEZER_M19C = buf('AA1810EB02090901020202000100FFFFFFFF00FFFF0086BB')
const SAMPLE_FREEZER_M20C = SAMPLE_INITIAL_CELSIUS
const SAMPLE_FREEZER_M22C = buf('AA1810EB02090C01020202000100FFFFFFFF00FFFF0083BB')
const SAMPLE_FREEZER_M23C = buf('AA1810EB02090D01020202000100FFFFFFFF00FFFF0082BB')

const CLOUD_CMD_FRIDGE_3C = buf(
    'AA2FF017FF07FFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF93BB',
)
const CLOUD_CMD_FRIDGE_2C = buf(
    'AA2FF017FF09FFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9DBB',
)
const CLOUD_CMD_FREEZER_M19C = buf(
    'AA2FF017FFFF09FFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9DBB',
)
const CLOUD_CMD_FREEZER_M20C = buf(
    'AA2FF017FFFF0AFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9CBB',
)
const CLOUD_CMD_FREEZER_M22C = buf(
    'AA2FF017FFFF0CFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF9EBB',
)
const CLOUD_CMD_FREEZER_M23C = buf(
    'AA2FF017FFFF0DFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF99BB',
)

// Captured during the automatic-ack comparison. The cloud-style acknowledgment stops the fridge
// from retransmitting this 10AF telemetry packet.
const SAMPLE_TELEMETRY = buf('AA0B10AFFA00D0080A05BB')
const CLOUD_ACK_TELEMETRY = 'AA08F000AF0400BB'

// Consecutive 15-minute energy reports captured from the physical refrigerator. ThinQ showed
// 36 + 37 = 73 Wh for 12:00-1:00 PM and 36 Wh for 1:00-2:00 PM, matching these values exactly.
const ENERGY_36_WH = buf('AA0B10AF0F00240A0AEEBB')
const ENERGY_37_WH = buf('AA0B10AF0E00250A0AEEBB')
const ENERGY_NEXT_HOUR_36_WH = buf('AA0B10AF0E00240A0AEFBB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function props(ha: MockHAConnection) {
    return ha.devices[DEVICE_ID].properties
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

    test('10EB initial status publishes Fahrenheit config and baseline state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_FAHRENHEIT)

        const device = ha.devices[DEVICE_ID]
        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')
        assert.equal(components.fridge_setpoint.min, 33)
        assert.equal(components.fridge_setpoint.max, 43)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°F')
        assert.equal(components.freezer_setpoint.min, -7)
        assert.equal(components.freezer_setpoint.max, 5)
        assert.equal(components.fridge_setpoint.command_topic, '$this/fridge_setpoint/set')
        assert.equal(components.express_freeze.platform, 'switch')
        assert.equal(components.smart_grid.platform, 'select')
        assert.equal(components.energy.platform, 'sensor')
        assert.equal(components.energy.device_class, 'energy')
        assert.equal(components.energy.unit_of_measurement, 'Wh')
        assert.equal(components.energy.state_class, 'total_increasing')
        assert.deepEqual(components.smart_grid.options, ['Not In Use', 'Seasonal Energy Saver', 'Peak Energy Saver'])

        assert.equal(device.properties.fridge_setpoint, 36)
        assert.equal(device.properties.freezer_setpoint, -4)
        assert.equal(device.properties.express_freeze, 'OFF')
        assert.equal(device.properties.smart_grid, 'Not In Use')
        assert.equal(device.properties.fresh_air_filter_replace, 'OFF')
        assert.equal(device.properties.water_filter, 'OFF')
        assert.equal(device.properties.water_filter_months, 2)
        assert.equal(device.properties.door, 'OFF')
        assert.equal(device.properties.sabbath_mode, 'OFF')
    })

    test('captured aggregate door transition publishes open then closed', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(props(ha).door, 'ON')

        thinq.emit('data', SAMPLE_DELTA_DOOR_CLOSED)
        assert.equal(props(ha).door, 'OFF')
    })

    test('captured Ice Plus transitions publish on then off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_SEASONAL)
        assert.equal(props(ha).express_freeze, 'OFF')

        thinq.emit('data', SAMPLE_DELTA_EXPRESS_ON)
        assert.equal(props(ha).express_freeze, 'ON')

        thinq.emit('data', SAMPLE_DELTA_EXPRESS_OFF)
        assert.equal(props(ha).express_freeze, 'OFF')
    })

    test('captured Smart Grid transitions publish disabled then Seasonal', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_SEASONAL)
        assert.equal(props(ha).smart_grid, 'Seasonal Energy Saver')

        thinq.emit('data', SAMPLE_DELTA_SMART_GRID_OFF)
        assert.equal(props(ha).smart_grid, 'Not In Use')

        thinq.emit('data', SAMPLE_DELTA_SMART_GRID_SEASONAL)
        assert.equal(props(ha).smart_grid, 'Seasonal Energy Saver')
    })

    test('captured Sabbath status publishes on', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SABBATH_ON)
        assert.equal(props(ha).sabbath_mode, 'ON')
    })

    test('model-derived filter thresholds publish replacement state and clear unknown age', () => {
        const { ha, dev } = makeDevice()
        const status = Buffer.from('02080A01020002000000FFFFFFFF00FFFF00', 'hex')
        const cases = [
            [0, 0, 'OFF', 'OFF', 0],
            [1, 5, 'OFF', 'OFF', 5],
            [3, 6, 'ON', 'ON', 6],
            [4, 12, 'OFF', 'ON', 12],
            [255, 255, 'OFF', 'None', 'None'],
        ] as const

        for (const [air, water, airDue, waterDue, age] of cases) {
            status[4] = air
            status[6] = water
            dev.processStatus(status)
            assert.equal(props(ha).fresh_air_filter_replace, airDue)
            assert.equal(props(ha).water_filter, waterDue)
            assert.equal(props(ha).water_filter_months, age)
        }
    })

    test('Ice Plus writes reproduce the captured commands byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_FAHRENHEIT)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_EXPRESS_ON))

        thinq.resetRecorder()
        dev.setProperty('express_freeze', 'OFF')
        assert.equal(hex(thinq.outbox[0]), hex(CLOUD_CMD_EXPRESS_OFF))
    })

    test('Fahrenheit, Sabbath and Smart Grid writes reproduce captured commands byte-for-byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_FAHRENHEIT)

        const cases: [string, string, Buffer][] = [
            ['fridge_setpoint', '37', CLOUD_CMD_FRIDGE_37F],
            ['fridge_setpoint', '36', CLOUD_CMD_FRIDGE_36F],
            ['freezer_setpoint', '-3', CLOUD_CMD_FREEZER_M3F],
            ['freezer_setpoint', '-4', CLOUD_CMD_FREEZER_M4F],
            ['sabbath_mode', 'ON', CLOUD_CMD_SABBATH_ON],
            ['sabbath_mode', 'OFF', CLOUD_CMD_SABBATH_OFF],
            ['smart_grid', 'Not In Use', CLOUD_CMD_SMART_GRID_OFF],
            ['smart_grid', 'Seasonal Energy Saver', CLOUD_CMD_SMART_GRID_SEASONAL],
        ]
        for (const [property, value, expected] of cases) {
            thinq.resetRecorder()
            dev.setProperty(property, value)
            assert.equal(thinq.outbox.length, 1, `${property}=${value}`)
            assert.equal(hex(thinq.outbox[0]), hex(expected), `${property}=${value}`)
        }
    })

    test('Celsius config uses the model table ranges', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_CELSIUS)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
    })

    test('local Celsius writes and appliance readbacks match captured round trips', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_CELSIUS)

        const cases: [string, string, Buffer, Buffer, number, number][] = [
            ['fridge_setpoint', '3', CLOUD_CMD_FRIDGE_3C, SAMPLE_FRIDGE_3C, 3, -20],
            ['fridge_setpoint', '2', CLOUD_CMD_FRIDGE_2C, SAMPLE_FRIDGE_2C, 2, -20],
            ['freezer_setpoint', '-19', CLOUD_CMD_FREEZER_M19C, SAMPLE_FREEZER_M19C, 2, -19],
            ['freezer_setpoint', '-20', CLOUD_CMD_FREEZER_M20C, SAMPLE_FREEZER_M20C, 2, -20],
            ['freezer_setpoint', '-22', CLOUD_CMD_FREEZER_M22C, SAMPLE_FREEZER_M22C, 2, -22],
            ['freezer_setpoint', '-23', CLOUD_CMD_FREEZER_M23C, SAMPLE_FREEZER_M23C, 2, -23],
            ['freezer_setpoint', '-20', CLOUD_CMD_FREEZER_M20C, SAMPLE_FREEZER_M20C, 2, -20],
        ]
        for (const [property, value, expected, response, fridge, freezer] of cases) {
            thinq.resetRecorder()
            dev.setProperty(property, value)
            assert.equal(thinq.outbox.length, 1, `${property}=${value}`)
            assert.equal(hex(thinq.outbox[0]), hex(expected), `${property}=${value}`)
            thinq.emit('data', response)
            assert.equal(props(ha).fridge_setpoint, fridge)
            assert.equal(props(ha).freezer_setpoint, freezer)
        }
    })

    test('setpoint values without model codes are refused', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_CELSIUS)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-24')
        dev.setProperty('fridge_setpoint', '2.5')
        assert.equal(thinq.outbox.length, 0)
    })

    test('an unrecognized Smart Grid option and unknown property are ignored', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_FAHRENHEIT)
        thinq.resetRecorder()

        dev.setProperty('smart_grid', 'unknown')
        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })

    test('Peak Energy Saver encodes and decodes the model-defined demand-response code', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_FAHRENHEIT)
        thinq.resetRecorder()

        dev.setProperty('smart_grid', 'Peak Energy Saver')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][4 + 5], 3)

        // Model-derived status fixture. Utility enrollment prevented a live Peak transition capture.
        const status = buf('02080A01020302000000FFFFFFFF00FFFF00')
        dev.processStatus(status)
        assert.equal(props(ha).smart_grid, 'Peak Energy Saver')
    })

    test('captured telemetry is acknowledged so the fridge stops retransmitting it', () => {
        const { thinq } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', SAMPLE_TELEMETRY)

        const acks = thinq.sent.filter((message) => message.cmd === 'ack').map((message) => message.data)
        assert.deepEqual(acks, [CLOUD_ACK_TELEMETRY])
        assert.deepEqual(thinq.outbox, [], 'the ack is not sent as a packet')
    })

    test('captured 10AF energy reports accumulate in Wh exactly as shown by ThinQ', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_FAHRENHEIT)

        thinq.emit('data', ENERGY_36_WH)
        assert.equal(props(ha).energy, 36)

        thinq.emit('data', ENERGY_37_WH)
        assert.equal(props(ha).energy, 73)

        thinq.emit('data', ENERGY_NEXT_HOUR_36_WH)
        assert.equal(props(ha).energy, 109)
    })

    test('frames with unrecognized shapes are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })
})
