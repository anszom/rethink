import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13U6AM8W_D_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13U6AM8W_D_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LG DLE7300WE', swVersion: '1.0' }

// Packet layout: AA <len> <inner> <cksum> BB  (len = total packet length)
// processAABB receives inner = raw.subarray(2, raw.length - 2)
// inner = 3-byte header + stacked 0x1b-marked records; the LAST record is the current state.
// 0xEC carries a 29-byte old record then the 28-byte current one; 0xEB carries the current one alone.
//
// Every fixture below is a real frame captured from this appliance.

// Post-reconnect 0xEB snapshot: Initial, 1 minute.
const EB_RECONNECT = buf('AA2330EB001B010001000100000000000100000000A8000000000000006400000046BB')

// Heavy Duty mid-cycle. dryLevel 3 / temp 5 are exactly the DRYLEVEL_NORMAL / TEMP_HIGH defaults this
// model's JSON declares for HEAVYDUTY, which is what pins those two offsets on this model rather than
// on its RV13B6* relatives.
const EC_HEAVY_DUTY = buf(
    'AA4030EC001B320036003601000305000100000000A90000000100000064000000001B320035003601000305000100000000A90000530100000064000000AFBB',
)

// Time Dry being set up: the old record still shows temp 5 (High, the course default), the current one
// shows temp 1 (Ultra Low) — the temperature button had just been pressed and wrapped around.
const EC_TIME_DRY_SETUP = buf(
    'AA4030EC001B010014001412000005010100000040A80000000000000064000000001B010014001412000001010100000000A8000000000000006400000001BB',
)

// Captured just after resuming from a deliberate pause: old record Paused, current record Drying.
const EC_RESUMED = buf(
    'AA4030EC001B030012001412000002010100000040A80000743200000064000000001B320012001412000002010100000000A900007403000000640000000ABB',
)

// Time Dry 60 min, paused FROM THE LG APP mid-run (29 min left, Wrinkle Care engaged). Two things it
// pins: the record is Paused with rec[16] bit 0x01 still SET — an app pause does not disarm remote
// control, unlike the panel pause in EC_RESUMED's old record — and it is the state the app built its
// resume command from, which is what makes the byte-for-byte comparison below meaningful.
const LIVE_APP_PAUSE = buf(
    'AA4030EC001B32001D010012000005050100000010A900007903000000CA000000001B03001D010012000005050100000050A900007D32000000CA0000000DBB',
)

// The same load ten minutes later, paused AT THE PANEL: byte-for-byte the same situation as
// LIVE_APP_PAUSE except rec[16] drops to 0xa8. That is the A/B that says the bit tracks the remote
// CONTROL SESSION rather than the cycle — touching the panel drops it, and it came straight back to
// 0xa9 when the panel resumed the run.
const LIVE_PANEL_PAUSE = buf(
    'AA4030EC001B320013010012000005050100000010A90000A203000000CA000000001B030013010012000005050100000050A80000A532000000CA000000C1BB',
)

// The tail of that same load: Drying -> Cooling, 4 minutes left, remote start still set. This is the
// frame that retires the heater theory for rec[16] bit 0x01 — on a gas dryer the burner is off through
// Cooling, so a heat bit could not read 1 here.
const LIVE_COOLING = buf(
    'AA4030EC001B330005010012000005050100000010A90000DB32000000CA000000001B330004010012000005050100000010A90000DF32000000CA0000005EBB',
)

// End of that load, and the Wrinkle Care tumble that follows it 30 seconds later — the first capture of
// phase 0x38 from this appliance, which until now was mapped from the sibling handlers alone. Wrinkle
// Care was engaged at rec[15] 0x10 for the whole run, so this is what that option actually does at the
// end of a cycle. Note rec[16] bit 0x01 drops at End and returns for the tumble, with nobody near the
// panel: the machine tears the remote session down when the cycle finishes and builds a new one for the
// new program. An automation watching remote_start sees it blink.
const LIVE_END = buf(
    'AA4030EC001B330001010012000005050100000010A90000EB32000000CA000000001B040001010112000005050100000050A80000EF33000000CA00000063BB',
)
const LIVE_WRINKLE_CARE = buf(
    'AA4030EC001B040001010112000005050100000050A80000EF33000000CA000000001B380001000112000005050100000050A90000EF04000000CA00000004BB',
)

// The door opened during that Wrinkle Care tumble, which ended it. Nothing in the record says "door":
// the phase simply goes to Off with pre_state 0x38, matching the model JSON declaring no doorClose
// field. rec[15] carries the drum light in the outgoing record and not in the current one, which is the
// lamp doing what a lamp does, not a door bit.
const LIVE_DOOR_OPENED = buf(
    'AA4030EC001B000001000100000000000100000040A80000F038000000CA000000001B000001000100000000000100000000A80000F038000000CA000000E3BB',
)

// Powered off mid-cycle: THREE stacked records. The previous exact-60-byte length check dropped this
// frame outright, so switching the dryer off left Home Assistant showing Drying until the next
// reconnect. The last record is the one that says Off.
const EC_POWER_OFF = buf(
    'AA4030EC001B320012001412000002010100000000A900007403000000640000000F001412000002010100000000A900009F0300000064000000001B00000F000F00000000000100000040A80000A13200000064000000C1BB',
)

// Cooldown, from a capture the logger truncated mid-frame. Worth keeping as a fixture because the
// tail-of-frame rule still decodes it; the old fixed-length checks ignored it entirely.
const EC_COOLING_TRUNCATED = buf('AA4030EC001B330001010301000305000100000040A8000BFD33000000640000000BBB')

// Two consecutive live status frames, one minute apart, from a Time Dry run. They are the proof that
// the LAST record is the current state: frame 1's second record (53 min) reappears as frame 2's FIRST
// record. Reading the first record publishes every value one update late.
const LIVE_54_53 = buf(
    'AA4030EC001B320036010012000005050100000000A900001701000000CA000000001B320035010012000005050100000000A900001B01000000CA00000034BB',
)
const LIVE_53_52 = buf(
    'AA4030EC001B320035010012000005050100000000A900001B01000000CA000000001B320034010012000005050100000000A900001F01000000CA00000032BB',
)

// Device identity/serial frame (0x31), sent once per reconnect.
const IDENTITY = buf(
    'AA3730310201534141333839363434323600002DF000008000000000000253414133383936343331300000AEAD000040000000000020BB',
)

// ── Live capture, 2026-09-07: one-button option pass on the appliance, each frame labelled by what the
// control panel showed. Every fixture's SECOND record is the state after the press. ─────────────────

const ANTI_BAC = buf(
    'AA4030EC001B010029002903000304000100000040A800000000000000CA000000001B01010A010A030005050001000000C0A800000000000000CA000000F6BB',
)
const WRINKLE = buf(
    'AA4030EC001B01010A010A03000505000100000080A800000000000000CA000000001B01010A010A03000505000100000090A800000000000000CA0000002FBB',
)
const DRUM_LIGHT = buf(
    'AA4030EC001B01010A010A03000505000100000090A800000000000000CA000000001B01010A010A030005050001000000D0A800000000000000CA0000009FBB',
)
const CHILD_LOCK = buf(
    'AA4030EC001B010029002903000304000100000018A800000000000000CA000000001B010029002903000304000100000019A800000000000000CA00000058BB',
)
const DAMP_DRY = buf(
    'AA4030EC001B010029002903000304000100000010A800000000000000CA000000001B010029002903000304000100000018A800000000000000CA00000051BB',
)
const SIG_HIGH = buf(
    'AA4030EC001B010029002903000304000100000018A800000000000000CA000000001B010029002903000304000400000018A800000000000000CA0000005ABB',
)
const ML_MINUS5 = buf(
    'AA4030EC001B010019001910000005000000000000A800000000000000CA000000001B0100140014100000050000FB000000A800000000000000CA000000F4BB',
)
const ML_PLUS5 = buf(
    'AA4030EC001B010019001910000005000000000000A800000000000000CA000000001B01001E001E10000005000005000000A800000000000000CA000000EABB',
)
const TIMEDRY_60 = buf(
    'AA4030EC001B010032003212000005040000000000A800000000000000CA000000001B010100010012000005050000000000A800000000000000CA000000EABB',
)
const REMOTE_ON = buf(
    'AA4030EC001B010028002812000005030000000000A800000000000000CA000000001B010028002812000005030000000000A900000000000000CA000000A2BB',
)

// Downloaded-slot changes made from the LG app, each labelled by the name the app showed. rec[21]
// (active) and rec[24] (slot) both carry the code with the dial on Downloaded; the cycle byte reports
// that smart course's declared BASE cycle, several of which exist nowhere on the dial.

const DL_BEDDING_CURTAINS = buf(
    'AA4030EC001B010029002903000303000100000010A800000000CA0000CA000000001B010105010507000503000100000000A80000000073000073000000C5BB',
)
const DL_BLANKETS = buf(
    'AA4030EC001B010014001412000001010100000000A8000000006D00006D000000001B01012301230E000503000100000000A8000000006C00006C00000089BB',
)
const DL_ECONODRY = buf(
    'AA4030EC001B01001E001E03000103000100000000A800000000C90000C9000000001B010103010303000303000100000000AA00000000CB0000CB0000005BBB',
)
const DL_SOCKS = buf(
    'AA4030EC001B01003200320D000302000100000000A8000000006E00006E000000001B010023002312000005020105000000A800000000710000710000007DBB',
)
const DL_SUPER_DRY = buf(
    'AA4030EC001B010023002312000005020105000000A80000000071000071000000001B01003B003B1A000505000100000000A800000000640000640000006DBB',
)
const DL_ULTRA_DELICATES = buf(
    'AA4030EC001B01003B003B1A000505000100000000A80000000064000064000000001B01001E001E06000301000100000000A800000000680000680000005DBB',
)

// Custom PGM pressed on Normal — recovered from rethink's own packet log after the capture had stopped.
const CUSTOM_PGM = buf(
    'AA4030EC001B010103010303000304000100000000AA00000000000000CA000000001B010103010303000304000100000020AA00000000000000CA00000039BB',
)

// Armed on Normal, captured immediately before the LG app started the dryer. The expected command
// bytes in the tests below are the frame the LG cloud actually sent in response.
const ARMED_NORMAL = buf(
    'AA4030EC001B010103010303000304000100000040AA00000000000000CA000000001B010103010303000304000100000040AB00000000000000CA00000098BB',
)

// Armed on Time Dry at 60 minutes. Capturing a start on a SECOND cycle is what pinned the command
// layout: on Normal the course, the dry level and offset 17 all read 0x03, leaving three separate
// fields indistinguishable.
const ARMED_TIME_DRY = buf(
    'AA4030EC001B010100010012000005050100000040A800000000000000CA000000001B010100010012000005050100000040A900000000000000CA000000B4BB',
)

// Armed on Normal with Wrinkle Care engaged. rec[15]=0x50 (wrinkle care + drum light) and the app's
// start carried 0x10 at offset 9 — the option bits with the drum light stripped out.
const ARMED_WRINKLE = buf(
    'AA4030EC001B010103010303000304000100000050AA00001300000000CA000000001B010103010303000304000100000050AB00001300000000CA00000046BB',
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
        for (const c of [
            'status',
            'pre_state',
            'remaining_time',
            'initial_time',
            'power',
            'remote_start',
            'child_lock',
            'wrinkle_care',
            'anti_bacterial',
            'damp_dry_signal',
            'energy_saver',
            'drum_light',
            'signal',
            'time_dry',
            'more_less_time',
            'cycle',
            'temp',
            'dry_level',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // free text, so an unmapped phase code can publish 'unknown' without HA rejecting it
        assert.equal(components.status.device_class, undefined)
        assert.equal(components.status.options, undefined)
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

    test('consecutive live frames decode as a clean one-minute countdown', () => {
        // frame 1's current record is 53; if the first record were used, this frame would report 54
        assert.equal(feed([LIVE_54_53]).remaining_time, 53)
        assert.equal(feed([LIVE_53_52]).remaining_time, 52)
    })

    test("each frame's first record repeats the previous frame's second one", () => {
        // the structural claim behind the line above, asserted on the bytes themselves
        const first = LIVE_54_53.subarray(2, LIVE_54_53.length - 2)
        const second = LIVE_53_52.subarray(2, LIVE_53_52.length - 2)
        assert.deepEqual(first.subarray(32), second.subarray(3, 31))
    })

    test('a cycle ending into Wrinkle Care walks Cooling -> End -> 0x38 on live traffic', () => {
        // One load, captured end to end. `pre_state` is what makes End usable: the dryer drops to Off
        // once a finished cycle times out, so "the laundry is done" survives only as the previous state.
        const end = feed([LIVE_END])
        assert.equal(end.status, 'End')
        assert.equal(end.pre_state, 'Cooling')
        assert.equal(end.remote_start, 'OFF')

        const wc = feed([LIVE_WRINKLE_CARE])
        assert.equal(wc.status, 'Wrinkle Care')
        assert.equal(wc.pre_state, 'End')
        assert.equal(wc.wrinkle_care, 'ON') // the option that caused it, still set at rec[15] 0x10
        assert.equal(wc.remote_start, 'ON') // a fresh session for the tumble, with nobody at the panel

        // Opening the door ends the tumble outright — no Paused, no return to End. The dryer reports
        // Off, and the only trace of what it was doing is pre_state. Anything that treats
        // status=Off + pre_state=End as "load finished" has to accept Wrinkle Care as well, or a load
        // that ended this way looks like a machine that was never used.
        const door = feed([LIVE_DOOR_OPENED])
        assert.equal(door.status, 'Off')
        assert.equal(door.pre_state, 'Wrinkle Care')
        assert.equal(door.power, 'OFF')
    })

    test('resuming from pause reports Drying, not the pause it just left', () => {
        const p = feed([EC_RESUMED])
        assert.equal(p.status, 'Drying')
        assert.equal(p.remaining_time, 18)
    })

    test('power-off mid-cycle is decoded instead of dropped', () => {
        const p = feed([LIVE_54_53, EC_POWER_OFF])
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
    })

    test('truncated cooling frame still decodes', () => {
        const p = feed([EC_COOLING_TRUNCATED])
        assert.equal(p.status, 'Cooling')
    })

    // ── Previous state ────────────────────────────────────────────────────────

    test('pre_state names the phase the dryer just left', () => {
        assert.equal(feed([EC_RESUMED]).pre_state, 'Paused') // now Drying
        assert.equal(feed([LIVE_54_53]).pre_state, 'Initial') // running since it was started
    })

    test('a load switched off mid-cycle still shows what it was doing', () => {
        const p = feed([EC_POWER_OFF])
        assert.equal(p.status, 'Off')
        assert.equal(p.pre_state, 'Drying')
    })

    // ── Times are [hour][minute] pairs ────────────────────────────────────────

    test('initial time estimate reads the hour byte', () => {
        // 01 00 — one hour, which the previous minute-byte-only decode reported as 0
        assert.equal(feed([LIVE_54_53]).initial_time, 60)
    })

    test('initial time pins while remaining time counts down', () => {
        const a = feed([LIVE_54_53])
        const b = feed([LIVE_53_52])
        assert.equal(a.initial_time, b.initial_time)
        assert.equal((a.remaining_time as number) - (b.remaining_time as number), 1)
    })

    // ── Settings ──────────────────────────────────────────────────────────────

    test('a powered-off dryer reports no cycle rather than an unknown one', () => {
        assert.equal(feed([EC_POWER_OFF]).cycle, 'Not selected')
    })

    test('Heavy Duty capture decodes its own declared defaults', () => {
        const p = feed([EC_HEAVY_DUTY])
        assert.equal(p.cycle, 'Heavy Duty')
        assert.equal(p.dry_level, 'Normal')
        assert.equal(p.temp, 'High')
    })

    test('Time Dry has no dry level, and the current record carries the newly pressed temperature', () => {
        const p = feed([EC_TIME_DRY_SETUP])
        assert.equal(p.cycle, 'Time Dry')
        assert.equal(p.dry_level, 'Not selected')
        assert.equal(p.temp, 'Ultra Low')
    })

    // rec[16] bit 0x01 was published as `drum_running` until it was tested directly on the appliance:
    // it sets when Remote Start is armed, observed four times while the dryer sat idle in Initial, which
    // no drum bit could do. It is nonetheless set through every Drying frame — not because those cycles
    // happened to be started remotely, but because the appliance arms itself for the length of any run.
    // A panel-started cycle that was never armed by hand reports it ON too, and can be paused and
    // resumed from the LG app.
    test('remote start is read from rec[16] bit 0x01', () => {
        assert.equal(feed([EC_HEAVY_DUTY]).remote_start, 'ON')
        assert.equal(feed([LIVE_54_53]).remote_start, 'ON')
        assert.equal(feed([EB_RECONNECT]).remote_start, 'OFF')
        assert.equal(feed([EC_POWER_OFF]).remote_start, 'OFF')
        // Cooling does not decide it either way: this frame reads clear and LIVE_COOLING, from a load
        // driven entirely from the app, reads set through the same phase. What separates them is
        // whether anyone had touched the panel, which is the whole point of the bit.
        assert.equal(feed([EC_COOLING_TRUNCATED]).remote_start, 'OFF')
        assert.equal(feed([LIVE_COOLING]).remote_start, 'ON')
    })

    // ── Frames that must publish nothing ──────────────────────────────────────

    test('non-status frames, washer frames and unmarked records are ignored', () => {
        for (const junk of [
            IDENTITY,
            // heartbeat and ping
            buf('aa0730d82b91bb'),
            buf('aa09307200c80048bb'),
            // a washer 0xEB frame
            buf('AA2120EB00190000010023000000000000000000400000000208000000670091BB'),
            // 0xEB-length frame whose record does not start with the 0x1b marker
            buf('AA2330EB0000010001000100000000000100000000A8000000000000006400000046BB'),
            // A real 0xE2 idle snapshot, one of nine the dryer burst out seconds apart when the door
            // was opened during Wrinkle Care. It is 0x1b-marked and exactly record-length, so it walks
            // straight through the marker and length checks — only the frame-type filter stops it. Its
            // record reads phase 0x32 with 1:00 on the clock, so decoding it would have announced a
            // fresh 60-minute Drying cycle on a dryer standing open with the load finished.
            buf('AA2330E2031B320100010012000005050100000010A80000F001000000CA00000094BB'),
        ]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', junk)
            assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
        }
    })

    test('unknown phase code publishes the unknown fallback', () => {
        const p = feed([buf('AA2330EB001BFF0001000100000000000100000000A8000000000000006400000046BB')])
        // an unmapped code maps to undefined, which the connection publishes as HA's unknown sentinel
        assert.equal(p.status, 'None')
    })

    // Home Assistant's MQTT integration swallows the exact payload 'None' (PAYLOAD_NONE) and renders the
    // entity as Unknown, so no label may ever be that string. This caught a real regression: Course,
    // Soil level and Temperature all showed Unknown in HA while Spin speed, labelled 'No Spin', worked.
    test('no published value uses the payload Home Assistant reserves', () => {
        for (const f of [EB_RECONNECT, EC_POWER_OFF, EC_HEAVY_DUTY, EC_TIME_DRY_SETUP]) {
            for (const [prop, value] of Object.entries(feed([f]))) {
                assert.notEqual(value, 'None', `${prop} publishes the reserved 'None' payload`)
            }
        }
    })

    // ── Option bits, each isolated by a single press on the appliance ───────────

    test('option bits decode to what the panel showed', () => {
        assert.equal(feed([ANTI_BAC]).anti_bacterial, 'ON')
        assert.equal(feed([WRINKLE]).wrinkle_care, 'ON')
        assert.equal(feed([DRUM_LIGHT]).drum_light, 'ON')
        assert.equal(feed([CHILD_LOCK]).child_lock, 'ON')
        assert.equal(feed([DAMP_DRY]).damp_dry_signal, 'ON')
        assert.equal(feed([REMOTE_ON]).remote_start, 'ON')
    })

    test('wrinkle care is read from rec[15], the position the two siblings disagree on', () => {
        // RV13B6BSD puts it at rec[16] bit 0x10, which is never set here — inheriting that would
        // publish Wrinkle Care as permanently OFF
        const p = feed([WRINKLE])
        assert.equal(p.wrinkle_care, 'ON')
        assert.equal(p.anti_bacterial, 'ON') // 0x80 still set alongside it
    })

    test('the drum light is a real toggle, not a panel-awake artifact', () => {
        // RV13B6BSD documents rec[15] 0x40 as a panel-state artifact; pressing Drum Light sets it
        assert.equal(feed([DRUM_LIGHT]).drum_light, 'ON')
        assert.equal(feed([WRINKLE]).drum_light, 'OFF')
    })

    test('signal volume', () => {
        assert.equal(feed([SIG_HIGH]).signal, 'High')
        assert.equal(feed([CHILD_LOCK]).signal, 'Low')
        assert.equal(feed([ML_PLUS5]).signal, 'Off')
    })

    test('more/less time is signed', () => {
        // 0xfb read unsigned is 251; the cycle was shortened by five minutes
        assert.equal(feed([ML_MINUS5]).more_less_time, -5)
        assert.equal(feed([ML_PLUS5]).more_less_time, 5)
    })

    test('time dry duration', () => {
        const p = feed([TIMEDRY_60])
        assert.equal(p.time_dry, '60 min')
        assert.equal(p.cycle, 'Time Dry')
        assert.equal(p.remaining_time, 60) // 01 00 — the hour byte
    })

    // ── Smart courses and the hidden base cycles behind them ────────────────────

    test('smart course codes decode to the names the LG app showed', () => {
        assert.equal(feed([DL_BEDDING_CURTAINS]).smart_course, 'Bedding/Curtains')
        assert.equal(feed([DL_BLANKETS]).smart_course, 'Blankets')
        assert.equal(feed([DL_ECONODRY]).smart_course, 'EconoDry Small Load')
        assert.equal(feed([DL_SOCKS]).smart_course, 'Socks')
        assert.equal(feed([DL_SUPER_DRY]).smart_course, 'Super Dry')
        assert.equal(feed([DL_ULTRA_DELICATES]).smart_course, 'Ultra Delicates')
    })

    test('smart courses expose base cycles that are not on the dial', () => {
        // none of these can be selected from the panel; they exist only behind a smart course
        assert.equal(feed([DL_BLANKETS]).cycle, 'Jumbo Dry') // 0x0e
        assert.equal(feed([DL_SUPER_DRY]).cycle, 'Super Dry') // 0x1a
        assert.equal(feed([DL_ULTRA_DELICATES]).cycle, 'Ultra Delicates') // 0x06
    })

    test('each smart course carries its declared settings', () => {
        // Socks: TIMEDRY base, no dry level, High, 30 min + 5 = the 35 the panel showed
        const socks = feed([DL_SOCKS])
        assert.equal(socks.cycle, 'Time Dry')
        assert.equal(socks.time_dry, '30 min')
        assert.equal(socks.more_less_time, 5)
        assert.equal(socks.temp, 'High')
        // EconoDry is the one smart course declaring ENERGYSAVER_ON
        assert.equal(feed([DL_ECONODRY]).energy_saver, 'ON')
        assert.equal(feed([DL_SOCKS]).energy_saver, 'OFF')
    })

    test('the downloaded slot is reported separately from the active smart course', () => {
        assert.equal(feed([DL_SUPER_DRY]).downloaded_course, 'Super Dry')
    })

    test('no smart course engaged reports Not selected', () => {
        assert.equal(feed([EC_HEAVY_DUTY]).smart_course, 'Not selected')
    })

    test('custom pgm is its own bit', () => {
        assert.equal(feed([CUSTOM_PGM]).custom_pgm, 'ON')
        assert.equal(feed([WRINKLE]).custom_pgm, 'OFF')
    })

    // ── Commands ────────────────────────────────────────────────────────────────

    test('start reproduces the command the LG app sent, byte for byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_NORMAL)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0260300000400000000430003000000000300000000007ebb'],
        )
    })

    test('start on a second cycle also reproduces the app command byte for byte', () => {
        // Time Dry 60 min: carries timeDry=0x05 at offset 8 and dryLevel=0x00 at 17, both of which the
        // Normal capture alone could not distinguish.
        //
        // This differs from the app's own frame at ONE byte, offset 19: the panel showed 60 minutes
        // with no More/Less adjustment (rec[12]=0), while the LG app was showing 40 and sent 0xec
        // (-20) to match. The cycle ran 40 — whichever side issues the start decides, and the app
        // sends its own view rather than reading the panel's. This driver sends what the APPLIANCE
        // reports, so pressing Start in Home Assistant runs what is set on the machine.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_TIME_DRY)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0261200000500000500410012000000000000000000001fbb'],
        )
    })

    test('start carries the option bits, with the drum light stripped', () => {
        // rec[15]=0x50 (wrinkle care + drum light); the app sent 0x10 at offset 9. The drum light is a
        // lamp, not a cycle setting, and the appliance is not asked to reproduce it.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_WRINKLE)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0260300000400000010430003000000000300000000006ebb'],
        )
    })

    test('pressing start while Paused resumes, reproducing the app resume byte for byte', () => {
        // Captured live: the app paused a running Time Dry and resumed it 15 seconds later. Its resume
        // differs from a start at exactly one byte — offset 10 is 0x01, not 0x41 — and the cycle picked
        // up at 29 minutes rather than restarting. Sending a start packet here would have re-run the
        // whole 60 minutes, which on a gas dryer is a real bill, not a cosmetic bug.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', LIVE_APP_PAUSE)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa1bf0261200000500000510010012000000000000000000004fbb'],
        )
    })

    test('a panel pause still resumes, though it reports remote start OFF', () => {
        // Both frames are the same load paused 10 minutes apart — from the app, then at the panel. The
        // panel one clears rec[16] bit 0x01, so gating the Start button on remote_start would have made
        // Home Assistant refuse to resume in exactly the case a human is standing there wanting it.
        assert.equal(feed([LIVE_APP_PAUSE]).remote_start, 'ON')
        assert.equal(feed([LIVE_PANEL_PAUSE]).remote_start, 'OFF')
        assert.equal(feed([LIVE_PANEL_PAUSE]).status, 'Paused')

        const { thinq, dev } = makeDevice()
        thinq.emit('data', LIVE_PANEL_PAUSE)
        dev.setProperty('start', 'PRESS')
        const inner = thinq.outbox[0].subarray(2, thinq.outbox[0].length - 2)
        assert.equal(inner[10], 0x01, 'resume, not a fresh start')
    })

    test('the same appliance state, not Paused, starts instead of resuming', () => {
        // ARMED_TIME_DRY is the identical cycle sitting armed at Initial: same course, temp and Time Dry
        // minutes, so the ONLY difference from the resume above is the 0x40 bit at offset 10.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_TIME_DRY)
        dev.setProperty('start', 'PRESS')
        const inner = thinq.outbox[0].subarray(2, thinq.outbox[0].length - 2)
        assert.equal(inner[10], 0x41)
    })

    test('pause and power off are byte-identical to the washer commands', () => {
        // the 0xF024 action family is shared across both appliances; only 0xF026 differs
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ARMED_NORMAL)
        dev.setProperty('pause', 'PRESS')
        dev.setProperty('power_off', 'PRESS')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa09f02404010099bb', 'aa09f0240101009cbb'],
        )
    })

    test('start is not gated in software — the appliance enforces its own arming', () => {
        // EB_RECONNECT has rec[16] bit 0x01 clear, so the dryer ignores a start. rethink does not
        // duplicate that lockout, and it no longer declares the button unavailable either — stacking a
        // second interlock on the appliance's own is what CONTRIBUTING rules out.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', EB_RECONNECT)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
    })

    test('power off is not gated on remote start', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', EB_RECONNECT)
        dev.setProperty('power_off', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
    })
})
