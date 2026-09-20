import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WMVEM1825'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WMVEM1825'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '20220616' }

// Real captures from an LG MVEM1825-series microwave. Each input frame was matched
// to the physical appliance; the combined outbound command was also verified live.
const SAMPLE_INITIAL_OFF = buf(
    'AA3441EB003100015500000000000000FF030D000000000000000000000000000000C3000000004000008080808001000000F1BB',
)
const SAMPLE_COOKING_10_SECONDS_HIGH = buf(
    'AA6241EC073000004001000000000000FF030D000000000000000000000000000000C3000100004000008080808001000000023000004401000000000A00FF030D00000A00000A000000000000000000C700010000400001808080800100000026BB',
)
const SAMPLE_COOKING_1_05_POWER_5 = buf(
    'AA6241EC073000004001000000000000FF030D000000000000000000000000000000C3000100004000008080808001000000023000004401000000000500FF030D000105000105000000000000000000C700010000400001808080800100000033BB',
)
const SAMPLE_PAUSED_AT_57_SECONDS = buf(
    'AA6241EC023000004401000000000500FF030D000039000105000000000000000000C7000100004000018080808001000000043000004401000000000500FF030D000039000105000000000000000000C7000100004000018080808001000000B6BB',
)
const SAMPLE_DONE = buf(
    'AA6241EC023000004401000000000A00FF030D00000100000A000000000000000000C7000100004000018080808001000000053000015500000000000000FF030D000000000000000000000000000000C300000000400000808080800100000029BB',
)
const SAMPLE_DOOR_OPEN = buf('AA0041B2000F070A01030000000197BB')
const SAMPLE_DOOR_CLOSED = buf('AA0041B2000F070A01030000000094BB')
const SAMPLE_LIGHT_LOW = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000004000008080808001000000003000015500000000000000FF030D000000000000000000000000000000C30000000040100080808080010000002EBB',
)
const SAMPLE_FAN_HIGH = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000004001008080808001000000003000015500000000000000FF030D000000000000000000000000000000C30000000040020080808080010000003BBB',
)
const SAMPLE_FAN_HIGH_LIGHT_LOW = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000004010008080808001000000003000015500000000000000FF030D000000000000000000000000000000C3000000004012008080808001000000D8BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('power differs from target seconds in a captured 20-second level-5 cook', () => {
        // Physical panel: 20 seconds at power level 5, allowed to finish.
        // Current record: [10] = 05 (50%), [17] = 14 (20s remaining),
        // [20] = 14 (20s target). Unlike the earlier fixtures, these values
        // distinguish power from the seconds portion of the target time.
        const packet = buf(
            'aa6241ec073000004001000000000000ff030d000000000000000000000000000000c3000100004000008080808001000000023000004401000000000500ff030d000014000014000000000000000000c7000100004000018080808001000000d7bb',
        )
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Cooking')
        assert.equal(ha.devices[DEVICE_ID].properties.power_level, 50)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 20)
    })

    test('config exposes microwave status and controllable hood components', () => {
        const { ha } = makeDevice()
        const config = ha.devices[DEVICE_ID].config
        assert.ok(config)

        const components = config.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'status',
            'remaining_time',
            'power_level',
            'door',
            'fan_power',
            'light_power',
        ])
        assert.equal(components.status.device_class, 'enum')
        assert.deepEqual(components.status.options, ['Idle', 'Cooking', 'Paused', 'Done', 'Ready to start'])
        assert.equal(components.remaining_time.device_class, 'duration')
        assert.equal(components.remaining_time.unit_of_measurement, 's')
        assert.equal(components.door.device_class, 'door')
        assert.equal(components.fan_power.platform, 'fan')
        assert.equal(components.fan_power.speed_range_max, 2)
        assert.equal(components.light_power.platform, 'light')
        assert.equal(components.light_power.brightness_scale, 2)
    })

    test('initial status reports idle with both hood controls off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_OFF)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.status, 'Idle')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.power_level, 0)
        assert.equal(props.fan_power, 'OFF')
        assert.equal(props.fan_speed, 0)
        assert.equal(props.light_power, 'OFF')
        assert.equal(props.light_level, 0)
    })

    test('10-second high-power cook reports cooking, time, and power', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING_10_SECONDS_HIGH)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.status, 'Cooking')
        assert.equal(props.remaining_time, 10)
        assert.equal(props.power_level, 100)
    })

    test('1:05 power-level-5 cook converts time and power to HA units', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COOKING_1_05_POWER_5)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.status, 'Cooking')
        assert.equal(props.remaining_time, 65)
        assert.equal(props.power_level, 50)
    })

    test('pause and completion states decode from real transitions', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PAUSED_AT_57_SECONDS)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Paused')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 57)

        thinq.emit('data', SAMPLE_DONE)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Done')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('door events publish open and closed states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', SAMPLE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('packed hood status decodes fan and light independently', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_FAN_HIGH_LIGHT_LOW)
        const props = ha.devices[DEVICE_ID].properties

        assert.equal(props.fan_power, 'ON')
        assert.equal(props.fan_speed, 2)
        assert.equal(props.light_power, 'ON')
        assert.equal(props.light_level, 1)
    })

    test('fan speed command preserves the reported light state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_LIGHT_LOW)
        thinq.resetRecorder()

        dev.setProperty('fan_speed', '2')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401020101808043BB')
    })

    test('light level command preserves the reported fan state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_FAN_HIGH)
        thinq.resetRecorder()

        dev.setProperty('light_level', '2')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401020102808042BB')
    })

    test('turning the fan off preserves the reported light state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_FAN_HIGH_LIGHT_LOW)
        thinq.resetRecorder()

        dev.setProperty('fan_power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220400000101808046BB')
    })

    test('invalid numeric control values are ignored', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('fan_speed', 'not-a-number')
        dev.setProperty('light_level', 'not-a-number')
        assert.equal(thinq.outbox.length, 0)
    })

    test('start sends the captured status query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()

        assert.equal(
            hex(thinq.outbox[0]),
            'AA28F0ED114101000000181A0207080C14191A1E262B30353A00000000000000000000000000F3BB',
        )
    })

    // an unmapped code publishes undefined, which goes out as the 'None' payload and shows in HA
    // as unknown - never a wrong label
    test('unknown status uses the Home Assistant enum fallback', () => {
        const { ha, thinq } = makeDevice()
        const unknown = Buffer.from(SAMPLE_INITIAL_OFF)
        unknown[4] = 0xff
        thinq.emit('data', unknown)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'None')
    })

    test('unrecognised frame shapes are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA084100430063BB'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
