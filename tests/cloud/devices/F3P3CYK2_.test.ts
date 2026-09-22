import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3P3CYK2_'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3P3CYK2_'
const META: Metadata = {
    modelId: MODEL_ID,
    modelName: 'LG WM4200HBA',
    swVersion: '2.10.119',
}

// Real frames captured from a physical WM4200HBA while connected to rethink. The complete-cycle
// fixtures cover a Rinse+Spin run that was paused, resumed, allowed to finish naturally, and then
// powered off. The settings fixtures were captured while selecting named controls at the panel.
const OFF_SNAPSHOT = buf(
    'AA3320EB002B0000000E00000000000000000000010000002D0000001069000000001E040000000000000040000000000078BB',
)
const PAUSED = buf(
    'AA6020EC002B0000000E0F2E0000000000000000150016000000000C2469070000011E0400000000002000100000010000002B0000000E0F2E000000000000000015001600000000020C69070000011E04000000000020004000000100001BBB',
)
const RESUMED_RINSING = buf(
    'AA6020EC002B0000000E0F2E000000000000000015001600000000240269070000011E0400000000002000100000010000002B0000000E0F2E0000000000000000150016000000000C2469070000011E040000000000200010000001000063BB',
)
const SPINNING = buf(
    'AA6020EC002B0000000E0F2E0000000000000000120016000100000C2469070000011E0400000000002000100000010000002B0000000E0F2E0000000000000000110016000200000E0C69070000001E040000000000200010000001000070BB',
)
const END = buf(
    'AA6020EC002B0000000E0F2E0000000000000000010016002800000E0C69070000001E0400000000002000100000010000002B0000000E00000000000000000000010000002D0000100E69000000001E0400000000000000400000000000ADBB',
)
const OFF_AFTER_END = buf(
    'AA6020EC002B0000000E00000000000000000000010000002D0000100E69000000001E0400000000000000400000000000002B0000000E00000000000000000000010000002D0000001069000000001E0400000000000000400000000000FDBB',
)
const E2_STALE_REPLAY = buf(
    'AA3320E2032B0000000E0F2E0000000000000000160016002D0000240169070000011E0400000000002000100000010000CFBB',
)

const DIAL_NORMAL = buf(
    'AA6020EC002B00030E0E0E1600000000000000002D002D00000000010069070000021E0400000000000000400000000000002B0003100E0F2E00000000000000002E002E00000000010069000000011E0400000000200000400000010000D3BB',
)
const DIAL_BEDDING = buf(
    'AA6020EC002B0005100E1023000000000000000082008200000000010069000000011E0400000000200000400000000000002B0003100E0E0D00000000000000003C003C00000000010069070000021E040000000000000040000000000069BB',
)
const DIAL_SANITARY = buf(
    'AA6020EC002B0003100E0E0D00000000000000003C003C00000000010069070000021E0400000000000000400000000000002B0003130E0F3C000000000000000074007400000000010069000000031E04000000000000004000000000004EBB',
)
const DIAL_DOWNLOADED = buf(
    'AA6020EC002B0000000E0E55000000000000000059005900000000010069000000021E0400000000001000400000000000002B0003100E0FFF00000000000000002D002D00000000010069000000021E040000000000000040000000000091BB',
)
const DIAL_DRAIN_SPIN = buf(
    'AA6020EC002B0003100E0FFF00000000000000002D002D00000044010069000000021E0400000000000000400000000000002B0000000E0F1900000000000000000B000B00000000010069070000001E040000000000000040000000000073BB',
)
const DIAL_DELICATES = buf(
    'AA6020EC002B0003100E0E3000000000000000002A002A00000000010069000000011E0400000000200000400000000000002B00030E0E0E1600000000000000002D002D00000000010069070000021E04000000000000004000000000002BBB',
)
const RINSE_SPIN_ON = buf(
    'AA6020EC002B0003100E0F2E00000000000000002E002E00000000010069000000011E0400000000200000400000010000002B0000000E0F2E000000000000000016001600000000010069070000011E0400000000002000400000010000D5BB',
)
const RINSE_SPIN_OFF = buf(
    'AA6020EC002B0000000E0F2E000000000000000016001600000000010069070000011E0400000000002000400000010000002B0003100E0F2E00000000000000002E002E00000000010069000000011E0400000000200000400000010000D5BB',
)
// Minimal envelope preserving the discriminator and error byte from the full live-captured dE1 frame.
// AABBDevice does not validate the unused payload or checksum, so keeping 400 irrelevant zero bytes here
// would make this regression test harder to audit without testing anything extra.
const ERROR_DE1 = Buffer.concat([buf('AA1620BD'), Buffer.alloc(15), buf('1100BB')])
const ERROR_DE1_ALT = Buffer.concat([buf('AA1520CD'), Buffer.alloc(14), buf('1100BB')])

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const frame of frames) thinq.emit('data', frame)
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('config exposes the conservative entity set', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components
        for (const component of [
            'power',
            'status',
            'run_completed',
            'error_state',
            'error_message',
            'course',
            'remaining_time',
            'initial_time',
            'reserve_time',
            'soil',
            'temp',
            'rinse',
            'spin',
            'rinse_spin',
            'tub_clean_count',
            'buzzer',
        ]) {
            assert.ok(components[component], `component ${component} present`)
        }
        assert.ok(components.power_off, 'one-way power-off button present')
        for (const unsafe of ['power_switch', 'pause', 'remote_start', 'course_selection']) {
            assert.ok(!components[unsafe], `control ${unsafe} must not be exposed`)
        }
        assert.deepEqual((components.spin as { options?: string[] }).options, [
            'No Spin',
            'Low',
            'Medium',
            'High',
            'Extra High',
        ])
    })

    test('power-off button sends the command captured from the ThinQ app', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('power_off', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa09f0240101009cbb'],
        )

        dev.setProperty('power_off', 'not-a-press')
        assert.equal(thinq.outbox.length, 1)
    })

    test('real dE1 full-status frame publishes and power-off clears the error', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', ERROR_DE1)
        assert.equal(p.error_state, 'ON')
        assert.equal(p.error_message, 'dE1 - Door Open')

        thinq.emit('data', OFF_SNAPSHOT)
        assert.equal(p.error_state, 'OFF')
        assert.equal(p.error_message, '-')
    })

    test('alternate 0xCD full-status frame publishes the same dE1 error', () => {
        const p = feed([ERROR_DE1_ALT])
        assert.equal(p.error_state, 'ON')
        assert.equal(p.error_message, 'dE1 - Door Open')
    })

    test('start requests a read-only 0x2B status snapshot', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa0ef0ed1121010000002b00a6bb'],
        )
    })

    test('single-record 0xEB snapshot initializes an off washer', () => {
        const p = feed([OFF_SNAPSHOT])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'None')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.run_completed, 'OFF')
    })

    test('real pause, resume, spin, end and power-off sequence decodes correctly', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', PAUSED)
        let p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Paused')
        assert.equal(p.remaining_time, 21)
        assert.equal(p.initial_time, 22)

        thinq.emit('data', RESUMED_RINSING)
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.remaining_time, 21)

        thinq.emit('data', SPINNING)
        assert.equal(p.status, 'Spinning')
        assert.equal(p.remaining_time, 17)

        thinq.emit('data', END)
        assert.equal(p.status, 'End')
        assert.equal(p.power, 'ON')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.run_completed, 'ON')

        thinq.emit('data', OFF_AFTER_END)
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.run_completed, 'ON') // retained through the automatic post-cycle power-off

        thinq.emit('data', DIAL_NORMAL)
        assert.equal(p.status, 'Initial')
        assert.equal(p.run_completed, 'OFF') // cleared when the next session starts
    })

    test('0xE2 post-cycle replay is ignored', () => {
        const p = feed([END, E2_STALE_REPLAY])
        assert.equal(p.status, 'End')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.run_completed, 'ON')
    })

    test('real course selections map to their panel names', () => {
        const fixtures: Array<[Buffer, string]> = [
            [DIAL_NORMAL, 'Normal'],
            [DIAL_BEDDING, 'Bedding'],
            [DIAL_SANITARY, 'Sanitary'],
            [DIAL_DOWNLOADED, 'Downloaded'],
            [DIAL_DRAIN_SPIN, 'Drain+Spin'],
            [DIAL_DELICATES, 'Delicates'],
        ]
        for (const [frame, expected] of fixtures) {
            assert.equal(feed([frame]).course, expected)
        }
    })

    test('the full captured course table maps every code', () => {
        const courses: Array<[number, string]> = [
            [0x05, 'Allergiene'],
            [0x0d, 'Bedding'],
            [0x16, 'Delicates'],
            [0x19, 'Drain+Spin'],
            [0x23, 'Heavy Duty'],
            [0x2e, 'Normal'],
            [0x30, 'Perm Press'],
            [0x3c, 'Sanitary'],
            [0x4a, 'Speed Wash'],
            [0x4f, 'Sportswear'],
            [0x54, 'Towels'],
            [0x55, 'Tub Clean'],
            [0x5a, 'Bright Whites'],
            [0xff, 'Downloaded'],
        ]
        for (const [code, expected] of courses) {
            const frame = Buffer.from(DIAL_NORMAL)
            frame[50 + 6] = code // current record begins at raw packet offset 50
            assert.equal(feed([frame]).course, expected)
        }
    })

    test('Rinse+Spin is an option layered on Normal, not a separate course', () => {
        const p = feed([RINSE_SPIN_ON])
        assert.equal(p.course, 'Normal')
        assert.equal(p.rinse_spin, 'ON')
        assert.equal(p.soil, 'None')
        assert.equal(p.temp, 'None')
        assert.equal(p.rinse, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.remaining_time, 22)

        const after = feed([RINSE_SPIN_ON, RINSE_SPIN_OFF])
        assert.equal(after.rinse_spin, 'OFF')
        assert.equal(after.course, 'Normal')
        assert.equal(after.soil, 'Normal')
        assert.equal(after.temp, 'Warm')
    })

    test('known settings and diagnostics decode from a real Normal selection', () => {
        const p = feed([DIAL_NORMAL])
        assert.equal(p.soil, 'Normal')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.rinse, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.remaining_time, 46)
        assert.equal(p.initial_time, 46)
        assert.equal(p.tub_clean_count, 30)
        assert.equal(p.buzzer, '4')
    })

    test('wrong-length and unrelated frames publish nothing', () => {
        for (const junk of ['aa0720d800fcbb', 'aa09207200c9005bbb', 'aa0a20ec002b000000bb']) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
        }
    })
})
