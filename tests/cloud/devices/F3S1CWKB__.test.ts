import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3S1CWKB__'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3S1CWKB__'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WKEX200HBA', swVersion: '2.10.123' }

// Real packet captures from the washer unit of a split-module WKEX200HBA WashTower, taken from the
// unit's own traffic. Full raw packets — processData strips the AA/BB framing first.

// 0xEB single-record snapshot replayed on reconnect (2026-10-17): the retained idle record — no
// course selected, but the session flag set and the remaining byte parked on 1. On a fresh driver
// instance this must read as OFF with 0 remaining, not as a 1-minute cycle.
const EB_RETAINED_IDLE =
    'AA3333EB002B0000000E000000000000000000000100000052000000109000000000240400000000000000400000000000DABB'

// 0xEC during a Speed Wash (2026-10-21): current record has course 0x4A selected, the door-lock
// bit set and 1 minute remaining.
const EC_SPEED_WASH_RUNNING =
    'AA6033EC002B0000000E0E4A000000000000000002000F002F00000E0C9007000000250400000000000000100000000000002B0000000E0E4A000000000000000001000F003200000E0C9007000000250400000000000000100000000000F4BB'

// 0xEC 82 s later: the cycle has finished — the current record's course is cleared while the
// panel is still powered. After the running frame above this must latch status Complete.
const EC_SPEED_WASH_COMPLETE =
    'AA6033EC002B0000000E0E4A000000000000000001000F003200000E0C9007000000250400000000000000100000000000002B0000000E0000000000000000000001000000360000100E90000000002604000000000000005000000000002BBB'

// 0xCD status dump carrying phase Washing (0x17 after the 01 02 0B header marker).
const CD_WASHING =
    'AA0033CD00019001020B17011101140000060003040002040005008022900024000000000000030417191A1E1F161724211CFFF7EDF3EF0000000000000000000000000000000000000000000000000000000000008484858584AE900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050074060000000000000000000001750248FFEF04000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008EBB'

const SEND_POWER_ON = 'AA0DF0E5000201FF010201C7BB'
const SEND_POWER_OFF = 'AA0DF0E5000201FF010200C4BB'

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
        for (const c of [
            'power',
            'status',
            'course',
            'remaining_time',
            'reserve_time',
            'soil',
            'spin',
            'temp',
            'extra_rinse',
            'extra_rinse_count',
            'pre_wash',
            'steam',
            'delay_wash',
            'door_lock',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
    })

    test('retained idle 0xEB on a fresh connect reads OFF with 0 remaining', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EB_RETAINED_IDLE))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['power'], 'OFF')
        assert.equal(props['status'], 'Off')
        assert.equal(props['remaining_time'], 0)
        assert.equal(props['course'], 'None')
    })

    test('0xEC decodes the running Speed Wash from the current record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_SPEED_WASH_RUNNING))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['power'], 'ON')
        assert.equal(props['course'], 'Speed Wash')
        assert.equal(props['remaining_time'], 1)
        assert.equal(props['door_lock'], 'ON')
        assert.equal(props['spin'], 'Medium')
    })

    test('course-cleared record after a run latches Complete', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_SPEED_WASH_RUNNING))
        thinq.emit('data', buf(EC_SPEED_WASH_COMPLETE))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['power'], 'ON')
        assert.equal(props['status'], 'Complete')
        assert.equal(props['remaining_time'], 0)
        assert.equal(props['course'], 'None')
    })

    test('0xCD dump publishes the run phase once a course is selected', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_SPEED_WASH_RUNNING))
        thinq.emit('data', buf(CD_WASHING))
        assert.equal(ha.devices[DEVICE_ID].properties['status'], 'Washing')
    })

    test('setProperty power sends the F0 E5 command', () => {
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

    test('retained replay after a remote power-off stays OFF', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(EC_SPEED_WASH_RUNNING))
        dev.setProperty('power', 'OFF')
        // The module reboots after a remote off and replays its retained idle record (session
        // flag set, no course). The remote-off latch must keep it reading OFF.
        thinq.emit('data', buf(EB_RETAINED_IDLE))
        assert.equal(ha.devices[DEVICE_ID].properties['power'], 'OFF')
    })
})
