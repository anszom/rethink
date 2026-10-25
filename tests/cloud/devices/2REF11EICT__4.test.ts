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
const FRAME_CRAFT_ICE_6ICE = buf(
    'AA5C10EC020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF000D0101FF020001FF003A3AFFFFFFFF0100020A050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF020D0101FF020001FF013A3AFFFFFFFF010076BB',
)
const FRAME_CRAFT_ICE_3ICE = buf(
    'AA5C10EC0204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF02120101FF030002FF013A3AFFFFFFFF02000204050102020200000001FFFFFF00FFFF01FFFFFFFFFFFFFF01120101FF030002FF013A3AFFFFFFFF02007CBB',
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
})
