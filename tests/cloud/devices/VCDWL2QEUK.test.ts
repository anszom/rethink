import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/VCDWL2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'VCDWL2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'VCDWL2QEUK', swVersion: '0.0.0' }

// All fixtures are REAL frames captured live from the appliance (or, for WASHING/END, the real
// drum-clean frame with record B replaced by a captured/edited wash record). The AA + length and
// checksum + BB envelope bytes are not validated on input, so synthetic ones (aa00…00bb) parse
// identically to the originals.

// 0x88 config — Quick 14, 20 °C, 400 rpm.
const CFG_COLD = buf(
    'aa00200a00880000d300020103004d010e0102010020001e0b0000008603c6000e000e00000c020201010200014000000c00000202022d2d1e001f2b47001c630063010700030008000800080008000800020000000000000000000201050025564344574c325145554b000000000000000000000102c712ea140b070000000000000000006400bb',
)
// 0x92 status — Drum Clean cycle start (status step 0x29, remaining=initial=72 min).
const DRUM = buf(
    'aaff200a0092000196000100ec00800003050e005500000000000000004800480040005529010000000001200202022d1e0000001000041800000000000004000000000000000000000000000000000003050e005500000000000000004800480000005529010009000001200202022d1e000000100104180000000000000400000000000000000000000000000000e163bb',
)
// 0x92 status — Quick 14 Washing phase (status 0x0b, remaining=initial=14 min).
const WASHING = buf(
    'aa00200a0092000196000100ec00800003050e005500000000000000004800480040005529010000000001200202022d1e0000001000041800000000000004000000000000000000000000000000000003010e014b00000000000000000e000e0000004b0b0100090000011f0202022d1e200000100104180000000000000400000000000000000000000000000000e100bb',
)
// 0x92 status — End (status 0x10, remaining 0).
const END = buf(
    'aa00200a0092000196000100ec00800003050e005500000000000000004800480040005529010000000001200202022d1e0000001000041800000000000004000000000000000000000000000000000003010e014b000000000000000000000e0000004b100100090000011f0202022d1e200000100104180000000000000400000000000000000000000000000000e100bb',
)
// 0x92 standby — powered OFF. REAL frame from a live power-off capture (2026-06-30); record B leads
// 0x00 with a 0x00 status byte. All three captured power-offs produced this signature.
const OFF = buf(
    'aa00200a0092000cbc000100ec00800003020e097200000000000000003b003b0000007201000000000001010200002d1e000000020004180000000000000400000000000000000000000000000000000000000c7200000000000000003b003b0000007200010009000001010200002d1e0000000000041800000000000004000000000000000000000000000000005800bb',
)
// 0x41 door/ready snapshots — REAL captured frames (2026-06-29 labelled door capture). Door state is
// inner[18]: 0x02 = closed, 0x01 = open (polarity confirmed by aligning the labelled open/close events
// with frame timestamps). These two differ only in that byte (plus seq + checksum).
const DOOR_CLOSED_F = buf(
    'aaff200a0041000c76000201030006100e0102100201050025564344574c325145554b000000000000000000000102ce12ea140b07000000000000000000c10ebb',
)
const DOOR_OPEN_F = buf(
    'aaff200a0041000c77000201030006100e0102100101050025564344574c325145554b000000000000000000000102ce12ea140b07000000000000000000063dbb',
)

// 0x92 status frames for spin + EzDispense mapping — REAL captured frames (2026-06-30 labelled LG-app
// "send to machine" pushes). Record B carries the selected spin (rec[3]) and the EzDispense reservoir
// enable flags (rec[29]/rec[30]) plus default doses (rec[31]/rec[32], literal mL). Each was diffed
// against the labelled push it followed; the offsets also read sane on the real DRUM frame above.
const SPIN1000 = buf(
    'aa00200a0092000d3f000100ec00800003020e097200000000000000003b003b0000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003020e067200000000000000003800380000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000004600bb',
) // record B spin idx 6 -> 1000 rpm
const SPIN1200 = buf(
    'aa00200a0092000d45000100ec00800003020e067200000000000000003800380000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003020e087200000000000000003800380000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000009000bb',
) // record B spin idx 8 -> 1200 rpm
const DET_ON = buf(
    'aa00200a0092000d4a000100ec00800003020e087200000000000000003800380000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003020e087200000000000000003800380000007201000000000001010202002d1e0000000200041800000000000004000000000000000000000000000000000b00bb',
) // record B detergent dispenser on (rec[29]=0x02), softener off
const SOFT_ON = buf(
    'aa00200a0092000d57000100ec00800003020e087200000000000000003800380000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003020e087200000000000000003800380000007201000000000001010200022d1e0000000200041800000000000004000000000000000000000000000000005c00bb',
) // record B softener dispenser on (rec[30]=0x02), detergent off
const DET_DOSE120 = buf(
    'aa00200a0092000d72000100ec00800003020e08720000000000000000380038000000720100000000000101020000091e0000000200041800000000000004000000000000000000000000000000000003020e08720000000000000000380038000000720100000000000101020000781e0000000200041800000000000004000000000000000000000000000000005000bb',
) // record B detergent dose 120 mL (rec[31]=0x78), softener 30
const SOFT_DOSE120 = buf(
    'aa00200a0092000d63000100ec00800003020e087200000000000000003800380000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003020e087200000000000000003800380000007201000000000001010200002d780000000200041800000000000004000000000000000000000000000000007800bb',
) // record B softener dose 120 mL (rec[32]=0x78), detergent 45

// 0x92 status frames for soil / option / course mapping — REAL captured frames (2026-06-30). Soil is
// record B rec[0] (also the running discriminator): light 0x01 / medium 0x03 / heavy 0x05, RE'd by
// stepping the soil level on a fixed course. SOIL_TUNG (rec[0]=0x05) and SOIL_LET (rec[0]=0x01) lock in
// that non-medium washes still decode (a prior rec[0]===0x03 sentinel rejected them).
const SOIL_LET = buf(
    'aa00200a0092000e00000100ec00800003010e047300000000000000009400940000007301000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000001010e047300000000000000008600860000007301000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000003400bb',
) // record B rec[0]=0x01 (Light), course Down Jacket 0x73
const SOIL_MED = buf(
    'aa00200a0092000e02000100ec00800001010e047300000000000000008600860000007301000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003010e047300000000000000009400940000007301000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000008800bb',
) // record B rec[0]=0x03 (Medium)
const SOIL_TUNG = buf(
    'aa00200a0092000e04000100ec00800003010e047300000000000000009400940000007301000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000005010e04730000000000000000b200b20000007301000000000001010200002d1e000000020004180000000000000400000000000000000000000000000000f700bb',
) // record B rec[0]=0x05 (Heavy)
// Program option toggles — record B rec[33] (pre-wash 0x40 / TurboWash 0x20) and rec[34] (steam 0x10),
// each isolated so only its bit moved vs an all-off baseline.
const STEAM_ON = buf(
    'aa00200a0092000e0c000100ec00800003050e097200000000000000005b005b0000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003050e097200000000000000006e006e0000007201000000000001010200002d1e0010000200041800000000000004000000000000000000000000000000005600bb',
) // record B rec[34]=0x10 (steam on)
const TURBOWASH_ON = buf(
    'aa00200a0092000e12000100ec00800003030e092e0000000000000000ef00ef0000002e01000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003030e062e0000000000000000c400c40000002e01000000000001010200002d1e2000000200041800000000000004000000000000000000000000000000007d00bb',
) // record B rec[33]=0x20 (TurboWash on), course Cotton 0x2e
const FORVASK_ON = buf(
    'aa00200a0092000e1b000100ec00800003030e062e0000000000000000dd00dd0000002e01000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003030e062e0000000000000000ee00ee0000002e01000000000001010200002d1e400000020004180000000000000400000000000000000000000000000000b600bb',
) // record B rec[33]=0x40 (pre-wash on)
// New course codes (rec[4]), REAL captured frames.
const ECO = buf(
    'aa00200a0092000db7000100ec00800005030e092e00000000000000010101010000002e01000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003030e09130000000000000000dc00dc0000001301000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000008e00bb',
) // record B course 0x13 (Eco 40-60)
const DELIKAT = buf(
    'aa00200a0092000ddd000100ec00800003030e062b00000000000000005100510000002b01000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003010e041600000000000000002d002d0000001601000009000001010200002d1e0000000200041800000000000004000000000000000000000000000000004200bb',
) // record B course 0x16 (Delicate)
// Rinse (skyl) level — record B rec[26] (0..5), REAL captured frames (selected by rec[26] value so the
// fixtures don't depend on capture-label timing).
const SKYL_NONE = buf(
    'aa00200a0092000e4f000100ec00800003030e092e0000000000000000ef00ef0000002e01000000000001010200002d1e00000002000418000000000000040000000000000000000000000000000000030300092e0000000000000000d100d10000002e01000000000000010200002d1e0000000200041800000000000004000000000000000000000000000000008c00bb',
) // record B rec[26]=0 (None)
const SKYL_PLUS = buf(
    'aa00200a0092000e55000100ec008000030300092e0000000000000000d100d10000002e01000000000000010200002d1e0000000200041800000000000004000000000000000000000000000000000003030f092e0000000000000000fe00fe0000002e01000000000002010200002d1e000000020004180000000000000400000000000000000000000000000000fc00bb',
) // record B rec[26]=2 (Rinse +)
const SKYL_HOLD = buf(
    'aa00200a0092000e5f000100ec008000030310092e00000000000000010d010d0000002e01000000000003010200002d1e00000002000418000000000000040000000000000000000000000000000000030312092e0000000000000000ef00ef0000002e01000000000004010200002d1e0000000200041800000000000004000000000000000000000000000000000900bb',
) // record B rec[26]=4 (Rinse + Hold)
const MIKROPLAST = buf(
    'aa00200a0092000e6e000100ec00800003030e092e0000000000000000ef00ef0000002e01000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003030e068800000000000000007000700000008801000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000004200bb',
) // record B course 0x88 (Microplastic Care)

// Child-lock / remote-start flags — record B rec[36]. REAL captured frames (2026-07-01): each toggled on
// the physical panel while capturing, and correlated against the LG cloud's childLock/remoteStart fields.
// rec[36] base carries a 0x02 standby-indicator bit (set at rest, clears in a run) independent of these.
const CHILD_LOCK_ON = buf(
    'aa00200a0092000ec5000100ec00800003030e097200000000000000003b003b0000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003030e097200000000000000003b003b0000007201000000000001010200002d1e00000022000418000000000000040000000000000000000000000000000082' +
        '00bb',
) // record B rec[36]=0x22 -> child lock on, remote start off
const REMOTE_START_ON = buf(
    'aa00200a0092000ecc000100ec00800003030e097200000000000000003b003b0000007201000000000001010200002d1e0000000200041800000000000004000000000000000000000000000000000003030e097200000000000000003b003b0000007201000000000001010200002d1e00000012000418000000000000040000000000000000000000000000000087' +
        '00bb',
) // record B rec[36]=0x12 -> remote start on, child lock off
// Mid-cycle (status 0x0b Washing) with BOTH flags set — proves rec[36] holds its offset in a running frame.
const RUN_CHILD_REMOTE = buf(
    'aa00200a009200100b000100ec00800003030e097200000000000000002b003b010800720b260006000001010202022d1e0000001001061800000000000004000000000000000000000000000000000003030e097200000000000000002b003b010900720b260006000001010202022d1e0000003001061800000000000004000000000000000000000000000000009b' +
        '00bb',
) // record B rec[36]=0x30 -> child lock + remote start both on

// Cycle-count end frame — REAL last standby-off frame of the AI-wash capture (2026-07-01): record B
// leads 0x00 with a 0x00 status byte (powered off) and rec[27] = 2, the incremented lifetime count that
// matched the LG cloud's own value at cycle end.
const CYCLE_END = buf(
    'aa00200a0092001101000100ec0080000000000c72000000000000000000003b01590072100e0009000001020202022d1e000000000006180000000000000400000000000000000000000000000000000000000c72000000000000000000003b0159007200100009000001020202022d1e0000000000061800000000000004000000000000000000000000000000007e' +
        '00bb',
) // record B rec[0]=0x00/rec[20]=0x00 (standby off), rec[27]=2 (cycle count)

// Back-half phase frames — REAL captured frames (2026-07-01 AI wash). Record B leads soil=0x00 during
// rinse/spin/end but uses the SAME offsets as the wash phase (remaining=rec[13], spin=rec[3], course=
// rec[4], status=rec[20]) — verified against the LG cloud. These must decode as running, not be dropped.
const RINSE = buf(
    'aa00200a009200102d000100ec00800003030e0972000000000000000021003b011a00720b260006000001010202022d1e0000001001061800000000000004000000000000000000000000000000000000000e0972000000000000000020003b011c00720c0b0006000001010202022d1e00000010010418000000000000040000000000000000000000000000000092' +
        '00bb',
) // record B: status 0x0c Rinsing, remaining 32, spin idx 9 (1400), course 0x72 (AI Wash)
const SPINNING = buf(
    'aa00200a00920010a3000100ec00800000000e097200000000000000000d003b013400720c270006000001010202022d1e00000010010618000000000000040000000000000000000000000000000000000000097200000000000000000c003b013500720e0c0006000001010202022d1e000000100104180000000000000400000000000000000000000000000000b8' +
        '00bb',
) // record B: status 0x0e Spinning, remaining 12
// Spin-only PROGRAM — REAL frame (2026-06-29). Also 0x00-soil-led; decodes with the same offsets (this
// disproves the earlier "spin-only uses a shifted layout" note).
const SPIN_ONLY = buf(
    'aa00200a0092000c1a000100ec00800003020e097200000000000000003b003b0000007201000000000001010200002d1e00000002000418000000000000040000000000000000000000000000000000000000014e00000000000000000800080000004e01000009000000010200002d1e0000000200041800000000000004000000000000000000000000000000006e' +
        '00bb',
) // record B: status 0x01, course 0x4e (Spin only), spin idx 1 (400), remaining 8

// Return a copy of an AA..BB frame with one INNER byte patched (inner[i] = full[2 + i]).
function patchInner(frame: Buffer, innerIndex: number, value: number): Buffer {
    const f = Buffer.from(frame)
    f[2 + innerIndex] = value
    return f
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes a lean component set (no inherited zombie entities)', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        // implemented entities present
        for (const c of [
            'power',
            'status',
            'course',
            'temp',
            'spin',
            'energy',
            'initial_time',
            'remaining_time',
            'door',
            'child_lock',
            'remote_start',
            'tub_clean_count',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // power is a read-only binary_sensor (no untested command), status is free-text (no enum)
        assert.equal(components.power.platform, 'binary_sensor')
        assert.equal(components.power.device_class, 'running')
        assert.equal(components.status.device_class, undefined, 'status has no enum constraint')
        assert.equal(components.status.options, undefined)
        // door is a read-only binary_sensor (device_class door: payload ON=open, OFF=closed)
        assert.equal(components.door.platform, 'binary_sensor')
        assert.equal(components.door.device_class, 'door')
        // not-yet-implemented fields are NOT declared (would be stuck-unknown zombies in HA)
        for (const c of ['error', 'error_message', 'door_lock', 'start', 'pause']) {
            assert.equal(components[c], undefined, `zombie component ${c} absent`)
        }
    })

    test('0x88 config frame marks power ON (settings now sourced from the status frame)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CFG_COLD)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
    })

    test('0x92 status decodes course, temp, spin from record B', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', WASHING) // record B: temp idx 1 (20°C), spin idx 1 (400), course 0x4b (Quick 14)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Quick 14')
        assert.equal(p.temp, 20)
        assert.equal(p.spin, 400)
    })

    test('0x92 status (Washing) decodes status, remaining, initial, power', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', WASHING)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Washing')
        assert.equal(p.remaining_time, 14)
        assert.equal(p.initial_time, 14)
        assert.ok((p.remaining_time as number) <= (p.initial_time as number), 'remaining <= initial')
    })

    test('0x92 status (Drum Clean) maps step 0x29 to Drum Clean, remaining/initial = 72', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRUM)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Drum Clean')
        assert.equal(p.course, 'Drum Clean') // course code 0x55
        assert.equal(p.remaining_time, 72)
        assert.equal(p.initial_time, 72)
    })

    test('0x92 status (End) decodes status=End, remaining=0', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', END)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'End')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 14) // initial stays at the selected duration when remaining hits 0
    })

    test('0x92 energy decodes as big-endian Wh (rec[16] high, rec[17] low)', () => {
        const { ha, thinq } = makeDevice()
        // rec[17] is inner[95]; ground truth: the cold Quick-14 reported 41 Wh with rec[16]=0.
        thinq.emit('data', patchInner(WASHING, 95, 41))
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 41)
        // exercise the high byte: rec[16]=inner[94]=1, rec[17]=inner[95]=16 -> 256+16
        const f = patchInner(WASHING, 94, 1)
        f[2 + 95] = 16
        thinq.emit('data', f)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 272)
    })

    test('unconfirmed status-frame enum indices fall back to unknown (never a wrong number)', () => {
        const { ha, thinq } = makeDevice()
        // record B starts at inner[78]; rec[1]=temp inner[79], rec[3]=spin inner[81], rec[4]=course inner[82]
        thinq.emit('data', patchInner(WASHING, 79, 0xff))
        assert.equal(ha.devices[DEVICE_ID].properties.temp, 'unknown')
        thinq.emit('data', patchInner(WASHING, 81, 0xff))
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 'unknown')
        thinq.emit('data', patchInner(WASHING, 82, 0xff))
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'unknown')
    })

    test('soil level decodes from rec[0]; light/heavy washes still decode (sentinel is "non-zero lead")', () => {
        const { ha, thinq } = makeDevice()
        // Regression: a prior rec[0]===0x03 sentinel rejected any non-medium soil. rec[0] is the soil
        // level (0x01 light / 0x03 medium / 0x05 heavy); all three must decode as running, not be dropped.
        thinq.emit('data', SOIL_LET)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.soil, 'Light')
        thinq.emit('data', SOIL_MED)
        assert.equal(ha.devices[DEVICE_ID].properties.soil, 'Medium')
        thinq.emit('data', SOIL_TUNG)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.soil, 'Heavy')
    })

    test('0x92 frame of unexpected length is ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.status
        thinq.emit('data', buf('aa00200a0092000196000100ec0080000300bb')) // 0x92 type, too short
        assert.equal(ha.devices[DEVICE_ID].properties.status, before)
    })

    test('0x92 standby frame (record B leads 0x00 with status 0x00) decodes power OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', WASHING) // running first (remaining_time -> 14)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 14)
        thinq.emit('data', OFF) // then powered off
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Off')
        // the countdown is cleared so HA doesn't show a stale remaining time while OFF
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 0)
    })

    test('OFF needs BOTH soil==0 and status==0 — a soil-led frame with a zero status stays running', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        // soil-led (rec[0]=0x03) but status byte 0 → must NOT flip OFF (guards the AND discriminator; with
        // a status-alone check this would wrongly power off and zero the countdown mid-cycle).
        thinq.emit('data', patchInner(WASHING, 98, 0x00)) // inner[98] = rec[20]
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Running') // 0x00 unmapped -> free-text fallback, not 'Off'
        // and the true standby frame (soil==0 AND status==0) IS off
        thinq.emit('data', OFF)
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
    })

    test('a 0x00-soil-led frame with status != 0 is powered ON, never OFF (rec[20] is the discriminator)', () => {
        const { ha, thinq } = makeDevice()
        // REAL spin-only frame: record B leads 0x00 (like standby) but rec[20]=0x01 (active). The OFF rule
        // keys on rec[20]==0x00, so this decodes as running — NOT read as OFF, and NOT dropped.
        thinq.emit('data', SPIN_ONLY)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON', 'spin-only must not be read as OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Detecting') // rec[20]=0x01
    })

    test('0x41 door snapshot decodes open/closed from buf[18]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_CLOSED_F)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
        thinq.emit('data', DOOR_OPEN_F)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', DOOR_CLOSED_F)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('0x41 with an uninitialised door byte (0x05 at power-on) holds the last state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DOOR_OPEN_F)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')
        thinq.emit('data', patchInner(DOOR_OPEN_F, 18, 0x05)) // neither open nor closed -> no publish
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON', 'last state held, not overwritten')
    })

    test('0x92 status maps spin index 6 -> 1000 rpm and 8 -> 1200 rpm', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SPIN1000)
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 1000)
        thinq.emit('data', SPIN1200)
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 1200)
    })

    test('config exposes the EzDispense entities (2 enable binary_sensors + 2 dose sensors)', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const c of ['detergent_dispenser', 'softener_dispenser', 'detergent_dose', 'softener_dose']) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.equal(components.detergent_dispenser.platform, 'binary_sensor')
        assert.equal(components.softener_dispenser.platform, 'binary_sensor')
        assert.equal(components.detergent_dose.platform, 'sensor')
        assert.equal(components.detergent_dose.unit_of_measurement, 'mL')
        assert.equal(components.softener_dose.unit_of_measurement, 'mL')
    })

    test('0x92 record B decodes EzDispense enable flags (detergent and softener independently)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DET_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.detergent_dispenser, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.softener_dispenser, 'OFF')
        thinq.emit('data', SOFT_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.detergent_dispenser, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.softener_dispenser, 'ON')
    })

    test('0x92 record B decodes EzDispense doses as literal mL (detergent rec[31], softener rec[32])', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DET_DOSE120)
        assert.equal(ha.devices[DEVICE_ID].properties.detergent_dose, 120)
        assert.equal(ha.devices[DEVICE_ID].properties.softener_dose, 30)
        thinq.emit('data', SOFT_DOSE120)
        assert.equal(ha.devices[DEVICE_ID].properties.softener_dose, 120)
        assert.equal(ha.devices[DEVICE_ID].properties.detergent_dose, 45)
    })

    test('0x92 decodes newly-mapped course codes (rec[4])', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ECO)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Eco 40-60')
        thinq.emit('data', DELIKAT)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Delicate')
        thinq.emit('data', MIKROPLAST)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Microplastic Care')
    })

    test('0x92 decodes rinse (skyl) level from rec[26]', () => {
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.rinse.platform, 'sensor')
        thinq.emit('data', SKYL_NONE)
        assert.equal(ha.devices[DEVICE_ID].properties.rinse, 'None')
        thinq.emit('data', SKYL_PLUS)
        assert.equal(ha.devices[DEVICE_ID].properties.rinse, 'Rinse +')
        thinq.emit('data', SKYL_HOLD)
        assert.equal(ha.devices[DEVICE_ID].properties.rinse, 'Rinse + Hold')
    })

    test('config exposes the soil + option entities', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.soil.platform, 'sensor')
        for (const c of ['prewash', 'turbowash', 'steam']) {
            assert.ok(components[c], `component ${c} present`)
            assert.equal(components[c].platform, 'binary_sensor')
        }
    })

    test('0x92 record B decodes option bitflags (pre-wash rec[33]&0x40, TurboWash rec[33]&0x20, steam rec[34]&0x10)', () => {
        const { ha, thinq } = makeDevice()
        // baseline: all options off (SOIL_MED has rec[33]=rec[34]=0x00)
        thinq.emit('data', SOIL_MED)
        assert.equal(ha.devices[DEVICE_ID].properties.prewash, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.turbowash, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', FORVASK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.prewash, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.turbowash, 'OFF')
        thinq.emit('data', TURBOWASH_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.turbowash, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.prewash, 'OFF')
        thinq.emit('data', STEAM_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
    })

    test('0x92 record B decodes child_lock (rec[36]&0x20) and remote_start (rec[36]&0x10)', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', CHILD_LOCK_ON) // rec[36]=0x22
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.remote_start, 'OFF')
        thinq.emit('data', REMOTE_START_ON) // rec[36]=0x12
        assert.equal(p.child_lock, 'OFF')
        assert.equal(p.remote_start, 'ON')
        thinq.emit('data', RUN_CHILD_REMOTE) // rec[36]=0x30, mid-cycle (status Washing)
        assert.equal(p.status, 'Washing', 'still a running frame')
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.remote_start, 'ON')
    })

    test('flags publish in standby too (rec[36] read before the OFF short-circuit)', () => {
        const { ha, thinq } = makeDevice()
        // prime both flags ON from a running frame, then a real standby OFF frame (rec[36]=0x00) must clear them
        thinq.emit('data', RUN_CHILD_REMOTE)
        thinq.emit('data', OFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.child_lock, 'OFF')
        assert.equal(p.remote_start, 'OFF')
    })

    test('0x92 record B decodes tub_clean_count / washes-since-drum-clean (rec[27]) in both run and standby', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUN_CHILD_REMOTE) // mid-cycle, count not yet incremented
        assert.equal(ha.devices[DEVICE_ID].properties.tub_clean_count, 1)
        thinq.emit('data', CYCLE_END) // powered off at cycle end, count stepped to 2 (matches cloud TCLCount)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.tub_clean_count, 2)
    })

    test('0x00-soil-led back-half phases decode as running (rinse/spin/end + spin-only)', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', RINSE)
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.remaining_time, 32)
        assert.equal(p.spin, 1400) // spin target still readable during rinse
        assert.equal(p.course, 'AI Wash')
        thinq.emit('data', SPINNING)
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Spinning')
        assert.equal(p.remaining_time, 12)
        // spin-only program is a distinct 0x00-led frame — must decode, not read as OFF
        thinq.emit('data', SPIN_ONLY)
        assert.equal(p.power, 'ON')
        assert.equal(p.course, 'Spin only')
        assert.equal(p.spin, 400)
        assert.equal(p.remaining_time, 8)
    })

    test('sub-step status codes map to their phase (0x03/0x25 Detecting, 0x26 Washing, 0x27 Rinsing)', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        for (const [code, phase] of [
            [0x03, 'Detecting'],
            [0x25, 'Detecting'],
            [0x26, 'Washing'],
            [0x27, 'Rinsing'],
        ] as const) {
            thinq.emit('data', patchInner(WASHING, 98, code)) // inner[98] = record B rec[20] (status)
            assert.equal(p.status, phase, `status 0x${code.toString(16)} -> ${phase}`)
        }
    })

    test('unknown frame type and non-envelope frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('aa00200a005a0001020304050600bb')) // 0x5A course-list
        thinq.emit('data', buf('aa0720e90a91bb')) // 3-byte heartbeat
        thinq.emit('data', buf('001122')) // not an AA..BB envelope
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })
})
