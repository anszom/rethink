import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REBGLUB_2P__'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REBGLUB_2P__'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '' }

// Real captures from a GBBSJ2CCEP through the rethink bridge, with each setting changed in the LG app.

// fridge 4C, freezer -18C, unit C, everything off, door closed (2)
const STATUS_INITIAL = buf(
    'AA6610EB02040401FFFFFF0201FFFFFF00FFFFFF0001FFFFFFFFFFFFFFFF050101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF00000DBB',
)
// door opened
const STATUS_DOOR_OPEN = buf(
    'AAC610EC02040401FFFFFF0201FFFFFF00FFFFFF0001FFFFFFFFFFFFFFFF020101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF000002040401FFFFFF0101FFFFFF00FFFFFF0001FFFFFFFFFFFFFFFF020101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF0000AABB',
)
// Super Cool on
const STATUS_SUPER_COOL = buf(
    'AAC610EC02040401FFFFFF0201FFFFFF00FFFFFF0001FFFFFFFFFFFFFFFF050101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF000002040401FFFFFF0201FFFFFF00FFFFFF0101FFFFFFFFFFFFFFFF050101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF000052BB',
)
// fresh converter set to Meat (2)
const STATUS_FRESH_CONVERTER_2 = buf(
    'AAC610EC02040401FFFFFF0201FFFFFF00FFFFFF0001FFFFFFFFFFFFFFFF050101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF000002040401FFFFFF0201FFFFFF00FFFFFF0001FFFFFFFFFFFFFFFF050101FF02FFFFFFFFFFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0005FFFFFFFFFF0000FF00025DBB',
)

// 8 Wh in the last 15 minutes
const ENERGY_8WH = buf('AA0B10AF0000080404D1BB')
// door opened once (18 in total), 10 s open (166 s in total)
const USAGE = buf('AA2010C5150401000100001203000000000011000A0000A6130000000000F6BB')
const FIRMWARE = buf(
    'AA37103102015341413330383830383031000068E0000018000003E8000253414133303631393030310000968F000000000000A8004CBB',
)

// the F017 commands the LG app sent
const APP_FRIDGE_5C =
    'AA7CF017FF03FFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBBBB'
const APP_FREEZER_M19C =
    'AA7CF017FFFF05FFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA5BB'
const APP_EXPRESS_FREEZE_ON =
    'AA7CF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB'
const APP_VACATION_ON =
    'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFF01FFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB'
const APP_SUPER_COOL_ON =
    'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF01FFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB'
const APP_SMART_LEARNER_OFF =
    'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBCBB'
const APP_FRESH_CONVERTER_2 =
    'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF02FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function ready() {
    const d = makeDevice()
    d.thinq.emit('data', STATUS_INITIAL)
    d.thinq.resetRecorder()
    return d
}

describe(MODEL_ID, () => {
    test('config not published until a status frame establishes the unit', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('0x10EB initial status', () => {
        const { ha } = ready()
        const dev = ha.devices[DEVICE_ID]
        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')

        assert.equal(dev.properties.fridge_setpoint, 4)
        assert.equal(dev.properties.freezer_setpoint, -18)
        assert.equal(dev.properties.door, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
        assert.equal(dev.properties.super_cool, 'OFF')
        assert.equal(dev.properties.smart_learner, 'ON')
        assert.equal(dev.properties.vacation, 'OFF')
        assert.equal(dev.properties.fresh_converter, 'Cheese')
    })

    test('0x10EC status changes', () => {
        const { ha, thinq } = ready()
        thinq.emit('data', STATUS_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', STATUS_SUPER_COOL)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.super_cool, 'ON')
        thinq.emit('data', STATUS_FRESH_CONVERTER_2)
        assert.equal(ha.devices[DEVICE_ID].properties.fresh_converter, 'Meat')
    })

    test('0x10AF energy accumulates', () => {
        const { ha, thinq } = ready()
        thinq.emit('data', ENERGY_8WH)
        thinq.emit('data', ENERGY_8WH)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 16)
    })

    test('0x10AF energy that arrives before the unit is counted', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ENERGY_8WH)
        thinq.emit('data', STATUS_INITIAL)
        thinq.emit('data', ENERGY_8WH)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 16)
    })

    test('0x10C5 door usage totals', () => {
        const { ha, thinq } = ready()
        thinq.emit('data', USAGE)
        assert.equal(ha.devices[DEVICE_ID].properties.door_openings, 18)
        assert.equal(ha.devices[DEVICE_ID].properties.door_open_time, 166)
    })

    test('0x1031 firmware versions', () => {
        const { ha, thinq } = ready()
        thinq.emit('data', FIRMWARE)
        assert.equal(ha.devices[DEVICE_ID].properties.firmware_1, '68e0.0 (SAA30880801)')
        assert.equal(ha.devices[DEVICE_ID].properties.firmware_2, '968f.0 (SAA30619001)')
    })

    test('start() sends the F0ED status query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('HA writes reproduce the LG app commands', () => {
        const cases: [string, string, string][] = [
            ['fridge_setpoint', '5', APP_FRIDGE_5C],
            ['freezer_setpoint', '-19', APP_FREEZER_M19C],
            ['express_freeze', 'ON', APP_EXPRESS_FREEZE_ON],
            ['vacation', 'ON', APP_VACATION_ON],
            ['super_cool', 'ON', APP_SUPER_COOL_ON],
            ['smart_learner', 'OFF', APP_SMART_LEARNER_OFF],
            ['fresh_converter', 'Meat', APP_FRESH_CONVERTER_2],
        ]
        for (const [prop, value, expected] of cases) {
            const { thinq, dev } = ready()
            dev.setProperty(prop, value)
            assert.equal(hex(thinq.outbox[0]), expected, `${prop}=${value}`)
        }
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = ready()
        dev.setProperty('nonsense', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
