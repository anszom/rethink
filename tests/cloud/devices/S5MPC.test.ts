import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import DUT from '@/cloud/devices/S5MPC'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

// Disk-backed course memory under test: the driver under test reads the
// path at call time, and each makeDevice starts with no memory file.
process.env.RETHINK_MEMORY_FILE = join(tmpdir(), 'rethink-course-memory-styler-test.json')

const DEVICE_ID = 'test-id'
const MODEL_ID = 'S5MPC'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.10.95' }

/*
 * Fixtures.
 *
 * All state frames below are REAL frames from the appliance, captured
 * 2026-09-07, each cross-checked against LG's own cloud decode of the same
 * moment (83 snapshots over the session):
 *
 * - REMOTE_ON: 08:48:46Z, LG: state INITIAL, remoteStart REMOTE_START_ON
 * - REMOTE_OFF: 08:50:56Z, LG: state INITIAL, remoteStart REMOTE_START_OFF
 * - PAUSE: 08:53:29Z, LG: state PAUSE, preState PRESTEAM, course STANDARD
 * - PRESTEAM: 08:53:22Z, trailing record state PRESTEAM (course STANDARD)
 * - RESERVED: 08:55:40Z, LG: state RESERVED, course QUICK, reserve 19h
 * - POWEROFF: 09:24:12Z, LG: state POWEROFF
 *
 * Every one of them reads error ERROR_NO, energyMonitoring 0 — no other error
 * code and no non-zero energy value were ever observed, which is why those two
 * entities stay conservative (see the driver header).
 */
const REMOTE_ON = buf(
    'aa4031ec001b010001000100000000000000000020000000000000000001624200001b01000100010000000000000000002800000000000000000162420080bb',
)
const REMOTE_OFF = buf(
    'aa4031ec001b010001000100000000000000000028000000000000000001624200001b01000100010000000000000000002000000000000000000162420080bb',
)
const PAUSE = buf(
    'aa4031ec001b320027002701000100000000000028000000000000000001624200001b03002700270100320000000000002800000000000000000162420088bb',
)
const PRESTEAM = buf(
    'aa4031ec001b010001000100000000000000000028000000000000000001624200001b32002700270100010000000000002800000000000000000162420009bb',
)
const RESERVED = buf(
    'aa4031ec001b030027002701003200000000000028000000000000000001624200001b080014001403000300000000130008000000000000000001624200d1bb',
)
const POWEROFF = buf(
    'aa4031ec001b01003b003b1c000300000000000020000000000063000001634200001b00003b003b000001000000000000200000000000000000016342006cbb',
)
// Real post-cycle single-status frame (06:10, after the 104-minute steam
// cycle): record+17/+18 hold 0x0251 = 593, matching the ThinQ app's daily
// 593Wh exactly. The per-minute 0x31ec status frames report 0 in the same
// field for the whole run and flip to 593 only at completion.
const ENERGY_AT_COMPLETION = buf('aa2331eb001b00000100000000040000000000002000000251000000000163420077bb')
// Real completion frame (06:05:11, state Complete): the wire still reports
// 0h01m remaining while the cycle is done.
const COMPLETE = buf(
    'aa4031ec001b040001012c0c003800000000000028000002510000000001634200001b000001012c000004000000000000200000025100000000016342004abb',
)
// SMART_RUN: 09:11:49Z, trailing record runs base Time Dry 30 with smart Golf
// Wear Dry — LG: course TIME_DRY_30, smartCourse GOLF_WEAR_DRY.
const SMART_RUN = buf(
    'aa4031ec001b01003b003b1c000300000000000028000000000063000001634200001b010119011911000300000000000028000000000079000001794200ffbb',
)
// CHILD_LOCK_ON / CHILD_LOCK_OFF: 2026-09-08, captured live off the panel's
// own child-lock button (LG's app has no control for it, so there is no
// cloud snapshot to cross-check against — only the owner-confirmed physical
// lock icon). Only flagsA's 0x01 bit moves between them.
const CHILD_LOCK_ON = buf(
    'aa4031ec001b010001000100000000000000000020000000000000000001634200001b01000100010000000000000000002100000000000000000163420085bb',
)
const CHILD_LOCK_OFF = buf(
    'aa4031ec001b010001000100000000000000000021000000000000000001634200001b01000100010000000000000000002000000000000000000163420085bb',
)

// Not state: the 8-byte ACK, a 9-byte notification of the kind that
// accompanies remote-start transitions, and the downloadable-course name list.
const ACK = buf('aa083100240052bb')
const NOTIFY_9 = buf('aa09317200c9004abb')
const COURSE_LIST = buf(
    'aa37313102015341413337353639313431000066260000800000000000025341413337353639303230000062a80000400000000000d9bb',
)

function makeDevice() {
    // Each test starts with no disk memory (what a fresh install sees).
    // Static remembered state is keyed by device id alone here, so tests
    // that need a truly fresh instance clear it themselves.
    try {
        unlinkSync(process.env.RETHINK_MEMORY_FILE as string)
    } catch {
        // nothing persisted yet — start clean
    }
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

/** This model's framing: `packet[1]` is the length, `packet[-2]` is the low byte of the sum XOR 0x55. */
function assertIntact(packet: Buffer) {
    assert.equal(packet[1], packet.length)
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    assert.equal(packet[packet.length - 2], (sum & 0xff) ^ 0x55)
}

/** Model-declared state probe derived from a real frame; not capture evidence. */
function withCurrentState(state: number) {
    const packet = Buffer.from(POWEROFF)
    const currentRecord = packet.length - 2 - 27
    packet[currentRecord] = state
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

describe(MODEL_ID, () => {
    test('the real-capture corpus is intact, not hand-written', () => {
        for (const f of [
            REMOTE_ON,
            REMOTE_OFF,
            PAUSE,
            PRESTEAM,
            RESERVED,
            POWEROFF,
            SMART_RUN,
            CHILD_LOCK_ON,
            CHILD_LOCK_OFF,
            ENERGY_AT_COMPLETION,
            COMPLETE,
        ])
            assertIntact(f)
    })

    test('exactly the scoped entities exist, with the right writability', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'child_lock',
            'course',
            'course_select',
            'energy',
            'error',
            'error_message',
            'initial_time',
            'pause',
            'power',
            'power_off',
            'remaining_time',
            'remote_start',
            'reserve_hours',
            'reserve_time',
            'resume',
            'smart_course',
            'smart_course_select',
            'smart_diagnosis',
            'start_course',
            'status',
            'store',
        ])
        assert.equal(components.energy.name, 'Energy')
        assert.equal(components.energy.device_class, 'energy')
        assert.equal(components.energy.unit_of_measurement, 'Wh')
        assert.equal(components.energy.state_class, 'total_increasing')
        assert.equal(components.power.platform, 'binary_sensor')
        assert.equal(components.power.icon, 'mdi:power')
        assert.equal(components.smart_diagnosis.device_class, 'problem')
        assert.deepEqual(components.status.options, [
            'Power off',
            'Standby',
            'Running',
            'Pause',
            'Complete',
            'Error',
            'Smart diagnosis',
            'Storing',
            'Reserved',
            'Power-save running',
            'Steam preparing',
            'Refreshing',
            'Drying',
            'Sterilizing',
        ])
        for (const name of [
            'power_off',
            'course_select',
            'smart_course_select',
            'start_course',
            'pause',
            'resume',
            'reserve_hours',
            'store',
        ]) {
            assert.equal(components[name].command_topic, `$this/${name}/set`, `${name} is writable`)
        }
        for (const name of [
            'power',
            'status',
            'course',
            'smart_course',
            'remaining_time',
            'initial_time',
            'reserve_time',
            'remote_start',
            'child_lock',
            'error',
            'error_message',
            'smart_diagnosis',
            'energy',
        ]) {
            assert.equal(components[name].command_topic, undefined, `${name} stays read-only`)
            assert.ok(
                components[name].platform === 'sensor' || components[name].platform === 'binary_sensor',
                `${name} is a sensor platform, got ${components[name].platform}`,
            )
        }
    })

    test('publishes this-cycle energy from the record+17 Wh counter', () => {
        // Real post-cycle frame: 0x0251 = 593Wh, matching the ThinQ app's
        // daily 593Wh exactly (Wh x1, same convention as washer and dryer).
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ENERGY_AT_COMPLETION)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 593)
    })

    test('remote start follows the verified flags bit', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REMOTE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
        thinq.emit('data', REMOTE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
    })

    test('child lock follows the verified flags bit, independent of remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        thinq.emit('data', CHILD_LOCK_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
        // Cross-check independence: remote-start fixtures never set 0x01, and
        // child-lock fixtures never set 0x08.
        thinq.emit('data', REMOTE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
    })

    test('status tracks the verified state codes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', PAUSE)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Pause')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 39)
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 39)
        thinq.emit('data', PRESTEAM)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Steam preparing')
        thinq.emit('data', RESERVED)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Reserved')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 19 * 60)
        thinq.emit('data', POWEROFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')
    })

    test('remaining time reads 0 once the cycle is done', () => {
        // The wire holds 0h01m through completion and power-off while
        // nothing remains; running states keep reporting the wire value.
        // (The frame's leading record is state Complete, the trailing
        // current record is already Power off.)
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COMPLETE)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
        thinq.emit('data', POWEROFF)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
        thinq.emit('data', withCurrentState(4))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Complete')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('a smart course whose base id is 13/14/16/27/67/78 still reports a course label', () => {
        // Those base ids never run standalone via Start course, so they were
        // missing from COURSE and a direct run of one of them (smartCourse
        // 0, course = the base id) left `course` unpublished (map(rawCourse)
        // returned undefined). Base id 67 (Silent) doubles as both a
        // SmartCourse and a directly startable course, so this also covers
        // that dual-use case: with no smart course active, `course` reports
        // the base label directly rather than the Downloaded Course
        // placeholder.
        const packet = Buffer.from(SMART_RUN)
        const currentRecord = packet.length - 2 - 27
        packet[currentRecord + 5] = 67 // OFF.course
        packet[currentRecord + 20] = 0 // OFF.smartCourse: no smart course running
        const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Silent')
    })

    test('a smart course built on base id 67 reports Downloaded Course on `course`, like the washer', () => {
        // Same synthetic frame, but with the SmartCourse id actually set:
        // `course` now matches course_select's own placeholder instead of
        // leaking the base id, and `smart_course` carries the real name.
        const packet = Buffer.from(SMART_RUN)
        const currentRecord = packet.length - 2 - 27
        packet[currentRecord + 5] = 67 // OFF.course
        packet[currentRecord + 20] = 67 // OFF.smartCourse
        const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Downloaded Course')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Silent')
    })

    test('uses the common Error and Smart diagnosis states declared by the model', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withCurrentState(5))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Error')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        thinq.emit('data', withCurrentState(6))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Smart diagnosis')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'ON')
    })

    test('a running smart course reports the Downloaded Course placeholder, like the washer', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SMART_RUN)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Downloaded Course')
        assert.equal(p.smart_course, 'Golf Wear Dry')
        assert.equal(p.smart_course_select, 'Golf Wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
    })

    test('a frame with a corrupted checksum is dropped, not decoded', () => {
        // The shared AABBDevice base never verified the checksum it writes
        // in send(); this device overrides processData to check it on
        // receive too. Flip a byte in a real captured frame without
        // recomputing the checksum, and the whole update must be ignored.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REMOTE_ON)
        const before = { ...ha.devices[DEVICE_ID].properties }

        const corrupted = Buffer.from(SMART_RUN)
        corrupted[10] ^= 0xff // flip a mid-frame byte, checksum left untouched
        thinq.emit('data', corrupted)
        const after = ha.devices[DEVICE_ID].properties
        assert.equal(after.course, before.course)
        assert.equal(after.smart_course, before.smart_course)
    })

    test('error, smart diagnosis and energy stay clear on every captured frame', () => {
        const { ha, thinq } = makeDevice()
        for (const f of [REMOTE_ON, REMOTE_OFF, PAUSE, PRESTEAM, RESERVED, POWEROFF]) thinq.emit('data', f)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.error, 'OFF')
        assert.equal(p.error_message, 'Normal')
        assert.equal(p.smart_diagnosis, 'OFF')
        assert.equal(p.energy, 0)
    })

    test('non-state frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REMOTE_ON)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', ACK)
        thinq.emit('data', NOTIFY_9)
        thinq.emit('data', COURSE_LIST)
        assert.deepEqual({ ...ha.devices[DEVICE_ID].properties }, before)
    })

    /*
     * The frames below are REAL: captured 2026-09-07 as the app drove each
     * action. The assertion is that this driver emits byte for byte what LG's
     * own app emitted — not that it agrees with its own idea of the format.
     */
    test('each write reproduces the frame LG itself sent for that command', () => {
        // Start Standard, immediate.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', 'Styling Standard')
            thinq.resetRecorder()
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1, 'start sent one frame')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                'aa34f02601010004000000000002645a00000005005a05b45a01b4001ab40000000000000000000000000000000000000000fabb',
            )
        }
        // Start Standard, store + 19-hour reservation.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', 'Styling Standard')
            dev.setProperty('store', 'ON')
            dev.setProperty('reserve_hours', '19')
            thinq.resetRecorder()
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1, 'reserved start sent one frame')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                'aa34f02601010006000013000002645a00000005005a05b45a01b4001ab4000000000000000000000000000000000000000091bb',
            )
        }
        // Start Quick, 19-hour reservation.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', 'Styling Quick')
            dev.setProperty('reserve_hours', '19')
            thinq.resetRecorder()
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1, 'quick start sent one frame')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                'aa34f02603010004000013000082645a00000003005a00000001b4000eb4000000000000000000000000000000000000000076bb',
            )
        }
        // Power off, pause, resume.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', 'Styling Standard')
            dev.setProperty('start_course', '')
            thinq.resetRecorder()
            dev.setProperty('pause', '')
            assert.equal(thinq.outbox[0].toString('hex'), 'aa09f02404010099bb')
            thinq.resetRecorder()
            dev.setProperty('resume', '')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                'aa33f026010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a1bb',
            )
            thinq.resetRecorder()
            dev.setProperty('power_off', '')
            assert.equal(thinq.outbox[0].toString('hex'), 'aa09f0240101009cbb')
        }
    })

    /*
     * Smart starts go out as the download + start pair, in that order —
     * exactly what the app emitted before each captured smart run. The 3-hour
     * reservation rides in the start head only, as captured.
     */
    test('smart starts reproduce the captured download + start pairs', () => {
        // Golf Wear Dry (base Time Dry 30), 3-hour reservation.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('smart_course_select', 'Golf Wear Dry')
            dev.setProperty('reserve_hours', '3')
            thinq.resetRecorder()
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 2, 'smart start sent two frames')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                'aa36f025032d11017900000000000080000000000000000000000000000055780000000000000000000000000000000000000000a8bb',
            )
            assert.equal(
                thinq.outbox[1].toString('hex'),
                'aa34f0261101790400000300008000000000000000000000000000005578000000000000000000000000000000000000000086bb',
            )
        }
        // Snow Raing Drying, 3-hour reservation.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('smart_course_select', 'Snow Raing Drying')
            dev.setProperty('reserve_hours', '3')
            thinq.resetRecorder()
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 2, 'smart start sent two frames')
            assert.equal(
                thinq.outbox[0].toString('hex'),
                'aa36f025032d0a014c0000000000000200000000000300000000000100002d78000000000000000000000000000000000000000072bb',
            )
            assert.equal(
                thinq.outbox[1].toString('hex'),
                'aa34f0260a014c0400000300000200000000000300000000000100002d780000000000000000000000000000000000000000a8bb',
            )
        }
    })

    test('selecting a smart course downloads it straight away, like the washer', () => {
        const { ha, thinq, dev } = makeDevice()
        // No state frame first: the appliance is off/unknown, and the sensor
        // must still reflect the selection because the download is sent anyway.
        dev.setProperty('smart_course_select', 'Golf Wear Dry')
        assert.equal(thinq.outbox.length, 1, 'select sent only the download frame')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa36f025032d11017900000000000080000000000000000000000000000055780000000000000000000000000000000000000000a8bb',
        )
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.smart_course_select, 'Golf Wear Dry')
        assert.equal(p.smart_course, 'Golf Wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
    })

    test('a polled idle frame does not wipe an armed smart course', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Golf Wear Dry')
        // The appliance is off and reports smart id 0 ("not running").
        thinq.emit('data', POWEROFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.smart_course, 'Golf Wear Dry')
        assert.equal(p.smart_course_select, 'Golf Wear Dry')
    })

    test('repeated identical status frames do not rewrite the memory file', () => {
        // Give this test its own memory file so it doesn't interfere with
        // other tests sharing the default one.
        const memFile = join(tmpdir(), 'rethink-course-memory-styler-nowrite-test.json')
        try {
            unlinkSync(memFile)
        } catch {
            // no memory file from a previous run — start clean
        }
        const previousMemFile = process.env.RETHINK_MEMORY_FILE
        process.env.RETHINK_MEMORY_FILE = memFile
        const warnSpy = mock.method(console, 'log')
        try {
            const { dev } = makeDevice()
            dev.setProperty('smart_course_select', 'Golf Wear Dry')
            // Make the file un-writable: if the driver's cached-entry skip
            // logic works, the repeated identical selection below never
            // calls writeFileSync again and this never gets hit. If it
            // regresses to writing on every call, the write fails and is
            // logged (saveMemory never throws).
            chmodSync(memFile, 0o444)
            dev.setProperty('smart_course_select', 'Golf Wear Dry')
            dev.setProperty('smart_course_select', 'Golf Wear Dry')
            assert.equal(warnSpy.mock.callCount(), 0)
        } finally {
            chmodSync(memFile, 0o644)
            warnSpy.mock.restore()
            process.env.RETHINK_MEMORY_FILE = previousMemFile
        }
    })

    // Bridge mode tunnels an app-issued download straight to the physical
    // appliance through send_packet(), bypassing setProperty entirely — the
    // same gap fixed for RH16_T_KR. HA must still learn about the change.
    test('bridge-tunnelled app download updates HA the same as a local select', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit(
            'sendData',
            buf(
                'aa36f025032d11017900000000000080000000000000000000000000000055780000000000000000000000000000000000000000a8bb',
            ),
        )
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.smart_course_select, 'Golf Wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
        assert.equal(p.smart_course, 'Golf Wear Dry')
    })

    test('bridge-tunnelled downloads are ignored when the body matches no known course', () => {
        const { ha, thinq, dev } = makeDevice()
        // Test isolation note: Device.remembered is keyed by device id and
        // this suite reuses one id throughout, so a prior test's armed
        // selection is still in effect here — assert the non-download frame
        // leaves it untouched rather than asserting a specific baseline.
        const before = ha.devices[DEVICE_ID].properties.smart_course_select
        thinq.emit('sendData', buf('aa08f024010000fcbb')) // power off, not a download
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, before)
    })

    test('course_select "Downloaded Course" routes Start course to the pre-selected smart course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Golf Wear Dry')
        dev.setProperty('reserve_hours', '3')
        // Re-selecting the placeholder base course must not lose the smart selection.
        dev.setProperty('course_select', 'Downloaded Course')
        thinq.resetRecorder()
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 2, 'smart start sent two frames')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa36f025032d11017900000000000080000000000000000000000000000055780000000000000000000000000000000000000000a8bb',
        )
        assert.equal(
            thinq.outbox[1].toString('hex'),
            'aa34f0261101790400000300008000000000000000000000000000005578000000000000000000000000000000000000000086bb',
        )
    })

    test('a start shows up straight away instead of waiting for the appliance', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', REMOTE_ON)
        dev.setProperty('course_select', 'Styling Standard')
        dev.setProperty('start_course', '')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Styling Standard')
        // ...and the appliance still has the last word.
        thinq.emit('data', REMOTE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
    })

    test('reserve hours reject anything outside 0 or 3..19', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('reserve_hours', '19')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 19)
        dev.setProperty('reserve_hours', '20')
        dev.setProperty('reserve_hours', '-1')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 19)
        // LG declares 0 (start now) or 3..19; 1 and 2 are outside that range.
        dev.setProperty('reserve_hours', '1')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 19)
        dev.setProperty('reserve_hours', '2')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 19)
        dev.setProperty('reserve_hours', '3')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 3)
        dev.setProperty('reserve_hours', '0')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 0)
    })

    test('a reconnect restores the armed smart course instead of resetting to Pants', () => {
        const first = makeDevice()
        first.dev.setProperty('smart_course_select', 'Golf Wear Dry')
        // A fresh handler for the same device (what a reconnect builds).
        const { ha } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.smart_course_select, 'Golf Wear Dry')
        assert.equal(p.smart_course, 'Golf Wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
    })

    test('a fresh idle frame after restart leaves smart_course untouched', () => {
        // A zero smart id while off/idle means "not running", not "no
        // course". Publishing map(0) ('None' -> HA unknown) here would wipe
        // HA's last displayed course on every restart (the F24VDD washer
        // never does that) — so the reading stays at its last value.
        // Clear the in-process remembered selection first: a real restart
        // wipes it (static memory), while earlier tests in this file armed
        // courses under the same device id.
        ;(DUT as unknown as { remembered: Map<string, unknown> }).remembered.clear()
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWEROFF)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('a restart restores the armed smart course from disk memory', () => {
        // Arm a download, wipe the in-process map (what a real restart
        // does), then build a fresh handler: the disk memory file restores
        // the selection, so smart_course keeps showing the installed
        // download like the F24VDD washer.
        const first = makeDevice()
        first.dev.setProperty('smart_course_select', 'Golf Wear Dry')
        ;(DUT as unknown as { remembered: Map<string, unknown> }).remembered.clear()
        const ha2 = new MockHAConnection()
        const thinq2 = new MockThinq2Device(DEVICE_ID, META)
        const second = new DUT(ha2.asConnection(), thinq2, META)
        assert.ok(second)
        const p = ha2.devices[DEVICE_ID].properties
        assert.equal(p.smart_course, 'Golf Wear Dry')
        assert.equal(p.smart_course_select, 'Golf Wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
    })

    test('a torn memory file boots with defaults instead of throwing', () => {
        // What a crash mid-write used to leave behind: truncated JSON.
        // Atomic saves make this impossible going forward, but files torn
        // by older versions must still boot cleanly with defaults. Clear
        // the in-process map first so this genuinely exercises the disk
        // path (same trick as the restart tests above).
        writeFileSync(process.env.RETHINK_MEMORY_FILE as string, `{"${DEVICE_ID}": {"smart": 6`)
        ;(DUT as unknown as { remembered: Map<string, unknown> }).remembered.clear()
        const ha2 = new MockHAConnection()
        const thinq2 = new MockThinq2Device(DEVICE_ID, META)
        assert.ok(new DUT(ha2.asConnection(), thinq2, META))
        const p = ha2.devices[DEVICE_ID].properties
        assert.equal(p.course_select, 'Styling Standard')
        assert.equal(p.smart_course, undefined)
    })
})
