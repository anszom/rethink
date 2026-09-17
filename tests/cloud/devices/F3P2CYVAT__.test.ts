import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3P2CYVAT__'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3P2CYVAT__'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F3P2CYVAT__', swVersion: '0.0.0' }

// All fixtures are REAL 0xEC/heartbeat frames captured live from the appliance, cross-checked against
// this model's own LG ThinQ product-config JSON. The AA + length and checksum + BB envelope bytes are
// not validated on input, so these parse identically to the originals.

// The very first frame emitted at power-on — a short heartbeat/ping. Despite its size this isn't a pure
// no-op: buf[2] carries the live TCLCount (tub clean count), confirmed against many repeated live
// cloud readouts at two different counts and by injection of modified package.
const BOOT_HEARTBEAT = buf('aa0720d800fcbb')
const HEARTBEAT_TCL_COUNT_20 = buf('aa0720d814e8bb')

// A preset change captured live: dial moved from Normal to Heavy Duty. Confirms soil/spin/course/time
// all update together as a single settings-change event.
const NORMAL_TO_HEAVY_DUTY = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000000001007800000002120400000000000000400000010000002b0005100e102300000000000000008d008d00000000010078000000021204000000000000004000000000000abb',
)

// Capturing the full Extra Rinse button cycle one press at a time —
// off -> Plus -> Plus 2 -> Plus 3 -> off — with the LG cloud's own decoded state recorded at every step.
const EXTRA_RINSE_STEP_TO_PLUS = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000000001006800000002140400000000000000000000010000002b0003100f0f2e00000000000000004c004c0000000001006800000003140400000000000000000040010000d9bb',
)
const EXTRA_RINSE_STEP_TO_PLUS2 = buf(
    'aa6020ec002b0003100f0f2e00000000000000004c004c0000000001006800000003140400000000000000000040010000002b000310100f2e00000000000000005700570000000001006800000004140400000000000000000040010000a9bb',
)
const EXTRA_RINSE_STEP_TO_PLUS3 = buf(
    'aa6020ec002b000310100f2e00000000000000005700570000000001006800000004140400000000000000000040010000002b000310110f2e0000000000000000620062000000000100680000000514040000000000000000004001000079bb',
)
const EXTRA_RINSE_STEP_TO_OFF = buf(
    'aa6020ec002b000310110f2e00000000000000006200620000000001006800000005140400000000000000000040010000002b0003100e0f2e00000000000000004100410000000001006800000002140400000000000000000000010000e9bb',
)

// Pre Wash enabled alone, isolating rec[35]'s 0x40 bit from every other field except total time.
const PRE_WASH_ON = buf(
    'aa6020ec002b0003100f0f2e00000000000000004c004c0000000001007800000003130400000000000000400040010000002b0003100f0f2e00000000000000005b005b0000000001007800000003130400000000400000400040010000b5bb',
)

// Delay Wash armed for 1h, then bumped to 2h, then eventually to 14h — the last one overflows a single byte and
// proves the field is a 16-bit big-endian minute count spanning rec[12:13], not [hour][minute].
const DELAY_1H = buf(
    'aa6020ec002b0003100f0f2e00000000000000005b005b0000000001007800000003130400000000400000400040010000002b0003100f0f2e0000000000003c005b005b00000000010078000000031304000000004000004000c0010000afbb',
)
const DELAY_2H = buf(
    'aa6020ec002b0003100f0f2e0000000000003c005b005b00000000010078000000031304000000004000004000c0010000002b0003100f0f2e00000000000078005b005b00000000010078000000031304000000004000004000c0010000a7bb',
)
const DELAY_14H = buf(
    'aa6020ec002b0003100f0f2e0000000000030c005b005b00000000010078000000031304000000004000004000c0010000002b0003100f0f2e00000000000348005b005b00000000010078000000031304000000004000004000c0010000cdbb',
)

// Steam pressed on, then off again, captured live with a matching LG cloud readout at each step: soil
// and temp reset to "not selected" alongside it (cloud: NO_SOILWASH/NO_TEMP), and nothing else moves.
const STEAM_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000000001006800000002140400000000000000000000010000002b0000000e0f2e000000000000000096009600000000010068000000021404000000000010000000000100008ebb',
)
const STEAM_OFF = buf(
    'aa6020ec002b0000000e0f2e00000000000000009600960000000001006800000002140400000000001000000000010000002b0003100e0f2e000000000000000041004100000000010068000000021404000000000000000000000100008ebb',
)

// Cold Wash (long-press on the Steam button). Confirms it rewrites the Temp field
// directly to Cold, and sets the rec[35] 0x04 bit — matching the cloud's `coldWash` field.
const COLD_WASH_HOLD = buf(
    'aa6020ec002b0003100f0f2e00000000000348004c004c00000000010078000000031304000000000000000000c0010000002b00030e0f0f2e000000000003480060006000000000010078000000031304000000000400000000c001000097bb',
)

// Spin Only (long-press on the Spin button). New course byte, soil/temp reset to "not selected", AI Wash off, rinse count
// drops to 0 — all consistent with a mechanical-only cycle.
const SPIN_ONLY_HOLD = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000000001007800000002130400000000000000400000010000002b0000000e0f4e00000000000000000b000b000000000100780700000013040000000000000040000000000022bb',
)

// A single-record 0xEB frame, captured right after a cycle finished and the appliance powered off. This
// specific capture also recorded the LG cloud's own
// decoded state for the same instant — every field below is asserted against that real cloud readout, not
// inferred: state Off (0), preState End (0x10), soilWash/temp/spin all "not selected", rinse Normal (14,
// residual/default), remainTimeMinute 1, initialTimeMinute 0, reserveTimeMinute 0, TCLCount 20, and
// preWash/extraRinse/AIDDLed all off.
const CYCLE_END_POWEROFF_GROUND_TRUTH = buf(
    'aa3320eb002b0000000e000000000000000000000100000000000000106800000000140400000000000000000000000000e7bb',
)

// Attempting to Start with the door open, captured live with the LG cloud's own decoded state at each
// step: state Confirm Start (0x24) + error Door Open (20) while it happens, then the error clearing once
// the machine is powered off.
const DOOR_OPEN_START_ATTEMPT = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000000001006800000002140400000000000000000000010000002b0003100e0f2e0000000000000000410041000014002401680000000214040000000000000000000001000039bb',
)
const DOOR_OPEN_ERROR_PERSISTS = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000140024016800000002140400000000000000000000010000002b0003100e0f2e00000000000000004100410000140001246800000002140400000000000000000000010000f1bb',
)
const POWEROFF_AFTER_DOOR_OPEN = buf(
    'aa6020ec002b0003100e0f2e00000000000000004100410000140001246800000002140400000000000000000000010000002b0000000e000000000000000000000100000000000000016800000000140400000000000000000000000000cdbb',
)

// Selecting the Downloaded course, then a follow-up cloud message revealing its base course type. The
// downloaded-course-ID field (rec[21]) turns out to reuse the same byte values as the regular COURSE
// enum — confirmed by the cloud's `baseDownloadCourseData: NORMAL` landing on 0x2e, Normal's own byte.
const DOWNLOAD_COURSE_FIRST = buf(
    'aa6020ec002b0000000e0e5500000000000000005900590000000001006800000002140400000000001000000000000000002b0003120f0fff00000000000000005b005b00000000010068000000031404000000004000000000400100005abb',
)
const DOWNLOAD_COURSE_BASE_REVEALED = buf(
    'aa6020ec002b0003120f0fff00000000000000005b005b0000000001006800000003140400000000400000000040010000002b0003120f0fff00000000000000005b005b0000002e0100680000000314040000000040000000004001000021bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('F3P2CYVAT__', () => {
    test('boot heartbeat frame publishes only tcl_count, from buf[2]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', BOOT_HEARTBEAT)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.tcl_count, 0) // cloud: TCLCount 0, moments after power-on
        assert.equal(Object.keys(p).length, 1)

        thinq.emit('data', HEARTBEAT_TCL_COUNT_20)
        assert.equal(p.tcl_count, 20) // cloud: TCLCount 20
    })

    test('Normal -> Heavy Duty preset change updates soil/spin/course/time together', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NORMAL_TO_HEAVY_DUTY)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.soil, 'Heavy')
        assert.equal(p.spin, 'Extra High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.rinse, 'Normal')
        assert.equal(p.remaining_time, 141)
        assert.equal(p.initial_time, 141)
        assert.equal(p.ai_wash, 'OFF')
    })

    test('Extra Rinse full step sequence matches the LG cloud at every press, including Plus 2', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', EXTRA_RINSE_STEP_TO_PLUS)
        assert.equal(p.rinse, 'Plus') // cloud: rinse RINSE_PLUS
        assert.equal(p.rinse_count, 'Rinse x3') // cloud: rinseCount RINSE_3
        assert.equal(p.remaining_time, 76) // cloud: remainTimeMinute 76
        assert.equal(p.initial_time, 76) // cloud: initialTimeMinute 76
        assert.equal(p.extra_rinse, 'ON') // cloud: extraRinse EXTRARINSE_ON
        assert.equal(p.tcl_count, 20) // unaffected by menu browsing

        thinq.emit('data', EXTRA_RINSE_STEP_TO_PLUS2)
        assert.equal(p.rinse, 'Plus 2') // cloud: rinse RINSE_PLUS2
        assert.equal(p.rinse_count, 'Rinse x4') // cloud: rinseCount RINSE_4
        assert.equal(p.remaining_time, 87) // cloud: remainTimeMinute 87
        assert.equal(p.tcl_count, 20)

        thinq.emit('data', EXTRA_RINSE_STEP_TO_PLUS3)
        assert.equal(p.rinse, 'Plus 3') // cloud: rinse RINSE_PLUS3
        assert.equal(p.rinse_count, 'Rinse x5') // cloud: rinseCount RINSE_5
        assert.equal(p.remaining_time, 98) // cloud: remainTimeMinute 98
        assert.equal(p.tcl_count, 20)

        thinq.emit('data', EXTRA_RINSE_STEP_TO_OFF)
        assert.equal(p.rinse, 'Normal') // cloud: rinse RINSE_NORMAL
        assert.equal(p.rinse_count, 'Rinse x2') // cloud: rinseCount RINSE_2
        assert.equal(p.remaining_time, 65) // cloud: remainTimeMinute 65
        assert.equal(p.extra_rinse, 'OFF') // cloud: extraRinse EXTRARINSE_OFF
        assert.equal(p.tcl_count, 20)
    })

    test('Pre Wash isolated: only total time and the pre_wash flag change', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', PRE_WASH_ON)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.pre_wash, 'ON')
        assert.equal(p.remaining_time, 91)
        assert.equal(p.rinse, 'Plus') // unaffected by Pre Wash
    })

    test('Delay Wash: 1h -> 2h -> 14h proves rec[12:13] is a 16-bit big-endian minute count', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', DELAY_1H)
        assert.equal(p.reserve_time, 60)
        assert.equal(p.delay_active, 'ON')
        assert.equal(p.extra_rinse, 'ON') // stayed on from the earlier steps in this session

        thinq.emit('data', DELAY_2H)
        assert.equal(p.reserve_time, 120)

        thinq.emit('data', DELAY_14H)
        assert.equal(p.reserve_time, 840) // overflows rec[13] alone; rolls into rec[12] as the high byte
    })

    test('Steam isolated: on/off, resets soil and temp to "not selected" alongside it', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', STEAM_ON)
        assert.equal(p.steam, 'ON') // cloud: steam STEAM_ON
        assert.equal(p.soil, 'Not Selected') // cloud: soilWash NO_SOILWASH
        assert.equal(p.temp, 'Not Selected') // cloud: temp NO_TEMP
        assert.equal(p.remaining_time, 150) // cloud: remainTimeMinute 150

        thinq.emit('data', STEAM_OFF)
        assert.equal(p.steam, 'OFF') // cloud: steam STEAM_OFF
        assert.equal(p.soil, 'Normal') // cloud: soilWash SOILWASH_NORMAL
        assert.equal(p.temp, 'Warm') // cloud: temp FL27_TEMP_WARM
    })

    test('Cold Wash (long-press Steam): rewrites Temp directly, sets the coldWash flag', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COLD_WASH_HOLD)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.temp, 'Cold')
        assert.equal(p.cold_wash, 'ON')
    })

    test('Spin Only (hold): new course code, soil/temp reset, AI Wash off, no rinsing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SPIN_ONLY_HOLD)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Spin Only')
        assert.equal(p.soil, 'Not Selected')
        assert.equal(p.temp, 'Not Selected')
        assert.equal(p.remaining_time, 11)
        assert.equal(p.ai_wash, 'OFF')
        assert.equal(p.error, 'No Error')
        assert.equal('door_lock' in p, false) // never confirmed, must not be declared/published
    })

    test('Attempting Start with the door open reports Confirm Start + Door Open error, cross-checked against the cloud', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', DOOR_OPEN_START_ATTEMPT)
        assert.equal(p.status, 'Confirm Start') // cloud: state CONFIRM_START_FOR_CONTROL
        assert.equal(p.error, 'Door Open') // cloud: error ERROR_DE1

        thinq.emit('data', DOOR_OPEN_ERROR_PERSISTS)
        assert.equal(p.status, 'Initial') // cloud: state INITIAL, preState CONFIRM_START_FOR_CONTROL
        assert.equal(p.error, 'Door Open') // unchanged — door is still open

        thinq.emit('data', POWEROFF_AFTER_DOOR_OPEN)
        assert.equal(p.status, 'Off') // cloud: state POWEROFF
        assert.equal(p.error, 'No Error') // cloud: error ERROR_NO — clears at power-off
    })

    test('Downloaded course reveals its base course type via a follow-up cloud message', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', DOWNLOAD_COURSE_FIRST)
        assert.equal(p.course, 'Downloaded') // rec[21] is still 0 (unmapped) at this point

        thinq.emit('data', DOWNLOAD_COURSE_BASE_REVEALED)
        assert.equal(p.course, 'Downloaded (Normal)') // cloud: baseDownloadCourseData NORMAL
    })

    test("0xEB single-record frame matches the LG cloud's own decoded state byte-for-byte", () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CYCLE_END_POWEROFF_GROUND_TRUTH)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF') // cloud: state POWEROFF
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'None') // cloud: course NOT_SELECTED
        assert.equal(p.soil, 'Not Selected') // cloud: soilWash NO_SOILWASH
        assert.equal(p.temp, 'Not Selected') // cloud: temp NO_TEMP
        assert.equal(p.rinse, 'Normal') // cloud: rinse RINSE_NORMAL
        assert.equal(p.remaining_time, 1) // cloud: remainTimeMinute 1
        assert.equal(p.initial_time, 0) // cloud: initialTimeMinute 0
        assert.equal(p.reserve_time, 0) // cloud: reserveTimeMinute 0
        assert.equal(p.tcl_count, 20) // cloud: TCLCount 20
        assert.equal(p.pre_wash, 'OFF') // cloud: preWash PREWASH_OFF
        assert.equal(p.extra_rinse, 'OFF') // cloud: extraRinse EXTRARINSE_OFF
        assert.equal(p.ai_wash, 'OFF') // cloud: AIDDLed AIDDLed_OFF
    })
})
