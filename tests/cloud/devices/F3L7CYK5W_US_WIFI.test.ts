import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3L7CYK5W_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3L7CYK5W_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames captured from the physical machine, each cross-checked against the LG
// cloud's own decoded washerDryer state at matching timestamps. The comments name the cloud field that
// confirmed each one. Cloud events were filtered on matchesDevice — the dryer on the same account emits
// washerDryer updates sharing key names (state, preState, temp) that would otherwise corrupt the mapping.

// --- dial sweep: the course table is this model's own, and disagrees with F3L2CYU__ at nine of twelve
// positions. Course 0x06 is NORMAL here; the sibling's table calls it Heavy Duty.
const DIAL_SPEED_WASH = buf(
    'aa3a20ec001805010101010a0003050403000000000000000000332e0000001805000f000f0b0001050601000000000000000000332e000713bb',
)
const DIAL_DOWNLOADED = buf(
    'aa3a20ec001805000f000f0b0001050601000000000000000000332e0007001805002d002d0c0003050402000000000000000000332e0f00f9bb',
)
const DIAL_TUB_CLEAN = buf(
    'aa3a20ec001805002d002d0c0003050402000000000000000000332e0f00001805011d011d010000030002000000040000000000332e0000e0bb',
)
const DIAL_NORMAL = buf(
    'aa3a20ec00180502150215050005050402000000000000000000332e000000180501030103060003040402000000000000000000332e00001fbb',
)

// --- single-variable option toggles, each confirmed against the cloud enum named in the test
const COLD_WASH_ON = buf(
    'aa3a20ec00180501210121060003030702000000000000000000332e000000180501170117060003030202000000001000000000332e0000c0bb',
)
const EXTRA_RINSE_2 = buf(
    'aa3a20ec001805010e010e060003030412000000400000000000332e000000180501190119060003030422000000400000000000332e000047bb',
)
const CHILD_LOCK_ON = buf(
    'aa3a20ec00180501030103060003040402000000000000000000332e000000180501030103060003040402000000010000000000332e000076bb',
)
const STEAM_ON = buf(
    'aa3a20ec00180501030103060003040402000000000000000000332e0000001805021c021c060000040002000000040000000000332e000006bb',
)
const PRE_WASH_ON = buf(
    'aa3a20ec00180501030103060003040402000000000000000000332e000000180501120112060003040402000000080000000000332e00001dbb',
)
const DELAY_2H = buf(
    'aa3a20ec00180501030103060003040402000000000000000000332e000000180501030103060003040402000200020000000000332e000073bb',
)
const RINSE_SPIN_ON = buf(
    'aa3a20ec00180501000100040003030402000000000000000100332e0007001805000c000c040000030001000000200000000100332e00071bbb',
)

// --- a real Rinse+Spin run, including Add Garments pressed mid-cycle
const RINSING = buf(
    'aa3a20ec001805000c000c040000030001000000200000000100332e000700181e000c000c040000030001000000208000000105332e00074fbb',
)
const ADD_GARMENTS = buf(
    'aa3a20ec00181e000c000c040000030001000000208002000005332e0007001815000c000c04000003000100000020001200001e332e00070fbb',
)
const PAUSED = buf(
    'aa3a20ec001815000c000c04000003000100000020001200001e332e0007001806000c000c040000030001000000200010000015332e0007b5bb',
)
const RUN_COMPLETE = buf(
    'aa3a20ec0018280001000c040000030000000000208002000e1e332e000700183c00010000fe0000000000000000000000000e28332e000031bb',
)

// --- frames from an earlier passive capture of three full Normal cycles (no cloud bridge; these are the
// ones that establish the timer and cycle-counter behaviour over a complete wash)
const EB_OFF = buf('aa2020eb00180000010000fe0000000000000000000000000005332b00001abb')
const SELECTING = buf(
    'aa3a20ec00180000010000fe0000000000000000000000000005332b000000180501030103060003040402000000008000000000332b0000d5bb',
)
const SENSING = buf(
    'aa3a20ec00180501030103060003040402000000008000000000332b000000181401030103060003040402000000008000000005332b000065bb',
)
const DOOR_CLOSES = buf(
    'aa3a20ec00181401030103060003040402000000008000000005332b000000181401030103060003040402000000008002000005332b000013bb',
)
const WASHING_START = buf(
    'aa3a20ec00181401030103060003040402000000008002000005332b000000181701140114060003040402000000008002000014332b0004d5bb',
)
const WASHING_MINUTE_LATER = buf(
    'aa3a20ec00181701140114060003040402000000008002000014332b000400181701130114060003040402000000008002000114332b0004edbb',
)
const WASHING_TO_RINSING = buf(
    'aa3a20ec001817003a0114060003040402000000008002002414332b000400181e00390114060000040402000000008002002617332b000407bb',
)
const SPINNING = buf(
    'aa3a20ec00181e00150114060000040401000000008002003f17332b00040018280014011406000004000000000000800200411e332b00041abb',
)
const CYCLE_COMPLETE = buf(
    'aa3a20ec0018280001011406000004000000000000800200671e332b000400183c00010000fe0000000000000000000000006c28332c0000aabb',
)
const OFF = buf(
    'aa3a20ec00183c00010000fe0000000000000000000000006c28332c000000180000010000fe0000000000000000000000006c3c332c000001bb',
)
const SECOND_RUN_WASHING = buf(
    'aa3a20ec00181401030103060003040402000000008002000005332d0000001817003a003a060003040402000000008002000014332d000398bb',
)

// A 0xE2 frame captured 15s AFTER a cycle completed. 28 bytes with a valid 0x18 record at offset 3 —
// structurally indistinguishable from 0xEB — but it replays the START of the finished cycle.
const E2_STALE_REPLAY = buf('aa2020e203181401030103060003040402000000008000006c05332b000030bb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('F3L7CYK5W_US_WIFI', () => {
    test('0xEB single-record frames decode with the same offsets as 0xEC', () => {
        const p = feed([EB_OFF])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'unknown') // 0xFE is the no-selection sentinel
        assert.equal(p.remaining_time, 0)
        assert.equal(p.tub_clean_count, 43)
    })

    // This is the test that would fail if this model were aliased to F3L2CYU__: the sibling's table maps
    // 0x06 to Heavy Duty, 0x0b to Rinse+Spin and 0x0c to Speed Wash.
    test('the course table is this model’s own, not the sibling’s', () => {
        assert.equal(feed([DIAL_NORMAL]).course, 'Normal') // cloud: NORMAL (sibling says Heavy Duty)
        assert.equal(feed([DIAL_SPEED_WASH]).course, 'Speed Wash') // cloud: SPEEDWASH
        assert.equal(feed([DIAL_DOWNLOADED]).course, 'Downloaded') // cloud: DOWNLOAD
        assert.equal(feed([DIAL_TUB_CLEAN]).course, 'Tub Clean') // cloud: TUB_CLEAN
    })

    test('while selecting, remaining and initial time agree', () => {
        const p = feed([SELECTING])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'Normal')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.remaining_time, 63)
        assert.equal(p.initial_time, 63)
    })

    test('Sensing is a real distinct phase on this model', () => {
        const p = feed([SELECTING, SENSING])
        assert.equal(p.status, 'Sensing')
        assert.equal(p.remaining_time, 63)
    })

    test('rec[11] packs rinse count and extra-rinse count in separate nibbles', () => {
        const plain = feed([DIAL_NORMAL])
        assert.equal(plain.rinse_count, 2) // cloud: RINSE_2
        assert.equal(plain.extra_rinse_count, 0) // cloud: NO_EXTRARINSE
        assert.equal(plain.extra_rinse, 'OFF')

        const extra = feed([EXTRA_RINSE_2])
        assert.equal(extra.extra_rinse, 'ON') // cloud: EXTRARINSE_ON
        assert.equal(extra.extra_rinse_count, 2) // cloud: EXTRARINSE_2
        assert.equal(extra.rinse_count, 2) // the low nibble is untouched by the extra-rinse button
    })

    test('the rec[15] option bits each isolate cleanly', () => {
        const lock = feed([CHILD_LOCK_ON])
        assert.equal(lock.child_lock, 'ON') // cloud: CHILDLOCK_ON — the sibling has no bit for this
        assert.equal(lock.steam, 'OFF')
        assert.equal(lock.pre_wash, 'OFF')
        assert.equal(lock.delay_wash, 'OFF')

        assert.equal(feed([STEAM_ON]).steam, 'ON') // cloud: STEAM_ON
        assert.equal(feed([PRE_WASH_ON]).pre_wash, 'ON') // cloud: PREWASH_ON

        const rs = feed([RINSE_SPIN_ON])
        assert.equal(rs.rinse_spin, 'ON') // cloud: RINSE_SPIN_ON — also absent from the sibling
        assert.equal(rs.child_lock, 'OFF')
        assert.equal(rs.extra_rinse, 'OFF')
    })

    test('cold wash sits in the other bitfield and forces the temperature index', () => {
        const p = feed([COLD_WASH_ON])
        assert.equal(p.cold_wash, 'ON') // cloud: COLDWASH_ON
        assert.equal(p.temp, 'Cold') // cloud: TEMP_COLD
        assert.equal(p.child_lock, 'OFF') // rec[15] untouched
    })

    test('delay wash exposes its reserve clock', () => {
        const p = feed([DELAY_2H])
        assert.equal(p.delay_wash, 'ON') // cloud: DELAY_ON
        assert.equal(p.reserve_time, 120) // cloud: reserveTimeHour 2
    })

    test('door position is never published — rec[17] is the latch, not a door sensor', () => {
        // Retracted 2026-08-13 after testing the real appliance: polled with the door physically OPEN and
        // again physically CLOSED (powered on, idle) the frames were byte-for-byte identical, and moving
        // the door produced no frame at all. rec[17] bit 0x02 only tracks the cycle latch and lags rec[16]
        // on release, so the old entity reported "open" whenever the washer was merely idle.
        const open = feed([SENSING])
        assert.equal(open.door, undefined)
        assert.equal(open.door_lock, 'ON')

        // rec[17] does change between these two frames — it must not be surfaced as door position
        const shut = feed([SENSING, DOOR_CLOSES])
        assert.equal(shut.door, undefined)
        assert.equal(shut.door_lock, 'ON')
    })

    test('initial time pins when the cycle starts while remaining time counts down', () => {
        const start = feed([SENSING, WASHING_START])
        assert.equal(start.status, 'Washing')
        assert.equal(start.remaining_time, 80)
        assert.equal(start.initial_time, 80)

        const later = feed([SENSING, WASHING_START, WASHING_MINUTE_LATER])
        assert.equal(later.remaining_time, 79)
        assert.equal(later.initial_time, 80) // pinned, not following the countdown

        // and the pinned value is per-run, not a constant
        const second = feed([SECOND_RUN_WASHING])
        assert.equal(second.remaining_time, 58)
        assert.equal(second.initial_time, 58)
    })

    test('Add Garments unlocks the door mid-cycle and Pause follows it', () => {
        const running = feed([RINSE_SPIN_ON, RINSING])
        assert.equal(running.status, 'Rinsing')
        assert.equal(running.door_lock, 'ON')
        assert.equal(running.load_level, 7) // cloud: loadLevel 7

        const adding = feed([RINSE_SPIN_ON, RINSING, ADD_GARMENTS])
        assert.equal(adding.status, 'Add Garments') // cloud: ADD_DRAIN
        assert.equal(adding.door_lock, 'OFF') // the whole point of the feature

        const paused = feed([RINSE_SPIN_ON, RINSING, ADD_GARMENTS, PAUSED])
        assert.equal(paused.status, 'Pause') // cloud: PAUSE
        assert.equal(paused.door_lock, 'OFF')
    })

    test('a real run: Washing -> Rinsing -> Spinning, settings drop out as they stop applying', () => {
        const rinsing = feed([WASHING_START, WASHING_TO_RINSING])
        assert.equal(rinsing.status, 'Rinsing')
        assert.equal(rinsing.soil, 'unknown') // soil index goes to 0 once washing ends
        assert.equal(rinsing.temp, 'Warm')
        assert.equal(rinsing.initial_time, 80)

        const spinning = feed([WASHING_START, WASHING_TO_RINSING, SPINNING])
        assert.equal(spinning.status, 'Spinning')
        assert.equal(spinning.temp, 'unknown')
        assert.equal(spinning.door_lock, 'ON')
    })

    test('completing a cycle unlocks the door and increments the tub-clean counter', () => {
        const before = feed([WASHING_START, SPINNING])
        assert.equal(before.tub_clean_count, 43)

        const done = feed([WASHING_START, SPINNING, CYCLE_COMPLETE])
        assert.equal(done.status, 'Complete')
        assert.equal(done.power, 'ON') // Complete is still powered on
        assert.equal(done.tub_clean_count, 44) // cloud: TCLCount
        assert.equal(done.door_lock, 'OFF')
        // a finished washer must not advertise a stale minute of remaining time
        assert.equal(done.remaining_time, 0)
        assert.equal(done.initial_time, 0)
    })

    test('the Rinse+Spin run also lands on Complete', () => {
        const p = feed([RINSING, RUN_COMPLETE])
        assert.equal(p.status, 'Complete')
        assert.equal(p.course, 'unknown') // parks on the 0xFE sentinel
        assert.equal(p.tub_clean_count, 46)
    })

    test('powering off clears the selection', () => {
        const p = feed([WASHING_START, SPINNING, CYCLE_COMPLETE, OFF])
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.course, 'unknown')
        assert.equal(p.remaining_time, 0)
    })

    test('0xE2 post-cycle replay frames are ignored, not treated as status', () => {
        // fed straight after a completed cycle, this frame must not drag the machine back to Sensing
        const p = feed([WASHING_START, SPINNING, CYCLE_COMPLETE, E2_STALE_REPLAY])
        assert.equal(p.status, 'Complete')
        assert.equal(p.tub_clean_count, 44) // not rolled back to the frame's stale 43
        assert.equal(p.remaining_time, 0) // not the frame's stale 63
    })

    test('start() requests a status snapshot, so a reconnect does not leave HA blank', () => {
        // Without this the driver is purely passive: the washer only volunteers a frame when
        // something changes, so after a restart HA would sit at "Off"/unknown until someone
        // physically touched the machine.
        const { thinq, dev } = makeDevice()
        dev.start()

        // AA | length | 0xF0ED status query | checksum | BB. Verified against a live F3L7CYK5W,
        // which answered this exact frame with a 0xEB snapshot.
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa0ef0ed1121010000001800b5bb'],
        )
    })

    test('frames that are not status frames publish nothing', () => {
        for (const junk of ['aa0720d800fcbb', 'aa09207200c9005bbb', 'aa0a20ec001805010cbb']) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {}, `frame ${junk} should publish nothing`)
        }
    })
})
