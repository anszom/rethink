import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RH16_T_KR'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RH16_T_KR', modelName: 'RH16_T_KR', swVersion: '2.10.122' }

// Real frames captured from the owner's RH16_T_KR. OFF is the current state
// after a live reconnect; INITIAL and the EC transition are historical traffic
// from the same appliance.
const OFF = buf('AA2130EB00190000000000000000000000000000000000000000000000770023BB')
const INITIAL = buf('AA2130EB001901000000000000000000000000000804000000000000007700D6BB')
const DOUBLE_INITIAL = buf(
    'AA3C30EC00190100000000000000000000000000080400000000000000770000190100000000000000000000000000000400000000000000770061BB',
)
const CHILD_LOCK_ON = buf(
    'AA3C30EC00190000000000000000000000000000000000000001000000770000190100000000000000000000000000080800000000000000770061BB',
)
const CHILD_LOCK_OFF = buf(
    'AA3C30EC00190100000000000000000000000000080800000000000000770000190100000000000000000000000000000800000000000000770069BB',
)
const REMOTE_START_ON = buf(
    'AA3C30EC00190100000000000000000000000000000900000000000000770000190100000000000000000000000000001900000000000000770013BB',
)
const REMOTE_START_OFF = buf(
    'AA3C30EC00190100000000000000000000000000001900000000000000770000190100000000000000000000000000001800000000000000770000BB',
)
const STATUS_REQUEST = 'aa0ef0ed1121010000001800b5bb'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function assertIntact(packet: Buffer) {
    assert.equal(packet[1], packet.length)
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    assert.equal(packet[packet.length - 2], (sum & 0xff) ^ 0x55)
}

/** Model-declared state probe derived from a real frame; not capture evidence. */
function withState(state: number) {
    const packet = Buffer.from(OFF)
    packet[6] = state
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

/** Model-declared error probe derived from a real frame; not capture evidence. */
function withError(error: number) {
    const packet = Buffer.from(OFF)
    packet[12] = error
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

describe('RH16_T_KR read-only status', () => {
    test('real capture fixtures have intact AA/BB envelopes', () => {
        for (const frame of [
            OFF,
            INITIAL,
            DOUBLE_INITIAL,
            CHILD_LOCK_ON,
            CHILD_LOCK_OFF,
            REMOTE_START_ON,
            REMOTE_START_OFF,
        ])
            assertIntact(frame)
    })

    test('exposes the common read-only status sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'child_lock',
            'error',
            'error_message',
            'power',
            'remote_start',
            'smart_diagnosis',
            'status',
        ])
        for (const component of Object.values(components)) assert.equal(component.command_topic, undefined)
        assert.equal(components.power.icon, 'mdi:power')
        assert.equal(components.status.icon, 'mdi:tumble-dryer')
        assert.equal(components.child_lock.device_class, 'lock')
        assert.equal(components.error.device_class, 'problem')
        assert.equal(components.error_message.device_class, 'enum')
        assert.equal(components.error_message.entity_category, 'diagnostic')
        assert.equal(components.smart_diagnosis.device_class, 'problem')
    })

    test('decodes the current real powered-off EB snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'OFF')
    })

    test('decodes the real Initial EB snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
    })

    test('uses the current record in a real EC frame', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF)
        thinq.emit('data', DOUBLE_INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
    })

    test('keeps Error separate from the state enum and derives it from the error code', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withState(5))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Error')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'OFF')
        thinq.emit('data', withState(8))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Smart diagnosis')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'ON')
    })

    test('maps the model-declared error byte and safely handles an undefined code', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withError(1))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'tE1')
        thinq.emit('data', withError(0))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Normal')
        thinq.emit('data', withError(3))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'None')
    })

    test('decodes child lock from the isolated real ON and OFF transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        thinq.emit('data', CHILD_LOCK_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
    })

    test('decodes remote start from the isolated real ON and OFF transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REMOTE_START_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
        thinq.emit('data', REMOTE_START_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
    })

    test('asks only for the family-wide read-only status snapshot on connect', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), STATUS_REQUEST)
    })

    test('ignores other device types and malformed RH16 status shapes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA2120EB00190000000000000000000000000000000000000000000000770033BB'))
        thinq.emit('data', buf('AA0730EB00A8BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.status, undefined)
    })
})
