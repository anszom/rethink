import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WLREL6323S'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WLREL6323S'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '20160616' }

// Real WLREL6323S packets captured on 2026-08-30 while operating the physical range panel.
// EC frames contain a previous 62-byte record followed by the current 62-byte record.
const IDLE_INITIAL_STATUS = buf(
    'AA4440EB0000000000000000000000000000000E0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000072BB',
)

// Left-front, left-rear, and right-front tests all produced this same aggregate transition.
const COOKTOP_OFF_TO_ON = buf(
    'AA8240EC0000000000000000000000000000000E0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000001000100000000000000000000000000000000000000000000003BBB',
)
const COOKTOP_ON_TO_OFF = buf(
    'AA8240EC00000000000000000000000000000006000000000000000000000000000000000000000001000100000000000000000000000000000000000000000000000000000000000000000000000000000E000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003BBB',
)
// The center-rear warming zone uses the adjacent pair of aggregate bytes (37 and 39).
const WARMING_ZONE_OFF_TO_ON = buf(
    'AA8240EC0000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000010001000000000000000000000000000000000000000000000033BB',
)

const OVEN_DOOR_CLOSED_TO_OPEN = buf(
    'aa8240ec0000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029bb',
)
const OVEN_DOOR_OPEN_TO_CLOSED = buf(
    'aa8240ec0000000000000000000000080000000e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000029bb',
)

// Panel-started Bake at 350°F (0x015E), followed by Cancel/Off ten seconds later.
const BAKE_350_PREHEATING = buf(
    'aa8240ec00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000101000000015e0000000000000000230000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000089bb',
)
const BAKE_CANCELLED = buf(
    'aa8240ec0101000000015e000000000000000023000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000bfbb',
)

// Additional panel-started modes captured on 2026-09-07. Each frame's current record
// identifies the mode independently of the mode-specific set-temperature behavior.
const CONVECTION_BAKE_PREHEATING = buf(
    'aa8240ec0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010300000001450000000000000000230000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000090bb',
)
const CONVECTION_ROAST_PREHEATING = buf(
    'aa8240ec0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010400000001450000000000000000230000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000093bb',
)
const AIR_FRY_COOKING = buf(
    'aa8240ec000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002100000000190000000000000000023000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004bbb',
)
const BROIL_COOKING = buf(
    'aa8240ec00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000207000000000000000000000000004200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f6bb',
)
const WARM_COOKING = buf(
    'aa8240ec00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000208000000000000000000000000004200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f1bb',
)
const EASY_CLEAN = buf(
    'aa8240ec0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000090d000a00000000000000000000004200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000efbb',
)
const SELF_CLEAN = buf(
    'aa8240ec0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000090f000004000000000000000000004200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e3bb',
)
const SELF_CLEAN_CANCELLED = buf(
    'aa8240ec090f313b0300000000000001000000420000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000100000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007cbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('publishes read-only oven and aggregate cooktop components', () => {
        const { ha } = makeDevice()
        const config = ha.devices[DEVICE_ID].config
        assert.ok(config)

        const components = config.components as Record<string, Record<string, unknown>>
        assert.equal(components.cooktop_status.platform, 'binary_sensor')
        assert.equal(components.oven_status.device_class, 'enum')
        assert.deepEqual(components.oven_status.options, ['Idle', 'Preheating', 'Cooking', 'Cooling', 'Cleaning'])
        assert.equal(components.oven_mode.device_class, 'enum')
        assert.deepEqual(components.oven_mode.options, [
            'None',
            'Bake',
            'Convection Bake',
            'Convection Roast',
            'Broil',
            'Warm',
            'EasyClean',
            'Self Clean',
            'Air Fry',
        ])
        assert.equal(components.oven_set_temperature.unit_of_measurement, '°F')
        assert.equal(components.oven_door.device_class, 'door')
        assert.equal(components.oven_door.icon, undefined)
        assert.equal(components.oven_status.command_topic, undefined)
        assert.equal(components.clock_sync.platform, 'button')
        assert.equal(components.clock_sync.command_topic, '$this/clock_sync/set')
        assert.equal(components.clock_format.platform, 'select')
        assert.deepEqual(components.clock_format.options, ['12-hour', '24-hour'])
        assert.equal(components.clock_format.optimistic, true)
        assert.equal(components.beeper_volume.platform, 'select')
        assert.deepEqual(components.beeper_volume.options, ['High', 'Mute'])
        assert.equal(components.beeper_volume.optimistic, true)
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

    test('decodes the initial idle status', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', IDLE_INITIAL_STATUS)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            oven_status: 'Idle',
            oven_mode: 'None',
            oven_set_temperature: 'None',
            oven_door: 'OFF',
            cooktop_status: 'OFF',
        })
    })

    test('decodes aggregate cooktop on and off transitions from the current EC record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COOKTOP_OFF_TO_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop_status, 'ON')

        thinq.emit('data', COOKTOP_ON_TO_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop_status, 'OFF')
    })

    test('includes the warming zone in aggregate cooktop status', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', WARMING_ZONE_OFF_TO_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop_status, 'ON')
    })

    test('decodes oven door open and closed transitions', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OVEN_DOOR_CLOSED_TO_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_door, 'ON')

        thinq.emit('data', OVEN_DOOR_OPEN_TO_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_door, 'OFF')
    })

    test('decodes panel-started Bake at 350°F and cancellation', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', BAKE_350_PREHEATING)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_status, 'Preheating')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_mode, 'Bake')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_set_temperature, 350)

        thinq.emit('data', BAKE_CANCELLED)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_status, 'Idle')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_mode, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_set_temperature, 'None')
    })

    test('decodes every captured cooking mode', () => {
        const { ha, thinq } = makeDevice()
        const cases = [
            [CONVECTION_BAKE_PREHEATING, 'Preheating', 'Convection Bake', 325],
            [CONVECTION_ROAST_PREHEATING, 'Preheating', 'Convection Roast', 325],
            [AIR_FRY_COOKING, 'Cooking', 'Air Fry', 400],
            [BROIL_COOKING, 'Cooking', 'Broil', 'None'],
            [WARM_COOKING, 'Cooking', 'Warm', 'None'],
            [EASY_CLEAN, 'Cleaning', 'EasyClean', 'None'],
            [SELF_CLEAN, 'Cleaning', 'Self Clean', 'None'],
            [SELF_CLEAN_CANCELLED, 'Cooling', 'None', 'None'],
        ] as const

        for (const [packet, status, mode, temperature] of cases) {
            thinq.emit('data', packet)
            assert.equal(ha.devices[DEVICE_ID].properties.oven_status, status)
            assert.equal(ha.devices[DEVICE_ID].properties.oven_mode, mode)
            assert.equal(ha.devices[DEVICE_ID].properties.oven_set_temperature, temperature)
        }
    })

    test('does not mask unknown oven-mode bits into a known mode', () => {
        assert.equal(DUT.formatOvenMode(0x81), undefined)
    })

    // Sent to a live WLREL6323S on 2026-09-10, both acknowledged 40 00 43 00. The first (13:11,
    // byte 2 = 0x00) switched the display to 24-hour; the second (1:13 with byte 2 = 0x01) restored
    // 12-hour, confirmed at the panel.
    test('clock writes reproduce both frames verified on the appliance', () => {
        const { thinq, dev } = makeDevice()

        dev.sendClock(13, 11, 0x00)
        dev.sendClock(13, 13, 0x01)

        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E0D0B008080808080808080FF80EDBB')
        assert.equal(hex(thinq.outbox[1]), 'AA15F043210E010D018080808080808080FF80FABB')
    })

    test('12-hour clock writes carry midnight and noon as 12', () => {
        const { thinq, dev } = makeDevice()

        dev.sendClock(0, 5, 0x01)
        dev.sendClock(12, 5, 0x01)

        assert.equal(thinq.outbox[0][6], 12)
        assert.equal(thinq.outbox[1][6], 12)
    })

    test('clock sync keeps the 12-hour format until another is selected', () => {
        const { thinq, dev } = makeDevice()
        const payload = (frame: Buffer) => frame.subarray(6, frame.length - 2)

        dev.setProperty('clock_sync', 'PRESS')
        assert.equal(payload(thinq.outbox[0])[2], 0x01)
        assert.ok(payload(thinq.outbox[0])[0] >= 1 && payload(thinq.outbox[0])[0] <= 12)
        assert.deepEqual([...payload(thinq.outbox[0]).subarray(3)], [...Array(8).fill(0x80), 0xff, 0x80])

        // Selecting a format re-sends the time in it, and later syncs follow the selection.
        dev.setProperty('clock_format', '24-hour')
        dev.setProperty('clock_sync', 'PRESS')
        assert.equal(thinq.outbox.length, 3)
        assert.equal(payload(thinq.outbox[1])[2], 0x00)
        assert.equal(payload(thinq.outbox[2])[2], 0x00)
        assert.ok(payload(thinq.outbox[2])[0] < 24)
    })

    // Mute was sent live and silenced the panel keys; High (0x02) brought them back.
    test('beeper volume writes only payload index 11', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('beeper_volume', 'Mute')
        dev.setProperty('beeper_volume', 'High')

        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E8080808080808080808080008074BB')
        const high = thinq.outbox[1].subarray(6, thinq.outbox[1].length - 2)
        high.forEach((value, index) => assert.equal(value, index === 11 ? 0x02 : 0x80, `payload index ${index}`))
    })

    test('invalid preference values send nothing', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('clock_sync', 'not-a-press')
        dev.setProperty('clock_format', '36-hour')
        dev.setProperty('beeper_volume', 'Deafening')
        assert.equal(thinq.outbox.length, 0)
    })

    test('write acknowledgements are consumed without publishing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA084000430060BB'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('ignores frames outside the AA..BB envelope and unexpected status lengths', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        thinq.emit('data', buf('AA0840EB000073BB'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
