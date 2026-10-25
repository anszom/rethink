import { test } from 'node:test'
import assert from 'node:assert/strict'
import Device from '@/cloud/devices/2REBGLUBD1P_A'
import AABBDevice from '@/cloud/devices/aabb_device'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
const META = { modelId: '2REBGLUBD1P_A', modelName: '2REBGLUBD1P_A', swVersion: '' }
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
    assert.deepEqual(ha.devices.fridge.properties, { fridge_setpoint: 3, freezer_setpoint: -18, door: 'ON' })
    thinq.emit('data', CLOSED)
    assert.equal(ha.devices.fridge.properties.door, 'OFF')
})
test('only publishes read-only entities and a status query', () => {
    const { ha, thinq, dev } = setup()
    const components = ha.devices.fridge.config!.components
    for (const component of Object.values(components)) assert.equal('command_topic' in component, false)
    thinq.resetRecorder()
    dev.setProperty('freezer_setpoint', '-20')
    assert.equal(thinq.outbox.length, 0)
    dev.start()
    assert.equal(thinq.outbox[0].toString('hex'), 'aa0ef0ed1211010000010400ebbb')
})
test('rejects corrupt checksums and incorrect record lengths', () => {
    const { ha, thinq } = setup()
    const corrupt = Buffer.from(OPEN)
    corrupt[10] ^= 1
    thinq.emit('data', corrupt)
    thinq.emit('data', AABBDevice.frame(Buffer.from('10eb02050401', 'hex')))
    assert.deepEqual(ha.devices.fridge.properties, {})
})
test('unsupported units and sentinel fields become unknown', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', OPEN)
    const inner = Buffer.from(OPEN.subarray(2, -2))
    inner[2 + 8] = 0xff
    inner[2 + 7] = 0xff
    thinq.emit('data', AABBDevice.frame(inner))
    assert.deepEqual(ha.devices.fridge.properties, { fridge_setpoint: 'None', freezer_setpoint: 'None', door: 'None' })
})
