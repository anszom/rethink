import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/T1789EFH_F'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'T1789EFH_F'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LG WT7300CW', swVersion: '1.0' }

// Packet layout: AA <len> <inner> <cksum> BB  (len = total packet length)
// processAABB receives inner = raw.subarray(2, raw.length - 2)
// inner = 3-byte header + stacked 0x19-marked records; the LAST record is the current state.
// 0xEC carries a 27-byte old record then the 26-byte current one; 0xEB carries the current one alone.
//
// Every fixture below is a real frame captured from this appliance.

// Idle just after provisioning — both records phase 0x00.
const EC_IDLE = buf(
    'AA3C20EC0019000000011A00000000000000000000100000040800000064000019000000011A000000000000000000001000000408000000640037BB',
)

// Heavy Duty. Old record: Washing, 24 min, soil 5. Current record: the cycle has moved on to Rinsing
// with 29 min left, and soil has dropped to 0 the way it does once washing hands over.
// soil=5/spin=3/temp=4 in the old record are exactly the soilWash/spin/temp defaults this model's JSON
// declares for HEAVY_DUTY, which is what pins these three offsets.
const EC_HEAVY_DUTY = buf(
    'AA3C20EC0019050018011A0200050304000000000410000000050000006400001906001D011E0200000304000000000410000000050000006400FABB',
)

// Bedding, mid-cycle: soil 3 / spin 1 / temp 4 — again the model's own BEDDING defaults (Normal, Low,
// Warm), a different triple from Heavy Duty's. Old record Washing, current record Paused.
const EC_RUNNING = buf(
    'AA3C20EC001905002B00340800030104000000000410000000030000006400001902002B0034080003010400000000041000000005000000640054BB',
)

// Deliberate lid-open pause — both records Paused, countdown frozen at 43.
const EC_PAUSED = buf(
    'AA3C20EC001902002B00340800030104000000000410000000050000006400001902002B00340800030104000000000010000000050000006400A9BB',
)

// Immediately after unpausing: old record still Paused, current record back to Washing.
const EC_RESUMED = buf(
    'AA3C20EC001902002B00340800030104000000000010000000050000006400001905002B00340800030104000000000010000000020000006400ADBB',
)

// End of cycle: old record Spinning with 1 minute left, current record Complete with none. Under the
// previous "first record is current" reading this frame reported "Rinse / Drain, 1 min" — the machine
// was finished and Home Assistant never saw a completed state at all.
const EC_SPIN_TO_COMPLETE = buf(
    'AA3C20EC00190700010019010000030000000000440000000006000000640000190800000019010000030000000000440000000107000000640099BB',
)

// Single-record 0xEB reply to a status query, powered off. Its preState byte (rec[20] = 0x08) says the
// state before Off was Complete, which is how a finished cycle looks from cold.
const EB_IDLE = buf('AA2120EB00190000010023000000000000000000400000000208000000670091BB')

// 0xE2 settings echo. It has a valid 0x19 record at the same place a 0xEB does, so only the frame-type
// gate keeps it out — the sibling F3L7CYK5W_US_WIFI found its equivalent replays a stale snapshot of
// the cycle's start, which would knock the machine back a phase every time one arrived.
const E2_SETTINGS = buf('AA2120E20319030102003A010003030100000000400000000101000000640082BB')

// Device identity/serial frame (0x31), sent once per reconnect, and the short 0xD8 heartbeat.
const IDENTITY = buf(
    'AA372031020153414133393935353130330000D05F0000800000000000025341413339393534393033000044FC000040000000000008BB',
)
const SHORT_ACK = buf('AA0720D80EE2BB')

// EC_HEAVY_DUTY with only the current record's two remaining-time bytes edited, 00 1D -> 01 05, to pin
// the hour byte: a real 0xE2 frame from this washer carries 01 02 (62 minutes), which the previous
// minute-byte-only decode reported as 2.
const EC_REMAINING_OVER_AN_HOUR = buf(
    'AA3C20EC0019050018011A02000503040000000004100000000500000064000019060105011E0200000304000000000410000000050000006400FABB',
)

// ── Live capture, 2026-09-05: dial sweep and one-button option tests on the appliance, each frame
// labelled by what the control panel showed at the moment it was emitted. ──────────────────────────

const NORMAL_TURBO_ON = buf(
    'AA3C20EC001901000100000000000000000000000080000000000000006700001901003B003A010003030400000000400000000000000000670060BB',
)
// Dialled straight to Deep Wash: rec[16] reads 0x10 (Turbo Wash supported, currently off).
const DEEP_WASH_DIALLED = buf(
    'AA3C20EC001901012801270200050304000000000010000000000000006700001901003A003919000302040000000000100000000000000067005DBB',
)
// Water Plus pressed on Normal: the machine switches to the Deep Wash course AND sets 0x02, so it is
// 0x12 here against 0x10 above — same course, one bit apart. That pair is what isolates Water Plus.
const WATER_PLUS = buf(
    'AA3C20EC001901003B003A0100030304000000004000000000000000008300001901003A00391900030204000000000012000000000000008300C6BB',
)
// Downloaded slot loaded with the Whites smart course, whose defaults include Extra Rinse. Base course
// reads 0x01 (Normal) because the Downloaded position reports the smart course's base cycle. Panel
// showed 2:06 — the remaining-time bytes are 02 06, i.e. the hour byte carrying two hours.
const WHITES_EXTRA_RINSE = buf(
    'AA3C20EC0019010100003B0800010204000000000000000000006B00006B00001901020602050100050205020000004001000000008300008300F9BB',
)
const SOAK = buf(
    'AA3C20EC001901003B003A0100030304000000004000000000000000008300001901011D003A0100030304000000004020000000000000008301E5BB',
)
const STAIN_CARE = buf(
    'AA3C20EC001901011D003A01000303040000000040200000000000000083010019010120003A01000303030200000000080000000000000083000ABB',
)
const CONTROL_LOCK = buf(
    'AA3C20EC00190100390038040001010100000000001000000000000000830000190100390038040001010100000000011000000000000000830068BB',
)
// Delay Wash at 16 h. The byte reads 0x10, which a BCD reading would publish as 10.
const DELAY_16H = buf(
    'AA3C20EC00190100390038040001010100000F0000100000000000000083000019010039003804000101010000100000100000000000000083000EBB',
)
// Delay Wash at 19 h — 0x13, and the model JSON's declared maximum for reserveTimeHour.
const DELAY_19H = buf(
    'AA3C20EC00190100390038040001010100001200001000000000000000830000190100390038040001010100001300001000000000000000830034BB',
)
// Remote Start held: the door physically locked. rec[17] took 0x01 one frame earlier, then rec[15]
// took 0x04 — which is how the two were separated. The sibling F3L7CYK5W could not separate them.
const REMOTE_START = buf(
    'AA3C20EC00190100390038040001010100000000001001000000000000830000190100390038040001010100000000041001000000000000830017BB',
)
const SPIN_ONLY = buf(
    'AA3C20EC0019010021002011000003010000000000100000000000000083000019010010000F120000030000000000000000000000000000830093BB',
)
const PREWASH_NORMAL = buf(
    'AA3C20EC0019010039003804000101010000000000100000000000000083000019010119011829000303040000000040000000000000000083000FBB',
)
const TUB_CLEAN = buf(
    'AA3C20EC001901011901182900030304000000004000000000000000008300001901010801080C00010305000000000000000000000000008300ACBB',
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

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of ['power', 'status', 'pre_state', 'remaining_time', 'initial_time', 'soil', 'spin', 'temp']) {
            assert.ok(components[c], `component ${c} present`)
        }
        // free text, so an unmapped phase code can publish 'unknown' without HA rejecting it
        assert.equal(components.status.device_class, undefined)
        assert.equal(components.status.options, undefined)
        // HA's 'lock' binary-sensor class is inverted (on = unlocked), so publishing ON for locked
        // through it renders backwards. It displayed "Locked" on a powered-off machine with the door
        // open until this was removed.
        assert.equal(components.door_lock.device_class, undefined)
    })

    test('start() requests a status snapshot, so a reconnect does not leave HA blank', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa0ef0ed1121010000001800b5bb'],
        )
    })

    // ── The current state is the LAST record, not the first ───────────────────

    test('end-of-cycle frame reports Complete, not the spin it just left', () => {
        const p = feed([EC_SPIN_TO_COMPLETE])
        assert.equal(p.status, 'Complete')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.power, 'ON')
    })

    test('pause and resume follow the current record', () => {
        assert.equal(feed([EC_RUNNING]).status, 'Paused') // old record Washing, current Paused
        assert.equal(feed([EC_PAUSED]).status, 'Paused')
        assert.equal(feed([EC_RESUMED]).status, 'Washing') // old record Paused, current Washing
    })

    test('mid-cycle Heavy Duty frame reports the phase the machine is in now', () => {
        const p = feed([EC_HEAVY_DUTY])
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.remaining_time, 29)
    })

    // ── Previous state ────────────────────────────────────────────────────────

    test('pre_state names the phase the machine just left', () => {
        assert.equal(feed([EC_RESUMED]).pre_state, 'Paused') // now Washing
        assert.equal(feed([EC_SPIN_TO_COMPLETE]).pre_state, 'Spinning') // now Complete
        assert.equal(feed([EC_HEAVY_DUTY]).pre_state, 'Washing') // now Rinsing
    })

    test('a finished cycle is still visible after the washer powers itself off', () => {
        // the whole reason this field is published: status alone reports plain Off here, and a
        // laundry-done automation would have nothing to trigger on
        const p = feed([EB_IDLE])
        assert.equal(p.status, 'Off')
        assert.equal(p.pre_state, 'Complete')
    })

    // ── Times are [hour][minute] pairs ────────────────────────────────────────

    test('remaining time reads the hour byte', () => {
        assert.equal(feed([EC_REMAINING_OVER_AN_HOUR]).remaining_time, 65)
    })

    test('initial time estimate reads the hour byte and outlives the countdown', () => {
        const p = feed([EC_HEAVY_DUTY])
        assert.equal(p.initial_time, 90) // 01 1E
        assert.ok((p.remaining_time as number) < (p.initial_time as number))
    })

    test('powered off, both times report 0 rather than the last cycle leftovers', () => {
        // EB_IDLE's record still carries 00 01 / 00 23 from the cycle that finished
        const p = feed([EB_IDLE])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
    })

    // ── Settings, each pinned by a course whose defaults the model JSON declares ─

    test('Heavy Duty capture decodes its own declared defaults', () => {
        // the old record is the one holding the wash-phase settings; the current record is already
        // rinsing, where soil resets — assert what the current record actually carries
        const p = feed([EC_HEAVY_DUTY])
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.soil, 'Not selected')
    })

    test('Bedding capture decodes a different triple', () => {
        const p = feed([EC_RUNNING])
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'Low')
        assert.equal(p.temp, 'Warm')
    })

    test('idle frame decodes settings as unset rather than unknown', () => {
        const p = feed([EC_IDLE])
        assert.equal(p.course, 'Not selected')
        assert.equal(p.soil, 'Not selected')
        assert.equal(p.spin, 'Not selected')
        assert.equal(p.temp, 'Not selected')
    })

    // ── Frames that must publish nothing ──────────────────────────────────────

    test('non-status frames are ignored even when they contain a valid record', () => {
        for (const junk of [E2_SETTINGS, IDENTITY, SHORT_ACK]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', junk)
            assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
        }
    })

    test('frames for the dryer, too-short frames and unmarked records are ignored', () => {
        for (const junk of [
            // same as EB_IDLE but with the dryer's 0x30 device byte
            'AA2130EB00190000010023000000000000000000400000000208000000670091BB',
            'AA0420EB00BB',
            // 0xEB-length frame whose record does not start with the 0x19 marker
            'AA2120EB00000000010023000000000000000000400000000208000000670091BB',
        ]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
        }
    })

    test('unknown phase code publishes the unknown fallback', () => {
        const p = feed([buf('AA2120EB0019FF00010023000000000000000000400000000208000000670091BB')])
        // an unmapped code maps to undefined, which the connection publishes as HA's unknown sentinel
        assert.equal(p.status, 'None')
    })

    // ── Course table, every code read off the appliance with the panel naming the cycle ─────────

    test('course codes decode to the panel names', () => {
        assert.equal(feed([NORMAL_TURBO_ON]).course, 'Normal')
        assert.equal(feed([EC_HEAVY_DUTY]).course, 'Heavy Duty')
        assert.equal(feed([DEEP_WASH_DIALLED]).course, 'Deep Wash')
        assert.equal(feed([SPIN_ONLY]).course, 'Spin Only')
        assert.equal(feed([PREWASH_NORMAL]).course, 'Pre Wash+Normal')
        assert.equal(feed([TUB_CLEAN]).course, 'Tub Clean')
    })

    test('the Downloaded position reports the smart course base cycle, not a code of its own', () => {
        // Whites is built on NORMAL, so the course byte reads Normal while the settings are Whites'
        const p = feed([WHITES_EXTRA_RINSE])
        assert.equal(p.course, 'Normal')
        assert.equal(p.temp, 'Hot')
        assert.equal(p.soil, 'Heavy')
    })

    // ── Option bits, each isolated by a single button press ─────────────────────

    test('a powered-off washer reports no cycle options, even ones the machine still holds', () => {
        // EB_IDLE has rec[15] bit 0x40 set: the appliance remembers Turbo Wash from the last cycle
        // while powered off, and reporting it verbatim shows "Turbo Wash on" next to a machine that
        // is off and has no cycle selected.
        const p = feed([EB_IDLE])
        assert.equal(p.status, 'Off')
        assert.equal(p.turbo_wash, 'OFF')
        assert.equal(p.course, 'Not selected')
    })

    test('turbo wash', () => {
        assert.equal(feed([NORMAL_TURBO_ON]).turbo_wash, 'ON')
        assert.equal(feed([DEEP_WASH_DIALLED]).turbo_wash, 'OFF')
    })

    test('water plus is distinguishable from simply selecting Deep Wash', () => {
        // both frames are course 0x19; they differ only in rec[16] bit 0x02
        const dialled = feed([DEEP_WASH_DIALLED])
        const pressed = feed([WATER_PLUS])
        assert.equal(dialled.course, pressed.course)
        assert.equal(dialled.water_plus, 'OFF')
        assert.equal(pressed.water_plus, 'ON')
    })

    test('extra rinse, stain care and soak', () => {
        assert.equal(feed([WHITES_EXTRA_RINSE]).extra_rinse, 'ON')
        assert.equal(feed([NORMAL_TURBO_ON]).extra_rinse, 'OFF')
        assert.equal(feed([STAIN_CARE]).stain_care, 'ON')
        assert.equal(feed([SOAK]).soak, 'ON')
        // Special Care selections are mutually exclusive on the appliance
        assert.equal(feed([STAIN_CARE]).soak, 'OFF')
        assert.equal(feed([SOAK]).stain_care, 'OFF')
    })

    test('control lock', () => {
        assert.equal(feed([CONTROL_LOCK]).child_lock, 'ON')
        assert.equal(feed([NORMAL_TURBO_ON]).child_lock, 'OFF')
    })

    test('the door locks during ordinary cycles, with remote start off', () => {
        // arming remote start also locks the lid, so this is what shows the two are independent
        // signals rather than one bit reported twice
        for (const f of [EC_HEAVY_DUTY, EC_SPIN_TO_COMPLETE]) {
            const p = feed([f])
            assert.equal(p.door_lock, 'ON')
            assert.equal(p.remote_start, 'OFF')
        }
    })

    test('remote start and door lock are separate bits', () => {
        const p = feed([REMOTE_START])
        assert.equal(p.remote_start, 'ON')
        assert.equal(p.door_lock, 'ON')
        assert.equal(feed([NORMAL_TURBO_ON]).remote_start, 'OFF')
        assert.equal(feed([NORMAL_TURBO_ON]).door_lock, 'OFF')
    })

    // ── Delay Wash is binary hours, not BCD ─────────────────────────────────────

    test('delay wash decodes 16 h as 16, not the 10 a BCD reading would give', () => {
        assert.equal(feed([DELAY_16H]).delay_wash, 16 * 60)
    })

    test('delay wash reaches the model JSON maximum of 19 h', () => {
        assert.equal(feed([DELAY_19H]).delay_wash, 19 * 60)
    })

    test('no delay set publishes 0', () => {
        assert.equal(feed([NORMAL_TURBO_ON]).delay_wash, 0)
    })

    test('a two-hour remaining estimate reads the hour byte', () => {
        // panel showed 2:06 on the Whites cycle
        assert.equal(feed([WHITES_EXTRA_RINSE]).remaining_time, 126)
    })

    // Home Assistant's MQTT integration swallows the exact payload 'None' (PAYLOAD_NONE) and renders the
    // entity as Unknown, so no label may ever be that string. This caught a real regression: Course,
    // Soil level and Temperature all showed Unknown in HA while Spin speed, labelled 'No Spin', worked.
    test('no published value uses the payload Home Assistant reserves', () => {
        for (const f of [EB_IDLE, EC_IDLE, NORMAL_TURBO_ON, WHITES_EXTRA_RINSE, SPIN_ONLY]) {
            for (const [prop, value] of Object.entries(feed([f]))) {
                assert.notEqual(value, 'None', `${prop} publishes the reserved 'None' payload`)
            }
        }
    })

    // ── Remote start command ────────────────────────────────────────────────────
    //
    // These two fixtures are the appliance's own status frames captured immediately before the LG app
    // started the machine, and the expected bytes are the commands the LG cloud actually sent in
    // response. If the driver builds the same bytes from the same state, it is doing what the app does.

    // Armed on Normal: turbo on (f15=0x44 incl. door lock), no options set.
    const NORMAL_ARMED = buf(
        'AA3C20EC001901003B003A0100030304000000004000010000000000006400001901003B003A010003030400000000440001000000000000640021BB',
    )
    // Armed on Deep Wash with Extra Rinse: rinse=0x02, o16=0x11, rec[17]=0x01 (armed).
    const DEEPWASH_ARMED = buf(
        'AA3C20EC001901011200391900030204020000000011000000000000006400001901011200391900030204020000000011010000000000006400A4BB',
    )

    test('start button reproduces the command the LG app sent, byte for byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL_ARMED)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa15f02601030304000000000000000040000376bb'],
        )
    })

    test('start command carries the rinse setting and the opt2 byte verbatim', () => {
        // the Extra Rinse capture: offset 6 = rinse 0x02, offset 15 = 0x11 (extra rinse + the
        // turbo-supported bit). Rebuilding offset 15 from individual flags would drop the 0x10.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', DEEPWASH_ARMED)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa15f02619030204020000000000000000110358bb'],
        )
    })

    test('the door-lock bit is never echoed back into the command', () => {
        // NORMAL_ARMED has f15=0x44; the cloud sent 0x40
        const { thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL_ARMED)
        dev.setProperty('start', 'PRESS')
        const inner = thinq.outbox[0].subarray(2, thinq.outbox[0].length - 2)
        assert.equal(inner[14], 0x40)
    })

    test('start is not gated in software — the appliance enforces its own arming', () => {
        // EB_IDLE has rec[17]=0: remote start is not armed, and the washer ignores a start in that
        // state. rethink does not add a lockout on top of the one the appliance already has; the
        // button is declared unavailable in HA, which is a UI hint rather than an enforcement point.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', EB_IDLE)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
    })

    test('start refuses before any status frame has been seen', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [])
    })

    test('the button is declared unavailable unless remote start is armed', () => {
        const { ha } = makeDevice()
        const c = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(c.start.platform, 'button')
        assert.deepEqual(c.start.availability, [
            { topic: '$this/remote_start', payload_available: 'ON', payload_not_available: 'OFF' },
        ])
    })

    test('pause sends the command the LG app sent to pause', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL_ARMED)
        dev.setProperty('pause', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa09f02404010099bb'],
        )
    })

    test('pressing start while Paused resumes with verb 0x01, not a fresh start', () => {
        // EC_PAUSED is a real capture with phase 0x02. Resume must not be gated on remote start being
        // armed — the cycle is already running, merely suspended.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', EC_PAUSED)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
        const inner = thinq.outbox[0].subarray(2, thinq.outbox[0].length - 2)
        assert.equal(inner[16], 0x01, 'verb is resume')
        assert.equal(inner[0], 0xf0)
        assert.equal(inner[1], 0x26)
    })

    test('an unknown property sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL_ARMED)
        dev.setProperty('nonsense', 'PRESS')
        assert.deepEqual(thinq.outbox, [])
    })

    // ── Smart / downloaded courses ──────────────────────────────────────────────
    //
    // Real frames captured while changing the downloaded cycle in the LG app, each labelled by the name
    // the app showed. rec[21] (active) and rec[24] (slot) both carry the code while the dial sits on
    // Downloaded. The course byte independently corroborates each one by moving to that smart course's
    // declared base cycle.

    const DL_CURTAINS = buf(
        'AA3C20EC0019010132013102000502050000000040200000000078000078010019010100003B0800010204000000000000000000006B00006B005EBB',
    )
    const DL_SMALL_LOAD = buf(
        'AA3C20EC001901001D001D0700010302000000004000000000006500006500001901003B003A0100010204000000004000000000006400006400A9BB',
    )
    const DL_SWEAT_STAINS = buf(
        'AA3C20EC001901003B003A01000102040000000040000000000064000064000019010130012F02000303040000000040200000000069000069011EBB',
    )
    const DL_SWIMWEAR = buf(
        'AA3C20EC0019010130012F0200030304000000004020000000006900006901001901010F010E0400010102020000000001000000006A00006A0091BB',
    )

    test('smart course codes decode to the names the LG app showed', () => {
        assert.equal(feed([DL_CURTAINS]).smart_course, 'Curtains')
        assert.equal(feed([DL_SMALL_LOAD]).smart_course, 'Small Load')
        assert.equal(feed([DL_SWEAT_STAINS]).smart_course, 'Sweat Stains')
        assert.equal(feed([DL_SWIMWEAR]).smart_course, 'Swimwear')
    })

    test('each smart course reports its declared base cycle in the course byte', () => {
        // this is what makes the codes cross-checked rather than merely recorded
        assert.equal(feed([DL_CURTAINS]).course, 'Bedding')
        assert.equal(feed([DL_SMALL_LOAD]).course, 'Normal')
        assert.equal(feed([DL_SWEAT_STAINS]).course, 'Heavy Duty')
        assert.equal(feed([DL_SWIMWEAR]).course, 'Delicates')
    })

    test('the downloaded slot is reported separately from the active smart course', () => {
        assert.equal(feed([DL_SWIMWEAR]).downloaded_course, 'Swimwear')
    })

    test('no smart course engaged reports Not selected, not unknown', () => {
        // EC_HEAVY_DUTY predates the Downloaded position being used; rec[21] is 0
        assert.equal(feed([EC_HEAVY_DUTY]).smart_course, 'Not selected')
    })

    test('a smart course is distinguishable from its base cycle', () => {
        // both report course Normal; only smart_course separates them
        const whites = feed([WHITES_EXTRA_RINSE])
        const plain = feed([NORMAL_TURBO_ON])
        assert.equal(whites.course, plain.course)
        assert.notEqual(whites.smart_course, plain.smart_course)
    })

    // Expected bytes are the frame the LG cloud actually sent, copied from the capture rather than
    // computed by hand.
    test('power off sends the command the LG app sent', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL_ARMED)
        dev.setProperty('power_off', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa09f0240101009cbb'],
        )
    })

    test('power off is not gated on remote start being armed', () => {
        // EB_IDLE has rec[17]=0, which blocks start; stopping must still work
        const { thinq, dev } = makeDevice()
        thinq.emit('data', EB_IDLE)
        dev.setProperty('power_off', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
    })

    test('No Spin is reported only as a real selection, not as the powered-off value', () => {
        // EB_IDLE is powered off with the spin byte at 0; SPIN_ONLY is running with spin High
        assert.equal(feed([EB_IDLE]).spin, 'Not selected')
        assert.equal(feed([SPIN_ONLY]).spin, 'High')
    })

    test('power is not declared as a running sensor', () => {
        // the byte is phase != Off, which is "switched on", not "a cycle is running" — it goes ON at
        // power-up before anything starts, so device_class 'running' would render it as Running while
        // the machine sits idle
        const { ha } = makeDevice()
        const c = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(c.power.device_class, undefined)
        assert.equal(c.power.name, 'Power')
    })
})
