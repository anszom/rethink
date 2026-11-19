import { describe, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Device from '@/cloud/devices/2REF11EID___2'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq1Device } from '@/tests/helpers/mocks'
import type { Metadata } from '@/cloud/thinq'

const id = 'test-fridge'
const meta: Metadata = { modelId: '2REF11EID___2', modelName: 'LFXC22526S' }
// LFXC22526S capture: panel 34 F / -2 F, all doors closed.
const captured = Buffer.from('020d0a01020205000000ffffffff00', 'hex')
// Live sequence: closed, refrigerator open, closed, freezer open, closed.
const doorSequence = [
    '020d0a01020205000000ffffffff00',
    '020d0a01020205010000ffffffff00',
    '020d0a01020205000000ffffffff00',
    '020d0a01020205010000ffffffff00',
    '020d0a01020205000000ffffffff00',
]
function discovered(ha: MockHAConnection) {
    return ha.devices[id].config!.components as Record<string, Record<string, unknown>>
}

function setup(t: TestContext, initial = captured) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(id, meta)
    const device = new Device(ha.asConnection(), thinq, meta)
    t.after(() => device.drop())
    device.start()
    thinq.emit('data', initial)
    thinq.resetRecorder()
    return { ha, thinq, device }
}

describe(meta.modelId, () => {
    test('live 15-byte sample decodes the physical panel setpoints', (t) => {
        const { ha } = setup(t)
        const state = ha.devices[id].properties
        assert.equal(state.fridge_setpoint, 34)
        assert.equal(state.freezer_setpoint, -2)
        assert.equal(state.door, 'OFF')
    })

    test('captured door sequence covers refrigerator and freezer opening and closing', (t) => {
        const { ha, thinq } = setup(t)
        const result = []
        for (const packet of doorSequence) {
            thinq.emit('data', Buffer.from(packet, 'hex'))
            result.push(ha.devices[id].properties.door)
        }
        assert.deepEqual(result, ['OFF', 'ON', 'OFF', 'ON', 'OFF'])
        assert.equal(ha.devices[id].properties.fridge_setpoint, 34)
        assert.equal(ha.devices[id].properties.freezer_setpoint, -2)
    })

    test('polls for fresh snapshots every three seconds and stops on disconnect', (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
        const { thinq, device } = setup(t)
        device.start() // repeated start must not create a second poller
        t.mock.timers.tick(9000)
        assert.deepEqual(thinq.sent, Array(3).fill({ Cmd: 'Mon', CmdOpt: 'Start' }))
        device.drop()
        thinq.resetRecorder()
        t.mock.timers.tick(9000)
        assert.deepEqual(thinq.sent, [])
    })

    test('missed status responses expire availability and control state, then recover', (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
        const { ha, thinq, device } = setup(t)
        assert.equal(ha.devices[id].availability, 'online')
        t.mock.timers.tick(90000)
        assert.equal(ha.devices[id].availability, 'offline')
        thinq.resetRecorder()
        device.setProperty('fridge_setpoint', '36')
        assert.deepEqual(thinq.sent, [])
        const publish = t.mock.method(ha, 'publishProperty')
        device.publishConfig()
        assert.equal(ha.devices[id].availability, 'offline', 'HA restart must not revive stale readings')
        assert.equal(
            publish.mock.calls.some((call) => call.arguments[1] === 'availability' && call.arguments[2] === 'online'),
            false,
        )
        thinq.emit('data', captured)
        assert.equal(ha.devices[id].availability, 'online')
    })

    test('ThinQ1 registry selects the new model handler', (t) => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq1Device(id, meta)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        const device = bridge.haDevices.get(id)!
        t.after(() => bridge.dropDevice(device))
        thinq.emit('data', captured)
        assert.equal(ha.devices[id].properties.fridge_setpoint, 34)
    })

    test('control follows LG SetControl template while preserving unrelated settings', (t) => {
        const { thinq, device, ha } = setup(t)
        device.setProperty('fridge_setpoint', '36')
        assert.deepEqual(thinq.sent, [
            {
                Cmd: 'Control',
                CmdOpt: 'Set',
                Value: 'ControlData',
                Format: 'B64',
                Data: Buffer.from('0b0a010202050000ffffffffff00', 'hex').toString('base64'),
            },
        ])
        assert.equal(ha.devices[id].properties.fridge_setpoint, 34, 'wait for device confirmation')
        device.setProperty('freezer_setpoint', '-1')
        assert.equal(Buffer.from(thinq.sent[1].Data as string, 'base64')[1], 9)
    })

    test('a second target write does not undo an unconfirmed first write', (t) => {
        const { thinq, device } = setup(t)
        device.setProperty('fridge_setpoint', '36')
        thinq.emit('data', captured) // device has not echoed the first write yet
        device.setProperty('freezer_setpoint', '-1')
        const data = Buffer.from((thinq.sent[1] as { Data: string }).Data, 'base64')
        assert.equal(data[0], 11, 'preserve pending 36 F target')
        assert.equal(data[1], 9, 'apply new -1 F target')
    })

    test('rejects unsupported gaps in the Fahrenheit freezer table and malformed values', (t) => {
        const { thinq, device } = setup(t)
        for (const value of ['-5', '7', '0.5', '', ' ', 'NaN', 'Infinity', '-20']) {
            device.setProperty('freezer_setpoint', value)
        }
        assert.deepEqual(thinq.sent, [])
    })

    test('Celsius uses model lookup codes rather than arithmetic conversion', (t) => {
        const { thinq, device, ha } = setup(t)
        // Derived from LG's modelJSON, not a captured Celsius-mode frame.
        const celsius = Buffer.from(captured)
        celsius[1] = 14
        celsius[2] = 13
        celsius[8] = 1
        thinq.emit('data', celsius)
        assert.equal(ha.devices[id].properties.fridge_setpoint, 1)
        assert.equal(ha.devices[id].properties.freezer_setpoint, -21)
        device.setProperty('fridge_setpoint', '4')
        const data = Buffer.from((thinq.sent[0] as { Data: string }).Data, 'base64')
        assert.equal(data[0], 9)
        assert.equal(data[7], 1)
    })

    test('truncated snapshots invalidate the buffer needed for control', (t) => {
        const { thinq, device } = setup(t)
        thinq.emit('data', captured.subarray(0, 8))
        device.setProperty('fridge_setpoint', '36')
        assert.deepEqual(thinq.sent, [])
    })

    test('unknown units do not produce plausible temperatures or accept writes', (t) => {
        const { thinq, device, ha } = setup(t)
        const invalid = Buffer.from(captured)
        invalid[8] = 255
        thinq.emit('data', invalid)
        assert.equal(ha.devices[id].properties.fridge_setpoint, 'None')
        device.setProperty('fridge_setpoint', '36')
        assert.deepEqual(thinq.sent, [])
    })

    test('an unknown door value is never reported as closed', (t) => {
        const { thinq, device, ha } = setup(t)
        const invalid = Buffer.from(captured)
        invalid[7] = 255
        thinq.emit('data', invalid)
        assert.equal(ha.devices[id].properties.door, 'None')
        assert.equal(ha.devices[id].availability, 'offline', 'HA must not retain an available closed-door state')
        assert.equal(ha.devices[id].properties.fridge_setpoint, 34)
        thinq.emit('data', captured)
        assert.equal(ha.devices[id].availability, 'online')
    })

    test('live snapshot decodes the additional reported features without inventing unavailable ones', (t) => {
        const { ha } = setup(t)
        const props = ha.devices[id].properties
        const expected = {
            ice_plus: 'OFF',
            fresh_air_filter_mode: 'Auto',
            fresh_air_filter_status: 'Auto',
            fresh_air_filter_replace: 'OFF',
            water_filter_used_months: 5,
            water_filter_remaining_months: 1,
            water_filter_replace: 'OFF',
            smart_saving_mode: 'Delay defrost',
            smart_saving_active: 'OFF',
            sabbath_mode: 'OFF',
            temperature_unit: '°F',
        }
        for (const [key, value] of Object.entries(expected)) {
            assert.equal(props[key], value, key)
            assert.equal(props[`${key}/availability`], 'online', key)
        }
        assert.equal(discovered(ha).display_lock, undefined)
        for (const unsupported of ['active_saving', 'eco_friendly', 'middle_temperature']) {
            assert.equal(discovered(ha)[unsupported], undefined)
        }
    })

    test('Ice Plus commands use codes 2/1, preserve all other settings, and wait for a device echo', (t) => {
        const { ha, thinq, device } = setup(t)
        device.setProperty('ice_plus', 'ON')
        assert.equal(
            (thinq.sent[0] as { Data: string }).Data,
            Buffer.from('0d0a020202050000ffffffffff00', 'hex').toString('base64'),
        )
        assert.equal(ha.devices[id].properties.ice_plus, 'OFF')
        const enabled = Buffer.from(captured)
        enabled[3] = 2
        thinq.emit('data', enabled)
        assert.equal(ha.devices[id].properties.ice_plus, 'ON')
        device.setProperty('ice_plus', 'OFF')
        assert.equal(Buffer.from((thinq.sent[1] as { Data: string }).Data, 'base64')[2], 1)
    })

    test('Sabbath, filter mode and smart saving commands follow their exact model enums', (t) => {
        const { thinq, device } = setup(t)
        const actions: [string, string, number, number][] = [
            ['sabbath_mode', 'ON', 13, 1],
            ['sabbath_mode', 'OFF', 13, 0],
            ['fresh_air_filter_mode', 'Power', 3, 3],
            ['fresh_air_filter_mode', 'Auto', 3, 2],
            ['smart_saving_mode', 'Off', 4, 0],
            ['smart_saving_mode', 'Demand response', 4, 3],
            ['smart_saving_mode', 'Delay defrost', 4, 2],
        ]
        for (const [key, value, index, expected] of actions) {
            thinq.resetRecorder()
            device.setProperty(key, value)
            assert.equal(thinq.sent.length, 1, `${key}=${value}`)
            const data = Buffer.from((thinq.sent[0] as { Data: string }).Data, 'base64')
            assert.equal(data[index], expected)
            assert.equal(data[0], 13, 'fridge target retained')
            assert.equal(data[1], 10, 'freezer target retained')
            assert.equal(data[5], 5, 'water filter age retained')
            assert.equal(data[7], 0, 'temperature unit retained')
            assert.deepEqual([...data.subarray(8, 13)], Array(5).fill(255))
        }
    })

    test('consecutive feature and temperature writes preserve every outstanding change', (t) => {
        const { thinq, device } = setup(t)
        device.setProperty('ice_plus', 'ON')
        thinq.emit('data', captured) // poll can return pre-command state
        device.setProperty('sabbath_mode', 'ON')
        device.setProperty('fridge_setpoint', '35')
        const data = Buffer.from((thinq.sent[2] as { Data: string }).Data, 'base64')
        assert.equal(data[0], 12)
        assert.equal(data[1], 10)
        assert.equal(data[2], 2)
        assert.equal(data[13], 1)
    })

    test('rejects malformed feature commands and writes to read-only fields', (t) => {
        const { thinq, device } = setup(t)
        for (const [key, value] of [
            ['ice_plus', 'true'],
            ['ice_plus', '0'],
            ['sabbath_mode', 'off'],
            ['fresh_air_filter_mode', 'Replace'],
            ['smart_saving_mode', 'Unknown'],
            ['temperature_unit', '°C'],
            ['water_filter_used_months', '0'],
            ['water_filter_reset', 'RESET'],
            ['display_lock', 'Locked'],
            ['smart_saving_active', 'ON'],
            ['fresh_air_filter_status', 'Replace'],
            ['toString', 'ON'],
            ['__proto__', 'OFF'],
        ])
            device.setProperty(key, value)
        assert.deepEqual(thinq.sent, [])
    })

    test('255-valued optional fields are not discovered as off, zero or unlocked', (t) => {
        const unavailable = Buffer.from(captured)
        for (const index of [3, 4, 5, 6, 9, 10, 14]) unavailable[index] = 255
        const { ha, thinq, device } = setup(t, unavailable)
        const components = discovered(ha)
        for (const name of [
            'ice_plus',
            'fresh_air_filter_mode',
            'water_filter_used_months',
            'smart_saving_mode',
            'smart_saving_active',
            'sabbath_mode',
            'display_lock',
        ]) {
            assert.equal(components[name], undefined, name)
        }
        assert.equal(ha.devices[id].availability, 'online', 'core sensors still work')
        device.setProperty('ice_plus', 'ON')
        assert.deepEqual(thinq.sent, [])
    })

    test('unknown optional state expires only that entity and recovers without losing discovery', (t) => {
        const { ha, thinq, device } = setup(t)
        const uniqueId = discovered(ha).ice_plus.unique_id
        device.setProperty('ice_plus', 'ON')
        const unknown = Buffer.from(captured)
        unknown[3] = 255
        thinq.emit('data', unknown)
        assert.equal(ha.devices[id].properties['ice_plus/availability'], 'offline')
        assert.equal(ha.devices[id].availability, 'online')
        assert.equal(discovered(ha).ice_plus.unique_id, uniqueId)
        thinq.resetRecorder()
        device.setProperty('ice_plus', 'ON')
        assert.deepEqual(thinq.sent, [])
        device.setProperty('fridge_setpoint', '35')
        assert.equal(
            Buffer.from((thinq.sent[0] as { Data: string }).Data, 'base64')[2],
            255,
            'discard pending writes for a field that stopped reporting valid state',
        )
        thinq.emit('data', captured)
        assert.equal(ha.devices[id].properties['ice_plus/availability'], 'online')
    })

    test('filter replacement states do not become selectable modes or false remaining time', (t) => {
        const { ha, thinq, device } = setup(t)
        const replacement = Buffer.from(captured)
        replacement[4] = 4
        replacement[6] = 6
        thinq.emit('data', replacement)
        const props = ha.devices[id].properties
        assert.equal(props.fresh_air_filter_status, 'Replace')
        assert.equal(props.fresh_air_filter_replace, 'ON')
        assert.equal(props['fresh_air_filter_mode/availability'], 'offline')
        assert.equal(props.water_filter_used_months, 6)
        assert.equal(props.water_filter_remaining_months, 0)
        assert.equal(props.water_filter_replace, 'ON')
        device.setProperty('fresh_air_filter_mode', 'Auto')
        assert.equal(Buffer.from((thinq.sent[0] as { Data: string }).Data, 'base64')[3], 2)
        device.setProperty('fresh_air_filter_mode', 'Replace')
        assert.equal(thinq.sent.length, 1, 'Replace is a reportable state, not a writable mode')
        replacement[6] = 255
        thinq.emit('data', replacement)
        assert.equal(props['water_filter_used_months/availability'], 'offline')
        assert.equal(props['water_filter_remaining_months/availability'], 'offline')
        assert.equal(props['water_filter_replace/availability'], 'offline')
        assert.equal(props.water_filter_remaining_months, 'None')
    })

    test('new valid fields and firmware refresh discovery once while preserving existing unique IDs', (t) => {
        const { ha, thinq, device } = setup(t)
        const originalId = discovered(ha).fridge_setpoint.unique_id
        const publish = t.mock.method(ha, 'publishConfig')
        thinq.emit('data', captured)
        assert.equal(publish.mock.callCount(), 0, 'ordinary polling must not resend discovery')
        const lock = Buffer.from(captured)
        lock[10] = 2
        thinq.emit('data', lock)
        assert.equal(publish.mock.callCount(), 1)
        assert.equal(ha.devices[id].properties.display_lock, 'Locked')
        thinq.emit('rawPacket', {
            Cmd: 'DevInfo',
            Format: 'B64',
            Data: Buffer.from('FwVer=QC_Modem_1.2.80,regFail=Y').toString('base64'),
        })
        assert.equal(ha.devices[id].config!.device?.sw_version, 'QC_Modem_1.2.80')
        assert.equal(discovered(ha).fridge_setpoint.unique_id, originalId)
        assert.ok(discovered(ha).ice_plus)
    })

    test('stale telemetry rejects feature writes before the device becomes unavailable', (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
        const { ha, thinq, device } = setup(t)
        t.mock.timers.tick(12000)
        assert.equal(ha.devices[id].availability, 'online')
        thinq.resetRecorder()
        device.setProperty('ice_plus', 'ON')
        device.setProperty('sabbath_mode', 'ON')
        assert.deepEqual(thinq.sent, [])
    })

    test('brief telemetry gaps keep readings available but require fresh state for full-state writes', (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
        const { ha, thinq, device } = setup(t)
        t.mock.timers.tick(15000)
        assert.equal(ha.devices[id].availability, 'online')
        assert.equal(ha.devices[id].properties.fridge_setpoint, 34)
        thinq.resetRecorder()
        device.setProperty('fridge_setpoint', '35')
        assert.deepEqual(thinq.sent, [], 'do not compose a command from stale settings')
        thinq.emit('data', captured)
        device.setProperty('fridge_setpoint', '35')
        assert.equal(thinq.sent.length, 1, 'fresh status restores writes')
        t.mock.timers.tick(89999)
        assert.equal(ha.devices[id].availability, 'online', 'a fresh report restarts the status timeout')
        t.mock.timers.tick(1)
        assert.equal(ha.devices[id].availability, 'offline')
    })

    test('longer availability timeout does not extend pending command lifetime', (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
        const { ha, thinq, device } = setup(t)
        device.setProperty('ice_plus', 'ON')
        t.mock.timers.tick(15000)
        assert.equal(ha.devices[id].availability, 'online')
        thinq.emit('data', captured) // expired Ice Plus request was never confirmed
        thinq.resetRecorder()
        device.setProperty('sabbath_mode', 'ON')
        const data = Buffer.from((thinq.sent[0] as { Data: string }).Data, 'base64')
        assert.equal(data[2], 1, 'do not replay the expired Ice Plus request')
        assert.equal(data[13], 1)
        device.drop()
        assert.equal(ha.devices[id].availability, 'offline', 'disconnect still marks the device offline immediately')
    })

    test('availability is deduplicated during polling but forced for rediscovery and restored after invalid state', (t) => {
        const { ha, thinq, device } = setup(t)
        const publish = t.mock.method(ha, 'publishProperty')
        const availability = () =>
            publish.mock.calls.filter((call) => call.arguments[1] === 'availability').map((call) => call.arguments[2])
        thinq.emit('data', captured)
        thinq.emit('data', captured)
        assert.deepEqual(availability(), [], 'unchanged polls do not republish online')
        device.publishConfig()
        device.publishConfig()
        assert.deepEqual(availability(), ['online', 'online'], 'rediscovery must republish even unchanged availability')
        thinq.emit('data', captured.subarray(0, 3))
        thinq.emit('data', captured.subarray(0, 3))
        assert.deepEqual(availability(), ['online', 'online', 'offline'])
        device.publishConfig()
        assert.deepEqual(availability(), ['online', 'online', 'offline', 'offline'])
        thinq.emit('data', captured)
        thinq.emit('data', captured)
        assert.deepEqual(
            availability(),
            ['online', 'online', 'offline', 'offline', 'online'],
            'recovery must not be suppressed',
        )
    })

    test('a command rejected for stale state explains why without changing the device', (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
        const { ha, thinq, device } = setup(t)
        const log = t.mock.method(device, 'log', () => {})
        t.mock.timers.tick(12000)
        thinq.resetRecorder()
        device.setProperty('ice_plus', 'ON')
        assert.equal(ha.devices[id].availability, 'online')
        assert.deepEqual(thinq.sent, [])
        assert.deepEqual(
            log.mock.calls.map((call) => call.arguments),
            [['Ignoring command: status snapshot is stale', 'ice_plus']],
        )
    })
})
