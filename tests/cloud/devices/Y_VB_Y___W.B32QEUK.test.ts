import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_VB_Y___W.B32QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_VB_Y___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'Y_VB_Y___W.B32QEUK', swVersion: '2.11.207' }

// Frame: AA <length> 20 0A 00 <actual_length> ... 2-byte CRC16 BB.
// SAMPLE_INITIAL/SAMPLE_POWER_OFF are real 93-byte (dual-block) captures from a Y_VB_Y___W.B32QEUK
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
// frames above; the device falls back to payload_a when there's no second block to read.
const SAMPLE_SINGLE_BLOCK_WASHING = buf(
    'aaff200a003900c2a6000100eb00270000060216021b0400030a04010000000042200001040011006400000200000602002a1e00400189a4bb',
)
// A valid AA..BB frame with a correct CRC16 and the same payload_length/payload_type as a status
// push, but message_type=0x0a instead of 0x00
// This looks like raw sensor data for some unknown purpose
const SAMPLE_UNKNOWN_MESSAGE_TYPE = buf(
    'aaff200a003900ce8600010ae20027000004032603260400030a04010000000002200001010011006400000200011602002a1e000001dbabbb',
)

// Turning the selector from Drum Clean (payload_a) to the downloaded "Duvet" program (payload_b):
// course is the program's base course (0x05, Duvet), and its LG catalog id 0x3a appears at [22]
// (selected downloaded program) and [25] (program in the download slot).
const SAMPLE_DOWNLOADED_DUVET_SELECTED = buf(
    'aaff200a006000e811000100ec004e000001010c010c1200030106010000000000000003000005003a00000200000000002a1e000001000001011c011c0500030201010000000000000001003a05003a00000300000002022a1e000001990cbb',
)

// Returns a copy of a dual-block status frame with some payload_b bytes replaced and the CRC16
// recomputed, so it still passes verify_frame_valid.
function withPayloadB(frame: Buffer, bytes: Record<number, number>) {
    const out = Buffer.from(frame)
    // aa, then payload_b at 53 in processAABB's buffer
    for (const [index, value] of Object.entries(bytes)) out[1 + 53 + Number(index)] = value
    let crc = 0
    for (const byte of out.subarray(0, out.length - 3)) {
        crc ^= byte << 8
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
    out[out.length - 3] = crc >> 8
    out[out.length - 2] = crc & 0xff
    return out
}

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

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'
// captured from the LG app setting the detergent amount to 43 ml and the softener amount to 31 ml
const WRITE_EZDISPENSE_DETERGENT_43 = 'AA09F0240D012B55BB'
const WRITE_EZDISPENSE_SOFTENER_31 = 'AA09F0240E011FA0BB'

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
            'downloaded_program',
            'temp',
            'spin',
            'cycles',
            'remote_start',
            'door_lock',
            'child_lock',
            'energy',
            'initial_time',
            'remaining_time',
            'delay_end',
            'detergent',
            'softener',
            'ezdispense_detergent',
            'ezdispense_softener',
            'turbowash',
            'prewash',
            'steam',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.equal(components.ezdispense_detergent.command_topic, '$this/ezdispense_detergent/set')
        assert.equal(components.ezdispense_softener.command_topic, '$this/ezdispense_softener/set')
        // this model has no EcoHybrid feature
        assert.equal(components.eco_hybrid, undefined)
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.status.options as string[]).includes('Error'))
        assert.ok((components.detergent.options as string[]).includes('Medium'))
        assert.ok((components.softener.options as string[]).includes('Medium'))
    })

    test('initial state: neutral start, no program selected', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        // no program selected yet: course/spin/temp all publish undefined, which reaches HA as 'None'
        assert.equal(props.course, 'None')
        assert.equal(props.spin, 'None')
        assert.equal(props.temp, 'None')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.cycles, 31)
        assert.equal(props.energy, 0)
        assert.equal(props.delay_end, 0)
        // lock_status=0x00: remote_start=OFF, door_lock=ON (unlocked, the inverted convention), child_lock=OFF
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Medium')
        // options=0x00: no optional cycle features active
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        // the download slot's factory content, before anything else was downloaded
        assert.equal(props.downloaded_program, 'Rinse + Spin')
    })

    test('selecting a downloaded program: course and downloaded program show its catalog name', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOWNLOADED_DUVET_SELECTED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Ready')
        // catalog id 0x3a, looked up in the shared table — not this model's AI Wash selector position
        assert.equal(props.course, 'Bedding')
        assert.equal(props.downloaded_program, 'Bedding')
        assert.equal(props.spin, 400)
        assert.equal(props.initial_time, 88)
        assert.equal(props.detergent, 'Medium')
        assert.equal(props.softener, 'Medium')
    })

    test('selecting a downloaded program shows its name, not its base course', () => {
        const { ha, thinq } = makeDevice()
        // Kid Clothes: base course Cotton (0x01), catalog id 0x34
        thinq.emit('data', withPayloadB(SAMPLE_DOWNLOADED_DUVET_SELECTED, { 7: 0x01, 22: 0x34, 25: 0x34 }))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Children Clothing')
        assert.equal(props.downloaded_program, 'Children Clothing')
    })

    test('built-in courses: AI Wash keeps its model-specific label, Rinse + Spin reads as the shared table has it', () => {
        const { ha, thinq } = makeDevice()
        for (const [code, label] of [
            [0x3a, 'AI Wash'],
            [0x0e, 'Rinse + Spin'],
        ] as const) {
            // [22] = 0: no downloaded program selected, so [7] is a built-in course code
            thinq.emit('data', withPayloadB(SAMPLE_DOWNLOADED_DUVET_SELECTED, { 7: code, 22: 0x00 }))
            const props = ha.devices[DEVICE_ID].properties
            assert.equal(props.course, label)
            // the slot still holds the downloaded program, whatever the selector is on
            assert.equal(props.downloaded_program, 'Bedding')
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

    test('measuring state: Drum Clean, door locked, remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_MEASURING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Measuring')
        assert.equal(props.course, 'Drum Clean')
        assert.equal(props.spin, 0)
        assert.equal(props.temp, 60)
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
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
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
        assert.equal(props.temp, 'None')
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
        assert.equal(props.spin, 1400)
        // temp isn't reported during the spin phase
        assert.equal(props.temp, 'None')
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
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
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

    test('frames with a bad CRC16 are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        // valid AA..BB envelope, but the trailing checksum doesn't match the payload
        thinq.emit('data', buf('AA08200A01020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('a real frame with a corrupted checksum byte is ignored', () => {
        const { ha, thinq } = makeDevice()
        const corrupted = Buffer.from(SAMPLE_INITIAL)
        corrupted[corrupted.length - 3] ^= 0x01 // flip a bit in the CRC16 high byte
        thinq.emit('data', corrupted)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
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

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
