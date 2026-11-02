import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RC90U2_WW_T1'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RC90U2_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: 'QC_Modem_1.2.80' }

// Every payload below was captured from a real RC90U2 with the QC_Modem module, decoded from the `Data`
// of the ThinQ1 status pushes. payload[i] is byte i of the AABB variant's record.

// Panel idle on Quick Dry: 0:30, no dry level (fixed on that course), Time.
const SAMPLE_IDLE_QUICK30 = buf('01 001e 0000 09 00 00 03 02 00000000 00 04 00 0000 00 000000 6b')
// Cotton, Extra, Time, right after Start: 2:40 left of 2:40.
const SAMPLE_RUNNING = buf('02 0228 0228 07 00 04 03 02 00000000 00 04 00 0000 01 000000 6b')
// The same cycle paused: event byte 0x60.
const SAMPLE_PAUSED = buf('03 0228 0228 07 00 04 03 02 00000000 00 04 60 0000 02 000000 6b')
// Powered off, Remote Start icon lit after a WakeUp.
const SAMPLE_OFF = buf('00 0000 0000 00 00 00 00 00 00000000 00 04 00 0000 01 000000 6b')
// What a WakeUp powers it on to: Ready, no course yet, Remote Start armed.
const SAMPLE_WOKEN = buf('01 0000 0000 00 00 00 00 00 00000000 00 05 00 0000 00 000000 6b')
// The DevInfo text ("RuleVer=1.3,FwVer=QC_Modem_1.2.80,regFail=N") comes through the same event.
const SAMPLE_DEVINFO = Buffer.from('RuleVer=1.3,FwVer=QC_Modem_1.2.80,regFail=N')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, props: () => ha.devices[DEVICE_ID].properties }
}

describe(`${MODEL_ID} over ThinQ1`, () => {
    test('start subscribes to the monitoring feed', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
    })

    test('idle payload is decoded with the AABB layout', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE_QUICK30)
        const p = props()

        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Ready')
        assert.equal(p.course, 'Quick Dry')
        assert.equal(p.eco_hybrid, 'Time')
        assert.equal(p.remaining_time, 30)
        assert.equal(p.initial_time, 0) // filled in when a cycle starts
        // bit 0x04 of the remote byte is set here, but only bit0 is Remote Start
        assert.equal(p.remote_start, 'OFF')
    })

    test('running then paused', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        assert.equal(props().status, 'Running')
        assert.equal(props().course, 'Cotton')
        assert.equal(props().dry_level, 'Extra')
        assert.equal(props().remaining_time, 160)
        assert.equal(props().initial_time, 160)

        thinq.emit('data', SAMPLE_PAUSED)
        assert.equal(props().status, 'Paused')
        assert.equal(props().remaining_time, 160)
    })

    test('the panel is mirrored into the remote selects', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        assert.equal(props().course, 'Cotton')
        assert.equal(props().dry_level, 'Extra')
        assert.equal(props().eco_hybrid, 'Time')
    })

    test('DevInfo text is ignored', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', SAMPLE_DEVINFO)
        assert.equal(props().status, undefined)
    })

    test('power: off is Power Off, on is a WakeUp', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('power', 'OFF')
        dev.setProperty('power', 'ON')
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' },
            { Cmd: 'Control', CmdOpt: 'Operation', Value: 'WakeUp', Format: 'B64', Data: '' },
        ])
    })

    test('Start/Pause stops a running cycle', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        dev.setProperty('start_pause', 'PRESS')
        assert.deepEqual(thinq.sent, [{ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' }])
    })

    test('Start/Pause resumes a paused cycle with its own settings', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_PAUSED)
        dev.setProperty('start_pause', 'PRESS')
        assert.deepEqual(thinq.sent, [
            {
                Cmd: 'Control',
                CmdOpt: 'Operation',
                Value: 'Start',
                Format: 'B64',
                // Cotton, Extra, Time; no Anti crease, Remote Start not armed
                Data: buf('07 04 03 00 00 00 00 00 00 00 00 00 00 00').toString('base64'),
            },
        ])
    })

    test('Start/Pause does nothing when idle', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE_QUICK30)
        dev.setProperty('start_pause', 'PRESS')
        assert.deepEqual(thinq.sent, [])
    })

    test('Start selected cycle is OperationStart with the F0 26 payload', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_IDLE_QUICK30)
        dev.setProperty('course', 'Cotton')
        dev.setProperty('dry_level', 'Extra')
        dev.setProperty('eco_hybrid', 'Eco')
        dev.setProperty('anti_crease', 'Yes')
        dev.setProperty('start_delay_end', '5')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.sent, [
            {
                Cmd: 'Control',
                CmdOpt: 'Operation',
                Value: 'Start',
                Format: 'B64',
                // [Course, DryLevel, EcoHybrid, MoreLessTime, 0, 0, Reserve_Time_H, 0, 0, Option1, Option2, 0,
                // SmartCourse, 0]
                Data: buf('07 04 01 00 00 00 05 00 00 02 01 00 00 00').toString('base64'),
            },
        ])
    })

    const WAKE_UP = { Cmd: 'Control', CmdOpt: 'Operation', Value: 'WakeUp', Format: 'B64', Data: '' }
    // Cotton, Cupboard, Eco, Remote Start
    const START_COTTON = {
        Cmd: 'Control',
        CmdOpt: 'Operation',
        Value: 'Start',
        Format: 'B64',
        Data: buf('07 03 01 00 00 00 00 00 00 00 01 00 00 00').toString('base64'),
    }

    test('Start selected cycle on an off appliance wakes it up first', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.sent, [WAKE_UP], 'no Start while off: the module would keep it for later')

        thinq.emit('data', SAMPLE_WOKEN)
        tickMockTimers(t, 1900)
        assert.deepEqual(thinq.sent, [WAKE_UP])
        tickMockTimers(t, 200)
        assert.deepEqual(thinq.sent, [WAKE_UP, START_COTTON])
    })

    test('the start is dropped when the appliance does not wake up', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        dev.setProperty('start', 'PRESS')
        tickMockTimers(t, 20000)

        thinq.emit('data', SAMPLE_WOKEN)
        tickMockTimers(t, 5000)
        assert.deepEqual(thinq.sent, [WAKE_UP])
    })

    test('power off cancels a pending start', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        dev.setProperty('start', 'PRESS')
        dev.setProperty('power', 'OFF')

        thinq.emit('data', SAMPLE_WOKEN)
        tickMockTimers(t, 5000)
        assert.deepEqual(thinq.sent, [
            WAKE_UP,
            { Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' },
        ])
    })
})
