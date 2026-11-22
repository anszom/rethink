import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2RES1VE61PFA2'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2RES1VE61PFA2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Captured initial status at 2°C / -23°C with the door closed, then door-open and door-closed deltas.
const INITIAL_CLOSED = buf('aa2110eb0206090107000200010001ffffff00ff0001ffffffffffffff020288bb')
const DOOR_OPEN = buf(
    'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090107000201010001ffffff00ff0001ffffffffffffff020244bb',
)
const DOOR_CLOSED = buf(
    'aa3c10ec0206090107000201010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
)

// Physical captures from the two-door unit: right fridge and left freezer, without Door-in-Door.
const INDIVIDUAL_DOORS = [
    'aa0810a8020138bb',
    'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090107000201010001ffffff00ff0001ffffffffffffff020244bb',
    'aa0810a8020039bb',
    'aa3c10ec0206090107000201010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
    'aa0810a8010139bb',
    'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090107000201010001ffffff00ff0001ffffffffffffff020244bb',
    'aa0810a801003ebb',
    'aa3c10ec0206090107000201010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
].map(buf)
const OVERLAPPING_DOORS = [
    [
        'aa0810a8020138bb',
        'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090107000201010001ffffff00ff0001ffffffffffffff020244bb',
        'aa0810a8010139bb',
        'aa0810a8020039bb',
        'aa0810a801003ebb',
        'aa3c10ec0206090107000201010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
    ],
    [
        'aa0810a8010139bb',
        'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090107000201010001ffffff00ff0001ffffffffffffff020244bb',
        'aa0810a8020138bb',
        'aa0810a801003ebb',
        'aa0810a8020039bb',
        'aa3c10ec0206090107000201010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
    ],
].map((sequence) => sequence.map(buf))

function doorStates(ha: MockHAConnection) {
    const state = ha.devices[DEVICE_ID].properties
    return [state.fridge_door, state.freezer_door, state.door]
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id, prop, value) => {
        if (id === DEVICE_ID) dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

function commandThroughTopic(ha: MockHAConnection, component: string, value: string) {
    ha.setProperty(DEVICE_ID, component, 'command', value)
}

function statusFrame(
    overrides: Partial<
        Record<'fridge' | 'freezer' | 'door' | 'unit' | 'filter' | 'cool' | 'freeze' | 'smartCare', number>
    >,
) {
    const status = Buffer.from(INITIAL_CLOSED.subarray(4, 31))
    if (overrides.fridge !== undefined) status[1] = overrides.fridge
    if (overrides.freezer !== undefined) status[2] = overrides.freezer
    if (overrides.door !== undefined) status[7] = overrides.door
    if (overrides.unit !== undefined) status[8] = overrides.unit
    if (overrides.filter !== undefined) status[6] = overrides.filter
    if (overrides.cool !== undefined) status[16] = overrides.cool
    if (overrides.freeze !== undefined) status[3] = overrides.freeze
    if (overrides.smartCare !== undefined) status[17] = overrides.smartCare
    return AABBDevice.frame(Buffer.concat([Buffer.from([0x10, 0xeb]), status]))
}

const CONTROLS = [
    {
        label: 'fridge_3',
        prop: 'fridge_setpoint',
        value: '3',
        command: 'aa2ff017ff05ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff91bb',
        response:
            'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020205090107000200010001ffffff00ff0001ffffffffffffff02025abb',
    },
    {
        label: 'fridge_2',
        prop: 'fridge_setpoint',
        value: '2',
        command: 'aa2ff017ff06ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff90bb',
        response:
            'aa3c10ec0205090107000200010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff02025abb',
    },
    {
        label: 'freezer_minus22',
        prop: 'freezer_setpoint',
        value: '-22',
        command: 'aa2ff017ffff08ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff92bb',
        response:
            'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206080107000200010001ffffff00ff0001ffffffffffffff02025abb',
    },
    {
        label: 'freezer_minus23',
        prop: 'freezer_setpoint',
        value: '-23',
        command: 'aa2ff017ffff09ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff9dbb',
        response:
            'aa3c10ec0206080107000200010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff02025abb',
    },
    {
        label: 'express_cool_on',
        prop: 'express_cool',
        value: 'ON',
        command: 'aa2ff017ffffffffffffffffffffffffffffffff01ffffffff000000ffff00ffffffff00ffffffffffffffffffebbb',
        response:
            'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0101ffffffffffffff020244bb',
    },
    {
        label: 'express_cool_off',
        prop: 'express_cool',
        value: 'OFF',
        command: 'aa2ff017ffffffffffffffffffffffffffffffff00ffffffff000000ffff00ffffffff00ffffffffffffffffffe8bb',
        response:
            'aa3c10ec0206090107000200010001ffffff00ff0101ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
    },
    {
        label: 'express_freeze_on',
        prop: 'express_freeze',
        value: 'ON',
        command: 'aa2ff017ffffff02ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffeabb',
        response:
            'aa3c10ec0206090107000200010001ffffff00ff0001ffffffffffffff02020206090207000200010001ffffff00ff0001ffffffffffffff020244bb',
    },
    {
        label: 'express_freeze_off',
        prop: 'express_freeze',
        value: 'OFF',
        command: 'aa2ff017ffffff01ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffebbb',
        response:
            'aa3c10ec0206090207000200010001ffffff00ff0001ffffffffffffff02020206090107000200010001ffffff00ff0001ffffffffffffff020244bb',
    },
].map((fixture) => ({
    ...fixture,
    command: buf(fixture.command),
    response: buf(fixture.response),
}))

describe(MODEL_ID, () => {
    test('startup and reconstruction clear retained compartment states before publishing online', (t) => {
        const ha = new MockHAConnection()
        const publish = t.mock.method(ha, 'publishProperty')
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const dev = new DUT(ha.asConnection(), thinq, META)
        assert.deepEqual(doorStates(ha), ['None', 'None', undefined])
        assert.equal(ha.devices[DEVICE_ID].availability, undefined)

        thinq.emit('data', DOOR_OPEN)
        assert.deepEqual(doorStates(ha), ['None', 'None', 'ON'])
        const online = publish.mock.calls.findIndex((call) => call.arguments[1] === 'availability')
        assert.ok(online >= 0)
        for (const prop of ['fridge_door', 'freezer_door']) {
            const cleared = publish.mock.calls.findIndex(
                (call) => call.arguments[1] === prop && call.arguments[2] === undefined,
            )
            assert.ok(cleared >= 0 && cleared < online, prop)
        }

        thinq.emit('data', INDIVIDUAL_DOORS[4])
        thinq.emit('data', INDIVIDUAL_DOORS[2])
        assert.deepEqual(doorStates(ha), ['ON', 'OFF', 'ON'])
        dev.drop()
        const beforeReconnect = publish.mock.calls.length
        const reconnectedThinq = new MockThinq2Device(DEVICE_ID, META)
        new DUT(ha.asConnection(), reconnectedThinq, META)
        assert.deepEqual(doorStates(ha).slice(0, 2), ['None', 'None'])
        assert.deepEqual(
            publish.mock.calls.slice(beforeReconnect).map((call) => call.arguments),
            [
                [DEVICE_ID, 'fridge_door', undefined],
                [DEVICE_ID, 'freezer_door', undefined],
            ],
        )
        reconnectedThinq.emit('data', DOOR_OPEN)
        assert.deepEqual(doorStates(ha), ['None', 'None', 'ON'])
    })

    test('individual physical captures update the correct read-only compartment and preserve aggregate authority', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [prop, name] of [
            ['fridge_door', 'Fridge door'],
            ['freezer_door', 'Freezer door'],
        ]) {
            assert.equal(components[prop].platform, 'binary_sensor')
            assert.equal(components[prop].device_class, 'door')
            assert.equal(components[prop].name, name)
            assert.equal(components[prop].state_topic, `$this/${prop}`)
            assert.equal(components[prop].command_topic, undefined)
            dev.setProperty(prop, 'ON')
        }
        assert.equal(thinq.outbox.length, 0)
        assert.deepEqual(doorStates(ha), ['OFF', 'OFF', 'OFF'])

        const expected = [
            ['OFF', 'ON', 'OFF'],
            ['OFF', 'ON', 'ON'],
            ['OFF', 'OFF', 'ON'],
            ['OFF', 'OFF', 'OFF'],
            ['ON', 'OFF', 'OFF'],
            ['ON', 'OFF', 'ON'],
            ['OFF', 'OFF', 'ON'],
            ['OFF', 'OFF', 'OFF'],
        ]
        for (const [index, frame] of INDIVIDUAL_DOORS.entries()) {
            thinq.emit('data', frame)
            assert.deepEqual(doorStates(ha), expected[index], `individual capture ${index}`)
        }
    })

    test('physical overlaps preserve the other open compartment through partial closure in both orders', () => {
        const expected = [
            [
                ['OFF', 'ON', 'OFF'],
                ['OFF', 'ON', 'ON'],
                ['ON', 'ON', 'ON'],
                ['ON', 'OFF', 'ON'],
                ['OFF', 'OFF', 'ON'],
                ['OFF', 'OFF', 'OFF'],
            ],
            [
                ['ON', 'OFF', 'OFF'],
                ['ON', 'OFF', 'ON'],
                ['ON', 'ON', 'ON'],
                ['OFF', 'ON', 'ON'],
                ['OFF', 'OFF', 'ON'],
                ['OFF', 'OFF', 'OFF'],
            ],
        ]
        for (const [order, sequence] of OVERLAPPING_DOORS.entries()) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', INITIAL_CLOSED)
            for (const [index, frame] of sequence.entries()) {
                thinq.emit('data', frame)
                assert.deepEqual(doorStates(ha), expected[order][index], `overlap ${order}, capture ${index}`)
            }
        }
    })

    test('Door-in-Door captures keep the fridge-side sensor open until both right-side doors close', () => {
        // @JuzzWuzz reported identical packets for both opening orders, with no events at the middle steps.
        // https://github.com/anszom/rethink/pull/324#issuecomment-6880495170
        const open = buf(
            'aa3c10ec0206030102000600010001ffffff00ff0000ffffffffffffff02790206030102000601010001ffffff00ff0000ffffffffffffff0279babb',
        )
        const closed = buf(
            'aa3c10ec0206030102000601010001ffffff00ff0000ffffffffffffff02790206030102000600010001ffffff00ff0000ffffffffffffff0279babb',
        )
        const { ha, thinq } = makeDevice()
        thinq.emit('data', closed)
        assert.deepEqual(doorStates(ha), ['OFF', 'OFF', 'OFF'])

        thinq.emit('data', buf('aa0810a8010139bb'))
        assert.deepEqual(doorStates(ha), ['ON', 'OFF', 'OFF'])
        thinq.emit('data', open)
        assert.deepEqual(doorStates(ha), ['ON', 'OFF', 'ON'])

        thinq.emit('data', buf('aa0810a801003ebb'))
        assert.deepEqual(doorStates(ha), ['OFF', 'OFF', 'ON'])
        thinq.emit('data', closed)
        assert.deepEqual(doorStates(ha), ['OFF', 'OFF', 'OFF'])
    })

    test('open or invalid aggregate status does not infer or overwrite individual observations', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INDIVIDUAL_DOORS[0])
        thinq.emit('data', DOOR_OPEN)
        assert.deepEqual(doorStates(ha), ['None', 'ON', 'ON'])
        thinq.emit('data', INDIVIDUAL_DOORS[6])
        assert.deepEqual(doorStates(ha), ['OFF', 'ON', 'ON'])

        // Synthetic aggregate values exercise unknown flags; 1 is also present in the captures.
        for (const door of [1, 2, 0xff]) {
            thinq.emit('data', statusFrame({ door }))
            assert.deepEqual(doorStates(ha), ['OFF', 'ON', door === 1 ? 'ON' : 'None'])
        }
    })

    test('closed EB and EC captures resynchronize both compartments after missed close events', () => {
        const { ha, thinq } = makeDevice()
        for (const frame of [INITIAL_CLOSED, DOOR_CLOSED]) {
            thinq.emit('data', INDIVIDUAL_DOORS[0])
            thinq.emit('data', INDIVIDUAL_DOORS[4])
            assert.deepEqual(doorStates(ha).slice(0, 2), ['ON', 'ON'])
            thinq.emit('data', frame)
            assert.deepEqual(doorStates(ha), ['OFF', 'OFF', 'OFF'])
        }
    })

    test('unconfirmed channels and malformed A8 events leave all door states unchanged', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)
        thinq.emit('data', INDIVIDUAL_DOORS[0])
        thinq.emit('data', INDIVIDUAL_DOORS[4])
        const observed = doorStates(ha)

        // Published collaborator capture, not captured from this two-door unit: channel 00 is unconfirmed.
        thinq.emit('data', buf('aa0810a800003fbb'))
        assert.deepEqual(doorStates(ha), observed)

        // Synthetic inner payloads target this handler's exact class, type, length, channel and state guards.
        for (const inner of [
            '10a8',
            '10a801',
            '10a802',
            '10a80100ff',
            '10a80200ff',
            '11a80100',
            '10a90100',
            '10a80000',
            '10a80300',
            '10a8ff00',
            '10a80102',
            '10a80202',
            '10a801ff',
            '10a802ff',
        ]) {
            dev.processAABB(buf(inner))
            assert.deepEqual(doorStates(ha), observed, inner)
        }
    })

    test('real initial and delta captures publish the observed temperatures and door states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device?.config)
        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 2)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -23)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.express_cool, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 2)
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_status, 'Good')

        thinq.emit('data', DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('Smart Learner reports enablement without accepting controls', () => {
        const { ha, thinq, dev } = makeDevice()
        // The captured ON flag agrees with the LG cloud's smartCareV2 state.
        thinq.emit('data', INITIAL_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_learner, 'ON')
        dev.setProperty('smart_learner', 'OFF')
        assert.equal(thinq.outbox.length, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_learner, 'ON')

        // OFF and IGNORE are descriptor-derived, not captured transitions.
        thinq.emit('data', statusFrame({ smartCare: 0 }))
        assert.equal(ha.devices[DEVICE_ID].properties.smart_learner, 'OFF')
        thinq.emit('data', statusFrame({ smartCare: 0xff }))
        assert.equal(ha.devices[DEVICE_ID].properties.smart_learner, 'None')
    })

    test('status request uses the captured query packet', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(thinq.outbox.map(hex), ['AA0EF0ED1211010000010400EBBB'])
    })

    test('replays all captured control responses and decodes their state fields', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)
        for (const fixture of CONTROLS) {
            thinq.emit('data', fixture.response)
            const state = ha.devices[DEVICE_ID].properties
            if (fixture.prop === 'fridge_setpoint')
                assert.equal(state.fridge_setpoint, Number(fixture.value), fixture.label)
            if (fixture.prop === 'freezer_setpoint')
                assert.equal(state.freezer_setpoint, Number(fixture.value), fixture.label)
            if (fixture.prop === 'express_cool') assert.equal(state.express_cool, fixture.value, fixture.label)
            if (fixture.prop === 'express_freeze') assert.equal(state.express_freeze, fixture.value, fixture.label)
        }
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 2)
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_status, 'Good')
    })

    test('all captured controls produce exact payloads without optimistic state changes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)
        const originalState = { ...ha.devices[DEVICE_ID].properties }
        for (const fixture of CONTROLS) {
            thinq.resetRecorder()
            commandThroughTopic(ha, fixture.prop, fixture.value)
            assert.deepEqual(thinq.outbox, [fixture.command], fixture.label)
            assert.deepEqual(ha.devices[DEVICE_ID].properties, originalState, fixture.label)
        }
    })

    test('controls validate values, require a known unit for temperatures, and recover after a bad unit', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('fridge_setpoint', '3')
        dev.setProperty('freezer_setpoint', '-22')
        assert.equal(thinq.outbox.length, 0)

        // Switch controls do not require the unit field.
        dev.setProperty('express_cool', 'ON')
        assert.deepEqual(thinq.outbox, [CONTROLS[4].command])
        thinq.resetRecorder()

        thinq.emit('data', INITIAL_CLOSED)
        thinq.emit('data', statusFrame({ unit: 2 }))
        commandThroughTopic(ha, 'fridge_setpoint', '3')
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', INITIAL_CLOSED)
        commandThroughTopic(ha, 'fridge_setpoint', '3')
        assert.deepEqual(thinq.outbox, [CONTROLS[0].command])

        for (const [prop, invalid] of [
            ['fridge_setpoint', ['', ' ', 'NaN', 'Infinity', '0x2', '2.5', '1e2', '0', '8']],
            ['freezer_setpoint', ['', ' ', 'NaN', 'Infinity', '0x2', '-22.5', '-14', '-24']],
        ] as const) {
            thinq.resetRecorder()
            for (const value of invalid) commandThroughTopic(ha, prop, value)
            assert.equal(thinq.outbox.length, 0, prop)
        }

        thinq.resetRecorder()
        commandThroughTopic(ha, 'express_cool', 'true')
        commandThroughTopic(ha, 'express_freeze', '')
        dev.setProperty('not_a_control', 'ON')
        assert.equal(thinq.outbox.length, 0)
    })

    test('temperature controls accept Celsius range boundaries', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)

        commandThroughTopic(ha, 'fridge_setpoint', '1')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][5], 7)
        thinq.resetRecorder()
        commandThroughTopic(ha, 'fridge_setpoint', '7')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][5], 1)
        thinq.resetRecorder()
        commandThroughTopic(ha, 'freezer_setpoint', '-15')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][6], 1)
        thinq.resetRecorder()
        commandThroughTopic(ha, 'freezer_setpoint', '-23')
        assert.deepEqual(thinq.outbox, [CONTROLS[3].command])
    })

    test('descriptor-derived Fahrenheit uses the shared conversion and range mapping', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statusFrame({ unit: 0 }))
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.min, 33)
        assert.equal(components.fridge_setpoint.max, 43)
        assert.equal(components.freezer_setpoint.min, -7)
        assert.equal(components.freezer_setpoint.max, 5)

        commandThroughTopic(ha, 'fridge_setpoint', '33')
        assert.equal(thinq.outbox[0][5], 11)
        assert.equal(thinq.outbox[0][12], 0)
        thinq.resetRecorder()
        commandThroughTopic(ha, 'freezer_setpoint', '-7')
        assert.equal(thinq.outbox[0][6], 13)
        assert.equal(thinq.outbox[0][12], 0)
    })

    test('filter months follow the descriptor replace threshold and clear with unknown express states', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)
        thinq.emit('data', statusFrame({ filter: 6, cool: 1, freeze: 2 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 6)
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_status, 'Replace')
        assert.equal(ha.devices[DEVICE_ID].properties.express_cool, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')

        thinq.emit('data', statusFrame({ filter: 0xff, cool: 2, freeze: 0 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.express_cool, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'None')

        thinq.emit('data', statusFrame({ filter: 13 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter_months, 'None')
    })

    test('invalid fields clear stale values while independently valid fields still update', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_CLOSED)

        thinq.emit('data', statusFrame({ unit: 2, door: 1 }))
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, 'None')

        thinq.emit('data', statusFrame({ door: 2, fridge: 0, freezer: 0 }))
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, 'None')
    })

    test('invalid unit before the first valid status does not publish guessed metadata', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', statusFrame({ unit: 2 }))
        assert.equal(ha.devices[DEVICE_ID].config, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, undefined)
    })
})
