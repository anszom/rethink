import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_V8_Y___W.B32QEUK'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_V8_Y___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_V8_Y___W.B32QEUK', swVersion: '2.11.207' }

// Real packet captures from a Y_V8_Y___W.B32QEUK washer (issue #11, lg-washer-rethink-cloud-14-min-prog.txt).
// Frame: AA <unused> 20 0A 00 39 ... (53-byte inner block, total 57 bytes).

const SAMPLE_INITIAL = buf(
    'AAFF200A0039000381000100EB0027000001032603260000000000000000000000000003000011007100000000000000000000000000974EBB',
)
const SAMPLE_RUNNING_DOOR_LOCKED = buf(
    'AAFF200A0039000398000100EB0027000006000E000E0C0003020201000000014220000101001100710000010000000000000000000056D9BB',
)
const SAMPLE_RINSING = buf(
    'AAFF200A00390003C6000100EB0027000007000B000E0C000302000100000001420000010600110071000001000022000000000000004970BB',
)
const SAMPLE_SPINNING = buf(
    'AAFF200A0039000435000100EB00270000080005000E0C00000200000000000042000001070011007100000100002600000000000000AF09BB',
)
const SAMPLE_END = buf(
    'AAFF200A0039000478000100EB002700000A0000000E0C00000000000000000040000001080011007100000100002900000000000000C901BB',
)
const SAMPLE_POWER_OFF = buf(
    'AAFF200A0039000487000100EB00270000000000000E0C000000000000000000000000000A0011007100000100002900000000000000CB19BB',
)

// Captured live from an LG FSR7A04PG on 2026-09-28 while it was switched on from Home Assistant and
// then had its temperature and steam changed on the panel. These are 0x00ec records: the envelope
// carries the state being replaced followed by the state replacing it, 39 bytes each.
const PAIR_POWER_ON = buf(
    'AAFF200A006000027F000100EC004E00000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000E0048000000000000000000000000006E4BBB',
)
const PAIR_COURSE_SELECTED = buf(
    'AAFF200A0060000286000100EC004E00000100000000000000000000000000000000000000000E004800000000000000000000000000000001003B003B3A00030A0401000000000001000200000E0048000004000000000000000000004282BB',
)
const PAIR_STEAM_AND_60C = buf(
    'AAFF200A0060000288000100EC004E000001003B003B3A00030A0401000000000001000200000E004800000400000000000000000000000001013201323A00030A0601000000800001000300000E0048000004000000000000000000000709BB',
)
const PAIR_POWER_OFF = buf(
    'AAFF200A006000028B000100EC004E000001013201323A00030A0601000000800001000300000E004800000400000000000000000000000000013201323A0000000000000000000001000301000E004800000400000000000000000000BEFABB',
)

// Captured live from an LG FSR7A04PG the moment its downloaded "Hygiene" programme was selected:
// 60 C with steam, 1400 rpm. The course field reads 0x2d - the ALLERGYSPASTEAM base the Hygiene
// course is built on - while the downloaded course itself is 0x48 in its own code space.
const PAIR_HYGIENE_SELECTED = buf(
    'AAFF200A006000074F000100EC004E00000100000000000000000000000000004200000000000E004800000000000000000000000000000001023002302D00030A0601000000804200000000480E00480000000000000000000000C000B72ABB',
)

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'start',
            'pause',
            'status',
            'error',
            'error_message',
            'course',
            'temp',
            'spin',
            'cycles',
            'remote_start',
            'door_lock',
            'energy',
            'initial_time',
            'remaining_time',
            'reserve_time',
            'child_lock',
            'wrinkle_care',
            'intensive_wash',
            'extra_rinse',
            'turbowash',
            'steam',
            'steam_softener',
            'prewash',
            'crease_care',
            'medic_rinse',
            'ai_dd',
            'rinse',
            'smart_course',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.status.options as string[]).includes('Error'))
    })

    test('initial state push decodes status, time and cycles', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.remaining_time, 3 * 60 + 38) // 03:38
        assert.equal(props.initial_time, 3 * 60 + 38)
        assert.equal(props.cycles, 17)
        assert.equal(props.energy, 0)
        // flags1=0x00 = remote_start=OFF, door_lock=ON (unlocked, the inverted convention)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.reserve_time, 0) // no delayed end set
        assert.equal(props.turbowash, 'OFF')
    })

    test('running state with door locked + remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING_DOOR_LOCKED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing') // 0x06
        assert.equal(props.course, 'Speed 14') // 0x0c
        assert.equal(props.spin, 400) // buf[23]=0x02
        // buf[24]=0x02 = 20 C, which is what Speed 14 runs at. This read 10 C while the field was
        // taken from buf[25], one byte late.
        assert.equal(props.temp, 20)
        assert.equal(props.initial_time, 14)
        assert.equal(props.remaining_time, 14) // 00:14
        // flags1=0x42 = 0x40 lock bit set + 0x02 remote_start bit set
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.child_lock, 'ON') // 0x80 clear = unlocked, the inverted convention
        assert.equal(props.wrinkle_care, 'OFF') // 0x20 clear
        assert.equal(props.turbowash, 'ON') // options=0x01
        assert.equal(props.steam, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.intensive_wash, 'OFF') // soilWash=3 = normal
        assert.equal(props.extra_rinse, 'OFF') // rinse=1
        assert.equal(props.ai_dd, 'OFF') // buf[31]=0x20, and only 0x01 is the AI DD indicator
        assert.equal(props.rinse, 'Normal') // code 1
        assert.equal(props.reserve_time, 0)
    })

    // The two fields this file used to read one byte late, and the one it read four bytes late.
    // Both only show up away from the wash phase, which is why a single frame never caught them.
    test('spin holds for the whole cycle and energy accumulates', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_RUNNING_DOOR_LOCKED)
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 400)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 0)

        // A spin setting does not stop existing because the machine moved on to rinsing: read from
        // buf[24] these three came back 400, undefined, undefined.
        thinq.emit('data', SAMPLE_RINSING)
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 400)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 34)

        thinq.emit('data', SAMPLE_SPINNING)
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 400)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 38)

        // Energy holds its total once the cycle is over rather than resetting.
        thinq.emit('data', SAMPLE_END)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 41)
        thinq.emit('data', SAMPLE_POWER_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 41)
    })

    test('rinsing state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing') // 0x07
        assert.equal(props.remaining_time, 11)
    })

    test('spinning state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning') // 0x08
    })

    test('end state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'End') // 0x0A
        assert.equal(props.remaining_time, 0)
        assert.equal(props.door_lock, 'OFF') // still locked at the end-of-cycle reading
        assert.equal(props.remote_start, 'OFF')
    })

    test('power-off transition (status=0)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
    })

    test('a status envelope is acked, so the appliance stops retransmitting it', () => {
        const { thinq } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', SAMPLE_INITIAL)

        // SAMPLE_INITIAL carries sequence 0x0381 at inner[5..6]; the cloud acks an envelope by that
        // sequence under the `ack` command, not as an ordinary packet.
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, [AABBDevice.frame(buf('f0000a040381')).toString('hex').toUpperCase()])
        assert.deepEqual(thinq.outbox, [], 'the ack is not sent as a packet')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('frames with wrong inner length are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        // valid AA..BB envelope but inner is too short to be a 53-byte status
        thinq.emit('data', buf('AA08200A01020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    // The 0x00ec pair is what this appliance actually sends when anything is touched. Matching on a
    // 53-byte length ignored all of it, which is what made the Home Assistant power switch snap back
    // to off and left panel changes invisible.
    describe('0x00ec state pairs', () => {
        test('switching on is reported, so the power switch holds', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', PAIR_POWER_ON)
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.power, 'ON')
            assert.equal(props.status, 'Ready')
            assert.equal(props.cycles, 14)
        })

        test('a course selected on the panel reaches HA', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', PAIR_COURSE_SELECTED)
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.course, 'AI Wash') // 0x3a
            assert.equal(props.spin, 1400) // 0x0a
            assert.equal(props.temp, 40) // 0x04
            assert.equal(props.initial_time, 59)
            assert.equal(props.remaining_time, 59)
            assert.equal(props.ai_dd, 'ON')
            assert.equal(props.steam, 'OFF')
            assert.equal(props.intensive_wash, 'OFF') // soilWash=3 = normal
        })

        // This frame's two records disagree: the one being replaced is the 40 C, steam-off state, the
        // one replacing it is 60 C with steam. Reading the first would report the state the appliance
        // has just left.
        test('the replacing record wins, not the one being replaced', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', PAIR_STEAM_AND_60C)
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.temp, 60) // 0x06, against 0x04 in the superseded record
            assert.equal(props.steam, 'ON') // options 0x80, against 0x00
            assert.equal(props.spin, 1400) // unchanged by the edit
            assert.equal(props.course, 'AI Wash')
            // A hotter wash with steam is a longer one, and the appliance says so.
            assert.equal(props.initial_time, 110)
            assert.equal(props.crease_care, 'OFF')
            assert.equal(props.prewash, 'OFF')
            assert.equal(props.medic_rinse, 'OFF')
            assert.equal(props.steam_softener, 'OFF')
        })

        test('switching off is reported', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', PAIR_STEAM_AND_60C)
            thinq.emit('data', PAIR_POWER_OFF)
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.power, 'OFF')
            assert.equal(props.status, 'Off')
            assert.equal(props.steam, 'OFF')
        })

        test('an envelope whose payload is shorter than it claims is ignored', () => {
            const { ha, thinq } = makeDevice()
            const before = ha.devices[DEVICE_ID].properties.power
            // 0x00ec announcing 78 bytes, carrying 4
            thinq.emit('data', buf('AA13200A001300028B000100EC004E00010203BB'))
            assert.equal(ha.devices[DEVICE_ID].properties.power, before)
        })
    })

    // LG's modelJson for this model defines rinse as 0=NO_RINSE, 1=RINSE_NORMAL, 2=RINSE_PLUS,
    // 3=RINSE_PLUSPLUS, 4=RINSE_NORMAL_HOLD, 5=RINSE_PLUS_HOLD. Code 4 is a normal rinse count left
    // standing in the drum, so it adds no rinse - which a `>= 2` test reports as an extra one.
    test('rinse codes map to their labels, and only the plus ones count as an extra rinse', () => {
        const { ha, thinq } = makeDevice()
        // SAMPLE_RUNNING_DOOR_LOCKED with the rinse byte replaced; record offset 12 is inner[25],
        // which is frame[27].
        const frame = (rinseCode: number) => {
            const f = Buffer.from(SAMPLE_RUNNING_DOOR_LOCKED)
            f[27] = rinseCode
            return f
        }
        const expected: [number, string, string][] = [
            [0, 'Not selected', 'OFF'],
            [1, 'Normal', 'OFF'],
            [2, 'Rinse+', 'ON'],
            [3, 'Rinse++', 'ON'],
            [4, 'Normal, hold', 'OFF'],
            [5, 'Rinse+, hold', 'ON'],
        ]
        for (const [code, label, extra] of expected) {
            thinq.emit('data', frame(code))
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.rinse, label, `rinse ${code}`)
            assert.equal(props.extra_rinse, extra, `extra_rinse for rinse ${code}`)
        }
    })

    test('a downloaded course is reported separately from the base course it is built on', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', PAIR_HYGIENE_SELECTED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.smart_course, 'Hygiene') // 0x48
        assert.equal(props.course, 'Allergy SpaSteam') // 0x2d, the base programme
        assert.equal(props.temp, 60)
        assert.equal(props.steam, 'ON')
        assert.equal(props.spin, 1400)
        assert.equal(props.rinse, 'Normal')
    })

    test('an unmapped course is published as its raw code, not as None', () => {
        const { ha, thinq } = makeDevice()
        const f = Buffer.from(PAIR_HYGIENE_SELECTED)
        // record offset 7 of the replacing record is inner[59], which is frame[61]
        f[61] = 0x63
        thinq.emit('data', f)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Unknown (0x63)')
    })

    test('downloaded courses map to their names', () => {
        const { ha, thinq } = makeDevice()
        // Read off an FSR7A04PG as each was downloaded to it; record offset 22 is frame[76].
        const downloaded: [number, string][] = [
            [0x34, 'Kids Wear'],
            [0x36, 'Swimming Wear'],
            [0x37, 'Rainy Season'],
            [0x38, 'Gym Clothes'],
            [0x39, 'Jeans'],
            [0x3a, 'Blanket'],
            [0x3b, 'Sweat Stain'],
            [0x3e, 'Single Garment'],
            [0x48, 'Hygiene'],
            [0x49, 'Small Load'],
            [0x4d, 'Cold Wash'],
            [0x64, 'Rinse + Spin'],
            [0x65, 'Lightly Soiled Items'],
            [0x66, 'Minimize Detergent Residue'],
            [0x6b, 'Sleeve Hems and Collars'],
            [0x6c, 'Juice and Food Stains'],
            [0x6f, 'Minimize Wrinkles'],
            [0x47, 'Baby Care'],
            [0x4c, 'Skin Care'],
            [0x4a, 'Lingerie'],
            [0x3f, 'Colour Protection'],
            [0x79, 'Drain'],
            [0x7a, 'Spin'],
            [0x86, 'MicroPlastic Care'],
            [0x84, 'Silent Wash'],
            [0x71, 'Quick Tub Clean'],
            // A code the appliance has never reported still has to stay identifiable.
            [0x5a, 'Unknown (0x5a)'],
        ]
        for (const [code, label] of downloaded) {
            const f = Buffer.from(PAIR_HYGIENE_SELECTED)
            f[76] = code
            thinq.emit('data', f)
            assert.equal(ha.devices[DEVICE_ID].properties.smart_course, label, `0x${code.toString(16)}`)
        }
    })

    test('an unmapped downloaded course is published as its raw code, not dropped', () => {
        const { ha, thinq } = makeDevice()
        const f = Buffer.from(PAIR_HYGIENE_SELECTED)
        // record offset 22 of the replacing record is inner[74], which is frame[76]
        f[76] = 0x77
        thinq.emit('data', f)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Unknown (0x77)')
    })

    // Every dial position of an FSR7A04PG, each read off the machine while turning the dial through
    // all thirteen. Pinned here because these are model-specific: washer_common's shared table reads
    // 0x3a as Bedding, where this machine means AI Wash by it.
    test('every dial position maps to its programme', () => {
        const { ha, thinq } = makeDevice()
        const dial: [number, string][] = [
            [0x3a, 'AI Wash'],
            [0x01, 'Cotton'],
            [0x02, 'Easy Care'],
            [0x04, 'Eco 40-60'],
            [0x05, 'Duvet'],
            [0x07, 'Mix'],
            [0x08, 'Sports Wear'],
            [0x0c, 'Speed 14'],
            [0x12, 'Tub Clean'],
            [0x1b, 'Wool'],
            [0x20, 'Delicate'],
            [0x2d, 'Allergy SpaSteam'],
            [0x31, 'Turbo Wash 39'],
        ]
        for (const [code, label] of dial) {
            const f = Buffer.from(PAIR_HYGIENE_SELECTED)
            f[61] = code // record offset 7 of the replacing record
            thinq.emit('data', f)
            assert.equal(ha.devices[DEVICE_ID].properties.course, label, `course 0x${code.toString(16)}`)
        }
    })

    // Reported by the course field whenever a downloadable programme with no dial equivalent is
    // selected. Each was identified from the downloadable course observed sitting on it.
    test('base courses that are not dial positions are named too', () => {
        const { ha, thinq } = makeDevice()
        const bases: [number, string][] = [
            [0x0e, 'Rinse + Spin'],
            [0x17, 'Spin only'],
            [0x09, 'Silent Wash'],
            [0x30, 'Quick Tub Clean'],
            [0x3b, 'MicroPlastic Care'],
        ]
        for (const [code, label] of bases) {
            const f = Buffer.from(PAIR_HYGIENE_SELECTED)
            f[61] = code
            thinq.emit('data', f)
            assert.equal(ha.devices[DEVICE_ID].properties.course, label, `course 0x${code.toString(16)}`)
        }
    })

    test('start() sends the F0ED initialisation packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('HA write power=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_ON)
    })

    test('HA write power=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    test('HA write pause button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_PAUSE)
    })

    test('HA write start button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_START)
    })

    describe('running a programme', () => {
        // The exact frame the LG app put on the wire starting Allergy SpaSteam at 60 C with steam,
        // captured through bridge mode on 2026-09-28. Reproducing it byte for byte is the whole
        // point of the F026 builder.
        const APP_START = 'AA16F0262D03FF06010000000080030000000000DABB'

        test('the assembled command matches the one the LG app sends', () => {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()

            dev.setProperty('set_course', 'Allergy SpaSteam')
            dev.setProperty('set_soil_wash', 'Normal')
            dev.setProperty('set_spin', 'Max')
            dev.setProperty('set_temp', '60 °C')
            dev.setProperty('set_rinse', 'Normal')
            dev.setProperty('set_steam', 'ON')
            dev.setProperty('run_programme', '')

            assert.equal(hex(thinq.outbox[thinq.outbox.length - 1]), APP_START)
        })

        test('an untouched start runs what the appliance already reports', () => {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', PAIR_HYGIENE_SELECTED) // Allergy SpaSteam, 60 C, steam, 1400 rpm
            thinq.resetRecorder()

            dev.setProperty('run_programme', '')

            const sent = Buffer.from(hex(thinq.outbox[thinq.outbox.length - 1]), 'hex')
            const inner = sent.subarray(2, sent.length - 2)
            assert.equal(inner[2], 0x2d, 'course as reported')
            assert.equal(inner[4], 0x0a, 'spin as reported, 1400 rather than Max')
            assert.equal(inner[5], 0x06, 'temp as reported')
            assert.equal(inner[11], 0x80, 'steam as reported')
            assert.equal(inner[12], 0x03, 'initialBit | remoteStart')
        })

        test('a chosen setting overrides the reported one, and is released once it has run', () => {
            const { ha, thinq, dev } = makeDevice()
            thinq.emit('data', PAIR_HYGIENE_SELECTED)
            assert.equal(ha.devices[DEVICE_ID].properties.set_temp, '60 °C')

            dev.setProperty('set_temp', '30 °C')
            assert.equal(ha.devices[DEVICE_ID].properties.set_temp, '30 °C', 'the choice shows immediately')

            thinq.resetRecorder()
            dev.setProperty('run_programme', '')
            const inner = Buffer.from(hex(thinq.outbox[thinq.outbox.length - 1]), 'hex').subarray(2)
            assert.equal(inner[5], 0x03, 'the chosen 30 C is sent')

            // With the programme running, the appliance is the authority again.
            thinq.emit('data', PAIR_HYGIENE_SELECTED)
            assert.equal(ha.devices[DEVICE_ID].properties.set_temp, '60 °C')
        })

        test('option switches set and clear their own bit only', () => {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', PAIR_HYGIENE_SELECTED) // steam already on
            thinq.resetRecorder()

            dev.setProperty('set_prewash', 'ON')
            dev.setProperty('run_programme', '')
            let inner = Buffer.from(hex(thinq.outbox[thinq.outbox.length - 1]), 'hex').subarray(2)
            assert.equal(inner[11], 0x80 | 0x40, 'steam kept, pre-wash added')

            thinq.emit('data', PAIR_HYGIENE_SELECTED)
            dev.setProperty('set_steam', 'OFF')
            dev.setProperty('run_programme', '')
            inner = Buffer.from(hex(thinq.outbox[thinq.outbox.length - 1]), 'hex').subarray(2)
            assert.equal(inner[11], 0x00, 'steam cleared')
        })

        // The appliance reports 0 for every setting while it is idle. Left unnamed, the selects
        // published "None", which is not in their option lists, and Home Assistant rejects a state
        // it was not offered - so the entities sat unknown until a wash was configured.
        test('an idle appliance leaves every select in a state HA will accept', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', SAMPLE_POWER_OFF) // every setting zero
            const props = ha.devices[DEVICE_ID].properties
            const cfg = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
            for (const name of ['set_course', 'set_temp', 'set_spin', 'set_rinse', 'set_soil_wash']) {
                const options = cfg[name].options as string[]
                assert.ok(
                    options.includes(props[name] as string),
                    `${name} published ${props[name]}, which is not one of its options`,
                )
            }
        })

        test('a delayed end outside the range the appliance accepts is ignored', () => {
            const { ha, dev } = makeDevice()
            dev.setProperty('set_delay_end', '5')
            assert.equal(ha.devices[DEVICE_ID].properties.set_delay_end, 5)
            dev.setProperty('set_delay_end', '1') // modelJson: reserveTimeHour is 3..19
            assert.equal(ha.devices[DEVICE_ID].properties.set_delay_end, 5, 'out-of-range value rejected')
            dev.setProperty('set_delay_end', '0') // 0 is "no delayed end"
            assert.equal(ha.devices[DEVICE_ID].properties.set_delay_end, 0)
        })
    })

    // homeassistant.ts publishes the literal "None" for an undefined value, and HA reads that as
    // unknown. Any enum using None as a real label therefore makes a state the appliance genuinely
    // reports vanish - which is what happened to the rinse select, and would have to the downloaded
    // course. No published option list may contain it.
    test('no option list uses the payload HA reserves for unknown', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [name, component] of Object.entries(components)) {
            const options = component.options as string[] | undefined
            if (!options) continue
            assert.ok(!options.includes('None'), `${name} offers "None", which HA treats as unknown`)
        }
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
