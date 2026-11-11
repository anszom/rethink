import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WMHES1738'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WMHES1738'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '20210927' }

// Real captures from an LG MHES1738F microwave (RTL8711am module, firmware 20210927). Each frame
// was matched to an action on the front panel; fan and light commands were verified live.
const SAMPLE_INITIAL_OFF = buf(
    'AA3441EB003000015500000000000000FF030C000000000000000000000000000000C3000000005300008080808001000000E0BB',
)
// Fan speeds 3 and 5 are outside the MVEM1825's two-speed range.
const SAMPLE_FAN_1_TO_3 = buf(
    'AA6241EC003000015500000000000000FF030C000000000000000000000000000000C3000000005301008080808001000000003000015500000000000000FF030C000000000000000000000000000000C3000000005303008080808001000000C6BB',
)
const SAMPLE_FAN_3_TO_5 = buf(
    'AA6241EC003000015500000000000000FF030C000000000000000000000000000000C3000000005303008080808001000000003000015500000000000000FF030C000000000000000000000000000000C3000000005305008080808001000000C2BB',
)
const SAMPLE_LIGHT_HIGH = buf(
    'AA6241EC003000015500000000000000FF030C000000000000000000000000000000C3000000005300008080808001000000003000015500000000000000FF030C000000000000000000000000000000C3000000005320008080808001000000FABB',
)
const SAMPLE_READY_TO_START = buf(
    'AA6241EC003000015500000000000000FF030C000000000000000000000000000000C3000000005300008080808001000000073000004001000000000000FF030C000000000000000000000000000000C3000100005300008080808001000000D7BB',
)
// Panel: 20 seconds at power level 5, allowed to finish.
const SAMPLE_COOKING_20_SECONDS_POWER_5 = buf(
    'AA6241EC073000004001000000000000FF030C000000000000000000000000000000C3000100005300008080808001000000023000004401000000000500FF030C000014000014000000000000000000C7000100005300018080808001000000F3BB',
)
const SAMPLE_DONE = buf(
    'AA6241EC023000004401000000000500FF030C000001000014000000000000000000C7000100005300018080808001000000053000015500000000000000FF030C000000000000000000000000000000C3000000005300008080808001000000F0BB',
)
// Panel: 1 minute at full power, paused by opening the door with 48 seconds left.
const SAMPLE_PAUSED_AT_48_SECONDS = buf(
    'AA6241EC023000004401000000000A00FF030C000031000100000000000000000000C7000100005300018080808001000000043000004401000000000A00FF030C000030000100000000000000000000C7000100005300018080808001000000A3BB',
)
// Pause events from a 30-second cook: one paused by opening the door, one by the Stop key.
const SAMPLE_PAUSE_EVENT_DOOR = buf(
    'AA0041B200073C0A01030000140000000001000000000A000000000001010100000000000000000000000000000000000000000000000000000000000000010100000047BB',
)
const SAMPLE_PAUSE_EVENT_STOP_KEY = buf(
    'AA0041B200073C0A01030000130000000001000000000A0000000000010100013C0000000000000000000000000000000000000000000000000000000000010100000018BB',
)
const SAMPLE_DOOR_OPEN = buf('AA0041B2000F070A01030000000197BB')
const SAMPLE_DOOR_CLOSED = buf('AA0041B2000F070A01030000000094BB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('initial status reports idle with both hood controls off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_OFF)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.status, 'Idle')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.fan_power, 'OFF')
        assert.equal(props.light_power, 'OFF')
    })

    test('vent fan reports speeds above two', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_FAN_1_TO_3)
        assert.equal(ha.devices[DEVICE_ID].properties.fan_power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fan_speed, 3)

        thinq.emit('data', SAMPLE_FAN_3_TO_5)
        assert.equal(ha.devices[DEVICE_ID].properties.fan_speed, 5)
        const components = ha.devices[DEVICE_ID].config?.components as Record<string, Record<string, unknown>>
        assert.equal(components.fan_power.speed_range_max, 5)
    })

    test('light high decodes as level 2', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_LIGHT_HIGH)
        assert.equal(ha.devices[DEVICE_ID].properties.light_power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.light_level, 2)
        assert.equal(ha.devices[DEVICE_ID].properties.fan_power, 'OFF')
    })

    test('a panel cook goes through ready, cooking and done', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_READY_TO_START)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Ready to start')

        thinq.emit('data', SAMPLE_COOKING_20_SECONDS_POWER_5)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Cooking')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 20)
        assert.equal(ha.devices[DEVICE_ID].properties.power_level, 50)

        thinq.emit('data', SAMPLE_DONE)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Done')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('opening the door mid-cook reports paused with the remaining time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PAUSED_AT_48_SECONDS)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Paused')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 48)
        assert.equal(ha.devices[DEVICE_ID].properties.power_level, 100)
    })

    test('door events publish open and closed states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('opening the door mid-cook reports the door open until the closed event', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        thinq.emit('data', SAMPLE_PAUSE_EVENT_DOOR)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')

        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('a pause from the Stop key leaves the door closed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        thinq.emit('data', SAMPLE_PAUSE_EVENT_STOP_KEY)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('fan speed commands accept all five speeds and keep the light state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_LIGHT_HIGH)
        thinq.resetRecorder()

        dev.setProperty('fan_speed', '5')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF04322040105010280804FBB')

        dev.setProperty('fan_speed', '9')
        assert.equal(hex(thinq.outbox[1]), 'AA0EF04322040105010280804FBB')
    })
})
