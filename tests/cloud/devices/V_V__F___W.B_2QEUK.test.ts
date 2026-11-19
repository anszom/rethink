import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Device from '@/cloud/devices/V_V__F___W.B_2QEUK'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/W4X1085NWH.json', import.meta.url), 'utf8')) as {
    samples: {
        rx: string
        state: number
        remaining_minutes: number
        course: number
        drying: number
        delay_hours: number
        flags: number
    }[]
    commands: string[]
}
test('physical ten-position selector sweep includes the downloaded-programme flag', () => {
    const { ha, thinq } = setup()
    const captures = [
        [
            'Cotton',
            'AAFF200A0060002B39000100EC004E000001030803080000000000000000000000000004000003008800000000000000000000000000000001030903090100030A04010000000000000003000003008800000400000000000000000000C69CBB',
        ],
        [
            'Eco 40-60',
            'AAFF200A0060002B3B000100EC004E000001030903090100030A04010000000000000003000003008800000400000000000000000000000001031D031D0400030A0401000000000000000300000300880000020000000000000000000014D4BB',
        ],
        [
            'Mix',
            'AAFF200A0060002B3D000100EC004E000001031D031D0400030A04010000000000000003000003008800000200000000000000000000000001011A011A07000307040100000000000000020000030088000003000000000000000000009F26BB',
        ],
        [
            'Quick 30',
            'AAFF200A0060002B3F000100EC004E000001011A011A0700030704010000000000000002000003008800000300000000000000000000000001001E001E220003050201000000000000000100000300880000020000000000000000000071ACBB',
        ],
        [
            'Synthetic',
            'AAFF200A0060002B40000100EC004E000001001E001E2200030502010000000000000001000003008800000200000000000000000000000001022302230200030A04010000000000000003000003008800000300000000000000000000D815BB',
        ],
        [
            'Downloaded programme',
            'AAFF200A0060002B42000100EC004E000001022302230200030A04010000000000000003000003008800000300000000000000000000000001032103212D00030A060100000080000000040088030088000005000000000000000000009368BB',
        ],
        [
            'Tub Clean',
            'AAFF200A0060002B43000100EC004E000001032103212D00030A06010000008000000004008803008800000500000000000000000000000001011001101200030106010000000000000003000003008800000200000000000000000000CF00BB',
        ],
        [
            'Hand wash/Wool',
            'AAFF200A0060002B45000100EC004E000001011001101200030106010000000000000003000003008800000200000000000000000000000001002700271B00030503010000000000000001000003008800000300000000000000000000E9F6BB',
        ],
        [
            'Dry only',
            'AAFF200A0060002B47000100EC004E000001002700271B000305030100000000000000010000030088000003000000000000000000000000010032003218000000000002000000000000060000030088000000000000000000000000000BB5BB',
        ],
        [
            'Wash + Dry',
            'AAFF200A0060002B4A000100EC004E000001003200321800000000000200000000000006000003008800000000000000000000000000000001060E060E1300030A04010200000000000004000003008800000400000000000000000000063DBB',
        ],
    ]
    for (const [programme, hex] of captures) {
        thinq.emit('data', Buffer.from(hex, 'hex'))
        assert.equal(ha.devices.washer.properties.course, programme)
    }
})
const META = { modelId: 'V_V__F___W.B_2QEUK', modelName: 'V_V__F___W.B_2QEUK', swVersion: '2.11.207' }
// Physical W4X1085NWH captures, clip_ble_v1.9.215, local provisioning.
// Owner confirmed Cotton, temperature 60 C, spin 0 then 400, and off/on.
const COTTON = Buffer.from(
    'aaff200a0060002a4d000100ec004e0039002a3b00010101002700000100000000000000000000000000000000000000000300880000000001030903090100030a040100000000000000030000030088000004000000000000000000005f01bb',
    'hex',
)
const TEMP_60 = Buffer.from(
    'aaff200a0060002aac000100ec004e0039002a7f000101010027000001030903090100030a0401000000000000000300000300880000000001030e030e0100030a06010000000000000004000003008800000400000000000000000000c04dbb',
    'hex',
)
const NO_SPIN = Buffer.from(
    'aaff200a0060002abf000100ec004e000001030e030e0100030a060100000000000000040000030088000004000000000000000000000000010300030001000301060100000000000000030000030088000004000000000000000000008014bb',
    'hex',
)
const SPIN_400 = Buffer.from(
    'aaff200a0060002ac3000100ec004e000001030003000100030106010000000000000003000003008800000400000000000000000000000001030803080100030206010000000000000004000003008800000400000000000000000000bbf4bb',
    'hex',
)
const OFF = Buffer.from(
    'aaff200a0060002ad2000100ec004e00000103080308010003020601000000000000000400000300880000040000000000000000000000000003080308010000000000000000000000000401000300880000040000000000000000000021ddbb',
    'hex',
)
const IDLE = Buffer.from(
    'aaff200a0039002a2f000100eb00270000010000000000000000000000000000000000000000030088000000000000000000000000002deabb',
    'hex',
)

function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer', META)
    const dev = new Device(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}
test('production registry maps the model and decodes a captured washer status', () => {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('washer', META)
    new Bridge(ha.asConnection()).newDevice(thinq)
    assert.equal(thinq.managed, true)
    thinq.emit('data', IDLE)
    assert.equal(ha.devices.washer.properties.status, 'Ready')
    assert.equal(ha.devices.washer.properties.course, 'Not selected')
})
test('physical settings decode from enveloped EC current records', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', COTTON)
    assert.equal(ha.devices.washer.properties.course, 'Cotton')
    thinq.emit('data', TEMP_60)
    assert.equal(ha.devices.washer.properties.temp, '60 °C')
    thinq.emit('data', NO_SPIN)
    assert.equal(ha.devices.washer.properties.spin, 'No spin')
    thinq.emit('data', SPIN_400)
    assert.equal(ha.devices.washer.properties.spin, '400 rpm')
    assert.equal(ha.devices.washer.properties.status, 'Ready')
})
test('captured power-off and EB idle records decode without retaining previous settings', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', OFF)
    assert.equal(ha.devices.washer.properties.status, 'Off')
    assert.equal(ha.devices.washer.properties.power, 'OFF')
    thinq.emit('data', IDLE)
    assert.equal(ha.devices.washer.properties.status, 'Ready')
    assert.equal(ha.devices.washer.properties.power, 'ON')
    assert.equal(ha.devices.washer.properties.course, 'Not selected')
})
test('power, pause and run use the commands accepted by the physical washer', () => {
    const { ha, thinq, dev } = setup()
    const ready = fixture.samples.find((s) => s.state === 1 && s.course === 34 && s.flags === 66)!
    thinq.emit('data', Buffer.from(ready.rx, 'hex'))
    thinq.resetRecorder()
    dev.setProperty('power_control', 'OFF')
    dev.setProperty('power_control', 'ON')
    dev.setProperty('run_programme', 'PRESS')
    dev.setProperty('pause', 'PRESS')
    assert.deepEqual(
        thinq.outbox.map((b) => b.toString('hex')),
        fixture.commands.slice(0, 4),
    )
    assert.equal(ha.devices.washer.config!.components.power!.platform, 'binary_sensor')
})
test('unvalidated resume, raw command payloads and an unselected programme cannot actuate', () => {
    const { thinq, dev } = setup()
    dev.setProperty('run_programme', 'PRESS') // no record received yet
    thinq.emit('data', IDLE)
    thinq.resetRecorder()
    for (const prop of ['start', 'resume', 'power', 'set_course']) dev.setProperty(prop, 'PRESS')
    dev.setProperty('run_programme', 'PRESS') // the panel has no selection
    dev.setProperty('pause', 'F024050100')
    dev.setProperty('power_control', 'F02A0100')
    assert.equal(thinq.outbox.length, 0)
    dev.start()
    assert.equal(thinq.outbox[0].toString('hex'), 'aa0ef0ed1121010000001800b5bb')
})
test('captured child lock and remote door lock are separate flags with HA lock polarity', () => {
    const { ha, thinq } = setup()
    for (const flags of [128, 0, 2, 66, 64, 0]) {
        const sample = fixture.samples.find((s) => s.flags === flags)!
        assert.ok(sample)
        thinq.emit('data', Buffer.from(sample.rx, 'hex'))
        const properties = ha.devices.washer.properties
        assert.equal(properties.child_lock, flags & 128 ? 'ON' : 'OFF')
        assert.equal(properties.remote_start, flags & 2 ? 'ON' : 'OFF')
        assert.equal(properties.door_lock, flags & 64 ? 'OFF' : 'ON')
    }
})
test('dry-only panel dashes do not become a spurious 50-minute idle countdown', () => {
    const { ha, thinq } = setup()
    for (const [code, name] of [
        [2, 'Cupboard dry'],
        [11, 'Low temperature'],
    ] as const) {
        const sample = fixture.samples.find((s) => s.course === 24 && s.drying === code)!
        thinq.emit('data', Buffer.from(sample.rx, 'hex'))
        assert.equal(ha.devices.washer.properties.drying, name)
        assert.equal(ha.devices.washer.properties.remaining_time, 'None')
        assert.equal(ha.devices.washer.properties.initial_time, 'None')
    }
    const idle = fixture.samples.find((s) => s.state === 1 && s.course === 0 && s.remaining_minutes === 50)!
    thinq.emit('data', Buffer.from(idle.rx, 'hex'))
    assert.equal(ha.devices.washer.properties.remaining_time, 'None')
})
test('physical delay sweep is independent of the 30-minute programme duration', () => {
    const { ha, thinq } = setup()
    for (const hours of [...Array.from({ length: 17 }, (_, i) => i + 3), 0]) {
        const sample = fixture.samples.find((s) => s.course === 34 && s.delay_hours === hours && s.state === 1)!
        assert.ok(sample)
        thinq.emit('data', Buffer.from(sample.rx, 'hex'))
        assert.equal(ha.devices.washer.properties.reserve_time, hours * 60)
        assert.equal(ha.devices.washer.properties.remaining_time, 30)
    }
})
test('real Washing and Paused records retain the captured countdown values', () => {
    const { ha, thinq } = setup()
    const cycle = fixture.samples.filter((s) => s.course === 34 && [2, 6].includes(s.state))
    assert.ok(cycle.some((s) => s.state === 2 && s.remaining_minutes === 28))
    assert.ok(cycle.some((s) => s.state === 6 && s.remaining_minutes < 30))
    for (const sample of cycle) {
        thinq.emit('data', Buffer.from(sample.rx, 'hex'))
        assert.equal(ha.devices.washer.properties.status, sample.state === 2 ? 'Paused' : 'Washing')
        assert.equal(ha.devices.washer.properties.remaining_time, sample.remaining_minutes)
        assert.equal(ha.devices.washer.properties.initial_time, 30)
    }
})
test('complete physical cycle reaches End at zero, unlocks, then powers off', () => {
    const { ha, thinq } = setup()
    const expected: Record<number, string> = { 7: 'Rinsing', 8: 'Spinning', 10: 'End', 0: 'Off' }
    const rinsing = fixture.samples.findIndex((s) => s.state === 7)
    assert.ok(rinsing > 0)
    const seen = new Set<number>()
    for (const sample of fixture.samples.slice(rinsing)) {
        thinq.emit('data', Buffer.from(sample.rx, 'hex'))
        seen.add(sample.state)
        assert.equal(ha.devices.washer.properties.status, expected[sample.state])
        assert.equal(ha.devices.washer.properties.remaining_time, sample.remaining_minutes)
        if (sample.state === 10 || sample.state === 0) {
            assert.equal(ha.devices.washer.properties.remaining_time, 0)
        }
    }
    assert.deepEqual([...seen], [7, 8, 10, 0])
    assert.equal(ha.devices.washer.properties.power, 'OFF')
    assert.equal(ha.devices.washer.properties.remote_start, 'OFF')
    assert.equal(ha.devices.washer.properties.door_lock, 'ON') // HA: unlocked
})
test('Run programme retains the prepared configuration when later phases clear settings', () => {
    const { thinq, dev } = setup()
    const ready = fixture.samples.find((s) => s.state === 1 && s.course === 34 && s.flags === 66)!
    const spinning = fixture.samples.find((s) => s.state === 8)!
    thinq.emit('data', Buffer.from(ready.rx, 'hex'))
    thinq.emit('data', Buffer.from(spinning.rx, 'hex'))
    thinq.resetRecorder()
    dev.setProperty('run_programme', 'PRESS')
    assert.equal(thinq.outbox[0].toString('hex'), fixture.commands[2])

    // A fresh driver attached mid-cycle never received the selected configuration.
    const attached = setup()
    attached.thinq.emit('data', Buffer.from(spinning.rx, 'hex'))
    attached.thinq.resetRecorder()
    attached.dev.setProperty('run_programme', 'PRESS')
    assert.equal(attached.thinq.outbox.length, 0)
})
test('captured envelopes receive delivery ACKs; malformed lengths publish no guessed state', () => {
    const { ha, thinq } = setup()
    thinq.emit('data', SPIN_400)
    assert.ok(thinq.sent.some((x) => x.cmd === 'ack'))
    const before = { ...ha.devices.washer.properties }
    const bad = Buffer.from(SPIN_400)
    bad[14] = 1
    thinq.emit('data', bad)
    assert.deepEqual(ha.devices.washer.properties, before)
})
