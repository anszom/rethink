import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EBIVPC4'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF11EBIVPC4'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REF11EBIVPC4', swVersion: '1.0' }

// Test packets for 2REF11EBIVPC4 (43-byte status block, always Celsius).
// Frame structure (AABBDevice):
//   AA <len> 10 EB <43 status bytes> <cksum> BB     - initial-status push
//   AA <len> 10 EC <43 prev> <43 cur> <cksum> BB    - status delta push (only `cur` is used)
//
// Status block offsets (0-indexed):
//   [1]  fridge temp raw   – displayed as C = (13 - raw) / 2
//   [2]  freezer temp raw  – displayed as C = -(raw + 29) / 2
//   [3]  express freeze:   1=off, 2=on
//   [7]  door open:        0=closed, 1=open
//   [14] shabbat mode:     0=off, 1=on

// Baseline 43-byte status block:
//   fridge=3°C (raw=7), freezer=-18°C (raw=7), express=OFF, door=closed, shabbat=OFF
const STATUS_BASELINE = '02070701FFFFFF00FFFFFFFFFFFF00' + 'FF'.repeat(28)

// 10EB: initial-status packet (AA <31=45+4> 10 EB <43 status bytes> <cksum=00> BB)
const SAMPLE_INITIAL = buf('AA3110EB' + STATUS_BASELINE + '00BB')

// 10EC delta — cur[7]=0x01 (door OPEN)
const SAMPLE_DELTA_DOOR_OPEN = buf(
    'AA5C10EC' + STATUS_BASELINE + '02070701FFFFFF01FFFFFFFFFFFF00' + 'FF'.repeat(28) + '00BB',
)

// 10EC delta — cur[1]=0x05 (fridge 4°C: raw=5 → (13-5)/2=4)
const SAMPLE_DELTA_FRIDGE_4C = buf(
    'AA5C10EC' + STATUS_BASELINE + '02050701FFFFFF00FFFFFFFFFFFF00' + 'FF'.repeat(28) + '00BB',
)

// 10EC delta — cur[2]=0x05 (freezer -17°C: raw=5 → -(5+29)/2=-17)
const SAMPLE_DELTA_FREEZER_17C = buf(
    'AA5C10EC' + STATUS_BASELINE + '02070501FFFFFF00FFFFFFFFFFFF00' + 'FF'.repeat(28) + '00BB',
)

// 10EC delta — cur[3]=0x02 (express freeze ON)
const SAMPLE_DELTA_EXPRESS_ON = buf(
    'AA5C10EC' + STATUS_BASELINE + '02070702FFFFFF00FFFFFFFFFFFF00' + 'FF'.repeat(28) + '00BB',
)

// 10EC delta — cur[14]=0x01 (shabbat ON)
const SAMPLE_DELTA_SHABBAT_ON = buf(
    'AA5C10EC' + STATUS_BASELINE + '02070701FFFFFF00FFFFFFFFFFFF01' + 'FF'.repeat(28) + '00BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is published immediately in the constructor (always Celsius)', () => {
        const { ha } = makeDevice()
        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev, 'device entry created at construction')
        assert.ok(dev.config, 'config published without a status packet')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
        assert.ok(components.express_freeze, 'express_freeze component present')
        assert.ok(components.shabbat_mode, 'shabbat_mode component present')
        assert.equal(components.flex_setpoint, undefined, 'no flex drawer on this model')
    })

    test('0x10EB initial status decodes all five properties', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 3) // (13-7)/2
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -18) // -(7+29)/2
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.shabbat_mode, 'OFF')
    })

    test('0x10EC delta with door open publishes door=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 3)
    })

    test('0x10EC delta with fridge=4°C decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FRIDGE_4C)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 4) // (13-5)/2
    })

    test('0x10EC delta with freezer=-17°C decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FREEZER_17C)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -17) // -(5+29)/2
    })

    test('0x10EC delta with express freeze ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_EXPRESS_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
    })

    test('0x10EC delta with shabbat ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_SHABBAT_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.shabbat_mode, 'ON')
    })

    test('suppresses duplicate publishes when the cur block is unchanged', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)

        let publishCalls = 0
        const realPublish = ha.publishProperty.bind(ha)
        ha.publishProperty = (id, prop, value) => {
            publishCalls++
            return realPublish(id, prop, value)
        }
        thinq.emit('data', SAMPLE_INITIAL)
        assert.equal(publishCalls, 0, 'no republishes when nothing changed')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(Object.keys(ha.devices[DEVICE_ID].properties).length, 0)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        // Valid AA..BB envelope but inner bytes 0x10/0x99 do not match 0xEB or 0xEC.
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(Object.keys(ha.devices[DEVICE_ID].properties).length, 0)
    })

    test('start() sends no packet (device self-reports on connect)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write fridge_setpoint=5°C', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '5')
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[5], 3) // convertFridgeTemperature('C', 5) = 8 - 5
        assert.equal(pkt[12], 1) // zone selector required with fridge/freezer commands
    })

    test('HA write freezer_setpoint=-20°C', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[6], 6) // convertFreezerTemperature('C', -20) = -14 - (-20)
        assert.equal(pkt[12], 1) // zone selector required with fridge/freezer commands
    })

    test('HA write express_freeze=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[7], 2) // ON = 2
    })

    test('HA write express_freeze=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        assert.equal(pkt[7], 1) // OFF = 1
    })

    test('HA write shabbat_mode=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('shabbat_mode', 'ON')
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[18], 1) // ON = 1
    })

    test('HA write shabbat_mode=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('shabbat_mode', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        assert.equal(pkt[18], 0) // OFF = 0
    })

    test('HA write to an unknown property sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
