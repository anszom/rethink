import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13S1AMJW_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13S1AMJW_US'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WKEX200HBA', swVersion: '2.10.123' }

// Real packet captures from the dryer unit of a split-module WKEX200HBA WashTower, taken from the
// unit's own traffic during an evening Normal cycle (2026-10-20). Full raw packets — processData
// strips the AA/BB framing before processAABB sees them.

// 0xEB single-record snapshot right after a reconnect, mid-cycle: Drying, 47 min left of 59.
const EB_DRYING = 'AA2434EB001C32002F003B03000504000400000000A90003A001000000740000000023BB'

// 0xEC two-record frame while Drying: previous record 39 min, current 38 min.
const EC_DRYING =
    'AA4234EC001C320027003B03000504000400000000A90005E2010000007400000000001C320026003B03000504000400000000A900060E01000000740000000097BB'

// 0xEC with the current record at phase End (0x04), power still on.
const EC_END =
    'AA4234EC001C330001003403000504000400000000A9000BCF320000007400000000001C040001003403000504000400000040A8000BD2330000007400000000CFBB'

// 0xEC 30 s later: current record phase Off, course cleared.
const EC_OFF =
    'AA4234EC001C040001003403000504000400000040A8000BD2330000007400000000001C000001000100000000000400000040A8000000040000000000000000BEBB'

const SEND_POWER_ON = 'AA09F0240101019FBB'
const SEND_POWER_OFF = 'AA09F0240101009CBB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected HA components', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        for (const c of ['power', 'status', 'course', 'remaining_time', 'dry_level', 'temp', 'wrinkle_care']) {
            assert.ok(components[c], `component ${c} present`)
        }
    })

    test('0xEB snapshot decodes a running cycle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EB_DRYING))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['power'], 'ON')
        assert.equal(props['status'], 'Drying')
        assert.equal(props['course'], 'Normal')
        assert.equal(props['remaining_time'], 47)
        assert.equal(props['dry_level'], 'Damp')
        assert.equal(props['temp'], 'Level 4')
        assert.equal(props['wrinkle_care'], 'OFF')
    })

    test('0xEC reads the current (second) record, not the previous one', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_DRYING))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['status'], 'Drying')
        assert.equal(props['remaining_time'], 38)
    })

    test('End phase keeps power on, the following Off record clears the cycle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_DRYING))
        thinq.emit('data', buf(EC_END))
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props['status'], 'End')
        assert.equal(props['power'], 'ON')

        thinq.emit('data', buf(EC_OFF))
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props['power'], 'OFF')
        assert.equal(props['status'], 'Off')
        assert.equal(props['remaining_time'], 0)
        assert.equal(props['course'], 'None')
        assert.equal(props['dry_level'], 'None')
        assert.equal(props['temp'], 'None')
    })

    test('setProperty power sends the F0 24 command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_POWER_ON)

        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_POWER_OFF)
    })
})
