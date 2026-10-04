import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF11EICT__4'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF11EICT__4'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '' }

// Real frames captured from an LRYXC2606S through the rethink bridge, confirmed against the app.
const FRAME_BASELINE = buf(
    'AA5C10EC020B060102020201000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF0100020B060102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF010058BB',
)
const FRAME_DOOR_OPEN = buf(
    'AA5C10EC020B060102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF0100020B060102020201000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF010058BB',
)
const FRAME_ICE_PLUS_ON = buf(
    'AA5C10EC020B060102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF0100020B060202020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF010058BB',
)
const FRAME_SABBATH_ON = buf(
    'AA5C10EC020B060202020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF0100020B060102020200000001FFFFFF01FFFF01FFFFFFFFFFFFFF00010101FF020001FF003A3AFFFFFFFF01005BBB',
)
const FRAME_NIGHT_VIEW_OFF = buf(
    'AA5C10EC020B060102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00040105FF020001FF003A3AFFFFFFFF0100020B060102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00050105FF000001FF003A3AFFFFFFFF01004CBB',
)
const FRAME_CRAFT_ICE_6ICE = buf(
    'AA5C10EC020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF000D0101FF020001FF003A3AFFFFFFFF0100020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF020D0101FF020001FF013A3AFFFFFFFF010076BB',
)
const FRAME_CRAFT_ICE_3ICE = buf(
    'AA5C10EC0204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF02120101FF030002FF013A3AFFFFFFFF02000204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02007CBB',
)
const FRAME_SET_TIME_MODE = buf(
    'AA5C10EC020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF000F0101FF020001FF003A3AFFFFFFFF0100020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00100101FF030001FF003A3AFFFFFFFF010073BB',
)
const FRAME_SMART_LEARNER_OFF = buf(
    'AA5C10EC0204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02000204050102020200000001FFFFFF00FFFF00FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF020072BB',
)
const FRAME_USAGE_BEFORE_DISPENSE = buf(
    'AA3810C5D80801000000000F020000000000030000000003110000000146120000000000130000000040210000000000220000000000FABB',
)
const FRAME_USAGE_AFTER_DISPENSE = buf(
    'AA3810C5DA0801000000000F0200000000000300000000031100000001461200000000001300000000402103E60003E6220000000000D6BB',
)
// Real panel toggle: fridge 40°F -> 4°C, freezer 1°F -> -17°C (both read off the physical display).
const FRAME_UNIT_F = buf(
    'AA5C10EC0204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02000204050102020201000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02007CBB',
)
const FRAME_UNIT_C = buf(
    'AA5C10EC0204050102020201000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02000205050102020201010001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF020079BB',
)
// Real transition caught live: Mini Cubed Ice went "Making ice" -> "Full ice bin" in the app.
const FRAME_MINI_CUBED_MAKING = buf(
    'AA5C10EC0204050102020201000001FFFFFF00FFFF01FFFFFFFFFFFFFF00120103FF030001FF003A3AFFFFFFFF01000204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00120103FF030001FF003A3AFFFFFFFF010070BB',
)
const FRAME_MINI_CUBED_FULL = buf(
    'AA5C10EC0204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00120103FF030001FF003A3AFFFFFFFF01000204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF00120103FF030001FF003A3AFFFFFFFF020070BB',
)
// Same frame as FRAME_CRAFT_ICE_6ICE — Craft Ice status also read "Making ice" there.
const FRAME_CRAFT_ICE_MAKING = FRAME_CRAFT_ICE_6ICE
// Real snapshot: Crushed/Cubed and Mini Cubed Ice both read "Full ice bin" simultaneously.
const FRAME_BOTH_FULL = buf(
    'AA5C10EC0205050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF0200020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02007ABB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function props(ha: MockHAConnection) {
    return ha.devices[DEVICE_ID].properties
}

function lastSent(thinq: MockThinq2Device) {
    return thinq.outbox[thinq.outbox.length - 1].toString('hex').toUpperCase()
}

describe(MODEL_ID, () => {
    test('config exposes only the confirmed fields; only door is read-only', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')
        const readOnly = new Set([
            'door',
            'fresh_air_filter',
            'water_filter',
            'water_dispensed',
            'mini_cubed_ice',
            'craft_ice_status',
            'crushed_cubed_ice',
        ])
        for (const [name, comp] of Object.entries(components)) {
            const expected = readOnly.has(name) ? undefined : `$this/${name}/set`
            assert.equal((comp as Record<string, unknown>).command_topic, expected, name)
        }
    })

    test('setpoints decode from the app-confirmed baseline', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).fridge_setpoint, 33)
        assert.equal(props(ha).freezer_setpoint, 0)
    })

    test('door, Ice Plus and Sabbath Mode decode', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).door, 'OFF')
        assert.equal(props(ha).ice_plus, 'OFF')
        assert.equal(props(ha).sabbath_mode, 'OFF')

        thinq.emit('data', FRAME_DOOR_OPEN)
        assert.equal(props(ha).door, 'ON')

        thinq.emit('data', FRAME_ICE_PLUS_ON)
        assert.equal(props(ha).ice_plus, 'ON')

        thinq.emit('data', FRAME_SABBATH_ON)
        assert.equal(props(ha).sabbath_mode, 'ON')
        assert.equal(props(ha).ice_plus, 'OFF')
    })

    test('Smart Learner decodes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).smart_learner, 'ON')

        thinq.emit('data', FRAME_SMART_LEARNER_OFF)
        assert.equal(props(ha).smart_learner, 'OFF')
    })

    test('Night View mode decodes all three states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).night_view, 'Sunset to Sunrise')

        thinq.emit('data', FRAME_NIGHT_VIEW_OFF)
        assert.equal(props(ha).night_view, 'Off')

        thinq.emit('data', FRAME_SET_TIME_MODE)
        assert.equal(props(ha).night_view, 'Set Time')
    })

    test('Craft Ice decodes all three states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).craft_ice, 'Off')

        thinq.emit('data', FRAME_CRAFT_ICE_6ICE)
        assert.equal(props(ha).craft_ice, '6 ICE')

        thinq.emit('data', FRAME_CRAFT_ICE_3ICE)
        assert.equal(props(ha).craft_ice, '3 ICE')
    })

    test('Mini Cubed Ice status decodes a Making ice -> Full ice bin transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_MINI_CUBED_MAKING)
        assert.equal(props(ha).mini_cubed_ice, 'Making ice')

        thinq.emit('data', FRAME_MINI_CUBED_FULL)
        assert.equal(props(ha).mini_cubed_ice, 'Full ice bin')
    })

    test('Craft Ice status decodes "Off" and "Making ice"', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).craft_ice_status, 'Off')

        thinq.emit('data', FRAME_CRAFT_ICE_MAKING)
        assert.equal(props(ha).craft_ice_status, 'Making ice')
    })

    test('Crushed/Cubed and Mini Cubed Ice both decode "Full ice bin"', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BOTH_FULL)
        assert.equal(props(ha).crushed_cubed_ice, 'Full ice bin')
        assert.equal(props(ha).mini_cubed_ice, 'Full ice bin')
    })

    test('Sabbath Set Schedule commands match what the app sent, byte for byte', () => {
        const { dev, thinq } = makeDevice()

        dev.setProperty('sabbath_set_schedule', 'ON')
        assert.equal(lastSent(thinq), 'AA13F010011A0A090124001A0A0901240037BB')

        dev.setProperty('sabbath_set_schedule', 'OFF')
        assert.equal(lastSent(thinq), 'AA13F01000000000000000000000000000E8BB')
    })

    test('fridge/freezer setpoints decode in both F and C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_UNIT_F)
        assert.equal(props(ha).fridge_setpoint, 40)
        assert.equal(props(ha).freezer_setpoint, 1)
        let components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°F')

        thinq.emit('data', FRAME_UNIT_C)
        assert.equal(props(ha).fridge_setpoint, 4)
        assert.equal(props(ha).freezer_setpoint, -17)
        components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
    })

    test('water dispensed tracks a 24oz dispense', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_USAGE_BEFORE_DISPENSE)
        assert.equal(props(ha).water_dispensed, 0)

        thinq.emit('data', FRAME_USAGE_AFTER_DISPENSE)
        assert.equal(props(ha).water_dispensed, 0.998)
    })

    test('filter life decodes from the app-confirmed baseline', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRAME_BASELINE)
        assert.equal(props(ha).fresh_air_filter, 58)
        assert.equal(props(ha).water_filter, 58)
    })

    test('every command matches what the LG app sent, byte for byte', () => {
        const { dev, thinq } = makeDevice()
        const cases: [string, string, string][] = [
            [
                'ice_plus',
                'ON',
                'AA7CF017FFFFFF02FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB',
            ],
            [
                'sabbath_mode',
                'ON',
                'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFF01FFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB',
            ],
            [
                'sabbath_mode',
                'OFF',
                'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBCBB',
            ],
            [
                'freezer_setpoint',
                '1',
                'AA7CF017FFFF05FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBABB',
            ],
            [
                'fridge_setpoint',
                '34',
                'AA7CF017FF0AFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA1BB',
            ],
            [
                'craft_ice',
                '6 ICE',
                'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FF0200FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB',
            ],
            [
                'craft_ice',
                'Off',
                'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FF0000FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBCBB',
            ],
            [
                'craft_ice',
                '3 ICE',
                'AA7CF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FF0100FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB',
            ],
        ]
        for (const [prop, value, expected] of cases) {
            dev.setProperty(prop, value)
            assert.equal(lastSent(thinq), expected, `${prop}=${value}`)
        }
    })

    // Builds on prior state in capture order — Night View resends full state on every write, so
    // each step's expected bytes depend on what the previous step set.
    test('Night View commands match what the app sent, byte for byte, across a stateful sequence', () => {
        const { dev, thinq } = makeDevice()

        dev.setProperty('night_view', 'Sunset to Sunrise')
        assert.equal(lastSent(thinq), 'AA16F01002011A0A05012C001A0A050E0E00001E29BB')

        dev.setProperty('night_view_level', '70')
        assert.equal(lastSent(thinq), 'AA16F01002011A0A05012C001A0A050E0E000046F1BB')

        dev.setProperty('night_view', 'Off')
        assert.equal(lastSent(thinq), 'AA16F010020000000000000000000000000000465DBB')

        dev.setProperty('night_view', 'Sunset to Sunrise')
        assert.equal(lastSent(thinq), 'AA16F01002011A0A05012C001A0A050E0E000046F1BB')

        dev.setProperty('night_view_end_time', '06:00:00')
        dev.setProperty('night_view_start_time', '21:00:00')
        assert.equal(lastSent(thinq), 'AA16F01002021A0A050100001A0A050A0000004632BB')

        dev.setProperty('night_view_end_time', '05:00:00')
        dev.setProperty('night_view_start_time', '22:00:00')
        assert.equal(lastSent(thinq), 'AA16F01002021A0A050200001A0A05090000004632BB')

        dev.setProperty('night_view_end_time', '06:15:00')
        dev.setProperty('night_view_start_time', '21:30:00')
        assert.equal(lastSent(thinq), 'AA16F01002021A0A05011E001A0A050A0F000046C1BB')
    })
})
