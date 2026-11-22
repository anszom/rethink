import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Device from '@/cloud/devices/2REBGLUBD1P_A'
import AABBDevice from '@/cloud/devices/aabb_device'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
const META = { modelId: '2REBGLUBD1P_A', modelName: '2REBGLUBD1P_A', swVersion: '' }
const capture = JSON.parse(readFileSync(new URL('./fixtures/GBBSJ11ESW.json', import.meta.url), 'utf8')) as {
    baseline: string
    panel: { property: string; value: string; rx: string }[]
    controls: { property: string; value: string; tx: string; rx: string }[]
}
// Local captures from a GBBSJ11ESW with clip_ble_v1.9.225, without LG cloud.
// Owner confirmed panel setpoints 3 C / -18 C. OPEN is a 95-byte 10 EB
// snapshot; CLOSED is a 10 EC delta with two records. Only byte 7 changes
// from 1 to 2 when the physical fridge door is closed.
const OPEN = Buffer.from(
    'aa6510eb02050401ffffff0101ffffff00ffffff0000ffffffffffffffff000101ff00ffffffffffffffffff01ff00ffffffffffffffffffffffffffffffffffffffff0078ffffffffffffffffffffffffffffffffffffff0005ffffffffff0000ff001abb',
    'hex',
)
const CLOSED = Buffer.from(
    'aac410ec02050401ffffff0101ffffff00ffffff0000ffffffffffffffff000101ff00ffffffffffffffffff01ff00ffffffffffffffffffffffffffffffffffffffff0078ffffffffffffffffffffffffffffffffffffff0005ffffffffff0000ff0002050401ffffff0201ffffff00ffffff0000ffffffffffffffff000101ff00ffffffffffffffffff01ff00ffffffffffffffffffffffffffffffffffffffff0078ffffffffffffffffffffffffffffffffffffff0005ffffffffff0000ff00a0bb',
    'hex',
)
function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('fridge', META)
    const dev = new Device(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}
test('real capture matches owner-confirmed 3 C / -18 C and door open to closed', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', OPEN)
    assert.deepEqual(ha.devices.fridge.properties, {
        fridge_setpoint: 3,
        freezer_setpoint: -18,
        door: 'ON',
        super_cool: 'OFF',
        express_freeze: 'OFF',
        vacation: 'OFF',
    })
    thinq.emit('data', CLOSED)
    assert.equal(ha.devices.fridge.properties.door, 'OFF')
})
test('keeps existing sensors and routes added HA temperature controls to verified commands', () => {
    const { ha, thinq, dev } = setup()
    const components = ha.devices.fridge.config!.components as Record<string, Record<string, unknown>>
    for (const key of ['fridge_setpoint', 'freezer_setpoint', 'door'])
        assert.equal('command_topic' in components[key], false)
    assert.equal(components.fridge_setpoint.unique_id, '$deviceid-fridge_setpoint')
    assert.equal(components.freezer_setpoint.unique_id, '$deviceid-freezer_setpoint')
    thinq.emit('data', Buffer.from(capture.baseline, 'hex'))
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))
    thinq.resetRecorder()
    ha.setProperty('fridge', 'fridge_temperature', 'command', '4')
    assert.equal(
        thinq.outbox[0].toString('hex'),
        capture.controls.find((c) => c.property === 'fridge_setpoint' && c.value === '4')!.tx,
    )
    assert.equal(
        ha.devices.fridge.properties.fridge_setpoint,
        3,
        'wait for appliance readback instead of publishing an optimistic value',
    )
    thinq.resetRecorder()
    dev.start()
    assert.equal(thinq.outbox[0].toString('hex'), 'aa0ef0ed1211010000010400ebbb')
})
test('captured panel sweeps decode all Celsius setpoints and mode changes', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', Buffer.from(capture.baseline, 'hex'))
    for (const entry of capture.panel) {
        thinq.emit('data', Buffer.from(entry.rx, 'hex'))
        const expected = entry.property.endsWith('_setpoint') ? Number(entry.value) : entry.value
        assert.equal(ha.devices.fridge.properties[entry.property], expected, `${entry.property}=${entry.value}`)
    }
    assert.deepEqual(
        [...new Set(capture.panel.filter((p) => p.property === 'fridge_setpoint').map((p) => Number(p.value)))].sort(
            (a, b) => a - b,
        ),
        [1, 2, 3, 4, 5, 6, 7],
    )
    assert.deepEqual(
        [...new Set(capture.panel.filter((p) => p.property === 'freezer_setpoint').map((p) => Number(p.value)))].sort(
            (a, b) => a - b,
        ),
        [-23, -22, -21, -20, -19, -18, -17, -16, -15],
    )
})
test('all five controls reproduce physically verified commands and decode appliance responses', () => {
    for (const command of capture.controls) {
        const { ha, thinq, dev } = setup()
        thinq.emit('data', Buffer.from(capture.baseline, 'hex'))
        thinq.resetRecorder()
        dev.setProperty(command.property, command.value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), command.tx, `${command.property}=${command.value}`)
        if (command.property.endsWith('_setpoint')) {
            thinq.resetRecorder()
            dev.setProperty(command.property, command.value + '.0')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                command.tx,
                'HA float serialization keeps the same wire setpoint',
            )
        }
        thinq.emit('data', Buffer.from(command.rx, 'hex'))
        assert.equal(
            ha.devices.fridge.properties[command.property],
            command.property.endsWith('_setpoint') ? Number(command.value) : command.value,
        )
    }
})
test('ignores invalid MQTT values, unknown controls, and commands before a valid Celsius status', () => {
    const { thinq, dev } = setup()
    dev.setProperty('super_cool', 'ON')
    assert.equal(thinq.outbox.length, 0)
    thinq.emit('data', Buffer.from(capture.baseline, 'hex'))
    thinq.resetRecorder()
    for (const [prop, value] of [
        ['fridge_setpoint', '0'],
        ['fridge_setpoint', '8'],
        ['fridge_setpoint', '3.5'],
        ['fridge_setpoint', ''],
        ['fridge_setpoint', ' '],
        ['fridge_setpoint', 'NaN'],
        ['freezer_setpoint', '-24'],
        ['freezer_setpoint', '-14'],
        ['freezer_setpoint', '-18.5'],
        ['super_cool', 'true'],
        ['express_freeze', 'off'],
        ['vacation', '1'],
        ['smart_learner', 'ON'],
    ])
        dev.setProperty(prop, value)
    assert.equal(thinq.outbox.length, 0)
})
test('acknowledges captured usage and energy reports so this modem can finish telemetry delivery', () => {
    const { thinq } = setup()
    thinq.emit('data', Buffer.from('aa2010c5e90401000000000f03000000000011000000004f13000000000047bb', 'hex'))
    thinq.emit('data', Buffer.from('aa0b10af0000040405d4bb', 'hex'))
    assert.deepEqual(
        thinq.sent.map((s) => ({ cmd: s.cmd, data: s.data })),
        [
            { cmd: 'ack', data: 'AA08F000C5043EBB' },
            { cmd: 'ack', data: 'AA08F000AF0400BB' },
        ],
    )
})
test('ignores status frames with incorrect record lengths', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', AABBDevice.frame(Buffer.from('10eb02050401', 'hex')))
    assert.deepEqual(ha.devices.fridge.properties, {})
})
test('unsupported units and sentinel fields become unknown', () => {
    const { ha, thinq, dev } = setup()
    thinq.emit('data', OPEN)
    const inner = Buffer.from(OPEN.subarray(2, -2))
    inner[2 + 8] = 0xff
    inner[2 + 7] = 0xff
    thinq.emit('data', AABBDevice.frame(inner))
    assert.deepEqual(ha.devices.fridge.properties, {
        fridge_setpoint: 'None',
        freezer_setpoint: 'None',
        door: 'None',
        super_cool: 'OFF',
        express_freeze: 'OFF',
        vacation: 'OFF',
    })
    thinq.resetRecorder()
    dev.setProperty('super_cool', 'ON')
    dev.setProperty('fridge_setpoint', '4')
    assert.equal(thinq.outbox.length, 0)
})
