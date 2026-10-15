import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/SDH_GVX5_6211'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'SDH_GVX5_6211'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '3.0.97' }

// Real captures from an LG RHX5009NHB (protocolVer 7, clip_ble_v1.9.237).

// 0xEB reply to the F0ED status request, appliance powered off.
const SAMPLE_EB_OFF = buf(
    'AAFF300A00440008A2000100EB00320A000000000000000000000000010000000000040000008F20000000050000000600000000000000000000000000000000006B0DBB',
)

// Power button pressed, no course selected yet: block still all zeroes except the power bit.
const SAMPLE_EC_POWERED_IDLE = buf(
    'AAFF300A00760008A9000100EC00640A000000000000000000000000010000000000040000008F20000000050000000600000000000000000000000000000000000A000000000000000000000000010000000000040000008F2000008005000000060000000000000000000000000000000000CD40BB',
)

// Cotton / Cupboard / Turbo idle, Delay End armed at 8 h (previous block shows 6 h).
const SAMPLE_EC_DELAY_8H = buf(
    'AAFF300A00760008CD000100EC00640A030300000700016800960096010000020000040700008F00000880050000000600000000000000000000000000000000000A03030000070001E000960096010000020000040700008F0000088005000000060000000000000000000000000000000000DFD6BB',
)

// Remote start armed with the door ajar: the panel showed dE1 in parallel.
const SAMPLE_EC_ERROR_DE1 = buf(
    'AAFF300A00760008DB000100EC00640A030300000700000000960096010000020000040700008F00000080050000000600000000000000000000000000000000000A030300000700000000960096050110020000040700008F00000080050000000600000000000000000000000000000000002472BB',
)

// Beep switched off on the Condenser Care course: rec[19] loses its default 0x04.
const SAMPLE_EC_BEEP_OFF = buf(
    'AAFF300A0076000037000100EC00640A000300001200000000410041010000030000041200008F00004080050000000600000000000000000000000000000000000A000300001200000000410041010000030000001200008F0000408005000000060000000000000000000000000000000000B31ABB',
)

// Child lock armed: rec[26] gains 0x10 next to the remote-start 0x40.
const SAMPLE_EC_CHILD_LOCK = buf(
    'AAFF300A0076000039000100EC00640A000300001200000000410041010000030000041200008F00004080050000000600000000000000000000000000000000000A000300001200000000410041010000030000041200008F0000508005000000060000000000000000000000000000000000A304BB',
)

// Anti-crease toggled on (0x08 joins the drum light bit 0x20 in rec[24]).
const SAMPLE_EC_ANTI_CREASE = buf(
    'AAFF300A00760008E9000100EC00640A030300000700000000960096010000020000040700008F20000080050000000600000000000000000000000000000000000A030300000700000000960096010000020000040700008F2800008005000000060000000000000000000000000000000000DFF9BB',
)

// Remote start armed cleanly (door closed), appliance idle on Cotton.
const SAMPLE_EC_REMOTE_START = buf(
    'AAFF300A00760008F1000100EC00640A030300000700000000960096010000020000040700008F00000080050000000600000000000000000000000000000000000A030300000700000000960096010000020000040700008F000040800500000006000000000000000000000000000000000005F7BB',
)

// Timed Dry running, 19 of 20 minutes remaining, rec[26] 0x40 (remote start) set for the run.
const SAMPLE_EC_DRYING = buf(
    'AAFF300A0076000901000100EC00640A000300001500000000140014070100020000041500008F00004080050000000600000000000000000000000000000000000A000300001500000000130014070100020000041500008F0000408005000000060000000000000000000000000000000000F59CBB',
)

// Pause pressed mid-run: phase 0x03 with the replaced phase 0x07 in rec[14].
const SAMPLE_EC_PAUSED = buf(
    'AAFF300A0076000913000100EC00640A00030000150000000011001407010002000D041500008F00004080050000000600000000000000000000000000000000000A00030000150000000011001403070002000D041500008F20000080050000000600000000000000000000000000000000003498BB',
)

// Powered off after use: the phase byte drops to 0x00 but rec[27] keeps its latched 0x80.
const SAMPLE_EC_OFF_AFTER_USE = buf(
    'AAFF300A00760009AC000100EC00640A000000000000000000000000010000000000040000008F20000080050000000600000000000000000000000000000000000A000000000000000000000000000100000000040000008F00000080050000000600000000000000000000000000000000001912BB',
)

// Eco started on the panel with remote start never armed: rec[26] 0x00 -> 0x44, the dryer switching
// remote start on by itself (HA's Pause was then accepted).
const SAMPLE_EC_PANEL_START = buf(
    'AAFF300A0076000AD4000100EC00640A030200001900000000640064010000000000001900008F20000480050000000000000000000000000000000000000000000A0302000019000000006400640E0100000000001900008F00004480050000000000000000000000000000000000000000001DFDBB',
)

// Asleep 12 min after remote start was armed: phase Initial -> 0x00 with rec[26] 0x42 (remote start
// kept, 0x02 = asleep), where a real power-off leaves rec[26] clear.
const SAMPLE_EC_SLEEP = buf(
    'AAFF300A0076000AAC000100EC00640A000000000000000000000000010000000000000000008F00004080050000000000000000000000000000000000000000000A000000000000000000000000000100000000000000008F00004280050000000000000000000000000000000000000000003379BB',
)

// Condenser Care run: phase 0x15 (Condenser care) -> 0x11 (Condenser clean), rec[26] gaining 0x20.
const SAMPLE_EC_CONDENSER_CLEAN = buf(
    'AAFF300A0076000A48000100EC00640A000300001200000000410041150100030000001200008F00004080050000000000000000000000000000000000000000000A000300001200000000410041111500030000001200008F00006080050000000000000000000000000000000000000000008D3CBB',
)

// Eco started from HA: phase 0x0E (Detecting) while the auto-sensing course estimates its time.
const SAMPLE_EC_DETECTING = buf(
    'AAFF300A0076000A9C000100EC00640A000000000000000000000000010000000000000000008F20004080050000000000000000000000000000000000000000000A0302000019000000006400640E0100000000001900008F0000448005000000000000000000000000000000000000000000A600BB',
)

const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
// Power-field writes captured from the ThinQ app.
const WRITE_POWER_ON = 'AA0DF0E5000201FF010201C7BB'
const WRITE_POWER_OFF = 'AA0DF0E5000201FF010200C4BB'
// Run-command writes captured from the ThinQ app: pause (03 = 02) and resume (03 = 03).
const WRITE_PAUSE = 'AA0DF0E5000201FF010302C1BB'
const WRITE_RESUME = 'AA0DF0E5000201FF010303C0BB'
// End and Cooling frames from two real runs; rec[17..18] matched the ThinQ app exactly.
const SAMPLE_EC_END_284WH = buf(
    'AAFF300A007600065C000100EC00640A00030002150000000001001E08110005011B041500008F00004080050000000600000000000000000000000000000000000A00030002150000000001001E04080007011C041500008F2000008005000000060000000000000000000000000000000000B4F2BB',
)
const SAMPLE_EC_COOLING_144WH = buf(
    'AAFF300A007600071D000100EC00640A00030000150000000001001411070005008E041500008F00006080050000000600000000000000000000000000000000000A000300001500000000010014081100050090041500008F000040800500000006000000000000000000000000000000000023DFBB',
)

const WRITE_START_FOLLOW_UP = 'AA09F024120114BBBB'
// Start writes captured from the ThinQ app (Drum Care) and from a hand injection the dryer accepted
// (Condenser Care, hidden in the app; status 00 for field 0A).
const WRITE_START_DRUM_CARE = 'AA0FF0E5000201FF020A130301E6BB'
const WRITE_START_CONDENSER_CARE = 'AA0FF0E5000201FF020A120301E7BB'

// The fields of an F0E5 write as { field: value }, the Timed Dry time (70) taking two bytes.
function writeFields(frame: Buffer) {
    const inner = frame.subarray(2, -2)
    const fields: Record<number, number> = {}
    for (let i = 7, n = inner[6]; n > 0; n--) {
        const size = inner[i] === 0x70 ? 2 : 1
        fields[inner[i]] = inner.readUIntBE(i + 1, size)
        i += 1 + size
    }
    return fields
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('energy is the per-cycle Wh counter at rec[17..18]', () => {
        const a = makeDevice()
        a.thinq.emit('data', SAMPLE_EC_END_284WH)
        assert.equal(a.ha.devices[DEVICE_ID].properties.energy, 284)
        const b = makeDevice()
        b.thinq.emit('data', SAMPLE_EC_COOLING_144WH)
        assert.equal(b.ha.devices[DEVICE_ID].properties.energy, 144)
    })

    test('start() sends the F0ED status request', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('single 0xEB frame decodes the powered-off state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.error, 'OFF')
    })

    test('powered on with no course selected: power bit alone flips ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_POWERED_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Initial') // the phase byte reads 0x01 even before a course is picked
        assert.equal(props.course, 'None')
    })

    test('powered off after use: the latched rec[27] bit does not fake power ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_OFF_AFTER_USE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
    })

    test('doubled 0xEC frame decodes the LAST (current) block, not the stale previous one', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DELAY_8H)
        const props = ha.devices[DEVICE_ID].properties
        // previous block holds the 6 h delay; the current one 8 h
        assert.equal(props.delay_end, 480)
        assert.equal(props.course, 'Cotton')
        assert.equal(props.dry_level, 'Cupboard')
        assert.equal(props.dry_mode, 'Turbo')
        assert.equal(props.remaining_time, 150)
        assert.equal(props.initial_time, 150)
    })

    test('dE1 (door) error is reported with its message', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_ERROR_DE1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door open (dE1)')
        assert.equal(props.status, 'Error')
    })

    test('anti-crease bit is isolated from the drum light bit', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_ANTI_CREASE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.anti_crease, 'ON')
        assert.equal(props.damp_alert, 'OFF')
        assert.equal(props.drum_light, 'ON')
    })

    test('beep reads rec[19] bit 0x04, default on', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_BEEP_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.beep, 'OFF')
        assert.equal(props.course, 'Condenser Care')
    })

    test('child lock reads rec[26] bit 0x10 independently of remote start', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_CHILD_LOCK)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.beep, 'ON')
    })

    test('remote start reads rec[26] bit 0x40 while idle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_REMOTE_START)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
    })

    test('a panel-started run reports the remote start the dryer switched on itself', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PANEL_START)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
    })

    test('running cycle: Drying phase and countdown', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.course, 'Timed Dry')
        assert.equal(props.remaining_time, 19)
        assert.equal(props.initial_time, 20)
    })

    test('pause mid-run reports the Pause phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PAUSED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Pause')
        assert.equal(props.remaining_time, 17)
    })

    test("status follows LG's state indices, not guessed labels", () => {
        for (const [sample, status] of [
            [SAMPLE_EC_CONDENSER_CLEAN, 'Condenser clean'],
            [SAMPLE_EC_DETECTING, 'Detecting'],
            [SAMPLE_EC_COOLING_144WH, 'Cooling'],
        ] as const) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', sample)
            assert.equal(ha.devices[DEVICE_ID].properties.status, status)
        }
    })

    test('asleep: Off phase with rec[26] 0x02 reads Sleep, power OFF, remote start kept', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_EC_SLEEP)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Sleep')
        assert.equal(props.power, 'OFF')
        assert.equal(props.remote_start, 'ON')
    })

    test('the power switch sends the explicit on/off writes; other values and unknown props send nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        dev.setProperty('power', 'OFF')
        dev.setProperty('power', 'TOGGLE')
        dev.setProperty('nonsense', '')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_POWER_ON, WRITE_POWER_OFF])
    })

    test('pause sends the pause run command alone', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_PAUSE])
    })

    test('start programs the picked course, not the one the appliance reports', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DRYING) // rec[20] reports Timed Dry
        dev.setProperty('set_course', 'Drum Care')
        assert.equal(ha.devices[DEVICE_ID].properties.set_course, 'Drum Care')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_START_DRUM_CARE, WRITE_START_FOLLOW_UP])
    })

    test('the set entities show the panel until something is picked in HA', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DELAY_8H) // Cotton / Cupboard / Turbo on the panel
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.set_course, 'Cotton')

        // a pick outlives the panel's next report
        dev.setProperty('set_course', 'Eco')
        thinq.emit('data', SAMPLE_EC_DELAY_8H)
        assert.equal(props.set_course, 'Eco')
    })

    test('start runs what the set entities show, then they follow the panel again', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EC_DELAY_8H) // Cotton / Cupboard / Turbo on the panel
        dev.setProperty('set_course', 'Eco')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.deepEqual(writeFields(thinq.outbox[0]), { 0x0a: 0x19, 0x03: 0x01 })
        assert.equal(hex(thinq.outbox[1]), WRITE_START_FOLLOW_UP)
        assert.equal(ha.devices[DEVICE_ID].properties.set_course, 'Cotton')
    })

    test('start sends nothing with no course on the panel and none picked', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EB_OFF)
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.deepEqual(thinq.outbox, [])
    })

    test('start from Pause resumes the run instead of programming a new one', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_EC_PAUSED)
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.deepEqual(thinq.outbox.map(hex), [WRITE_RESUME, WRITE_START_FOLLOW_UP])
    })

    test('Condenser Care, hidden in the app, programs the code the appliance accepted', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('set_course', 'Condenser Care')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_START_CONDENSER_CARE)
    })

    test('frames that are not 0x30-family are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08F02A010098BB'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
