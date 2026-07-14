import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3L2CYU__'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3L2CYU__'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F3L2CYU__', swVersion: '0.0.0' }

// All fixtures are REAL 0xEC frames captured live from the appliance (a WM3900HBA / F3L2CYU2E.ABLEUUS,
// which self-reports modelId "F3L2CYU__") via the rethink-agent MCP tools, cross-checked against the LG
// cloud's own decoded washerDryer state at matching timestamps. The AA + length and checksum + BB
// envelope bytes are not validated on input, so these parse identically to the originals.

// A single-record 0xEB frame — same field layout as 0xEC's record B, just without a preceding "old
// state" record. Captured live right after the appliance reconnected to rethink-cloud post-deploy, idle
// with nothing selected (phase Selecting, course/soil/spin/temp all their zero/none sentinel).
const EB_RECONNECT_IDLE = buf('aa2020eb001805000000000000000000000000000000000000003318000068bb')

// Idle, dial resting on Normal (course/soil/spin/temp at their settled defaults). Notable real-world
// quirk confirmed live: Turbo Wash reads ON here and cannot be turned off while on Normal (course-locked),
// unlike Speed Wash where it's freely toggleable (see the Delay Wash / Turbo Wash block below).
const NORMAL_IDLE = buf(
    'aa3a20ec0018050000000000000000000000000000000000000033170000001805002e002e07000304040100000080000000000033170000f8bb',
)
// Course/dial-position identifier (offset 6 from the record marker) for several other programs — proves
// the identifier is a single stable byte, distinct from the time-estimate bytes at offset 2-3 (which an
// earlier reverse-engineering pass mistook for a "course code" before realizing it shifts with settings).
const COURSE_TOWELS = buf(
    'aa3a20ec001805002900290a000303020200000000000000000033170007001805010101010b0003050403000000000000000000331700001cbb',
)
const COURSE_SPEEDWASH = buf(
    'aa3a20ec001805010101010b000305040300000000000000000033170000001805000f000f0c0001050601000000000000000000331700074fbb',
)
const COURSE_RINSE_SPIN = buf(
    'aa3a20ec001805000f000f0c000105060100000000000000000033170007001805000b000b0d0000040000000000000000000000331700077fbb',
)
const COURSE_SMALL_LOAD = buf(
    'aa3a20ec001805000b000b0d000004000000000000000000000033170007001805002d002d0e000304040200000000000000000033170f0025bb',
)
const COURSE_TUB_CLEAN = buf(
    'aa3a20ec001805002d002d0e000304040200000000000000000033170f00001805011d011d01000003000200000004000000000033170000ddbb',
)

// Settings toggles, each isolated by changing exactly one control while parked on Normal and matched
// against the cloud's own enum for that field (soilWash/spin/temp/coldWash/extraRinse/preWash/steam).
const SOIL_NORMAL_HEAVY = buf(
    'aa3a20ec001805002e002e070003040401000000800000000000331700000018050033003307000404040100000080000000010033170000fdbb',
)
const SPIN_EXTRA_HIGH = buf(
    'aa3a20ec001805002e002e07000304040100000080000000010033170000001805003a003a07000305040100000080000000010033170000e2bb',
)
const TEMP_HOT = buf(
    'aa3a20ec001805002e002e07000304040100000080000000010033170000001805002e002e07000304060100000080000000010033170000f5bb',
)
// Cold Wash also forces the temp index to 0x02 (Cold) — confirmed here (temp reads 'Cold', not the prior
// 'Warm'), matching the real appliance behavior, not just a coincidence of this capture.
const COLD_WASH_ON = buf(
    'aa3a20ec001805002e002e0700030404010000008000000001003317000000180501060106070003040201000000801000000100331700000bbb',
)
const EXTRA_RINSE_ON_1 = buf(
    'aa3a20ec001805002e002e0700030404010000008000000001003317000000180500330033070003040411000000c0000000010033170000adbb',
)
const PRE_WASH_ON = buf(
    'aa3a20ec001805002e002e0700030404010000008000000001003317000000180501010101070003040401000000880000000100331700001bbb',
)
const STEAM_ON = buf(
    'aa3a20ec001805002e002e07000304040100000080000000010033170000001805020b020b070000040001000000840000000100331700000cbb',
)

// A full Speed Wash run, captured end-to-end. SELECTING_TO_WASHING is the exact frame where a bridge-mode
// "Start" command from the LG app landed and the washer transitioned — a genuine remote-start round trip,
// not just a status readback.
const SELECTING_TO_WASHING = buf(
    'aa3a20ec001805000f000f0c000105060100000000800200020033170007001817000f000f0c00010506010000000080020000053317000702bb',
)
const WASHING = buf(
    'aa3a20ec001817000f000f0c000105060100000000800200000533170007001817000e000f0c0001050601000000008002000005331700073ebb',
)
const RINSING = buf(
    'aa3a20ec001817000d000f0c00010506010000000080020012053317000700181e000c000f0c000005060100000000800200231733170007e1bb',
)
// Baseline for the pause/door block below: running, door locked and closed.
const RINSING_LOCKED_CLOSED = buf(
    'aa3a20ec00181e000c000f0c00000506010000000080020023173317000700181e000b000f0c00000506010000000080020024173317000789bb',
)
const SPINNING = buf(
    'aa3a20ec00181e000a000f0c0000050601000000008002002506331700070018280009000f0c000005000000000000800200261e3317000780bb',
)
const COMPLETE = buf(
    'aa3a20ec0018280001000f0c000005000000000000800200391e3317000700183c00010000fe000000000000000000000000402833180000d4bb',
)

// Pause (from the physical panel, mid-Rinsing) -> door opened -> resume -> door closed again. Confirms
// the door-lock bit (offset 16, 0x80) and the plain door-closed sensor (offset 17, 0x02) are independent:
// the machine can be paused with the door shut but unlocked.
const PAUSE_UNLOCKS = buf(
    'aa3a20ec00181e000b000f0c000005060100000000800200241733170007001806000b000f0c000005060100000000000200251e3317000719bb',
)
const DOOR_OPENS_WHILE_PAUSED = buf(
    'aa3a20ec001806000b000f0c000005060100000000000200251e33170007001806000b000f0c000005060100000000000000251e33170007efbb',
)
// Door-lock re-engages on resume even though this exact frame still reads the door as open — the physical
// door-close follows a moment later (see DOOR_CLOSES_AGAIN), matching real-world timing.
const RESUME_RELOCKS = buf(
    'aa3a20ec00181e000b000f0c000005060100000000000000251e3317000700181e000b000f0c0000050601000000008000002506331700076dbb',
)
const DOOR_CLOSES_AGAIN = buf(
    'aa3a20ec00181e000b000f0c00000506010000000080000025063317000700181e000b000f0c000005060100000000800200250633170007efbb',
)

// Delay Wash armed for 1 hour, then Turbo Wash enabled, both while still Selecting (Speed Wash, a course
// where Turbo Wash is actually toggleable — unlike Normal above).
const DELAY_1H_ARMED_STILL_SELECTING = buf(
    'aa3a20ec001805000f000f0c000105060100000000000000400033180007001805000f000f0c000105060100010002000000400033180007eabb',
)
const TURBO_ON_STILL_SELECTING = buf(
    'aa3a20ec001805000f000f0c000105060100010002000000400033180007001805000f000f0c00010506010001008200000040003318000717bb',
)
// Phase flips to Delay Wash pending (0x0a) and the door locks immediately, before the cycle actually runs.
const DELAY_PENDING_LOCKS_DOOR = buf(
    'aa3a20ec001805000f000f0c00010506010001008200000040003318000700180a000f000f0c00010506010001008280000040053318000719bb',
)
const DELAY_DOOR_CLOSES = buf(
    'aa3a20ec00180a000f000f0c00010506010001008280000040053318000700180a000f000f0c000105060100010082800200000533180007cdbb',
)
// Remote pause (from the LG app) of the Delay Wash countdown, then remote resume with the reserve time
// changed to 3 hours, then the reserve-time countdown ticking across an hour boundary (3:00 -> 2:59).
const APP_PAUSE = buf(
    'aa3a20ec00180a000f000f0c000105060100003a82800200000533180007001806000f000f0c000105060100003a82800200000a3318000798bb',
)
const APP_RESUME_3H = buf(
    'aa3a20ec001806000f000f0c000105060100003a82800200000a3318000700180a000f000f0c000105060100030082800200000633180007c2bb',
)
const RESERVE_TICKS = buf(
    'aa3a20ec00180a000f000f0c00010506010003008280020000063318000700180a000f000f0c000105060100023b82800200000633180007cfbb',
)
// Remote power-off (from the LG app) during the Delay Wash countdown: phase drops straight to Off and the
// course/settings bytes reset to their sentinel values (course 0xfe, soil/spin/temp all 0).
const APP_POWEROFF = buf(
    'aa3a20ec00180a000f000f0c000105060100023a8280020000063318000700180000010000fe000000000000000000000200000a331800001abb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('F3L2CYU__', () => {
    test('0xEB single-record frames decode with the same offsets as 0xEC, seen right after reconnect', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_RECONNECT_IDLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Selecting')
        assert.equal(p.course, 'unknown') // course byte is 0 — nothing selected yet
        assert.equal(p.door, 'ON') // open (byte reads 0, not the 0x02 closed value)
    })

    test('idle, Selecting on Normal: course/soil/spin/temp settle to their defaults', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NORMAL_IDLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Selecting')
        assert.equal(p.course, 'Normal')
        assert.equal(p.remaining_time, 46)
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        // Course-locked quirk, confirmed live: Turbo Wash is forced ON on Normal and can't be toggled off.
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.door, 'ON') // open — this capture was taken with the door open while browsing
        assert.equal(p.door_lock, 'OFF')
    })

    test('the course/dial-position byte (offset 6) identifies each program independently of the shifting time-estimate bytes', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        for (const [frame, course] of [
            [COURSE_TOWELS, 'Towels'],
            [COURSE_SPEEDWASH, 'Speed Wash'],
            [COURSE_RINSE_SPIN, 'Rinse+Spin'],
            [COURSE_SMALL_LOAD, 'Small Load'],
            [COURSE_TUB_CLEAN, 'Tub Clean'],
        ] as const) {
            thinq.emit('data', frame)
            assert.equal(p.course, course)
        }
    })

    test('single-variable settings toggles decode soil/spin/temp/cold-wash/extra-rinse/pre-wash/steam', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', SOIL_NORMAL_HEAVY)
        assert.equal(p.soil, 'Normal-Heavy')

        thinq.emit('data', SPIN_EXTRA_HIGH)
        assert.equal(p.spin, 'Extra High')

        thinq.emit('data', TEMP_HOT)
        assert.equal(p.temp, 'Hot')

        thinq.emit('data', COLD_WASH_ON)
        assert.equal(p.cold_wash, 'ON')
        assert.equal(p.temp, 'Cold') // Cold Wash forces the temp index too

        thinq.emit('data', EXTRA_RINSE_ON_1)
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.extra_rinse_count, 1)

        thinq.emit('data', PRE_WASH_ON)
        assert.equal(p.pre_wash, 'ON')

        thinq.emit('data', STEAM_ON)
        assert.equal(p.steam, 'ON')
    })

    test('a full Speed Wash run: remote start, phase transitions, and the remaining-time countdown', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', SELECTING_TO_WASHING)
        assert.equal(p.status, 'Washing')
        assert.equal(p.remaining_time, 15)

        thinq.emit('data', WASHING)
        assert.equal(p.status, 'Washing')
        assert.equal(p.remaining_time, 14)

        thinq.emit('data', RINSING)
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.remaining_time, 12)

        thinq.emit('data', SPINNING)
        assert.equal(p.status, 'Spinning')
        assert.equal(p.remaining_time, 9)

        thinq.emit('data', COMPLETE)
        assert.equal(p.status, 'Complete')
        // Course/soil/spin/temp fall back to 'unknown' here — the Complete-phase frame's course byte is
        // 0xfe, the same sentinel used at power-off, not one of the 14 named programs.
        assert.equal(p.course, 'unknown')
    })

    test('pause unlocks the door, opening/closing the door is independent of the lock, and resume relocks', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', RINSING_LOCKED_CLOSED)
        assert.equal(p.door_lock, 'ON')
        assert.equal(p.door, 'OFF') // closed

        thinq.emit('data', PAUSE_UNLOCKS)
        assert.equal(p.status, 'Paused')
        assert.equal(p.door_lock, 'OFF')
        assert.equal(p.door, 'OFF') // still closed

        thinq.emit('data', DOOR_OPENS_WHILE_PAUSED)
        assert.equal(p.door, 'ON') // now open
        assert.equal(p.door_lock, 'OFF')

        thinq.emit('data', RESUME_RELOCKS)
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.door_lock, 'ON')

        thinq.emit('data', DOOR_CLOSES_AGAIN)
        assert.equal(p.door, 'OFF') // closed
        assert.equal(p.door_lock, 'ON')
    })

    test('Delay Wash: arming, Turbo Wash, the Delay-pending phase, reserve-time countdown, remote pause/resume, and remote power-off', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', DELAY_1H_ARMED_STILL_SELECTING)
        assert.equal(p.status, 'Selecting') // not yet armed as a running delay
        assert.equal(p.delay_wash, 'ON')
        assert.equal(p.reserve_time, 60)

        thinq.emit('data', TURBO_ON_STILL_SELECTING)
        assert.equal(p.turbo_wash, 'ON') // toggleable on Speed Wash, unlike Normal

        thinq.emit('data', DELAY_PENDING_LOCKS_DOOR)
        assert.equal(p.status, 'Delay Wash')
        assert.equal(p.door_lock, 'ON') // locks as soon as the delay is armed, not just once running

        thinq.emit('data', DELAY_DOOR_CLOSES)
        assert.equal(p.door, 'OFF')

        thinq.emit('data', APP_PAUSE)
        assert.equal(p.status, 'Paused')

        thinq.emit('data', APP_RESUME_3H)
        assert.equal(p.status, 'Delay Wash')
        assert.equal(p.reserve_time, 180)

        thinq.emit('data', RESERVE_TICKS)
        assert.equal(p.reserve_time, 179) // 3:00 -> 2:59 across the hour boundary

        thinq.emit('data', APP_POWEROFF)
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.reserve_time, 0)
        assert.equal(p.course, 'unknown')
    })

    test('unknown frame type and non-envelope frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NORMAL_IDLE)
        const before = ha.devices[DEVICE_ID].properties.status
        thinq.emit('data', buf('aa0720d81795bb')) // 0xd8 heartbeat
        thinq.emit('data', buf('aa09207200000010bb')) // 0x72 heartbeat
        thinq.emit('data', buf('001122')) // not an AA..BB envelope
        assert.equal(ha.devices[DEVICE_ID].properties.status, before)
    })
})
