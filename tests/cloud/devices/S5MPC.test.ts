import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/S5MPC'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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
 * Every one of them reads error ERROR_NO and energyMonitoring 0, and byte 24
 * (currentDownloadCourse1) holds the installed smart course throughout.
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
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Course complete')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
    })

    test('a smart course whose base id is 13/14/16/27/67/78 still reports a course label', () => {
        // Those base ids never run standalone via Start course, so they were
        // missing from COURSE and a direct run of one of them (smartCourse
        // 0, course = the base id) left `course` unpublished. Base id 67
        // doubles as both a smart course and a directly startable course.
        const packet = Buffer.from(SMART_RUN)
        const currentRecord = packet.length - 2 - 27
        packet[currentRecord + 5] = 67 // OFF.course
        packet[currentRecord + 20] = 0 // OFF.smartCourse: no smart course running
        const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Quiet Care')
    })

    test('a running smart course reports its base course and the smart course id', () => {
        const packet = Buffer.from(SMART_RUN)
        const currentRecord = packet.length - 2 - 27
        packet[currentRecord + 5] = 67 // OFF.course
        packet[currentRecord + 20] = 67 // OFF.smartCourse
        const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        const { ha, thinq } = makeDevice()
        thinq.emit('data', packet)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Quiet Care')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Quiet Care')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Downloaded Course')
    })

    test('error and diagnosis states come from the shared styler table', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withCurrentState(5))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Check appliance')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        thinq.emit('data', withCurrentState(6))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Smart diagnosing')
    })

    test('a captured smart run reports the smart course and the installed download', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SMART_RUN)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Timed Dry 30')
        assert.equal(p.smart_course, 'Golf-wear Dry')
        assert.equal(p.download_course, 'Golf-wear Dry')
        assert.equal(p.smart_course_select, 'Golf-wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
    })

    test('error and energy stay clear on every captured frame', () => {
        const { ha, thinq } = makeDevice()
        for (const f of [REMOTE_ON, REMOTE_OFF, PAUSE, PRESTEAM, RESERVED, POWEROFF]) thinq.emit('data', f)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.error, 'OFF')
        assert.equal(p.error_message, 'Normal')
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
        // Pause, resume, power off.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', 'Styling Standard')
            dev.setProperty('start_course', '')
            thinq.resetRecorder()
            dev.setProperty('pause_course', '')
            assert.equal(thinq.outbox[0].toString('hex'), 'aa09f02404010099bb')
            thinq.resetRecorder()
            dev.setProperty('resume_course', '')
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
        // Golf-wear Dry (base Time Dry 30), 3-hour reservation.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('smart_course_select', 'Golf-wear Dry')
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
        // Snow/Rain Dry, 3-hour reservation.
        {
            const { thinq, dev } = makeDevice()
            dev.setProperty('smart_course_select', 'Snow/Rain Dry')
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
        dev.setProperty('smart_course_select', 'Golf-wear Dry')
        assert.equal(thinq.outbox.length, 1, 'select sent only the download frame')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa36f025032d11017900000000000080000000000000000000000000000055780000000000000000000000000000000000000000a8bb',
        )
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.smart_course_select, 'Golf-wear Dry')
        assert.equal(p.course_select, 'Downloaded Course')
    })

    test('the installed download is read from the appliance, idle or off', () => {
        // Byte 24 keeps the installed smart course while idle and powered off, so a
        // download made from the LG app shows up the same as one made here.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REMOTE_ON)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.download_course, 'Uniform Care')
        assert.equal(p.smart_course_select, 'Uniform Care')
        assert.equal(p.smart_course, 'None')
        thinq.emit('data', POWEROFF)
        assert.equal(p.power, 'OFF')
        assert.equal(p.download_course, 'Padding Care')
        assert.equal(p.smart_course_select, 'Padding Care')
    })

    test('Start course on Downloaded Course runs the download the appliance reports', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', REMOTE_ON) // byte 24 = 98, Uniform Care on base 27
        dev.setProperty('course_select', 'Downloaded Course')
        thinq.resetRecorder()
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 2, 'smart start sent two frames')
        assert.ok(thinq.outbox[0].toString('hex').startsWith('aa36f025032d1b0162'), 'download of 98')
        assert.ok(thinq.outbox[1].toString('hex').startsWith('aa34f0261b0162'), 'start of 98')
    })

    test('course_select "Downloaded Course" routes Start course to the pre-selected smart course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Golf-wear Dry')
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
})
