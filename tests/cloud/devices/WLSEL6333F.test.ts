import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import DUT from '@/cloud/devices/WLSEL6333F'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const fixtures: Record<string, string> = JSON.parse(
    readFileSync(new URL('./WLSEL6333F.captures.json', import.meta.url), 'utf8'),
)
const META = { modelId: 'WLSEL6333F', modelName: 'WLSEL6333F', swVersion: '20160616' }
function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('test-oven', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    const feed = (name: string) => thinq.emit('data', buf(fixtures[name]))
    const props = () => ha.devices['test-oven'].properties
    return { ha, thinq, dev, feed, props }
}

test('75-byte initial record establishes idle with no programmed temperature', () => {
    const { feed, props } = setup()
    feed('idle')
    assert.equal(props().oven_status, 'Idle')
    assert.equal(props().oven_mode, 'None')
    assert.equal(props().oven_set_temperature, 'None')
    assert.equal(props().oven_temperature, 'None')
    assert.equal(props().oven_door, 'OFF')
})

test('clock command preserves the reported 12-hour format', () => {
    const { dev, thinq, feed, ha } = setup()
    feed('idle')
    thinq.resetRecorder()
    dev.sendClock(13, 17)
    assert.equal(hex(thinq.outbox[0]), 'AA15F043210E0111018080808080808080FF80E6BB')
    const components = ha.devices['test-oven'].config!.components as Record<string, Record<string, unknown>>
    assert.equal(components.clock_sync.payload_press, 'PRESS')
    assert.equal(components.clock_sync.state_topic, undefined)
})

test('clock sync preserves 24-hour format after a captured preference transition', () => {
    const { dev, thinq } = setup()
    thinq.emit(
        'data',
        buf(
            'AA9C40EC0101000000010200FF020001000000000000000000000000000000000000000E000000000000000000000000000000000000000000000000000000000300000300000300000300000300000001000000010200FF020101000000000000000000000000000000000000000E00000000000000000000000000000000000000000000000000000000030000030000030000030000030000EFBB',
        ),
    )
    thinq.resetRecorder()
    dev.sendClock(13, 7)
    assert.equal(hex(thinq.outbox[0]), 'AA15F043210E0D07008080808080808080FF80E1BB')
})

test('clock sync waits for a known format and rejects non-press actions', () => {
    const { dev, thinq, feed } = setup()
    dev.sendClock(13, 7)
    assert.equal(thinq.outbox.length, 0)
    feed('idle')
    thinq.resetRecorder()
    for (const value of ['not-a-press', '']) dev.setProperty('clock_sync', value)
    assert.equal(thinq.outbox.length, 0)
})

test('physical door changes use bit 2 at offset 27, not the other range layout', () => {
    const { feed, props } = setup()
    feed('door_open')
    assert.equal(props().oven_door, 'ON')
    assert.equal(props().oven_status, 'Idle')
    feed('door_closed')
    assert.equal(props().oven_door, 'OFF')
})

test('Bake 350 F and 355 F decode current records; Cancel clears stale cook values', () => {
    const { feed, props } = setup()
    feed('bake350')
    assert.equal(props().oven_status, 'Preheating')
    assert.equal(props().oven_mode, 'Bake')
    assert.equal(props().oven_set_temperature, 350)
    feed('cancel350')
    assert.equal(props().oven_status, 'Idle')
    assert.equal(props().oven_mode, 'None')
    assert.equal(props().oven_set_temperature, 'None')
    assert.equal(props().oven_temperature, 'None')
    feed('bake355')
    assert.equal(props().oven_status, 'Preheating')
    assert.equal(props().oven_set_temperature, 355)
})

test('periodic temperature reports update preheat without corrupting the programmed target', () => {
    const { feed, props } = setup()
    feed('bake355')
    feed('preheat_progress')
    assert.equal(props().oven_temperature, 155)
    assert.equal(props().oven_set_temperature, 355)
    assert.equal(props().oven_status, 'Preheating')
})

test('preheat-complete at 355 F reports Cooking and Cancel resets both temperatures', () => {
    const { feed, props } = setup()
    feed('ready355')
    assert.equal(props().oven_status, 'Cooking')
    assert.equal(props().oven_mode, 'Bake')
    assert.equal(props().oven_temperature, 355)
    assert.equal(props().oven_set_temperature, 355)
    feed('cancel355')
    assert.equal(props().oven_status, 'Idle')
    assert.equal(props().oven_temperature, 'None')
    assert.equal(props().oven_set_temperature, 'None')
})

test('Control Lock is a global flag distinct from the oven door and cooking state', () => {
    const { feed, props } = setup()
    feed('cancel355')
    assert.equal(props().control_lock, 'OFF')
    feed('control_locked')
    assert.equal(props().control_lock, 'ON')
    assert.equal(props().oven_status, 'Idle')
    assert.equal(props().oven_door, 'OFF')
    assert.equal(props().cooktop_status, 'OFF', 'locked cooktop slots are not active heaters')
    feed('control_unlocked')
    assert.equal(props().control_lock, 'OFF')
    assert.equal(props().cooktop_status, 'OFF')
})

test('physical cooktop on/off cycles publish aggregate activity without changing the idle oven', () => {
    const { feed, props } = setup()
    for (const [packet, expected] of [
        ['cooktop_on', 'ON'],
        ['cooktop_off', 'OFF'],
        ['cooktop_on_repeat', 'ON'],
        ['cooktop_off_repeat', 'OFF'],
    ]) {
        feed(packet)
        assert.equal(props().cooktop_status, expected)
        assert.equal(props().oven_status, 'Idle')
        assert.equal(props().oven_set_temperature, 'None')
    }
})

test('clock sync button sends server-local time using the existing PRESS convention', () => {
    const { dev, thinq, feed } = setup()
    feed('idle')
    thinq.resetRecorder()
    const before = new Date()
    dev.setProperty('clock_sync', 'PRESS')
    const after = new Date()
    const payload = thinq.outbox[0].subarray(6)
    assert.ok([before.getHours() % 12 || 12, after.getHours() % 12 || 12].includes(payload[0]))
    assert.ok([before.getMinutes(), after.getMinutes()].includes(payload[1]))
})

test('oven beeper reports and commands match the three labeled app captures', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, option] of [
        ['mute', 'Mute'],
        ['low', 'Low'],
        ['high', 'High'],
    ]) {
        feed('oven_beeper_' + label)
        assert.equal(props().oven_beeper_volume, option)
        thinq.resetRecorder()
        dev.setProperty('oven_beeper_volume', option)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['oven_beeper_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('oven_beeper_volume', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('cooktop beeper reports and commands match the three labeled app captures', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, option] of [
        ['mute', 'Mute'],
        ['low', 'Low'],
        ['high', 'High'],
    ]) {
        feed('cooktop_beeper_' + label)
        assert.equal(props().cooktop_beeper_volume, option)
        thinq.resetRecorder()
        dev.setProperty('cooktop_beeper_volume', option)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['cooktop_beeper_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('cooktop_beeper_volume', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('preheat light readback and writes match off/on app captures', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, value] of [
        ['off', 'OFF'],
        ['on', 'ON'],
    ]) {
        feed('preheat_light_' + label)
        assert.equal(props().preheat_alarm_light, value)
        assert.equal(props().oven_beeper_volume, 'High')
        assert.equal(props().cooktop_beeper_volume, 'High')
        thinq.resetRecorder()
        dev.setProperty('preheat_alarm_light', value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['preheat_light_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('preheat_alarm_light', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('Auto Conversion readback and writes match off/on app captures', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, value] of [
        ['off', 'OFF'],
        ['on', 'ON'],
    ]) {
        feed('auto_conversion_' + label)
        assert.equal(props().auto_conversion, value)
        assert.equal(props().oven_beeper_volume, 'High')
        assert.equal(props().cooktop_beeper_volume, 'High')
        thinq.resetRecorder()
        dev.setProperty('auto_conversion', value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['auto_conversion_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('auto_conversion', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('Auto Remote readback and writes match off/on app captures', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, value] of [
        ['off', 'OFF'],
        ['on', 'ON'],
    ]) {
        feed('auto_remote_' + label)
        assert.equal(props().auto_remote, value)
        assert.equal(props().oven_beeper_volume, 'High')
        assert.equal(props().cooktop_beeper_volume, 'High')
        thinq.resetRecorder()
        dev.setProperty('auto_remote', value)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['auto_remote_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('auto_remote', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('temperature unit preference readback and commands match Celsius/Fahrenheit captures', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, option] of [
        ['c', '°C'],
        ['f', '°F'],
    ]) {
        feed('temperature_unit_' + label)
        assert.equal(props().temperature_unit, option)
        thinq.resetRecorder()
        dev.setProperty('temperature_unit', option)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['temperature_unit_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    dev.setProperty('temperature_unit', 'invalid')
    assert.equal(thinq.outbox.length, 0)
})

test('signed Fahrenheit thermostat trims and Off reproduce the captured commands', () => {
    const { dev, feed, props, thinq } = setup()
    for (const [label, adjustment] of [
        ['minus5', -5],
        ['plus5', 5],
        ['off', 0],
    ] as const) {
        feed('adjustment_' + label)
        assert.equal(props().temperature_adjustment, adjustment)
        thinq.resetRecorder()
        dev.setProperty('temperature_adjustment', String(adjustment))
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), fixtures['adjustment_' + label + '_command'].toUpperCase())
    }
    thinq.resetRecorder()
    for (const value of ['', 'NaN', '-36', '36', '1.5']) dev.setProperty('temperature_adjustment', value)
    assert.equal(thinq.outbox.length, 0)
})

test('physical Remote Start arming reports readiness separately from Auto Remote', () => {
    const { feed, props } = setup()
    feed('remote_unarmed')
    assert.equal(props().remote_start, 'OFF')
    feed('remote_ready')
    assert.equal(props().remote_start, 'ON')
    assert.equal(props().auto_remote, 'OFF')
    assert.equal(props().oven_status, 'Idle')
})

test('remote Bake input staging sends nothing until Start and matches the app start/cancel captures', () => {
    const { dev, thinq } = setup()
    dev.setProperty('remote_temperature', '350')
    dev.setProperty('remote_cook_time', '3')
    assert.equal(thinq.outbox.length, 0)
    dev.setProperty('start', 'PRESS')
    assert.equal(hex(thinq.outbox[0]), fixtures.remote_bake350_3min_command.toUpperCase())
    dev.setProperty('cancel', 'PRESS')
    assert.equal(hex(thinq.outbox[1]), fixtures.remote_cancel_command.toUpperCase())
})

test('remote Bake countdown and cancel decode programmed and remaining time independently', () => {
    const { feed, props } = setup()
    feed('remote_bake350_3min')
    assert.equal(props().remote_started, 'ON')
    assert.equal(props().oven_mode, 'Bake')
    assert.equal(props().oven_set_temperature, 350)
    assert.equal(props().remaining_time, 180)
    assert.equal(props().cook_time, 180)
    feed('remote_bake350_countdown')
    assert.equal(props().remaining_time, 179)
    assert.equal(props().cook_time, 180)
    feed('remote_canceled')
    assert.equal(props().oven_status, 'Idle')
    assert.equal(props().remote_started, 'OFF')
    assert.equal(props().remaining_time, 0)
    assert.equal(props().cook_time, 0)
})

test('Keep Warm staging and readback match the enabled Bake capture and clear on cancel', () => {
    const { dev, thinq, feed, props } = setup()
    dev.setProperty('remote_temperature', '350')
    dev.setProperty('remote_cook_time', '2')
    dev.setProperty('remote_keep_warm', 'ON')
    assert.equal(thinq.outbox.length, 0)
    dev.setProperty('start', 'PRESS')
    assert.equal(hex(thinq.outbox[0]), fixtures.remote_bake350_2min_keep_warm_command.toUpperCase())
    feed('remote_bake350_2min_keep_warm')
    assert.equal(props().keep_warm, 'ON')
    assert.equal(props().cook_time, 120)
    assert.equal(props().oven_set_temperature, 350)
    feed('remote_keep_warm_canceled')
    assert.equal(props().keep_warm, 'OFF')
    assert.equal(props().oven_status, 'Idle')
    feed('remote_bake350_3min')
    assert.equal(props().keep_warm, 'OFF')
})

test('unverified Celsius and invalid temperature units clear stale Fahrenheit readings', () => {
    const { feed, thinq, props } = setup()
    feed('bake355')
    assert.equal(props().oven_set_temperature, 355)
    // Mutated guard case, not a physical Celsius cooking capture.
    const packet = buf(fixtures.bake355)
    packet[4 + 75 + 2] = 1
    packet[4 + 75 + 21] |= 0x80
    thinq.emit('data', packet)
    assert.equal(props().oven_set_temperature, 'None')
    assert.equal(props().oven_temperature, 'None')
    assert.equal(props().temperature_adjustment, 'None')
    feed('bake355')
    assert.equal(props().oven_set_temperature, 355)
})
