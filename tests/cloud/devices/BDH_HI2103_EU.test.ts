import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/BDH_HI2103_EU'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'BDH_HI2103_EU'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.242' }

// All fixtures are REAL frames captured live from an RH18U8AVCW via rethink-capture, with rethink
// bridged to the LG cloud. The comment on each names the cloud washerDryer fields reported in the same
// second, which is what confirmed it.

// Dial on Wool: cloud course "WOOL", ecoHybrid "ECOHYBRID_NORMAL", remainTimeMinute 29. Wool is the one
// course the US model does not have.
const WOOL = buf(
    'aaff300a00660008e2000100ec005400000100000800000000370000010000020000000800009400000080000000000000000000000000000000000200000b000000001d0000010000020000000b0000940000008000000000000000000000000000001687bb',
)

// Dial on Down Blanket: cloud course "BEDDING", remainTimeMinute 175.
const DOWN_BLANKET = buf(
    'aaff300a00660008f7000100ec005400000200000f00000000140000010000010000000f00009400000080000000000000000000000000000000000200000400000000af00000100000200000004000094000000800000000000000000000000000000ba84bb',
)

// Dial on Baby Care: cloud course "BABYWEAR". Next to it, Small Load, which the cloud calls QUICKDRY,
// with detectLoad "DETECT_LOAD_ON" and ecoHybrid "ECOHYBRID_TURBO".
const BABY_CARE = buf(
    'aaff300a00660008a5000100ec0054000003000010000000009600000100000100000010000094000000800000000000000000000000000000000002000017000000003c00000100000200000017000094000000800000000000000000000000000000495abb',
)
const SMALL_LOAD = buf(
    'aaff300a00660008ae000100ec0054000002000017000000003c00000100000200000017000094000000800000000000000000000000000000000003000009000000006400000100000000000009000094000004800000000000000000000000000000197bbb',
)

// Dial on AI Dry: cloud course "AI_COURSE" with baseDownloadCourseData "SHIRT1EA". rec[5] reads 44 and
// rec[20] 28, which is what shows rec[5] is the field the cloud calls course.
const AI_DRY = buf(
    'aaff300a006600087a000100ec005400030200000700000000640000010000000000000700009420000480000000000000000000000000000000000200002c00000000640000010000000000001c00009420000480000000000000000000000000000034f3bb',
)

// The Drum Clean button: cloud course "TUBCLEAN", remainTimeMinute 160.
const DRUM_CLEAN = buf(
    'aaff300a00660009f8000100ec005400030200000700000000640000010000000000000700009400000480000000000000000000000000000000000300001300000000a000000100000200000013000094000000800000000000000000000000000000a480bb',
)

// The drying timer at 70 minutes: cloud initialTimeMinute 70, remainTimeMinute 70, course "TIMEDRY".
const TIMED_DRY_70 = buf(
    'aaff300a00660009fe000100ec005400000200041500000000320032010000020000001500009420000080000000000000000000000000000000000200001500000000460046010000020000001500009420000080000000000000000000000000000045d2bb',
)

// Download position before and after pushing Rack Dry from the app. Before: cloud course "DOWNLOAD"
// with baseDownloadCourseData "POWER", rec[23] = 148, the factory default the app calls Super Dry.
// After: downloadCourse "RACKDRY", rec[23] = 140.
const DOWNLOAD_BEFORE = buf(
    'aaff300a00660008ba000100ec00540000030000090000000064000001000000000000090000940000048000000000000000000000000000000000020000ff00000000640000010000000000001100009400000480000000000000000000000000000079c7bb',
)
const DOWNLOAD_RACK_DRY = buf(
    'aaff300a0066000a26000100ec00540003020000070000000064001e01000000000000070000942000048000000000000000000000000000000000010000ff000000001e001e010000020000000c00008c2000008000000000000000000000000000001707bb',
)

// The rest of the download slot, one cycle pushed from the app at a time, each with the cloud's
// downloadCourse in the same message.
const DOWNLOADED = {
    // GYMCLOTHES, rec[23] = 102
    'Gym Clothes': buf(
        'aaff300a0066003fe9000100ec00540000030000ff00000000640000010000000000002300006e2000048000000000000000000000000000000000010000ff000000003d00000100000200000021000066200000800000000000000000000000000000356dbb',
    ),
    // RAINYDAY, rec[23] = 105
    'Rainy Days': buf(
        'aaff300a0066004003000100ec00540003020000ff0000000064000001000000000000070000722800048000000000000000000000000000000000030000ff000000002800000100000200000022000069200000800000000000000000000000000000d79abb',
    ),
    // EASYIRON, rec[23] = 110
    'Easy Ironing': buf(
        'aaff300a0066003fe0000100ec00540000020000ff0000000064000001000000000000110000942000048000000000000000000000000000000000030000ff00000000640000010000000000002300006e200004800000000000000000000000000000d124bb',
    ),
    // MINIMIZEWRINKLES, rec[23] = 114, which also switches Anti-crease on
    'Minimize Wrinkles': buf(
        'aaff300a0066003ffb000100ec00540000010000ff000000003d000001000002000000210000662000008000000000000000000000000000000003020000ff000000006400000100000000000007000072280004800000000000000000000000000000a553bb',
    ),
    // OVERNIGHTDRY, rec[23] = 126
    Silent: buf(
        'aaff300a006600401c000100ec00540002020000ff000000006e0000010000020000002000008e0000008000000000000000000000000000000000020000ff00000000640000010000020000001e00007e0000008000000000000000000000000000009bedbb',
    ),
    // CLOTHINGCARE, rec[23] = 142
    'Shrinkage Relief': buf(
        'aaff300a006600400e000100ec00540000030000ff0000000028000001000002000000220000690000008000000000000000000000000000000002020000ff000000006e0000010000020000002000008e0000008000000000000000000000000000002b1abb',
    ),
    // POWER, rec[23] = 148, pushed back from the app at the start of the second session
    'Super Dry': buf(
        'aaff300a0066003fd4000100ec005400000000000000000000000000010000000000000000008c2000008000000000000000000000000000000000020000ff000000006400000100000000000011000094200004800000000000000000000000000000f18abb',
    ),
}

// Eco with the dryness level stepped, cloud dryLevel in each: DRYLEVEL_LESSDRY at rec[1] = 2,
// DRYLEVEL_CUPBOARD at 4, DRYLEVEL_VERYDRY at 5. The panel names them Light, Very Dry and Extra Dry:
// Extra Dry was lit while the byte read 5.
const DRYNESS_2 = buf(
    'aaff300a006600091c000100ec005400010200000700000000640000010000000000000700009400000480000000000000000000000000000000020200000700000000640000010000000000000700009400000480000000000000000000000000000029cbbb',
)
const DRYNESS_4 = buf(
    'aaff300a006600091a000100ec0054000302000007000000006400000100000000000007000094000004800000000000000000000000000000000402000007000000006400000100000000000007000094000004800000000000000000000000000000bfafbb',
)
const DRYNESS_5 = buf(
    'aaff300a0066000946000100ec005400040200000700000000640000010000000000000700009400000480000000000000000000000000000000050200000700000000640000010000000000000700009400000480000000000000000000000000000098cfbb',
)

// Drying mode stepped to ECO, cloud ecoHybrid "ECOHYBRID_ECO" (rec[2] = 1), with Extra Dry still set:
// the panel showed exactly these two lit.
const DRYING_MODE_ECO = buf(
    'aaff300a0066000957000100ec0054000502000007000000006400000100000000000007000094000004800000000000000000000000000000000501000007000000006400000100000000000007000094000004800000000000000000000000000000e5a7bb',
)

// Anti-crease on: cloud wrinkleCare "WRINKLECARE_ON" (rec[24] 0x08).
const ANTI_CREASE_ON = buf(
    'aaff300a006600098e000100ec0054000501000007000000006400000100000000000007000094000004800000000000000000000000000000000501000007000000006400000100000000000007000094080004800000000000000000000000000000d160bb',
)

// Damp dry signal on: cloud dampDryBeep "DAMPDRYBEEP_ON" and buzzer "BUZZER_4" in the same message, the
// appliance turning the buzzer back on with it.
const DAMP_DRY_SIGNAL_ON = buf(
    'aaff300a00660009e4000100ec005400030200000700000000640000010000000000000700009400000480000000000000000000000000000000030200000700000000640000010000000000040700009440000480000000000000000000000000000002cabb',
)

// A Cool Air run (the drying timer's 30-minute step): started, the door lock clicking in five seconds
// later, paused after two minutes, resumed, run on and switched off at the panel. Cloud, frame by frame:
//   START       state COOLING, preState INITIAL, remoteStart ON, drumLight OFF
//   LOCKED      doorLock DOORLOCK_ON
//   PAUSED      state PAUSE, preState COOLING, remoteStart OFF, drumLight ON, courseSpendPower 5
//   RESUMED     state COOLING, preState PAUSE, remoteStart ON, drumLight OFF
//   RUNNING     courseSpendPower 16, remainTimeMinute 23
//   POWERED_OFF state POWEROFF, course NOT_SELECTED, drumLight ON, initialTimeMinute 0
//   UNLOCKED    doorLock DOORLOCK_OFF, two seconds after power-off
const START = buf(
    'aaff300a0066000a42000100ec005400000000000d000000001e001e010000050000000d00008c20000080000000000000000000000000000000000000000d000000001e001e080100050000000d00008c000040800000000000000000000000000000fa63bb',
)
const LOCKED = buf(
    'aaff300a0066000a44000100ec005400000000000d000000001e001e080100050000000d00008c00004080000000000000000000000000000000000000000d000000001e001e080100050000000d00008c000041800000000000000000000000000000fd2abb',
)
const PAUSED = buf(
    'aaff300a0066000a6e000100ec005400000000000d000000001c001e080100050004000d00008c00004180000000000000000000000000000000000000000d000000001c001e030800050005000d00008c20000180000000000000000000000000000041c5bb',
)
const RESUMED = buf(
    'aaff300a0066000a7e000100ec005400000000000d000000001c001e030800050005000d00008c20000080000000000000000000000000000000000000000d000000001c001e080300050005000d00008c000040800000000000000000000000000000b43bbb',
)
const RUNNING = buf(
    'aaff300a0066000ac7000100ec005400000000000d0000000018001e08030005000d000d00008c00004180000000000000000000000000000000000000000d0000000017001e080300050010000d00008c000041800000000000000000000000000000f437bb',
)
const POWERED_OFF = buf(
    'aaff300a0066000be8000100ec005400000000000d0000000005001e08030005003d000d00008c0000418000000000000000000000000000000000000000000000000000000000080000003d000000008c2000018000000000000000000000000000003b91bb',
)
const UNLOCKED = buf(
    'aaff300a0066000be9000100ec00540000000000000000000000000000080000003d000000008c2000018000000000000000000000000000000000000000000000000000000000080000003d000000008c2000008000000000000000000000000000003107bb',
)

// After a mains power cycle LG's cloud sent the 0xF0ED status query, and the dryer answered with this
// single 0xEB record. The cloud's full state dump in the same second: state POWEROFF, course
// NOT_SELECTED, downloadCourse OVERNIGHTDRY (the slot survives power loss), every option off.
const STATUS_REPLY = buf(
    'aaff300a003c000013000100eb002a00000000000000000000000000000000000000000000007e0000008000000000000000000000000000003edabb',
)

// Paused on Eco with Turbo and Cupboard, anti-crease off, then the same a moment later with it on: the
// status the app's two resume-with-settings commands were sent from.
const PAUSED_ECO_TURBO = buf(
    'aaff300a00660003f0000100ec0054000303000407000000006400640e0300000000000700007e00004580000000000000000000000000000000030300040700000000640064030e00000000000700007e200045800000000000000000000000000000d6dabb',
)
const PAUSED_ECO_TURBO_CREASE = buf(
    'aaff300a0066000400000100ec0054000303000407000000006400640e0300000000000700007e08004580000000000000000000000000000000030300040700000000640064030e00000000000700007e2800458000000000000000000000000000000c0ebb',
)

// Start Wool: the same command the app sent for it, course 0x0b.
const AABB_START_WOOL = 'aa0ff0e5000201ff020a0b0301febb'

// Started with the door open: cloud state ERROR, error ERROR_DOOR (rec[15] = 16). Then closed and
// cleared at the panel: cloud state PAUSE, error ERROR_NO.
const DOOR_ERROR = buf(
    'aaff300a0066000699000100ec0054000302000007000000006400640e0100000000000700009400004480000000000000000000000000000000030200000700000000640064050e1000000000070000940000048000000000000000000000000000002f98bb',
)
const DOOR_ERROR_CLEARED = buf(
    'aaff300a00660006a2000100ec005400030200000700000000640064050e100000000007000094000004800000000000000000000000000000000302000007000000006400640305000000000007000094200004800000000000000000000000000000c667bb',
)

// Started with the lint filter removed: cloud state ERROR, error ERROR_NOFILTER (rec[15] = 18).
const FILTER_ERROR = buf(
    'aaff300a00660007b5000100ec0054000302000007000000006400640e0100000000000700009400004480000000000000000000000000000000030200000700000000640064050e120000000007000094000004800000000000000000000000000000eea1bb',
)

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

describe('BDH_HI2103_EU', () => {
    test('courses are named from the panel, not from the cloud identifiers', () => {
        assert.equal(feed([WOOL]).course, 'Wool')
        assert.equal(feed([DOWN_BLANKET]).course, 'Down Blanket') // cloud: BEDDING
        assert.equal(feed([BABY_CARE]).course, 'Baby Care') // cloud: BABYWEAR
        assert.equal(feed([SMALL_LOAD]).course, 'Small Load') // cloud: QUICKDRY
        assert.equal(feed([DRUM_CLEAN]).course, 'Drum Clean') // cloud: TUBCLEAN
        assert.equal(feed([TIMED_DRY_70]).course, 'Timed Dry')
        assert.equal(feed([START]).course, 'Cool Air')
    })

    test('the AI position is read from rec[5], not the loaded-cycle byte', () => {
        // rec[20] holds 28 here; reading it would report something other than what the dial shows
        assert.equal(feed([AI_DRY]).course, 'AI Dry')
    })

    test('the download slot always holds a cycle, named separately from the course', () => {
        const before = feed([DOWNLOAD_BEFORE])
        assert.equal(before.course, 'Downloaded cycle')
        assert.equal(before.download_course, 'Super Dry') // 148, not 0: the slot is never empty

        const after = feed([DOWNLOAD_RACK_DRY])
        assert.equal(after.course, 'Downloaded cycle')
        assert.equal(after.download_course, 'Rack Dry') // cloud: downloadCourse RACKDRY

        // and the slot reads the same with the dryer off, where the course is reset
        assert.equal(feed([UNLOCKED]).download_course, 'Rack Dry')
    })

    test('every cycle the app can download is named from the app', () => {
        for (const [name, frame] of Object.entries(DOWNLOADED)) {
            const p = feed([frame])
            assert.equal(p.course, 'Downloaded cycle', name)
            assert.equal(p.download_course, name)
        }
        assert.equal(feed([DOWNLOADED['Minimize Wrinkles']]).wrinkle_care, 'ON')
    })

    test('the dryness level uses the panel names, which the cloud names are shifted against', () => {
        assert.equal(feed([DRYNESS_2]).dry_level, 'Light') // cloud: DRYLEVEL_LESSDRY
        assert.equal(feed([DRYNESS_4]).dry_level, 'Very Dry') // cloud: DRYLEVEL_CUPBOARD
        assert.equal(feed([DRYNESS_5]).dry_level, 'Extra Dry') // cloud: DRYLEVEL_VERYDRY

        // cycles that do not sense dryness report 0, NO_DRYLEVEL
        assert.equal(feed([WOOL]).dry_level, 'Not selected')
    })

    test('the drying mode and dryness level read from their own bytes', () => {
        const p = feed([DRYING_MODE_ECO])
        assert.equal(p.eco_hybrid, 'Eco')
        assert.equal(p.dry_level, 'Extra Dry')

        assert.equal(feed([DRYNESS_5]).eco_hybrid, 'Balanced') // cloud: ECOHYBRID_NORMAL
        assert.equal(feed([SMALL_LOAD]).eco_hybrid, 'Turbo')
    })

    test('detect load follows the selected cycle', () => {
        assert.equal(feed([SMALL_LOAD]).detect_load, 'ON') // cloud: DETECT_LOAD_ON
        assert.equal(feed([WOOL]).detect_load, 'OFF')
    })

    test('anti-crease and the damp dry signal share rec[24] without collision', () => {
        const crease = feed([ANTI_CREASE_ON])
        assert.equal(crease.wrinkle_care, 'ON')
        assert.equal(crease.damp_dry_signal, 'OFF')

        const damp = feed([DAMP_DRY_SIGNAL_ON])
        assert.equal(damp.damp_dry_signal, 'ON')
        assert.equal(damp.wrinkle_care, 'OFF')
        assert.equal(damp.buzzer, '4') // the appliance turns the buzzer on with the signal
    })

    test('the minute counters are big-endian, and the timer sets the initial time', () => {
        const p = feed([TIMED_DRY_70])
        assert.equal(p.remaining_time, 70)
        assert.equal(p.initial_time, 70)

        assert.equal(feed([DOWN_BLANKET]).remaining_time, 175)
    })

    test('a run locks the door and sets remote start, and a pause clears remote start', () => {
        const started = feed([START])
        assert.equal(started.status, 'Cooling')
        assert.equal(started.power, 'ON')
        assert.equal(started.remote_start, 'ON')
        assert.equal(started.door_lock, 'ON') // not locked yet: HA's lock class reads ON as unlocked

        assert.equal(feed([START, LOCKED]).door_lock, 'OFF') // locked

        const paused = feed([START, LOCKED, PAUSED])
        assert.equal(paused.status, 'Paused')
        assert.equal(paused.remote_start, 'OFF')
        assert.equal(paused.drum_light, 'ON')
        assert.equal(paused.door_lock, 'OFF') // still locked: it releases a few seconds after the pause
        assert.equal(paused.energy, 5)

        const resumed = feed([PAUSED, RESUMED])
        assert.equal(resumed.status, 'Cooling')
        assert.equal(resumed.remote_start, 'ON')
        assert.equal(resumed.drum_light, 'OFF')
    })

    test('energy and the countdown track the run', () => {
        const p = feed([RUNNING])
        assert.equal(p.energy, 16) // cloud: courseSpendPower 16
        assert.equal(p.remaining_time, 23)
        assert.equal(p.initial_time, 30)
        assert.equal(p.door_lock, 'OFF') // locked
    })

    test('powering off clears the cycle but not the energy it used, and the lock releases after', () => {
        const off = feed([RUNNING, POWERED_OFF])
        assert.equal(off.power, 'OFF')
        assert.equal(off.status, 'Off')
        assert.equal(off.course, 'None')
        assert.equal(off.remaining_time, 0)
        assert.equal(off.initial_time, 0)
        assert.equal(off.energy, 61) // what the run had used
        assert.equal(off.door_lock, 'OFF') // still locked for a moment

        assert.equal(feed([RUNNING, POWERED_OFF, UNLOCKED]).door_lock, 'ON')
    })

    test('start() sends the status query the LG cloud sends on reconnect', () => {
        const { thinq, dev } = makeDevice()
        dev.start()

        // AA | length | 0xF0ED status query | checksum | BB, exactly as captured from the cloud
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa12f0ed1121010000001804111200005ebb'],
        )
    })

    test('the single-record reply to the status query fills in every entity', () => {
        const p = feed([STATUS_REPLY])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'None')
        assert.equal(p.download_course, 'Silent')
        assert.equal(p.door_lock, 'ON') // unlocked
        assert.equal(p.remote_start, 'OFF')
    })

    // Every expected frame below is one the LG cloud sent this dryer when the ThinQ app was used, copied
    // from the capture byte for byte, and each was answered with the dryer's 3000E500 ack and the state
    // change the cloud then reported.
    function sent(...steps: [string, string][]) {
        const { thinq, dev } = makeDevice()
        for (const [prop, value] of steps) dev.setProperty(prop, value)
        return thinq.outbox.map((b) => b.toString('hex'))
    }

    test('power, pause and resume send the app commands', () => {
        assert.deepEqual(sent(['power', 'ON']), ['aa0df0e5000201ff010201c7bb']) // cloud: state INITIAL
        assert.deepEqual(sent(['power', 'OFF']), ['aa0df0e5000201ff010200c4bb']) // cloud: state POWEROFF
        assert.deepEqual(sent(['pause', '']), ['aa0df0e5000201ff010302c1bb']) // cloud: state PAUSE
        assert.deepEqual(sent(['resume', '']), ['aa0df0e5000201ff010303c0bb']) // cloud: state DRYING
    })

    test('starting a course sends the course code and a start, as the app does', () => {
        // cloud: course TOWELS, AI_COURSE, TIMEDRY and CONDENSERCARE respectively
        assert.deepEqual(sent(['set_course', 'Towels'], ['start_course', '']), ['aa0ff0e5000201ff020a020301f7bb'])
        assert.deepEqual(sent(['set_course', 'AI Dry'], ['start_course', '']), ['aa0ff0e5000201ff020a2c030199bb'])
        assert.deepEqual(sent(['set_course', 'Timed Dry'], ['start_course', '']), ['aa0ff0e5000201ff020a150301e0bb'])
        assert.deepEqual(sent(['set_course', 'Condenser Care'], ['start_course', '']), [
            'aa0ff0e5000201ff020a120301e7bb',
        ])
    })

    test('the course selector follows the dryer until a course is picked', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', WOOL)
        assert.equal(ha.devices[DEVICE_ID].properties.set_course, 'Wool')

        dev.setProperty('set_course', 'Towels')
        thinq.emit('data', WOOL) // a status frame does not overwrite the pick
        assert.equal(ha.devices[DEVICE_ID].properties.set_course, 'Towels')

        // with nothing picked, Start course restarts what the dryer has selected
        const { thinq: t2, dev: d2 } = makeDevice()
        t2.emit('data', WOOL)
        d2.setProperty('start_course', '')
        assert.deepEqual(
            t2.outbox.map((b) => b.toString('hex')),
            [AABB_START_WOOL],
        )
    })

    test('a start with settings changed matches the app, unchanged ones at the course default', () => {
        // Each expected frame is the app's own, captured as that one setting was changed in it, the dryer
        // and the cloud confirming the change (dryLevel VERYDRY, ecoHybrid TURBO, a 100-minute run,
        // reservation 180 minutes, dampDryBeep ON).
        const start = (...picks: [string, string][]) => sent(...picks, ['start_course', ''])
        assert.deepEqual(start(['set_course', 'Eco'], ['set_dry_level', 'Extra Dry']), [
            'aa1ff0e5000201ff090a071f021e0534003f000f007000007f0000030126bb',
        ])
        assert.deepEqual(start(['set_course', 'Eco'], ['set_eco_hybrid', 'Turbo']), [
            'aa1ff0e5000201ff090a071f031e0334003f000f007000007f0000030127bb',
        ])
        assert.deepEqual(start(['set_course', 'Timed Dry'], ['set_timer', '100']), [
            'aa1ff0e5000201ff090a151f021e0034003f000f007000647f00000301b5bb',
        ])
        assert.deepEqual(start(['set_course', 'Eco'], ['set_delay_end', '3']), [
            'aa1ff0e5000201ff090a071f021e0334003f000f007000007f00b4030170bb',
        ])
        assert.deepEqual(start(['set_course', 'Eco'], ['set_damp_dry_signal', 'ON']), [
            'aa1ff0e5000201ff090a071f021e0334013f000f007000007f0000030127bb',
        ])
    })

    test('a resume with settings changed matches the app, unchanged ones as the dryer reports', () => {
        const resume = (status: Buffer, value: string) => {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', status)
            dev.setProperty('set_wrinkle_care', value)
            dev.setProperty('resume', '')
            return thinq.outbox.map((b) => b.toString('hex'))
        }
        // cloud: wrinkleCare ON, then OFF, both with the cycle resuming
        assert.deepEqual(resume(PAUSED_ECO_TURBO, 'ON'), ['aa1df0e5000201ff081f031e0334003f000f017000007f0000030334bb'])
        assert.deepEqual(resume(PAUSED_ECO_TURBO_CREASE, 'OFF'), [
            'aa1df0e5000201ff081f031e0334003f000f007000007f0000030335bb',
        ])
    })

    test('settings are held until sent, and out-of-range values are refused', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', PAUSED_ECO_TURBO)
        const props = () => ha.devices[DEVICE_ID].properties
        assert.equal(props().set_eco_hybrid, 'Turbo') // following the dryer

        dev.setProperty('set_eco_hybrid', 'Eco')
        dev.setProperty('set_timer', '20') // below the 30-minute minimum
        dev.setProperty('set_delay_end', '2') // delays start at 3 hours
        assert.equal(props().set_eco_hybrid, 'Eco')
        assert.equal(props().set_timer, 'None')
        assert.equal(props().set_delay_end, 0)
        assert.deepEqual(thinq.outbox, []) // nothing sent on a pick

        dev.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(props().set_eco_hybrid, 'Turbo') // back to following the dryer
    })

    test('the delay is reported in minutes', () => {
        // rec[7:9] = 180 while the cloud reported reserveTimeMinute 180 and state RESERVED
        const reserved = buf(
            'aaff300a0066000436000100ec005400000200031500000000640064030700020000001500007e2000418000000000000000000000000000000003020003070000b4006400640a0300000000000700007e00004d800000000000000000000000000000c827bb',
        )
        const p = feed([reserved])
        assert.equal(p.delay, 180)
        assert.equal(p.status, 'Delayed')
    })

    test('nothing is started without a known course', () => {
        assert.deepEqual(sent(['start_course', '']), []) // no status seen yet
        assert.deepEqual(sent(['set_course', 'Nonsense'], ['start_course', '']), [])
        assert.deepEqual(sent(['download_course', '']), []) // no stored cycle seen yet
    })

    test('downloading a cycle sends what the app sent for each of the eight', () => {
        // Each captured when the app downloaded that cycle, twice over in separate sessions, with the
        // cloud's downloadCourse naming it in the same second. 0x0c is the course it is built on.
        const downloads: Record<string, string> = {
            'Gym Clothes': 'aa21f0e5000201ff0a0b660aff0c311f011e0034003f000f007000007f000047bb',
            'Rainy Days': 'aa21f0e5000201ff0a0b690aff0c321f031e0034003f000f007000007f00004dbb',
            'Easy Ironing': 'aa21f0e5000201ff0a0b6e0aff0c331f031e0034003f000f007000007f00004bbb',
            'Minimize Wrinkles': 'aa21f0e5000201ff0a0b720aff0c071f021e0334003f000f017000007f0000acbb',
            Silent: 'aa21f0e5000201ff0a0b7e0aff0c2d1f021e0034003f000f007000007f000072bb',
            'Rack Dry': 'aa21f0e5000201ff0a0b8c0aff0c0c1f011e0034003f000f0070001e7f000064bb',
            'Shrinkage Relief': 'aa21f0e5000201ff0a0b8e0aff0c2e1f021e0234003f000f007000007f00006fbb',
            'Super Dry': 'aa21f0e5000201ff0a0b940aff0c111f021e0034003f000f007000007f000074bb',
        }
        for (const [name, frame] of Object.entries(downloads)) {
            // followed by the status query, so the new stored cycle is reported
            assert.deepEqual(
                sent(['set_download_course', name], ['download_course', '']),
                [frame, 'aa12f0ed1121010000001804111200005ebb'],
                name,
            )
        }
    })

    test('only the stored downloaded cycle can be started', () => {
        // The dryer refused a start naming Gym Clothes while Minimize Wrinkles was stored, every pair
        // coming back 17; so with a different cycle picked but not yet downloaded, nothing is sent.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_REPLY) // Silent in the slot
        dev.setProperty('set_download_course', 'Gym Clothes')
        dev.setProperty('set_course', 'Downloaded cycle')
        dev.setProperty('start_course', '')
        assert.deepEqual(thinq.outbox, [])
    })

    test('the downloaded cycle starts with the app command, from the stored cycle', () => {
        // Silent stored (rec[23] = 126) and the Download position picked: cloud course DOWNLOAD,
        // baseDownloadCourseData ULTRADELICATES, state DRYING.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_REPLY) // Silent in the slot
        dev.setProperty('set_course', 'Downloaded cycle')
        dev.setProperty('start_course', '')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa23f0e5000201ff0b0aff0b7e0c2d1f021e0034003f000f007000007f000003017bbb'],
        )
    })

    test('the error code is reported, and clears with the error', () => {
        const err = feed([DOOR_ERROR])
        assert.equal(err.status, 'Error')
        assert.equal(err.error, 'ON')
        assert.equal(err.error_message, 'Door open (dE1)')

        const cleared = feed([DOOR_ERROR, DOOR_ERROR_CLEARED])
        assert.equal(cleared.status, 'Paused')
        assert.equal(cleared.error, 'OFF')
        assert.equal(cleared.error_message, 'OK')

        const filter = feed([FILTER_ERROR])
        assert.equal(filter.error, 'ON')
        assert.equal(filter.error_message, 'Filter missing')
    })

    test('frames that are not status records publish nothing', () => {
        const junk = [
            // real frames from the same capture: an 0x01 envelope, the 0x3e energy totals, a 0x72 ping
            'aaff300a003000065300010103001e0e0a01050e00390004000402000000af00000000000002000000340000000b10bb',
            'aa0b303e002100210133bb',
            'aa09307200c9004bbb',
            'aaff300a0066000a42000100ec0054000000', // truncated 0xEC
        ]
        for (const frame of junk) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(frame))
            assert.deepEqual(ha.devices[DEVICE_ID]?.properties ?? {}, {}, `frame ${frame} should publish nothing`)
        }
    })
})
