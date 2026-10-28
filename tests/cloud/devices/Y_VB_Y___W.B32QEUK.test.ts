import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_VB_Y___W.B32QEUK'
import type { Metadata } from '@/cloud/thinq'
import crc16 from '@/util/crc16'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_VB_Y___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_VB_Y___W.B32QEUK', swVersion: '2.11.207' }

// Frame: AA <length> 20 0A 00 <actual_length> ... 2-byte CRC16 BB.
// SAMPLE_INITIAL/SAMPLE_POWER_OFF are real 96-byte (dual-block) captures from a Y_VB_Y___W.B32QEUK
// washer: a neutral start state with no program selected, and the same machine powered off.
const SAMPLE_INITIAL = buf(
    'aaff200a006000f52c000100ec004e00000100000000000000000000000000000000000000001f006400000000000002022a1e00800100000100000000000000000000000000000000000000001f006400000000000002022a1e0000010ee4bb',
)
const SAMPLE_POWER_OFF = buf(
    'aaff200a006000f531000100ec004e00000100000000000000000000000000000000000000001f006400000000000002022a1e00000100000000000000000000000000000000000000000001001f006400000000000002022a1e000001605cbb',
)
const SAMPLE_MEASURING = buf(
    'aaff200a00600008b5000100ec004e000001000000000000000000000000000000000000000020006400000000012402022a1e004001000004010c010c1200030106010000000042000001010020006400000200000000002a1e0000019db0bb',
)
const SAMPLE_RUNNING_DOOR_LOCKED = buf(
    'aaff200a006000f98f000100ec004e0000060219021b0400030a0401000000004220000104001f006400000200000103012a1e0040010000060219021b0400030a0401000000004220000104001f006400000200000103012a1e00000164afbb',
)
const SAMPLE_RINSING = buf(
    'AAFF200A00600002DA000100EC004E0000070022021B0400030A0001000000004200000106001F00640000020000B903012A1E0000010000070022021B0400030A0001000000004200000106001F00640000020000BA03012A1E000001CE60BB',
)
const SAMPLE_SPINNING = buf(
    'aaff200a006000cc44000100ec004e000007001d021b0400030a0001000000004200000106001100640000020000c102002a1e004001000008001c021b0400000a0000000000004200000107001100640000020000c202002a1e000001dc6cbb',
)
// A single-block (57-byte, no payload_b) capture. Same status layout as payload_a in the dual-block
// frames above; the driver falls back to payload_a when there's no second block to read.
const SAMPLE_SINGLE_BLOCK_WASHING = buf(
    'aaff200a003900c2a6000100eb00270000060216021b0400030a04010000000042200001040011006400000200000602002a1e00400189a4bb',
)
// A valid AA..BB frame with a correct CRC16 and the same payload_length/payload_type as a status
// push, but message_type=0x0a instead of 0x00
// This looks like raw sensor data for some unknown purpose
const SAMPLE_UNKNOWN_MESSAGE_TYPE = buf(
    'aaff200a003900ce8600010ae20027000004032603260400030a04010000000002200001010011006400000200011602002a1e000001dbabbb',
)

// Turning the selector from Drum Clean (payload_a) to the downloaded "Blanket" program (payload_b):
// course is the program's base course (0x05, Duvet), and its LG catalog id 0x3a appears at [22]
// (selected downloaded program) and [25] (program in the download slot).
const SAMPLE_DOWNLOADED_DUVET_SELECTED = buf(
    'aaff200a006000e811000100ec004e000001010c010c1200030106010000000000000003000005003a00000200000000002a1e000001000001011c011c0500030201010000000000000001003a05003a00000300000002022a1e000001990cbb',
)

// ezDispense amounts (ml per 5 kg of laundry) at [34] detergent / [35] softener: 42/30 at first,
// then 43/30 after the app set the detergent amount, then 43/31 after it set the softener amount.
// In the last two, payload_a still holds the old value and payload_b the new one.
const SAMPLE_EZDISPENSE_42_30 = buf(
    'aaff200a0060000400000100ec004e000001000000000000000000000000000000000000000005003400000000000002022a1e004001000001000000000000000000000000000000000000000005003400000000000002022a1e00800151adbb',
)
const SAMPLE_EZDISPENSE_43_30 = buf(
    'aaff200a0060000440000100ec004e000001000000000000000000000000000000000000000005003400000000000002022a1e000001000001000000000000000000000000000000000000000005003400000000000002022b1e0000016e6bbb',
)
const SAMPLE_EZDISPENSE_43_31 = buf(
    'aaff200a006000045a000100ec004e000001000000000000000000000000000000000000000005003400000000000002022b1e000001000001000000000000000000000000000000000000000005003400000000000002022b1f000001fda5bb',
)

// Opening and closing the ezDispense drawer, in the order the washer sent them. Only [37] changes:
// bit 2 is set for as long as the drawer is open, while bit 6 pulses on and off in between.
const SAMPLE_DRAWER_OPENING = buf(
    'aaff200a0060004cd1000100ec004e000001000000000000000000000000000000000000000005003400000000000002022a1e000001000001000000000000000000000000000000000000000005003400000000000002022a1e0004014a1dbb',
)
const SAMPLE_DRAWER_OPEN_PULSE_ON = buf(
    'aaff200a0060004cd4000100ec004e000001000000000000000000000000000000000000000005003400000000000002022a1e000401000001000000000000000000000000000000000000000005003400000000000002022a1e004401bd20bb',
)
const SAMPLE_DRAWER_OPEN_PULSE_OFF = buf(
    'aaff200a0060004cff000100ec004e000001000000000000000000000000000000000000000005003400000000000002022a1e004401000001000000000000000000000000000000000000000005003400000000000002022a1e00040183e8bb',
)
const SAMPLE_DRAWER_CLOSED = buf(
    'aaff200a0060004d02000100ec004e000001000000000000000000000000000000000000000005003400000000000002022a1e000401000001000000000000000000000000000000000000000005003400000000000002022a1e000001c8b2bb',
)

// Not a capture: a Y_V8_Y___W.B32QEUK idle record with Cotton selected, remote start on, detergent
// at MORE ([32] = 3) and softener at LESS ([33] = 1), which the LG cloud decoded as such. It was
// reported from a simulated washer so that the LG app's start (APP_START_COTTON) would carry the
// dose levels.
const SAMPLE_COTTON_DOSED = buf(
    'AAFF200A0039040081000100EB0027000001032603260100000000000000000002000003000011007100000000000003010000000000557ABB',
)

// Rewrites one byte of a single-record (0xeb) status frame, fixing up its CRC16
function withRecordByte(frame: Buffer, offset: number, value: number) {
    const copy = Buffer.from(frame)
    copy[2 + 13 + offset] = value
    copy.writeUInt16BE(crc16(copy.subarray(0, copy.length - 3)), copy.length - 3)
    return copy
}

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'
// captured from the LG app setting the detergent amount to 43 ml and the softener amount to 31 ml
const WRITE_EZDISPENSE_DETERGENT_43 = 'AA09F0240D012B55BB'
const WRITE_EZDISPENSE_SOFTENER_31 = 'AA09F0240E011FA0BB'
// The LG app starting Cotton at 40 C with Rinse+ on SAMPLE_COTTON_DOSED, through the bridge
const APP_START_COTTON = 'AA16F0260103FF04020000000000030000030100B3BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('initial state: neutral start, no program selected', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.course, 'Not selected')
        assert.equal(props.spin, 'Not selected')
        assert.equal(props.temp, 'Not selected')
        assert.equal(props.rinse, 'Not selected')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.cycles, 31)
        assert.equal(props.energy, 0)
        assert.equal(props.reserve_time, 0)
        // lock_status=0x00: remote_start=OFF; door_lock and child_lock ON, which is unlocked for HA's lock class
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Medium')
        // options=0x00: no optional cycle features active
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        // the download slot's factory content, before anything else was downloaded
        assert.equal(props.downloaded_program, 'Rinse + Spin')
    })

    test('selecting a downloaded program: course shows its base, smart course its catalog name', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOWNLOADED_DUVET_SELECTED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Duvet')
        // downloaded program 0x3a, the cloud's BLANKET — not this model's AI Wash selector position
        assert.equal(props.smart_course, 'Blanket')
        assert.equal(props.downloaded_program, 'Blanket')
        assert.equal(props.spin, '400 rpm')
        assert.equal(props.initial_time, 88)
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Medium')
    })

    test('status follows the washer through a cycle', () => {
        const { ha, thinq } = makeDevice()
        for (const [frame, status] of [
            [SAMPLE_MEASURING, 'Measuring'],
            [SAMPLE_RUNNING_DOOR_LOCKED, 'Washing'],
            [SAMPLE_RINSING, 'Rinsing'],
            [SAMPLE_SPINNING, 'Spinning'],
            [SAMPLE_POWER_OFF, 'Off'],
        ] as const) {
            thinq.emit('data', frame)
            assert.equal(ha.devices[DEVICE_ID].properties.status, status)
        }
    })

    test('dispenser drawer follows bit 2 of [37], not the bit 6 pulse', () => {
        const { ha, thinq } = makeDevice()
        for (const [frame, drawer] of [
            [SAMPLE_INITIAL, 'OFF'],
            [SAMPLE_DRAWER_OPENING, 'ON'],
            [SAMPLE_DRAWER_OPEN_PULSE_ON, 'ON'],
            [SAMPLE_DRAWER_OPEN_PULSE_OFF, 'ON'],
            [SAMPLE_DRAWER_CLOSED, 'OFF'],
            // bit 6 alone, as seen mid-cycle with the drawer shut
            [SAMPLE_SINGLE_BLOCK_WASHING, 'OFF'],
        ] as const) {
            thinq.emit('data', frame)
            assert.equal(ha.devices[DEVICE_ID].properties.dispenser_drawer, drawer)
        }
    })

    test('power-off transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
    })

    test('measuring state: Tub Clean, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_MEASURING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Measuring')
        assert.equal(props.course, 'Tub Clean')
        assert.equal(props.spin, 'No spin')
        assert.equal(props.temp, '60 °C')
        assert.equal(props.initial_time, 72)
        assert.equal(props.remaining_time, 72)
        assert.equal(props.cycles, 32)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        // no detergent/softener dosed yet during the measuring phase
        assert.equal(props.detergent, 'Off')
        assert.equal(props.softener, 'Off')
    })

    test('running state: Eco 40-60, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING_DOOR_LOCKED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.spin, '1400 rpm')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.rinse, 'Normal')
        assert.equal(props.initial_time, 147)
        assert.equal(props.remaining_time, 145)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.detergent, 'High')
        assert.equal(props.softener, 'Low')
    })

    test('rinsing state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing')
        assert.equal(props.course, 'Eco 40-60')
        // temp isn't reported during the rinse phase
        assert.equal(props.temp, 'Not selected')
        assert.equal(props.remaining_time, 34)
        assert.equal(props.energy, 186)
        assert.equal(props.initial_time, 147)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
    })

    test('spinning state: Eco 40-60, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.spin, '1400 rpm')
        // temp isn't reported during the spin phase
        assert.equal(props.temp, 'Not selected')
        assert.equal(props.initial_time, 147)
        assert.equal(props.remaining_time, 28)
        assert.equal(props.energy, 194)
        assert.equal(props.cycles, 17)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Off')
    })

    test('single-block (no payload_b) frame still decodes via payload_a', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SINGLE_BLOCK_WASHING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.spin, '1400 rpm')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.initial_time, 147)
        assert.equal(props.remaining_time, 142)
        assert.equal(props.energy, 6)
        assert.equal(props.cycles, 17)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Off')
    })

    test('a well-formed frame with an unrecognized message_type is ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_UNKNOWN_MESSAGE_TYPE)
        assert.equal(ha.devices[DEVICE_ID]?.properties.power, undefined)
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
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

    test('ezDispense amounts decode from the status push', () => {
        const { ha, thinq } = makeDevice()
        for (const [frame, detergent, softener] of [
            [SAMPLE_EZDISPENSE_42_30, 42, 30],
            [SAMPLE_EZDISPENSE_43_30, 43, 30],
            [SAMPLE_EZDISPENSE_43_31, 43, 31],
        ] as const) {
            thinq.emit('data', frame)
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.ezdispense_detergent, detergent)
            assert.equal(props.ezdispense_softener, softener)
            // separate from the dose levels, which stay Medium throughout
            assert.equal(props.detergent, 'Medium')
            assert.equal(props.softener, 'Medium')
        }
    })

    test('HA write ezDispense amounts sends the same packets as the LG app', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('ezdispense_detergent', '43')
        dev.setProperty('ezdispense_softener', '31')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_EZDISPENSE_DETERGENT_43, WRITE_EZDISPENSE_SOFTENER_31])
    })

    test('HA write ezDispense amounts accepts the edges of the app range, 9 and 150 ml', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('ezdispense_detergent', '9')
        dev.setProperty('ezdispense_softener', '150')
        assert.deepEqual(
            thinq.outbox.map((packet) => [...packet.subarray(2, packet.length - 2)]),
            [
                [0xf0, 0x24, 0x0d, 0x01, 9],
                [0xf0, 0x24, 0x0e, 0x01, 150],
            ],
        )
    })

    test('HA write ezDispense amounts rejects values outside the app range', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        for (const value of ['', ' ', '0', '8', '151', '256', '42.5', '-1', 'abc']) {
            dev.setProperty('ezdispense_detergent', value)
            dev.setProperty('ezdispense_softener', value)
        }
        assert.equal(thinq.outbox.length, 0)
    })

    test('the dispenser nozzle clean course decodes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withRecordByte(SAMPLE_COTTON_DOSED, 7, 0x37))
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Dispenser Clean')
    })

    describe('running a programme', () => {
        test('the assembled command matches the one the LG app sends, dose levels included', () => {
            const { ha, thinq, dev } = makeDevice()
            thinq.emit('data', SAMPLE_COTTON_DOSED)
            assert.equal(ha.devices[DEVICE_ID].properties.detergent, 'High')
            assert.equal(ha.devices[DEVICE_ID].properties.softener, 'Low')
            thinq.resetRecorder()

            dev.setProperty('set_course', 'Cotton')
            dev.setProperty('set_soil', 'Normal')
            dev.setProperty('set_spin', 'Max')
            dev.setProperty('set_temp', '40 °C')
            dev.setProperty('set_rinse', 'Rinse+')
            dev.setProperty('run_programme', '')

            assert.equal(hex(thinq.outbox[thinq.outbox.length - 1]), APP_START_COTTON)
        })

        test('the dispense type is repeated as reported', () => {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', withRecordByte(SAMPLE_COTTON_DOSED, 36, 2)) // EZD_DETERGENT_MAIN
            thinq.resetRecorder()

            dev.setProperty('run_programme', '')

            const inner = Buffer.from(hex(thinq.outbox[thinq.outbox.length - 1]), 'hex').subarray(2)
            assert.equal(inner[15], 3, 'detergent level')
            assert.equal(inner[16], 1, 'softener level')
            assert.equal(inner[17], 2, 'dispense type')
        })
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
