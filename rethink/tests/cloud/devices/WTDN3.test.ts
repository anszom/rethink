import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WTDN3'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WTDN3'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WTDN3', swVersion: '1.0' }

// Samples based on https://github.com/anszom/rethink/issues/16#issuecomment-3733925697
const SAMPLE_STATE_OFF = buf('00000000000000000000000000000000000000000006006400000000')
const SAMPLE_STATE_READY_COTTON_1200_40C = buf('01030403040100030904010000000000000003000006006400000400')
const SAMPLE_STATE_WASH_COTTON_1200_40C_REMAIN_1H20 = buf('06011401140100030904010000000040000001040006006400000400')
const SAMPLE_STATE_FAST30_RUNNING = buf('06001e001e2200030502010000000040000001010006006400000200')
const SAMPLE_STATE_CUSTOM_REDUCING_WRINKLES = buf('01030003000100030904010000000242000003006f08006f00000400')
const SAMPLE_STATE_ERROR_DE1 = buf('12030403040102030904010000000000000003010008006400000400')
const SAMPLE_STATE_REMOTE_START_ON = buf('01010e010e0000000000000000000042000003000007006400000000')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'start',
            'pause',
            'status',
            'error',
            'error_message',
            'course',
            'temp',
            'spin',
            'drying_mode',
            'cycles',
            'remote_start',
            'door_lock',
            'initial_time',
            'remaining_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // Status enum is the union of supported states (excluding undefined slots).
        assert.ok(Array.isArray(components.status.options))
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.status.options as string[]).includes('Error'))
    })

    test('OFF state push publishes power=OFF and "Off" status', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.cycles, 6)
        assert.equal(props.initial_time, 0)
        assert.equal(props.remaining_time, 0)
    })

    test('READY+COTTON@1200/40C state push decodes course/spin/temperature', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_READY_COTTON_1200_40C)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1200)
        assert.equal(props.temp, 40)
        assert.equal(props.initial_time, 184)
        assert.equal(props.remaining_time, 184)
        assert.equal(props.error, 'OFF')
        assert.equal(props.drying_mode, 'Off')
    })

    test('WASH state with door lock active publishes door_lock=OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_WASH_COTTON_1200_40C_REMAIN_1H20)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.remaining_time, 80)
        assert.equal(props.door_lock, 'OFF') // OFF means locked
        assert.equal(props.remote_start, 'OFF')
    })

    test('Fast 30 running publishes the right course and remaining time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_FAST30_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing') // ST=0x06
        assert.equal(props.course, 'Quick 30') // CS=0x22
        assert.equal(props.spin, 800) // SP=5
        assert.equal(props.temp, 20) // TT=2
        assert.equal(props.initial_time, 30)
        assert.equal(props.remaining_time, 30)
    })

    test('Custom course overrides the native course when CC is non-zero', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_CUSTOM_REDUCING_WRINKLES)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Reducing Wrinkles')
    })

    test('Error state publishes error binary + descriptive message', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_ERROR_DE1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Error') // ST=0x12
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door open error (DE1)') // ER=2
    })

    test('Remote-start flag publishes remote_start=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_REMOTE_START_ON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
    })

    test('Frames of unexpected length are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AABBCC')) // 3 bytes, not 28
        // No properties should be published from data handler.
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('start() sends a Mon/Start subscription on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
    })

    test('HA write power=ON sends Control/Power/On envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Power', Value: 'On', Format: 'B64', Data: '' }])
    })

    test('HA write power=OFF sends Control/Power/Off envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' }])
    })

    test('HA write pause sends Control/Operation/Stop envelope', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' }])
    })

    // no test for `start` payload, area isn't explored very well at the moment
})
