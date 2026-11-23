import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3L2CYV5W_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3L2CYV5W_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Samples: one empty Normal cycle on a real WM3700HVA, with the panel on Warm, High spin, Normal soil.
// The panel read 53 minutes during SAMPLE_WASHING_0H52's run, one frame earlier.
const SAMPLE_SENSING_1H05 = buf('14 01 05 01 05 06 00 03 04 04 02 00 00 00 00 00 02 00 00 05 33 36 00 00')
const SAMPLE_WASHING_0H52 = buf('17 00 34 00 35 06 00 03 04 04 02 00 00 00 00 00 02 00 02 14 33 36 00 01')
const SAMPLE_RINSING_0H26 = buf('1e 00 1a 00 35 06 00 00 04 04 02 00 00 00 00 00 02 00 0e 17 33 36 00 01')
const SAMPLE_SPINNING_0H11 = buf('28 00 0b 00 35 06 00 00 04 00 00 00 00 00 00 00 02 00 19 1e 33 36 00 01')
const SAMPLE_COMPLETE = buf('3c 00 01 00 00 fe 00 00 00 00 00 00 00 00 00 00 00 00 2a 28 33 37 00 00')
const SAMPLE_OFF = buf('00 00 01 00 00 fe 00 00 00 00 00 00 00 00 00 00 00 00 2a 3c 33 37 00 00')
// Dial sweep, washer idle: time, course and settings read off the same panel.
const SAMPLE_HEAVY_DUTY_2H21 = buf('05 02 15 02 15 05 00 05 05 04 02 00 00 00 00 00 00 00 00 00 33 37 00 00')
const SAMPLE_BRIGHT_WHITES_1H12 = buf('05 01 0c 01 0c 07 00 03 04 06 03 00 00 00 00 00 00 00 00 00 33 37 00 00')
const SAMPLE_SPEED_WASH_0H15 = buf('05 00 0f 00 0f 0b 00 01 05 06 01 00 00 00 00 00 00 00 00 00 33 37 00 07')
// The first frame after a reconnect, ASCII rather than status: RuleVer=1.3,FwVer=QC_Modem_1.2.75,regFail=N
const SAMPLE_CONNECT_REPORT = Buffer.from('RuleVer=1.3,FwVer=QC_Modem_1.2.75,regFail=N')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('a real cycle walks the phases with the countdown', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_SENSING_1H05)
        assert.equal(props().status, 'Detecting')
        assert.equal(props().remaining_time, 65)

        thinq.emit('data', SAMPLE_WASHING_0H52)
        assert.equal(props().status, 'Washing')
        assert.equal(props().course, 'Normal')
        assert.equal(props().remaining_time, 52)
        assert.equal(props().initial_time, 53)

        thinq.emit('data', SAMPLE_RINSING_0H26)
        assert.equal(props().status, 'Rinsing')
        assert.equal(props().remaining_time, 26)

        thinq.emit('data', SAMPLE_SPINNING_0H11)
        assert.equal(props().status, 'Spinning')
        assert.equal(props().remaining_time, 11)
    })

    test('finish reports End with the stale 1 minute and no-course sentinel cleared', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING_0H11)
        thinq.emit('data', SAMPLE_COMPLETE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'End')
        assert.equal(props.power, 'ON')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.course, 'None')
        assert.equal(props.tub_clean_count, 55)
    })

    test('auto power-off after a finish reads as Off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Off')
        assert.equal(props.power, 'OFF')
        assert.equal(props.remaining_time, 0)
    })

    test('dial positions decode the course and its settings', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_HEAVY_DUTY_2H21)
        assert.equal(props().status, 'Standby')
        assert.equal(props().course, 'Heavy Duty')
        assert.equal(props().remaining_time, 141)
        assert.equal(props().soil, 'Heavy')
        assert.equal(props().spin, 'Extra High')
        assert.equal(props().temp, 'Warm')

        thinq.emit('data', SAMPLE_BRIGHT_WHITES_1H12)
        assert.equal(props().course, 'Bright Whites')
        assert.equal(props().temp, 'Hot')
        assert.equal(props().rinse_count, 3)

        thinq.emit('data', SAMPLE_SPEED_WASH_0H15)
        assert.equal(props().course, 'Speed Wash')
        assert.equal(props().soil, 'Light')
    })

    test('the connect report does not disturb the decoded state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_0H52)
        thinq.emit('data', SAMPLE_CONNECT_REPORT)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Washing')
    })

    test('start asks the washer for monitoring frames, on every connect', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(thinq.sent, [{ Cmd: 'Mon', CmdOpt: 'Start' }])
    })
})
