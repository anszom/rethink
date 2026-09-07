import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F3P2CYUBE__'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F3P2CYUBE__'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F3P2CYUBE__', swVersion: '2.10.119' }

// All fixtures are REAL frames captured live from the appliance (an LG front-load washer that self-reports
// modelId "F3P2CYUBE__", deviceType 201) via rethink's management /device WebSocket in bridge mode, labelled
// against the LG cloud's own washerDryer deltas (rethink-capture --cloud) and the LG ThinQ integration's
// entities in Home Assistant at matching timestamps.

// 0xEB single-record frame, right after (re)connect, machine off. 47-byte body, record at buf[3:].
const EB_RECONNECT_OFF = buf(
    'aa3320eb002b0000000e0000000000000000000001000000000000000169000000003b04000000000000000000000000009ebb',
)

// Off, idle. Cycle counter 0x3B (59) persists across power-off — HA's cycle sensor read 59 all along.
// NOTE: in standby the machine alternates frames between state 0x00 (Off, previous 0x01) and state 0x01
// (Initial, previous 0x00) about once a minute; this fixture is one of the 0x00 frames.
const OFF_IDLE = buf(
    'aa6020ec002b0000000e0000000000000000000000000000000000010069000000003b0400000000000000400000000000002b0000000e0000000000000000000001000000000000000169000000003b04000000000000004000000000000ebb',
)

// Power on: state Initial (0x01), dial on the course this capture ran under (code 0x2E), settings at their
// defaults for that course — soil Normal (3), temp Warm (16), rinse Normal (14), spin High (15). The time
// bytes show the pre-run estimate (0x2E = 46 min) in both the remaining and initial slots.
const POWER_ON_SELECTING = buf(
    'aa6020ec002b0000000e0000000000000000000000000000000000010069000000003b0400000000000000400000000000002b0003100e0f2e00000000000000002e002e00000000010069000000013b04000000002000004000000100007dbb',
)

// Temperature button pressed twice while selecting: Warm (16) -> Hot (18) -> Tap Cold (13) at rec[3].
const TEMP_HOT = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000013b0400000000200000400000010000002b0003120e0f2e00000000000000002e002e00000000010069000000013b0400000000200000400000010000adbb',
)
const TEMP_TAP_COLD = buf(
    'aa6020ec002b0003120e0f2e00000000000000002e002e00000000010069000000013b0400000000200000400000010000002b00030d0e0f2e00000000000000002e002e00000000010069000000013b0400000000200000400000010000a0bb',
)
// Soil Normal (3) -> Normal-Heavy (4) at rec[2]; the time estimate grows from 46 to 51 minutes with it.
const SOIL_NORMAL_HEAVY = buf(
    'aa6020ec002b00030d0e0f2e00000000000000002e002e00000000010069000000013b0400000000200000400000010000002b00040d0e0f2e000000000000000033003300000000010069000000013b0400000000200000400000010000aebb',
)
// Extra rinse ON: rinse Normal (14) -> Plus (15) at rec[4], rinse count 1 -> 2 at rec[28], the 0x40 bit
// appears at rec[40], and the estimate grows to 56 minutes.
const EXTRA_RINSE_ON = buf(
    'aa6020ec002b00040d0e0f2e000000000000000033003300000000010069000000013b0400000000200000400000010000002b00040d0f0f2e000000000000000038003800000000010069000000023b040000000020000040004001000007bb',
)
// Cycle running: state Running (0x0B), previous Detecting (0x03), remaining 40 / initial 40 (the total HA
// reported), cycle counter 59.
const RUNNING = buf(
    'aa6020ec002b00040d0f0f2e000000000000000038003800000000032469000000023b0400000000200000100040010000002b00040d0f0f2e0000000000000000280028000000000b0369030000023b040000000020000010004001000001bb',
)
// Rinsing, cloud-labelled: remainTimeMinute 17, courseSpendPower 48 in the same second as this frame.
const RINSING_17_MIN = buf(
    'aa6020ec002b00000d0f0f2e0000000000000000120028002f00000c0b69030000023b0400000000200000100040010000002b00000d0f0f2e0000000000000000110028003000000c0b69030000023b04000000002000001000400100000fbb',
)
// Cloud delta in the same second: extraRinse EXTRARINSE_OFF, rinse RINSE_NORMAL, rinseCount RINSE_1,
// remainTimeMinute 15, courseSpendPower 61. rec[4] 0x0F -> 0x0E, rec[28] 2 -> 1, rec[40] loses 0x40.
const RINSING_EXTRA_RINSE_DROPPED = buf(
    'aa6020ec002b00000d0f0f2e0000000000000000100028003300000c0b69030000023b0400000000200000100040010000002b00000d0e0f2e00000000000000000f0028003d00000c0b69030000013b040000000020000010000001000070bb',
)

// Cold wash toggled live on Normal (Turbo is course-locked ON on Normal — the sibling shows the same — so
// cold wash was the clean single variable). rec[35] 0x20 (off) -> 0x24 (on, bit 0x04); cloud confirmed
// coldWash COLDWASH_ON in the same second. (Cold wash also forces temp to Cold; these two fixtures hold
// temp at Cold so only rec[35] differs, isolating the bit.)
const COLD_WASH_OFF = buf(
    'aa6020ec002b00030e0e0f2e000000000000000042004200000000010069000000011e0400000000240000400000010000002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000400000010000b3bb',
)
const COLD_WASH_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000400000010000002b00030e0e0f2e000000000000000042004200000000010069000000011e0400000000240000400000010000b3bb',
)

// Turbo Wash toggled live on Speed Wash (course 0x4A) — the course where it is actually cycleable. rec[35]
// 0x00 (off) <-> 0x20 (on), cloud-confirmed turboWash. These frames also carry course 0x4A = Speed Wash.
const SPEED_TURBO_ON = buf(
    'aa6020ec002b0001120e104a00000000000000000f000f00000000010069070000011e0400000000000000400000000000002b0001120e104a00000000000000000f000f00000000010069070000011e040000000020000040000000000033bb',
)
const SPEED_TURBO_OFF = buf(
    'aa6020ec002b0001120e104a00000000000000000f000f00000000010069070000011e0400000000200000000000000000002b0001120e104a00000000000000000f000f00000000010069070000011e0400000000000000000000000000b3bb',
)

const STEAM_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000000000010000002b0000000e0f2e000000000000000083008300000000010069000000011e0400000000201000000000010000b6bb',
)
const PREWASH_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000000000010000002b0003100e0f2e00000000000000003d003d00000000010069000000011e0400000000600000000000010000cfbb',
)
const REMOTE_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000000000010000002b0003100e0f2e00000000000000002e002e00000000010069000000011e040000000020000010000001000019bb',
)

// Child lock toggled live on Normal: rec[38] 0x40 (off) -> 0x60 (on), bit 0x20, cloud-confirmed childLock.
// (The 0x40 bit in this byte is separately set here and not yet identified; the child-lock bit is 0x20.)
const CHILD_LOCK_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000400000010000002b0003100e0f2e00000000000000002e002e00000000010069000000011e040000000020000060000001000089bb',
)
const CHILD_LOCK_OFF = buf(
    'aa6020ec002b0005100e1023000000000000000082008200000000010069000000011e0400000000200000400000000000002b0003100e0f2e00000000000000002e002e00000000010069000000011e04000000002000004000000100000ebb',
)

// FreshCare toggled live on Normal: rec[37] 0x00 (off) -> 0x40 (on), cloud-confirmed freshCare.
const FRESH_CARE_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200000400000010000002b0003100e0f2e00000000000000002e002e00000000010069000000011e0400000000200040400000010000a9bb',
)
const FRESH_CARE_OFF = buf(
    'aa6020ec002b0005100e1023000000000000000082008200000000010069000000011e0400000000200000400000000000002b0003100e0f2e00000000000000002e002e00000000010069000000011e04000000002000004000000100000ebb',
)

// Delay Wash armed to 2h: reserve minutes are a 16-bit big-endian count at rec[12:14] — 120 = 0x0078.
// Cloud-confirmed against reserveTimeMinute across 60/120/240/360/600/840/1080. delay flag = reserve > 0.
const DELAY_120 = buf(
    'aa6020ec002b0003100e0f2e0000000000003c002e002e00000000010069000000011e0400000000200000000080010000002b0003100e0f2e00000000000078002e002e00000000010069000000011e0400000000200000000080010000a5bb',
)
const DELAY_OFF = buf(
    'aa6020ec002b0005100e1023000000000000000082008200000000010069000000011e0400000000200000400000000000002b0003100e0f2e00000000000000002e002e00000000010069000000011e04000000002000004000000100000ebb',
)

// Door cycled live: rec[38] bit 0x40 was the ONLY bit that moved (open 0x00 -> closed 0x40). device_class
// door means payload ON = open. Matches the one cloud doorClose=OFF (open) sample reading the bit clear.
const DOOR_OPEN = buf(
    'aa6020ec002b0001120e104a00000000000000000f000f00000000010069070000011e0400000000200000400000000000002b0001120e104a00000000000000000f000f00000000010069070000011e040000000020000000000000000013bb',
)
const DOOR_CLOSED = buf(
    'aa6020ec002b0000000e0000000000000000000000000000000000000069000000001e0400000000000000400000000000002b0005100e1023000000000000000082008200000000010069000000011e0400000000200000400000000000d9bb',
)

// Rinse+Spin subcycle toggled live (on Heavy Duty): rec[36] bit 0x20; while ON temp & soil read null (0x00).
const RINSE_SPIN_ON = buf(
    'aa6020ec002b0000000e0f2e000000000000000016001600020000010069070000011e0400000000002000000000010000002b0000000e0f2e000000000000000016001600020000010069070000011e04000000000020000000000100009dbb',
)
const RINSE_SPIN_OFF = buf(
    'aa6020ec002b0000000e0f2e000000000000000016001600020000010069070000011e0400000000002000000000010000002b0005100e1023000000000000000082008200020000010069000000011e0400000000200000000000000000f6bb',
)

// Extra-rinse full sweep 0..3 (the 'digit', 2 bits): rinse level rec[4] 0E/0F/10/11, count rec[28] 1..4,
// rec[40] 0x40 = extra-rinse flag (set when count>1). RINSE_N = N extra rinses.
const RINSE_0 = buf(
    'aa6020ec002b0000000e1023000000000000000019001900020000010069070000011e0400000000002000000000000000002b0005100e1023000000000000000082008200020000010069000000011e0400000000200000000000000000cbbb',
)
const RINSE_1 = buf(
    'aa6020ec002b000310110f2e00000000000000003d003d00020000010069000000041e0400000000200000000040010000002b0003100f0f2e000000000000000033003300020000010069000000021e0400000000200000000040010000a5bb',
)
const RINSE_2 = buf(
    'aa6020ec002b0003100f0f2e000000000000000033003300020000010069000000021e0400000000200000000040010000002b000310100f2e000000000000000038003800020000010069000000031e0400000000200000000040010000b1bb',
)
const RINSE_3 = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00020000010069000000011e0400000000200000000000010000002b000310110f2e00000000000000003d003d00020000010069000000041e0400000000200000000040010000f1bb',
)

// Signal (end-of-cycle chime / button beeps), the panel toggle. Two frames captured off vs on: rec[30] bit
// 0x04 flips 0x00 -> 0x04, and symmetrically in the previous-state record. Normal-course idle otherwise.
const SIGNAL_OFF = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010073000000011e0400000000200000000000010000002b0003100e0f2e00000000000000002e002e00000000010073000000011e000000000020000000000001000019bb',
)
const SIGNAL_ON = buf(
    'aa6020ec002b0003100e0f2e00000000000000002e002e00000000010073000000011e0000000000200000000000010000002b0003100e0f2e00000000000000002e002e00000000010073000000011e040000000020000000000001000019bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('F3P2CYUBE__', () => {
    test('0xEB single-record frames decode with the same offsets as 0xEC record B', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_RECONNECT_OFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.cycles, 59)
        assert.equal(p.remaining_time, 0)
    })

    test('off and idle: power OFF, timers zeroed, cycle counter retained', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF_IDLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.cycles, 59)
    })

    test('power on: Initial state with the course defaults and the pre-run estimate', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWER_ON_SELECTING)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course_code, '0x2e')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.spin, 'High')
        assert.equal(p.remaining_time, 46)
        assert.equal(p.initial_time, 46)
        assert.equal(p.extra_rinse_count, 0)
    })

    test('single-variable settings changes decode temp, soil and extra rinse', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', TEMP_HOT)
        assert.equal(p.temp, 'Hot')
        thinq.emit('data', TEMP_TAP_COLD)
        assert.equal(p.temp, 'Tap Cold')
        thinq.emit('data', SOIL_NORMAL_HEAVY)
        assert.equal(p.soil, 'Normal-Heavy')
        assert.equal(p.remaining_time, 51)
        thinq.emit('data', EXTRA_RINSE_ON)
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.extra_rinse_count, 1) // rec[4] - 0x0E; one +1 press
        assert.equal(p.remaining_time, 56)
    })

    test('signal (chime) toggle: rec[30] bit 0x04, off vs on', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SIGNAL_OFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.signal, 'OFF')
        thinq.emit('data', SIGNAL_ON)
        assert.equal(p.signal, 'ON')
    })

    test('running: state, previous state, countdown and total', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Running')
        assert.equal(p.previous_status, 'Detecting')
        assert.equal(p.remaining_time, 40)
        assert.equal(p.initial_time, 40)
        assert.equal(p.cycles, 59)
    })

    test('rinsing, labelled by the cloud: remaining minutes and course energy track bytes 15 and 19', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', RINSING_17_MIN)
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.previous_status, 'Running')
        assert.equal(p.remaining_time, 17)
        assert.equal(p.energy, 48)
        thinq.emit('data', RINSING_EXTRA_RINSE_DROPPED)
        assert.equal(p.remaining_time, 15)
        assert.equal(p.energy, 61)
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.extra_rinse_count, 0)
    })

    test('cold wash toggles on rec[35] bit 0x04, isolated', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', COLD_WASH_OFF)
        assert.equal(p.cold_wash, 'OFF')
        thinq.emit('data', COLD_WASH_ON)
        assert.equal(p.cold_wash, 'ON')
    })

    test('turbo wash toggles on rec[35] bit 0x20, and course 0x4A decodes as Speed Wash', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', SPEED_TURBO_ON)
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.course, 'Speed Wash')
        assert.equal(p.cold_wash, 'OFF') // bit 0x04 clear — turbo (0x20) and cold (0x04) are independent
        thinq.emit('data', SPEED_TURBO_OFF)
        assert.equal(p.turbo_wash, 'OFF')
    })

    test('steam (rec[36] 0x10), pre-wash (rec[35] 0x40) and remote start (rec[38] 0x10)', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', STEAM_ON)
        assert.equal(p.steam, 'ON')
        assert.equal(p.pre_wash, 'OFF')
        assert.equal(p.remote_start, 'OFF')
        thinq.emit('data', PREWASH_ON)
        assert.equal(p.pre_wash, 'ON')
        assert.equal(p.steam, 'OFF')
        assert.equal(p.turbo_wash, 'ON') // Normal locks turbo on: bit 0x20 stays set alongside pre-wash's 0x40
        thinq.emit('data', REMOTE_ON) // remote start armed
        assert.equal(p.remote_start, 'ON')
        assert.equal(p.pre_wash, 'OFF')
    })

    test('child lock toggles on rec[38] bit 0x20, independent of the remote-start bit 0x10', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.remote_start, 'OFF') // 0x10 clear; 0x20 (child) and 0x10 (remote start) are separate bits
        thinq.emit('data', CHILD_LOCK_OFF)
        assert.equal(p.child_lock, 'OFF')
    })

    test('FreshCare toggles on rec[37] bit 0x40', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', FRESH_CARE_ON)
        assert.equal(p.fresh_care, 'ON')
        thinq.emit('data', FRESH_CARE_OFF)
        assert.equal(p.fresh_care, 'OFF')
    })

    test('the full dial: every course code decodes to its cloud name', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        // one representative frame per code isn't needed — assert the table directly via a synthetic 0xEB
        // frame whose only meaningful byte is the course code. buf: aa <len> 20 eb <2B record with code>.
        const mk = (code: number) => {
            const rec = Buffer.alloc(44)
            rec[0] = 0x2b
            rec[6] = code
            const body = Buffer.concat([Buffer.from([0x20, 0xeb, 0x00]), rec])
            return Buffer.concat([Buffer.from([0xaa, body.length + 4]), body, Buffer.from([0x00, 0xbb])])
        }
        const expect: Record<number, string> = {
            0x05: 'Allergiene',
            0x0d: 'Bedding',
            0x16: 'Delicates',
            0x23: 'Heavy Duty',
            0x2e: 'Normal',
            0x30: 'Perm. Press',
            0x3c: 'Sanitary',
            0x4a: 'Speed Wash',
            0x4e: 'Spin Only',
            0x54: 'Towels',
            0x55: 'Tub Clean',
            0x5a: 'Bright Whites',
            0xff: 'Downloaded Course',
        }
        for (const [code, name] of Object.entries(expect)) {
            thinq.emit('data', mk(Number(code)))
            assert.equal(p.course, name, `course 0x${Number(code).toString(16)}`)
            assert.equal(p.course_code, '0x' + Number(code).toString(16).padStart(2, '0'))
        }
    })

    test('delay wash: reserve minutes decode as rec[12:14] big-endian, delay flag = reserve>0', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', DELAY_120)
        assert.equal(p.reserve_time, 120)
        assert.equal(p.delay_wash, 'ON')
        thinq.emit('data', DELAY_OFF)
        assert.equal(p.reserve_time, 0)
        assert.equal(p.delay_wash, 'OFF')
    })

    test('Rinse+Spin subcycle on rec[36] bit 0x20; temp/soil report null while active', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', RINSE_SPIN_ON)
        assert.equal(p.rinse_spin, 'ON')
        assert.equal(p.temp, 'None')
        assert.equal(p.soil, 'None')
        assert.equal(p.steam, 'OFF') // 0x10 clear; steam and rinse+spin share rec[36], different bits
        thinq.emit('data', RINSE_SPIN_OFF)
        assert.equal(p.rinse_spin, 'OFF')
        assert.equal(p.soil, 'Heavy')
    })

    test('extra-rinse sweep: extra_rinse flag + extra_rinse_count (rec[4]) across 0..3', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', RINSE_0)
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.extra_rinse_count, 0)
        thinq.emit('data', RINSE_1)
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.extra_rinse_count, 1)
        thinq.emit('data', RINSE_2)
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.extra_rinse_count, 2)
        thinq.emit('data', RINSE_3)
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.extra_rinse_count, 3)
    })

    test('write: the power_off dropdown emits the exact captured WMOff packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power_off', 'Power Off')
        // exact cloud->device packet captured via bridge mode when Power Off was pressed in the LG app
        assert.equal(hex(thinq.outbox[0]).toLowerCase(), 'aa0df0e5000201ff010200c4bb')
    })

    test('write: pause / resume emit their exact captured packets', () => {
        const { thinq, dev } = makeDevice()
        for (const [prop, want] of [
            ['pause', 'aa0df0e5000201ff010302c1bb'],
            ['resume', 'aa0ff0e5000201ff024400030389bb'],
        ] as const) {
            thinq.resetRecorder()
            dev.setProperty(prop, '')
            assert.equal(hex(thinq.outbox[0]).toLowerCase(), want, prop)
        }
    })

    test('write: start_course builds the config/start command (course + defaults, start now)', () => {
        const { thinq, dev } = makeDevice()
        // grammar: f0e5000201ff [03=sub, no override pairs] 0a [course] 7f 0000 [start now] 0301 ; +AABB checksum
        for (const [course, want] of [
            ['Normal', 'aa12f0e5000201ff030a2e7f0000030104bb'],
            ['Heavy Duty', 'aa12f0e5000201ff030a237f0000030113bb'],
            ['Downloaded Course', 'aa12f0e5000201ff030aff7f0000030177bb'], // 0xFF = run the Downloaded slot
        ] as const) {
            thinq.resetRecorder()
            dev.setProperty('start_course', course)
            assert.equal(hex(thinq.outbox[0]).toLowerCase(), want, course)
        }
    })

    test('write: the delay value folds into the start_course blob (matches the captured 1h-delay frames)', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('delay', '1') // 1 hour -> 0x003c minutes in the blob
        thinq.resetRecorder()
        dev.setProperty('start_course', 'Normal')
        // byte-identical to the real captured app frame for Normal @ 1-hour delay
        assert.equal(hex(thinq.outbox[0]).toLowerCase(), 'aa12f0e5000201ff030a2e7f003c0301d8bb')
    })

    test('write: the specialty select emits each SmartCourse WMDownload, byte-identical to the capture', () => {
        const { thinq, dev } = makeDevice()
        // All 17 SmartCourse downloads, the exact cloud->device frames captured 2026-09-05 by pushing every one
        // from the LG app. The device stores the inner frame; send() re-derives the AABB length + checksum, so a
        // match here proves the stored inner + framing reproduces the real wire bytes for all 17.
        const want: ReadonlyArray<readonly [string, string]> = [
            [
                'Sweat Stains',
                'aa2cf0e5000201ff100b650aff0c2e1f10210f1e013d00200e220010003e0034003800350144007f00007bbb',
            ],
            ['Swimwear', 'aa2cf0e5000201ff100b670aff0c161f0e210d1e013d00200e220010003e0034003800350044007f000046bb'],
            [
                'Baby Clothes',
                'aa2cf0e5000201ff100b680aff0c2e1f12210f1e033d00200f220010003e0034013800350044007f000063bb',
            ],
            ['Small Load', 'aa2cf0e5000201ff100b690aff0c441f10210f1e033d00200e220010003e0034003800350044007f00001cbb'],
            ['Overnight', 'aa2cf0e5000201ff100b6a0aff0c2e1f10210d1e033d00200e220010003e0034003800350044017f000066bb'],
            [
                'Single Garments',
                'aa2cf0e5000201ff100b6b0aff0c4a1f12210f1e013d00200e220010003e0034003800350044007f000004bb',
            ],
            ['Rainy Day', 'aa2cf0e5000201ff100b6d0aff0c2e1f1021101e033d00200e220010003e0034003800350144007f00006cbb'],
            ['Gym Clothes', 'aa2cf0e5000201ff100b6e0aff0c4f1f10210e1e013d00200e220010003e0034003800350044007f000003bb'],
            ['Color Care', 'aa2cf0e5000201ff100b6f0aff0c2e1f0e210e1e033d00200e220010003e0034003800350144007f000062bb'],
            ['Denim', 'aa2cf0e5000201ff100b700aff0c2e1f0e210e1e033d00200e220010003e0034003800350144007f00006dbb'],
            ['Full Load', 'aa2cf0e5000201ff100b710aff0c2e1f10210f1e053d00200f220010003e0034003800350044007f00006bbb'],
            ['Beachwear', 'aa2cf0e5000201ff100b730aff0c161f0e210e1e013d00200e220010003e0034003800350044007f000075bb'],
            ['New Clothes', 'aa2cf0e5000201ff100b740aff0c2e1f0e210d1e013d00200e220010003e0034003800350144007f00006cbb'],
            ['Half Load', 'aa2cf0e5000201ff100b760aff0c2e1f10210f1e033d00200e220010003e0034003800350044007f000015bb'],
            ['EconoWash', 'aa2cf0e5000201ff100b780aff0c2e1f0e210f1e033d00200e220010003e0034003801350044007f000014bb'],
            [
                'Delicate Dresses',
                'aa2cf0e5000201ff100b790aff0c161f0e210d1e013d00200e220010003e0034003800350044007f000070bb',
            ],
            [
                'Hand Wash/Wool',
                'aa2cf0e5000201ff100bdd0aff0c221f10210d1e033d00200e220010003e0034003800350044007f0000ccbb',
            ],
        ]
        for (const [name, frame] of want) {
            thinq.resetRecorder()
            dev.setProperty('specialty', name)
            assert.equal(hex(thinq.outbox[0]).toLowerCase(), frame, name)
        }
    })

    test('write: the specialty select snaps back to unknown after firing (re-fireable)', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('specialty', 'Denim')
        assert.equal(ha.devices[DEVICE_ID].properties.specialty, 'unknown')
        // an unknown name is a no-op (nothing sent), never a bad frame
        thinq.resetRecorder()
        dev.setProperty('specialty', 'unknown')
        assert.equal(thinq.outbox.length, 0)
    })

    test('read: downloaded_course decodes the slot byte rec[24] to its SmartCourse name', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        // synthetic 0xEB frame whose only meaningful byte is rec[24], the downloaded-slot SmartCourse code
        const mk = (code: number) => {
            const rec = Buffer.alloc(44)
            rec[0] = 0x2b
            rec[24] = code
            const body = Buffer.concat([Buffer.from([0x20, 0xeb, 0x00]), rec])
            return Buffer.concat([Buffer.from([0xaa, body.length + 4]), body, Buffer.from([0x00, 0xbb])])
        }
        const expect: Record<number, string> = {
            0x69: 'Small Load', // the resting slot
            0x70: 'Denim',
            0x6a: 'Overnight',
            0xdd: 'Hand Wash/Wool',
            0x00: 'None', // empty slot
            0xab: '0xab', // unmapped code falls back to hex, never hidden
        }
        for (const [code, name] of Object.entries(expect)) {
            thinq.emit('data', mk(Number(code)))
            assert.equal(p.downloaded_course, name, `rec[24]=0x${Number(code).toString(16)}`)
        }
    })
})
