import { test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EICDX_2'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { readFileSync } from 'node:fs'

const META = { modelId: '2REF11EICDX_2', modelName: '2REF11EICDX_2', swVersion: '1.0' }
const fixtures: Record<string, string> = JSON.parse(
    readFileSync(new URL('./2REF11EICDX_2.captures.json', import.meta.url), 'utf8'),
)
const modelValues = JSON.parse(readFileSync(new URL('./2REF11EICDX_2.model-values.json', import.meta.url), 'utf8'))
function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('test-id', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    const props = () => ha.devices['test-id'].properties
    const feed = (time: string) => thinq.emit('data', buf(fixtures[time]))
    return { ha, thinq, dev, props, feed }
}

test('captured Ice Plus and setpoint transitions use the current status block', () => {
    const { feed, props } = setup()
    feed('14:49:08')
    assert.equal(props().express_freeze, 'OFF')
    feed('14:49:13')
    assert.equal(props().express_freeze, 'ON')
    feed('14:50:26')
    assert.equal(props().fridge_setpoint, 35)
    feed('14:50:54')
    assert.equal(props().fridge_setpoint, 36)
    feed('14:51:25')
    assert.equal(props().freezer_setpoint, -1)
    feed('14:51:53')
    assert.equal(props().freezer_setpoint, 0)
})

test('Craft Ice 3/6 reports and writes match both physical app changes', () => {
    const { feed, dev, thinq, props } = setup()
    for (const [name, option] of [
        ['craft_ice_6', '6 balls'],
        ['craft_ice_3', '3 balls'],
    ]) {
        feed(name)
        assert.equal(props().craft_ice_mode, option)
        assert.equal(props().fridge_setpoint, 36)
        assert.equal(props().freezer_setpoint, 0)
        thinq.resetRecorder()
        dev.setProperty('craft_ice_mode', option)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures[name + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('craft_ice_mode', 'Off')
    assert.equal(thinq.outbox.length, 0)
})

test('Sabbath on/off matches app captures without changing temperatures or Craft Ice', () => {
    const { feed, dev, thinq, props } = setup()
    for (const [name, value] of [
        ['sabbath_on', 'ON'],
        ['sabbath_off', 'OFF'],
    ]) {
        feed(name)
        assert.equal(props().sabbath_mode, value)
        assert.equal(props().fridge_setpoint, 36)
        assert.equal(props().freezer_setpoint, 0)
        assert.equal(props().craft_ice_mode, '3 balls')
        thinq.resetRecorder()
        dev.setProperty('sabbath_mode', value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures[name + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('sabbath_mode', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('Smart Learner on/off reproduces app writes and preserves the other settings', () => {
    const { feed, dev, thinq, props } = setup()
    for (const [name, value] of [
        ['smart_learner_on', 'ON'],
        ['smart_learner_off', 'OFF'],
    ]) {
        feed(name)
        assert.equal(props().smart_learner, value)
        assert.equal(props().sabbath_mode, 'OFF')
        assert.equal(props().smart_grid, 'Not In Use')
        assert.equal(props().craft_ice_mode, '3 balls')
        thinq.resetRecorder()
        dev.setProperty('smart_learner', value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures[name + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('smart_learner', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('Smart Grid seasonal/off matches both LG app commands; unconfirmed modes are not sent', () => {
    const { feed, dev, thinq, props } = setup()
    for (const [name, value] of [
        ['smart_grid_seasonal', 'Seasonal Energy Saver'],
        ['smart_grid_off', 'Not In Use'],
    ]) {
        feed(name)
        assert.equal(props().smart_grid, value)
        assert.equal(props().water_filter_months, 1)
        assert.equal(props().water_filter, 'OFF')
        thinq.resetRecorder()
        dev.setProperty('smart_grid', value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures[name + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('smart_grid', 'Peak Energy Saver')
    dev.setProperty('smart_grid', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('filter diagnostics use model-defined replacement months and clear invalid reports', () => {
    const { feed, thinq, props } = setup()
    // Real report: 1 month used, cross-checked as good by ThinQ and the LG cloud entities.
    feed('smart_grid_off')
    assert.equal(props().water_filter_months, 1)
    assert.equal(props().water_filter, 'OFF')
    // Boundary tests for the modelJson definition, not additional physical captures.
    for (const months of [0, 5, 6, 12, 255]) {
        const definition = Object.values(modelValues.waterFilter.valueMapping).find(
            (entry) => (entry as { index: number }).index === months,
        ) as { label: string }
        const expected = months === 255 ? 'None' : definition.label === '@RE_STATE_REPLACE_FILTER_W' ? 'ON' : 'OFF'
        const report = buf(fixtures.smart_grid_off)
        report[4 + 26 + 6] = months
        thinq.emit('data', report)
        assert.equal(props().water_filter_months, months === 255 ? 'None' : months)
        assert.equal(props().water_filter, expected)
    }
})

test('real door events distinguish compartments; aggregate reports do not guess which opened', () => {
    const { feed, props } = setup()
    assert.equal(props().fridge_door, 'None')
    assert.equal(props().freezer_door, 'None')
    feed('14:52:40')
    assert.equal(props().door, 'ON')
    assert.equal(props().fridge_door, 'None')
    feed('14:52:39')
    assert.equal(props().fridge_door, 'ON')
    assert.equal(props().freezer_door, 'None')
    feed('14:52:44')
    feed('14:52:45')
    assert.equal(props().fridge_door, 'OFF')
    assert.equal(props().freezer_door, 'OFF')
    feed('14:54:21')
    feed('14:54:22')
    assert.equal(props().freezer_door, 'ON')
    assert.equal(props().fridge_door, 'OFF')
    feed('14:54:25-event')
    feed('14:54:25-status')
    assert.equal(props().freezer_door, 'OFF')
    assert.equal(props().door, 'OFF')
})

test('writes reproduce the LG app command captures byte for byte', () => {
    const { feed, dev, thinq } = setup()
    feed('14:50:54')
    const commands = [
        [
            'fridge_setpoint',
            '35',
            'AA2FF017FF09FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF92BB',
        ],
        [
            'fridge_setpoint',
            '36',
            'AA2FF017FF08FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF93BB',
        ],
        [
            'freezer_setpoint',
            '-1',
            'AA2FF017FFFF07FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF90BB',
        ],
        [
            'freezer_setpoint',
            '0',
            'AA2FF017FFFF06FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF91BB',
        ],
        [
            'express_freeze',
            'OFF',
            'AA2FF017FFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEBBB',
        ],
        [
            'express_freeze',
            'ON',
            'AA2FF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFFEABB',
        ],
    ]
    for (const [property, value, expected] of commands) {
        thinq.resetRecorder()
        dev.setProperty(property, value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), expected)
    }
})

test('rejects unknown units, invalid switches, fractions and out of range temperatures', () => {
    const { feed, dev, thinq } = setup()
    dev.setProperty('fridge_setpoint', '35')
    assert.equal(thinq.outbox.length, 0)
    feed('14:50:54')
    thinq.resetRecorder()
    for (const [prop, value] of [
        ['fridge_setpoint', '32'],
        ['fridge_setpoint', '44'],
        ['fridge_setpoint', '35.5'],
        ['freezer_setpoint', '-8'],
        ['freezer_setpoint', '6'],
        ['freezer_setpoint', ''],
        ['express_freeze', 'banana'],
        ['unknown', 'ON'],
    ])
        dev.setProperty(prop, value)
    assert.equal(thinq.outbox.length, 0)
})

test('physical unit changes update discovery and decode the nonlinear Celsius table', () => {
    const { feed, props, ha } = setup()
    feed('14:50:54')
    assert.equal(props().fridge_setpoint, 36)
    const config = () => ha.devices['test-id'].config!.components as Record<string, Record<string, unknown>>
    const originalId = config().fridge_setpoint.unique_id
    feed('unit_celsius')
    assert.equal(props().fridge_setpoint, 2)
    assert.equal(props().freezer_setpoint, -18)
    const components = config()
    assert.equal(components.fridge_setpoint.unique_id, originalId)
    assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
    assert.equal(components.fridge_setpoint.min, 1)
    assert.equal(components.fridge_setpoint.max, 7)
    assert.equal(components.freezer_setpoint.min, -23)
    assert.equal(components.freezer_setpoint.max, -15)
    feed('unit_fahrenheit')
    assert.equal(config().fridge_setpoint.unit_of_measurement, '°F')
    assert.equal(props().fridge_setpoint, 35)
    assert.equal(props().freezer_setpoint, -1)
})

test('Celsius fridge writes reproduce the app commands without using the linear sibling conversion', () => {
    const { feed, props, dev, thinq } = setup()
    for (const degrees of [3, 2]) {
        const name = 'celsius_fridge_' + degrees
        feed(name)
        assert.equal(props().fridge_setpoint, degrees)
        assert.equal(props().freezer_setpoint, -18)
        thinq.resetRecorder()
        dev.setProperty('fridge_setpoint', String(degrees))
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures[name + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    for (const value of ['0', '8', '2.5', '', 'NaN']) dev.setProperty('fridge_setpoint', value)
    assert.equal(thinq.outbox.length, 0)
})

test('unknown units and invalid table entries clear stale temperatures and refuse writes', () => {
    const { feed, dev, thinq, props } = setup()
    feed('unit_celsius')
    const invalid = buf(fixtures.unit_celsius)
    invalid[4 + 26 + 1] = 4
    invalid[4 + 26 + 2] = 8
    thinq.emit('data', invalid)
    assert.equal(props().fridge_setpoint, 'None')
    assert.equal(props().freezer_setpoint, 'None')
    invalid[4 + 26 + 8] = 255
    thinq.emit('data', invalid)
    thinq.resetRecorder()
    dev.setProperty('fridge_setpoint', '2')
    dev.setProperty('freezer_setpoint', '-18')
    assert.equal(thinq.outbox.length, 0)
    feed('14:50:54')
    assert.equal(props().fridge_setpoint, 36)
    assert.equal(props().freezer_setpoint, 0)
})

test('Celsius freezer writes reproduce captured app commands', () => {
    const { feed, props, dev, thinq } = setup()
    for (const degrees of [19, 23, 18]) {
        const name = 'celsius_freezer_' + degrees
        feed(name)
        assert.equal(props().freezer_setpoint, -degrees)
        assert.equal(props().fridge_setpoint, 2)
        thinq.resetRecorder()
        dev.setProperty('freezer_setpoint', String(-degrees))
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures[name + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    for (const value of ['-24', '-14', '-18.5', '']) dev.setProperty('freezer_setpoint', value)
    assert.equal(thinq.outbox.length, 0)
})
