import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/H11'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'H11'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1' }

// Every positive fixture below is a complete AA...BB frame captured from a DUE2BG.AKOR dishwasher
// reporting modelId H11. The matching ThinQ cloud state was recorded at the same timestamp.

// INITIAL (displayed as Ready) -> Running, Express, 1 h 46 min, high_temp and extra_dry enabled, one extra rinse.
const EXPRESS_STARTS_RUNNING = buf(
    'aa6232ec0018010000012e0800012e0000100c00014146640240001000050d050f00020103ce003e0103ce003e0103ce003e0018020200012e0800012e0000100c00014146640240001000050d050f00020103ce003e0103ce003e0103ce003edabb',
)

// Running/Washing -> Running/Rinsing at 07:45:05; ThinQ reported process=RINSING.
const EXPRESS_STARTS_RINSING = buf(
    'aa6232ec0018020200003b0800002f00001000000141466402400020000f0d050f00040103ce003e0103ce003e0103ce003e0018020300003b0800002f00001000000141466402400020000f0d050f00040103ce003e0103ce003e0103ce003e9abb',
)

// Running/Rinsing -> Running/Drying at 08:26:47; ThinQ reported process=DRYING.
const EXPRESS_STARTS_DRYING = buf(
    'aa6232ec0018020300003b0800000100001000000141466402400020000f0d050f00040103ce003e0103ce003e0103ce003e0018020400003b08000001000010000001414e6402400020000f0d050f00040103ce003e0103ce003e0103ce003e2cbb',
)

// Running/Drying -> End/End at 08:27:16; ThinQ reported state=END, process=END.
const EXPRESS_ENDS = buf(
    'aa6232ec0018020400003b08000001000012000001414e6402400020000f0d050f00040103ce003e0103ce003e0103ce003e0018050500003b08000001000012000001414e6402400020000f0d050f00040103ce003e0103ce003e0103ce003edfbb',
)

// End -> Standby at 08:27:46; ThinQ reported state=STANDBY, process=NONE.
const EXPRESS_RETURNS_TO_STANDBY = buf(
    'aa6232ec0018050500003b08000001000012000001414e6402400020000f0d050f00040103ce003e0103ce003e0103ce003e0818040000003b00000001000012000001414c6402400000000f0d050f00040103ce003e0103ce003e0103ce003e33bb',
)

// Standby -> INITIAL (displayed as Ready), One hour, 90 min. The current record starts with 08 18.
// Captured in 1786956061585.jsonl, line 11; ThinQ reported INITIAL / ONE_HOUR at line 13.
const ONE_HOUR_SELECTED = buf(
    'aa6232ec0018040000011e0000000100001000000141446402400000000f0d050f00040103ce003e0103ce003e0103ce003e0818010000011e1200011e00001000000141466402400020000f0d050f00040103ce003e0103ce003e0103ce003e6cbb',
)

// Single-record 0xEB snapshot captured while the dishwasher was in Standby.
const STANDBY_SNAPSHOT = buf(
    'aa3432eb0018040000012e0000012e0000100000014144640240000000050d050f00020103ce003e0103ce003e0103ce003e5cbb',
)

// Settings baseline: rinse 0, salt 1, buzzer Low, end alarm and auto dry enabled, clean reminder off,
// remote start mode One-time, and display brightness High.
const SETTINGS_BASELINE = buf(
    'aa6232ec0018010000013a0800013a0000140c010143466402400020000f0d050f00040103ce003e0103ce003e0103ce003e0018010000013a0800013a0000100c000143466402400020000f0d050f00040103ce003e0103ce003e0103ce003ea8bb',
)

// Delayed Machine clean at 07:07:53. The current record reports RUNNING/RESERVED,
// 94 minutes of cycle time and 58 minutes until the delayed start.
const MACHINE_CLEAN_RESERVED = buf(
    'aa6232ec0018020100012209010122003b1001000141466402400d00000d0d050f00000103ce003e0103ce003e0103ce003e0018020100012209010122003a1001000141466402400d00000d0d050f00000103ce003e0103ce003e0103ce003e9cbb',
)

// Running/Washing -> Running/Cancel after f0 26 11. The appliance started draining
// and reported one minute remaining with no separate drain process code.
const CANCEL_STARTS_DRAINING = buf(
    'aa6232ec0018020200002f0800002e00001000000143466402400010000d0d050f00000103ce003e0103ce003e0103ce003e0018026300002f0000000100001000000143446402400000000d0d050f00000103ce003e0103ce003e0103ce003ef7bb',
)

// Running/Cancel -> Ready/Idle after f0 26 11 was pressed again during draining.
const CANCEL_STOPS_DRAINING = buf(
    'aa6232ec0018026300002f0000000100001000000143446402400000000d0d050f00000103ce003e0103ce003e0103ce003e0018010000002f0800002f00001000000143466402400010000d0d050f00000103ce003e0103ce003e0103ce003ef5bb',
)

// Two real energy reports from different cycles. Both use sequence 0x02 but report different totals.
const ENERGY_TOTAL_314 = buf('aa0b323e0092013a02a1bb')
const ENERGY_TOTAL_346 = buf('aa0b323e00c1015a0216bb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    dev.start()
    return { ha, thinq, dev }
}

describe('H11 Dishwasher', () => {
    test('publishes detailed state and process across the captured cycle', () => {
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.deepEqual(components.status.options, [
            'Ready',
            'Running',
            'Pause',
            'Standby',
            'End',
            'Reserved',
            'Washing',
            'Rinsing',
            'Drying',
            'Cancel',
        ])
        assert.deepEqual(components.process.options, [
            'Idle',
            'Reserved',
            'Washing',
            'Rinsing',
            'Drying',
            'End',
            'Cancel',
        ])

        thinq.emit('data', EXPRESS_STARTS_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Washing')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'Washing')

        thinq.emit('data', EXPRESS_STARTS_RINSING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Rinsing')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'Rinsing')

        thinq.emit('data', EXPRESS_STARTS_DRYING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Drying')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'Drying')

        thinq.emit('data', EXPRESS_ENDS)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'End')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'End')

        thinq.emit('data', EXPRESS_RETURNS_TO_STANDBY)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'Idle')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('updates state, course and time from the current 08 18 record only', () => {
        const { ha, thinq } = makeDevice()
        const updates: Array<[string, string | number | undefined]> = []
        const publishProperty = ha.publishProperty.bind(ha)
        ha.publishProperty = (id, property, value) => {
            updates.push([property, value])
            publishProperty(id, property, value)
        }

        thinq.emit('data', ONE_HOUR_SELECTED)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.status, 'Ready')
        assert.equal(properties.course, 'One hour')
        assert.equal(properties.remaining_time, 90)
        assert.equal(properties.initial_time, 90)
        assert.equal(properties.power, 'ON')
        assert.deepEqual(
            updates.filter(([property]) => property === 'status'),
            [['status', 'Ready']],
        )
        assert.deepEqual(
            updates.filter(([property]) => property === 'course'),
            [['course', 'One hour']],
        )
    })

    test('updates state and course from the real 0xEB reconnect snapshot', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', STANDBY_SNAPSHOT)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.status, 'Standby')
        assert.equal(properties.course, 'Off')
        assert.equal(properties.remaining_time, 106)
        assert.equal(properties.power, 'OFF')
    })

    test('updates state from the current 00 18 record only', () => {
        const { ha, thinq } = makeDevice()
        const statuses: Array<string | number | undefined> = []
        const publishProperty = ha.publishProperty.bind(ha)
        ha.publishProperty = (id, property, value) => {
            if (property === 'status') statuses.push(value)
            publishProperty(id, property, value)
        }

        thinq.emit('data', EXPRESS_STARTS_RUNNING)

        assert.deepEqual(statuses, ['Washing'])
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Express')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 106)
    })

    test('reports the captured delayed Machine clean cycle in minutes', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', MACHINE_CLEAN_RESERVED)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.status, 'Reserved')
        assert.equal(properties.process, 'Reserved')
        assert.equal(properties.course, 'Machine clean')
        assert.equal(properties.initial_time, 94)
        assert.equal(properties.remaining_time, 94)
        assert.equal(properties.delay_start, 58)
        assert.equal(properties.power, 'ON')
    })

    test('reports cancel draining as powered on and returns to Ready when it stops', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', CANCEL_STARTS_DRAINING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Cancel')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'Cancel')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 1)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')

        thinq.emit('data', CANCEL_STOPS_DRAINING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Ready')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'Idle')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 47)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
    })

    test('does not overwrite staged remote-start options with current-cycle status', () => {
        const { ha, thinq, dev } = makeDevice()

        dev.setProperty('target_extra_rinse', '2')
        thinq.emit('data', EXPRESS_STARTS_RUNNING)

        assert.equal(ha.devices[DEVICE_ID].properties.target_extra_rinse, 2)
    })

    test('0xEC processes only the fixed-offset current record from a real change frame', () => {
        const { ha, thinq } = makeDevice()
        const updates: Array<[string, string | number | undefined]> = []
        const publishProperty = ha.publishProperty.bind(ha)
        ha.publishProperty = (id, property, value) => {
            updates.push([property, value])
            publishProperty(id, property, value)
        }

        thinq.emit('data', EXPRESS_STARTS_RUNNING)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.status, 'Washing')
        assert.equal(properties.power, 'ON')
        assert.equal(properties.course, 'Express')
        assert.equal(properties.initial_time, 106)
        assert.equal(properties.remaining_time, 106)
        assert.equal(properties.delay_start, 0)
        assert.equal(properties.door, 'CLOSE')
        assert.equal(properties.extra_dry, 'ON')
        assert.equal(properties.high_temp, 'ON')
        assert.equal(properties.remote_start, 'OFF')
        assert.equal(properties.rinse_level, 0)
        assert.equal(properties.salt_level, 1)
        assert.equal(properties.auto_dry, 'ON')
        assert.equal(properties.clean_reminder, 'OFF')
        assert.equal(properties.buzzer_level, 'Low')
        assert.equal(properties.remote_start_mode, 'One-time')
        assert.equal(properties.end_alarm_sound, 'ON')
        assert.equal(properties.brightness, 'HIGH')
        assert.equal(properties.extra_rinse, 1)
        assert.equal(properties.target_extra_rinse, 0)
        assert.deepEqual(
            updates.filter(([property]) => property === 'status'),
            [['status', 'Washing']],
        )
    })

    test('0xEB parses the real single-record reconnect snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDBY_SNAPSHOT)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.status, 'Standby')
        assert.equal(properties.power, 'OFF')
        assert.equal(properties.course, 'Off')
        assert.equal(properties.door, 'CLOSE')
    })

    test('rejects unobserved lengths and malformed fixed record headers', () => {
        const { ha, thinq } = makeDevice()

        const wrongLength = Buffer.concat([
            EXPRESS_STARTS_RUNNING.subarray(0, EXPRESS_STARTS_RUNNING.length - 3),
            EXPRESS_STARTS_RUNNING.subarray(EXPRESS_STARTS_RUNNING.length - 2),
        ])
        thinq.emit('data', wrongLength)

        // A frame carrying a well-formed record header at an offset the appliance never uses.
        const unobservedLength = Buffer.alloc(58)
        unobservedLength[0] = 0xaa
        unobservedLength[1] = unobservedLength.length
        unobservedLength[2] = 0x32
        unobservedLength[3] = 0xec
        unobservedLength[30] = 0x00
        unobservedLength[31] = 0x18
        unobservedLength[unobservedLength.length - 1] = 0xbb
        thinq.emit('data', unobservedLength)

        const malformedRecord = Buffer.from(EXPRESS_STARTS_RUNNING)
        malformedRecord[2 + 48] = 0x06
        thinq.emit('data', malformedRecord)

        assert.equal(ha.devices[DEVICE_ID].properties.status, undefined)
    })

    test('unrecognised codes are published as unavailable instead of out-of-range values', () => {
        const { ha, thinq } = makeDevice()
        const unknownEnums = Buffer.from(EXPRESS_STARTS_RUNNING)
        const dataOffset = 2 + 48 + 2
        unknownEnums[dataOffset] = 0x7f
        unknownEnums[dataOffset + 1] = 0x7f
        unknownEnums[dataOffset + 5] = 0x7f
        unknownEnums[dataOffset + 15] |= 0xc0
        unknownEnums[dataOffset + 16] = 0x00
        unknownEnums[dataOffset + 20] = 0x7f
        unknownEnums[dataOffset + 21] = 0x40

        thinq.emit('data', unknownEnums)

        assert.equal(ha.devices[DEVICE_ID].properties.status, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.process, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.buzzer_level, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start_mode, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.extra_rinse, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.target_extra_rinse, 0)
    })

    test('does not discard a changed energy total merely because its sequence repeats', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', ENERGY_TOTAL_314)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 314)

        thinq.emit('data', ENERGY_TOTAL_346)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 346)
    })

    test('generates captured simple control packets through the public API', () => {
        const cases = [
            ['power', 'ON', 'aa07f0261688bb'],
            ['power', 'OFF', 'aa07f026128cbb'],
            ['pause', 'PRESS', 'aa07f026138fbb'],
            ['resume', 'PRESS', 'aa07f026148ebb'],
            ['cancel', 'PRESS', 'aa07f026118dbb'],
        ] as const

        for (const [property, value, expected] of cases) {
            const { thinq, dev } = makeDevice()
            dev.setProperty(property, value)
            assert.equal(thinq.outbox.length, 1)
            assert.equal(thinq.outbox[0].toString('hex'), expected)
        }
    })

    test('preserves all other captured settings when changing one setting', () => {
        const cases = [
            ['rinse_level', '0', 'aa0ef0260001624040000000e4bb'],
            ['rinse_level', '3', 'aa0ef0260301624040000000e1bb'],
            ['rinse_level', '4', 'aa0ef0260401624040000000e0bb'],
            ['salt_level', '0', 'aa0ef0260000624040000000e5bb'],
            ['salt_level', '2', 'aa0ef0260002624040000000e7bb'],
            ['salt_level', '4', 'aa0ef0260004624040000000e1bb'],
            ['buzzer_level', 'High', 'aa0ef0260001644040000000e6bb'],
            ['buzzer_level', 'Off', 'aa0ef0260001604040000000fabb'],
            ['end_alarm_sound', 'OFF', 'aa0ef026000122404000000024bb'],
            ['clean_reminder', 'ON', 'aa0ef02600016a4040000000ecbb'],
            ['auto_dry', 'OFF', 'aa0ef0260001424040000000c4bb'],
            ['brightness', 'LOW', 'aa0ef026000162400000000024bb'],
            ['remote_start_mode', 'Permanent', 'aa0ef0260001628040000000a4bb'],
        ] as const

        for (const [property, value, expected] of cases) {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', SETTINGS_BASELINE)
            thinq.resetRecorder()

            dev.setProperty(property, value)

            assert.equal(thinq.outbox.length, 1)
            assert.equal(thinq.outbox[0].toString('hex'), expected)
        }
    })

    test('does not send settings before a real status frame initializes the shared values', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('rinse_level', '3')

        assert.equal(thinq.outbox.length, 0)
    })

    test('does not reuse a stale remote-start mode after an unknown status value', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SETTINGS_BASELINE)

        const unknownRemoteMode = Buffer.from(SETTINGS_BASELINE)
        unknownRemoteMode[2 + 48 + 2 + 16] = 0x06
        thinq.emit('data', unknownRemoteMode)
        thinq.resetRecorder()

        dev.setProperty('rinse_level', '3')

        assert.equal(ha.devices[DEVICE_ID].properties.remote_start_mode, 'None')
        assert.equal(thinq.outbox.length, 0)
    })

    test('does not reuse a stale buzzer level after an invalid status bit combination', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SETTINGS_BASELINE)

        const unknownBuzzerLevel = Buffer.from(SETTINGS_BASELINE)
        unknownBuzzerLevel[2 + 48 + 2 + 15] |= 0xc0
        thinq.emit('data', unknownBuzzerLevel)
        thinq.resetRecorder()

        dev.setProperty('rinse_level', '3')

        assert.equal(ha.devices[DEVICE_ID].properties.buzzer_level, 'None')
        assert.equal(thinq.outbox.length, 0)
    })

    test('rejects invalid number, select, switch, and button inputs without sending', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SETTINGS_BASELINE)
        thinq.resetRecorder()

        const invalidInputs = [
            ['power', 'MAYBE'],
            ['pause', 'ON'],
            ['target_course', 'Off'],
            ['target_delay', '13'],
            ['target_delay', '1.5'],
            ['target_high_temp', 'YES'],
            ['target_extra_rinse', '4'],
            ['rinse_level', '5'],
            ['salt_level', '-1'],
            ['buzzer_level', 'LOUD'],
            ['remote_start_mode', 'Disabled'],
            ['auto_dry', 'YES'],
            ['brightness', 'MEDIUM'],
            ['start_course', 'ON'],
        ] as const

        for (const [property, value] of invalidInputs) dev.setProperty(property, value)

        assert.equal(thinq.outbox.length, 0)
    })

    test('generates captured remote-start packets from staged public controls', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('target_course', 'One hour')
        dev.setProperty('target_high_temp', 'ON')
        dev.setProperty('target_extra_dry', 'ON')
        dev.setProperty('target_extra_rinse', '1')
        dev.setProperty('start_course', 'PRESS')

        assert.equal(thinq.outbox[0].toString('hex'), 'aa0df026101200000c080056bb')

        dev.setProperty('target_delay', '1')
        dev.setProperty('start_course', 'PRESS')
        assert.equal(thinq.outbox[1].toString('hex'), 'aa0df026101201000c080051bb')

        const second = makeDevice()
        second.dev.setProperty('target_course', 'Download cycle')
        second.dev.setProperty('start_course', 'PRESS')
        assert.equal(second.thinq.outbox[0].toString('hex'), 'aa0df026100b00000040007dbb')
    })
})
