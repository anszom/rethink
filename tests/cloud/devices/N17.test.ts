import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/N17'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'N17'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// REAL frames, taken from a deployed instance's log (firmware clip_bkn_v1.9.226). Both validate against
// this repo's AABB checksum. The pair spans a genuine change: 0 Wh from boot, then 2 Wh with delta and accumulated
// moving together and the sequence byte stepping 0x00 -> 0x01 alongside them.
const STATISTICS_ZERO = buf('aa0b323e000000000070bb')
const STATISTICS_TWO_WH = buf('aa0b323e00020002017fbb')

// REAL, from the 2026-08-22 wash: the appliance's unsolicited 0xEC change report,
// captured mid-cycle. Two stacked 0x1D records — previous (1:03 remaining) then current (1:02) — in a
// 2h33m cycle whose course time and countdown matched the LG app to the minute.
const EC_REAL_RUNNING = buf(
    'aa4432ec001d0202000221010001030000540002008946640000004000010102030500001d020200022101000102000054000200894664000000400001010203050012bb',
)

// REAL, same wash, 05:24:01Z — the moment the door auto-opened for drying. The LG app at that minute
// read "Drying, 00:25 left" with a "Door is open." banner, which labels the process byte's 0x04 and
// re-confirms the door bit. Previous record: door still closed; current record: door open — so the
// door assertion below also re-pins that the current record wins.
const EC_REAL_DRYING_DOOR_OPEN = buf(
    'aa4432ec001d020400022101000019000054000200894e640000004000010102030500001d020400022101000019000056000200894e640000004000010102030500ddbb',
)

// REAL, same wash, 05:48:20Z — the completion instant. Previous record: still Drying with one
// minute on the clock; current record: state and process both 0x05. ~30 s later the appliance dropped to Standby and cleared the course.
const EC_REAL_COMPLETE = buf(
    'aa4432ec001d020400022101000001000056000200894e640000004000010102030500001d050500022101000001000056000200894e6400000040000101020305000bbb',
)

// REAL, 2026-08-23 02:15:58Z — a remote start of "mode Turbo, option Extra Dry on".
// The panel had AUTO (0x01) selected and the command carried course 0x04, so the current record here
// is what pins 0x04 = TURBO: commanded and selected differed, and the command won. Options byte 0x04
// is the Extra Dry bit, labelled by the same start.
const EC_REAL_TURBO_EXTRA_DRY = buf(
    'aa4432ec001d0100000221010002210000540002008b46640000004000010102030500001d020200021d0400021d0000540402008b46640000004000010102030500d3bb',
)

// REAL, 2026-08-23 02:21:39Z — the companion start, labelled "mode Heavy, High Temp on". Options byte
// 0x08 with Extra Dry deselected is what separates the two option bits; the previous record still
// carries the cancelled Turbo wash's course 0x04 and options 0x04, so this frame also re-pins that the
// command overrides whatever the panel was holding.
const EC_REAL_HEAVY_HIGH_TEMP = buf(
    'aa4432ec001d010000021d0400021d0000540402008b46640000004000010102030500001d0202000324020003240000540802008b46640000004000010102030500c2bb',
)

// REAL, 2026-08-23 02:27:34Z — an 11-hour delayed Normal wash starting from the panel. State goes to
// 0x02 Running with process 0x01 while the delay counts down, and i9/i10 hold 0x0B 0x00 = 11:00. This
// is the state in which "cancel" has to mean power-off rather than drain.
const EC_REAL_DELAYED_START = buf(
    'aa4432ec001d010000021c0500021c0b00560102008946640000004000010102030500001d020100021c0500021c0b00540102008946640000004000010102030500c5bb',
)

// REAL, 2026-08-23 03:04:27Z — a "Normal with Steam" remote start. Options byte 0x80 is
// steam. Note the course time: 0x03 0x2B = 3:43, against plain
// Normal's 2:28, so steam really does change the cycle rather than just setting a flag.
const EC_REAL_NORMAL_STEAM = buf(
    'aa4432ec001d010000021c0500021c0000540002008b46640000004000010102030500001d020200032b0500032b0000548002008b466400000040000101020305004ebb',
)

// REAL, 2026-08-23 03:28:17Z — an app-driven "Tub Clean, 1 hour delay" remote start of the panel's
// downloaded cycle. The command was aa0df026100b0100000000bcbb. This one frame pins three things: the
// smart-course byte i20 = 0x01 matching the app's "Tub Clean (P1)", the base course i5 = 0x09
// Machine Clean underneath it, and a COMMANDED delay counting at i9/i10 = 00:59.
const EC_REAL_DOWNLOAD_TUB_CLEAN = buf(
    'aa4432ec001d010000032b0500032b0000548002008b46640000004000010102030500001d020100010009010100003b540102008b4664000001400001010203050077bb',
)

// REAL, from the 2026-09-01 settings session: every control on the LG app's Settings screen was
// toggled one at a time with the capture running. These readbacks bracket the captured commands the
// write-path tests below reproduce. Idle appliance throughout (state Initial, door open).

// Rinse aid 0, Chime + End of Cycle tone ON, Clean Indicator + Automatic Selection ON, Tub Clean
// Reminder OFF, Status Indicator Light ON — the state right before the captured chime-off command.
const EC_SETTINGS_CHIME_ON = buf(
    'aa4432ec001d010000021c0500021c0000560002008946640000004000010102030500001d010000021c0500021c000052000000894664000000400001010203050027bb',
)

// Tub Clean Reminder ON and everything else OFF except the status light — the state right before the
// captured status-light-off command. i11 = 0x22: tub reminder plus the door bit alone.
const EC_SETTINGS_TUB_ONLY = buf(
    'aa4432ec001d010000021c0500021c0000320000000942640000004000010102030500001d010000021c0500021c000022000000094264000000400001010203050041bb',
)

// The readback of that command: i21 bit 0x40 gone, everything else unchanged.
const EC_SETTINGS_STATUS_LIGHT_OFF = buf(
    'aa4432ec001d010000021c0500021c0000220000000942640000004000010102030500001d010000021c0500021c000022000000094264000000000001010203050091bb',
)

// Rinse aid 4 with chime and tone off, clean light + automatic selection on, status light on — the
// state right before the captured rinse-to-2 command.
const EC_SETTINGS_RINSE_4 = buf(
    'aa4432ec001d010000021c0500021c0000560004000942640000000000010102030500001d010000021c0500021c000056000400094264000000400001010203050061bb',
)

// A dryer frame (class byte 0x30, not 0x32). Nothing in it should reach this handler.
const FOREIGN_CLASS = buf('aa2330eb001b000029002900000000000100000000280000000100000064000000b6bb')

// start() seeds the three target_* entities so HA's select and switches have a state before the first
// press, so "decoded nothing" means no STATUS key appeared — not an empty property bag.
function assertNoStatusDecoded(properties: Record<string, string | number>) {
    assert.deepEqual(
        Object.keys(properties)
            .filter((k) => !k.startsWith('target_'))
            .sort(),
        [],
    )
}

function feed(frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    dev.start()
    for (const f of frames) thinq.emit('data', f)
    const { properties, config } = ha.devices[DEVICE_ID]
    return { properties, config, outbox: thinq.outbox, dev, thinq }
}

// Everything after the connect-time status query, which start() always sends.
function commandsSent(outbox: Buffer[]) {
    return outbox.slice(1).map((b) => b.toString('hex'))
}

describe('N17', () => {
    test('0x3E statistics publish accumulated watt-hours, and track a change', () => {
        assert.equal(feed([STATISTICS_ZERO]).properties.energy, 0)
        const { properties } = feed([STATISTICS_ZERO, STATISTICS_TWO_WH])
        assert.equal(properties.energy, 2)
    })

    test('a repeated sequence number does not suppress a changed reading', () => {
        // Synthetic: sequence held at 0x00 while the reading moves to 12 Wh. Not something this appliance
        // has been seen to do — its sequence byte moved with the value — but it pins that the handler
        // never uses the sequence byte to drop a frame.
        const twelveWh = buf('aa0b323e0000000c0064bb')
        const { properties } = feed([STATISTICS_ZERO, twelveWh])
        assert.equal(properties.energy, 12)
    })

    test('the undecoded frame types this appliance really sends publish nothing', () => {
        // All three captured live. The 0x0A frame is the awkward one: its length byte claims 0xFF while
        // the frame is 88 bytes, and it fails the AABB checksum. AABBDevice keys off the 0xAA/0xBB
        // delimiters, so it still reaches the handler intact — which must not misread it as status.
        const REAL_0A = buf(
            'aaff320a005800004100010a8500460009053230342d3100053230342d3200053230342d33000644572d312d35000644572d332d33000644572d352d3100053230342d3600063230342d313100063230342d313300dbbfbb',
        )
        const REAL_31 = buf(
            'aa4f3231030153414133303030373330310000cc7d00008000000000000253414133303030333830310000633cfff80000000000000353414134343930313030310000eb1d00004000000000006ebb',
        )
        const REAL_72 = buf('aa093272006600e8bb')
        assertNoStatusDecoded(feed([REAL_0A, REAL_31, REAL_72]).properties)
    })

    test("connect sends exactly the status query LG's cloud was observed to send", () => {
        // Byte-identical to the packet captured from LG's bridged cloud (2026-08-22T00:09:29Z),
        // checksum included. Anything else on the wire at connect would be a guess.
        const { outbox } = feed([])
        assert.equal(outbox.length, 1)
        assert.equal(outbox[0].toString('hex'), 'aa0ef0ed1121010000001800b5bb')
    })

    test('frames from another appliance class are ignored', () => {
        assertNoStatusDecoded(feed([FOREIGN_CLASS]).properties)
    })

    // REAL 0xEB status frames from the deployed instance, captured across one panel session. 0xEB is
    // the reply-to-query framing; the same record also arrives doubled in unsolicited 0xEC frames.
    // NORMAL_SELECTED and OFF_STANDBY differ in exactly five record bytes; see N17.ts for the mapping.
    const EB_NORMAL_SELECTED_DOOR_OPEN = buf(
        'aa2532eb001d010000031a0500031a000056040200894664000000400001010203050071bb',
    )
    const EB_NORMAL_SELECTED = buf('aa2532eb001d010000031a0500031a000054040200894664000000400001010203050077bb')
    const EB_STANDBY_NO_COURSE = buf('aa2532eb001d040000031a0000031a00005400020089446400000040000101020305004fbb')
    const EB_MARKER_08 = buf('aa2532eb081d040000031a0000031a000054000200894464000000400001010203050077bb')
    const EB_OFF = buf('aa2532eb001d000000031a0000031a000054000200894464000000400001010203050043bb')

    test('0xEB publishes state, course, door and options from a real panel session', () => {
        const selected = feed([EB_NORMAL_SELECTED]).properties
        assert.equal(selected.state, 'Initial')
        assert.equal(selected.course, 'Normal') // the course actually selected on the panel
        assert.equal(selected.door, 'CLOSE')
        assert.equal(selected.extra_dry, 'ON')

        const standby = feed([EB_STANDBY_NO_COURSE]).properties
        assert.equal(standby.state, 'Standby')
        assert.equal(standby.course, 'Not selected')
        assert.equal(standby.extra_dry, 'OFF')

        assert.equal(feed([EB_OFF]).properties.state, 'Off')
    })

    test('0xEB tracks the door independently of everything else', () => {
        // The two frames differ only in record byte 11 bit 0x02, so this isolates the door bit.
        assert.equal(feed([EB_NORMAL_SELECTED_DOOR_OPEN]).properties.door, 'OPEN')
        assert.equal(feed([EB_NORMAL_SELECTED]).properties.door, 'CLOSE')
    })

    test('0xEB accepts either record marker', () => {
        // Marker byte is 0x00 on most frames and 0x08 on some, with an identical record behind it.
        assert.deepEqual(feed([EB_MARKER_08]).properties, feed([EB_STANDBY_NO_COURSE]).properties)
    })

    test('a 0xEB frame whose record length is not 0x1D decodes to nothing', () => {
        const wrongLen = buf('aa2532eb0018010000031a0500031a000056040200894664000000400001010203050071bb')
        assertNoStatusDecoded(feed([wrongLen]).properties)
    })
    test('a real 0xEC frame — dual 0x1D records — decodes the current record', () => {
        const { properties } = feed([EC_REAL_RUNNING])
        assert.equal(properties.state, 'Running')
        assert.equal(properties.initial_time, 153) // 2h33m — the app's 9:12pm start -> 11:45pm end
        assert.equal(properties.remaining_time, 62) // the current record's 1:02, not the previous one's 1:03
        assert.equal(properties.door, 'CLOSE')
        // The next four are ground truth from the LG app mid-cycle: it displayed the course as "Auto"
        // with Extra Dry, Delay Start and Remote Start all
        // shown OFF. The options byte read 0x00, so High Temp was off in the same frame.
        assert.equal(properties.course, 'Auto')
        assert.equal(properties.extra_dry, 'OFF')
        assert.equal(properties.delay_start, 0)
        assert.equal(properties.remote_start, 'OFF')
        assert.equal(properties.process, 'Washing') // the app read "Washing" while this byte was 0x02
    })

    test('the drying phase and the auto-open door, both app-labelled', () => {
        const { properties } = feed([EC_REAL_DRYING_DOOR_OPEN])
        assert.equal(properties.state, 'Running')
        assert.equal(properties.process, 'Drying') // the app read "Drying" while this byte was 0x04
        assert.equal(properties.remaining_time, 25) // the app read "00:25 left" at the same minute
        assert.equal(properties.door, 'OPEN') // current record; the previous record still has it closed
    })

    test('cycle completion: state and process both report Complete', () => {
        const { properties } = feed([EC_REAL_COMPLETE])
        assert.equal(properties.state, 'Complete') // current record; the previous one is still DRYING
        assert.equal(properties.process, 'Complete')
        assert.equal(properties.door, 'OPEN') // still cracked from the auto-open dry
    })

    test('a downloaded cycle reports its catalogue number, and the smart course wins', () => {
        const { properties } = feed([EC_REAL_DOWNLOAD_TUB_CLEAN])
        // i20 = 0x01 is Tub Clean (P1) in the app's catalogue, and it replaces the i5 base course
        // 0x09 Machine Clean that sits underneath it. This is the first N17 frame ever seen with a
        // non-zero i20, so it is also the only exercise of that branch.
        assert.equal(properties.course, 'Tub Clean')
        assert.equal(properties.process, 'Delayed Start')
        assert.equal(properties.state, 'Running')
        // i9/i10 = 0x00 0x3B. Publishing the hours byte alone would report 0 here,
        // and would keep reporting 0 for the whole first hour of the delay.
        assert.equal(properties.delay_start, 59)
    })

    test('a commanded delay is sent in byte 4 and read back from i9/i10', () => {
        const { dev, outbox } = feed([EC_REAL_TURBO_EXTRA_DRY])
        dev.setProperty('target_course', 'Download Cycle')
        dev.setProperty('target_delay', '1')
        dev.setProperty('start_course', 'PRESS')
        // Byte for byte what the app sent at 03:28:14Z for Tub Clean with a 1-hour delay.
        assert.deepEqual(commandsSent(outbox), ['aa0df026100b0100000000bcbb'])

        // And an out-of-range delay is refused rather than truncated into the packet.
        const bad = feed([EC_REAL_TURBO_EXTRA_DRY])
        bad.dev.setProperty('target_delay', '99')
        bad.dev.setProperty('start_course', 'PRESS')
        assert.equal(commandsSent(bad.outbox)[0].slice(12, 14), '00')
    })

    test('steam is decoded from the options byte, and lengthens the cycle', () => {
        const { properties } = feed([EC_REAL_NORMAL_STEAM])
        assert.equal(properties.course, 'Normal')
        assert.equal(properties.steam, 'ON')
        assert.equal(properties.high_temp, 'OFF')
        assert.equal(properties.extra_dry, 'OFF')
        assert.equal(properties.initial_time, 223) // 3:43, against plain Normal's 2:28
    })

    test('the two option bits are distinct, each labelled by its own remote start', () => {
        // Turbo + Extra Dry.
        const turbo = feed([EC_REAL_TURBO_EXTRA_DRY]).properties
        assert.equal(turbo.state, 'Running')
        assert.equal(turbo.course, 'Turbo')
        assert.equal(turbo.initial_time, 149)
        assert.equal(turbo.extra_dry, 'ON')
        assert.equal(turbo.high_temp, 'OFF')

        // Heavy + High Temp. The bit moves, the other one does not.
        const heavy = feed([EC_REAL_HEAVY_HIGH_TEMP]).properties
        assert.equal(heavy.course, 'Heavy')
        assert.equal(heavy.initial_time, 216)
        assert.equal(heavy.extra_dry, 'OFF')
        assert.equal(heavy.high_temp, 'ON')
    })

    test('the start button is available only while the appliance reports remote start armed', () => {
        const { config, properties } = feed([EC_REAL_TURBO_EXTRA_DRY])
        const components = config!.components as unknown as Record<string, { availability?: object[] }>
        assert.deepEqual(components.start_course.availability?.[2], {
            topic: '$this/remote_start',
            payload_available: 'ON',
            payload_not_available: 'OFF',
        })
        assert.equal(properties.remote_start, 'ON')
    })

    test('a start is passed through without an interlock of our own', () => {
        // The appliance ignores a start it is not armed for; rethink does not second-guess it.
        const { dev, outbox } = feed([EB_STANDBY_NO_COURSE])
        dev.setProperty('start_course', 'PRESS')
        assert.equal(commandsSent(outbox).length, 1)
    })

    test('a start reproduces, byte for byte, the packets LG was captured sending', () => {
        const turbo = feed([EC_REAL_TURBO_EXTRA_DRY])
        turbo.dev.setProperty('target_course', 'Turbo')
        turbo.dev.setProperty('target_extra_dry', 'ON')
        turbo.dev.setProperty('start_course', 'PRESS')
        // Exactly what the app sent at 02:15:57Z for Turbo + Extra Dry.
        assert.deepEqual(commandsSent(turbo.outbox), ['aa0df02610040000040000b0bb'])

        const heavy = feed([EC_REAL_TURBO_EXTRA_DRY])
        heavy.dev.setProperty('target_course', 'Heavy')
        heavy.dev.setProperty('target_high_temp', 'ON')
        heavy.dev.setProperty('start_course', 'PRESS')
        // And at 02:21:36Z for Heavy + High Temp.
        assert.deepEqual(commandsSent(heavy.outbox), ['aa0df02610020000080000b2bb'])

        const steam = feed([EC_REAL_TURBO_EXTRA_DRY])
        steam.dev.setProperty('target_course', 'Normal')
        steam.dev.setProperty('target_steam', 'ON')
        steam.dev.setProperty('start_course', 'PRESS')
        // And at 03:04:24Z for Normal + Steam.
        assert.deepEqual(commandsSent(steam.outbox), ['aa0df0261005000080000037bb'])
    })

    test('the three option bits combine in one command', () => {
        const { dev, outbox } = feed([EC_REAL_TURBO_EXTRA_DRY])
        dev.setProperty('target_course', 'Normal')
        dev.setProperty('target_steam', 'ON')
        dev.setProperty('target_high_temp', 'ON')
        dev.setProperty('target_extra_dry', 'ON')
        dev.setProperty('start_course', 'PRESS')
        // 0x80 | 0x08 | 0x04 = 0x8c. Each bit is individually confirmed; the combination is not, but
        // it is the only reading consistent with all three.
        // aa 0d f0 26 10 <course> <delay> 00 <opt3> ... — opt3 is the 9th byte, hex chars 16-18.
        assert.equal(commandsSent(outbox)[0].slice(16, 18), '8c')
    })

    test('a course outside the observed set is refused rather than started', () => {
        const { dev, outbox, properties } = feed([EC_REAL_TURBO_EXTRA_DRY])
        // Machine Clean is a real course here, but was never seen started remotely.
        dev.setProperty('target_course', 'Machine Clean')
        assert.equal(properties.target_course, 'Auto') // unchanged from the seeded default
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), ['aa0df026100100000000008bbb']) // still AUTO
    })

    test('cancel always sends 0x11, whatever the machine is doing', () => {
        // The app was observed sending 0x11 even for a DELAYED cycle with no water in the machine, so
        // cancel must not route on the process byte.
        const running = feed([EC_REAL_TURBO_EXTRA_DRY])
        running.dev.setProperty('cancel', 'PRESS')
        assert.deepEqual(commandsSent(running.outbox), ['aa07f026118dbb'])

        const delayed = feed([EC_REAL_DELAYED_START])
        assert.equal(delayed.properties.process, 'Delayed Start')
        delayed.dev.setProperty('cancel', 'PRESS')
        assert.deepEqual(commandsSent(delayed.outbox), ['aa07f026118dbb'])
    })

    test('power off is its own action, not a form of cancel', () => {
        const { dev, outbox } = feed([EC_REAL_TURBO_EXTRA_DRY])
        dev.setProperty('power_off', 'PRESS')
        assert.deepEqual(commandsSent(outbox), ['aa07f026128cbb'])
    })

    test('pause and resume send the captured packets', () => {
        const { dev, outbox } = feed([])
        dev.setProperty('pause', 'PRESS')
        dev.setProperty('resume', 'PRESS')
        assert.deepEqual(commandsSent(outbox), ['aa07f026138fbb', 'aa07f026148ebb'])
    })

    test('the settings read back from real status records', () => {
        const chimeOn = feed([EC_SETTINGS_CHIME_ON]).properties
        assert.equal(chimeOn.rinse_level, 0)
        assert.equal(chimeOn.chime_sound, 'ON')
        assert.equal(chimeOn.end_of_cycle_tone, 'ON')
        assert.equal(chimeOn.clean_indicator_light, 'ON')
        assert.equal(chimeOn.automatic_selection, 'ON')
        assert.equal(chimeOn.tub_clean_reminder, 'OFF')
        assert.equal(chimeOn.status_indicator_light, 'ON')

        const rinse4 = feed([EC_SETTINGS_RINSE_4]).properties
        assert.equal(rinse4.rinse_level, 4)
        assert.equal(rinse4.chime_sound, 'OFF')
        assert.equal(rinse4.end_of_cycle_tone, 'OFF')
        assert.equal(rinse4.clean_indicator_light, 'ON')

        const tubOnly = feed([EC_SETTINGS_TUB_ONLY]).properties
        assert.equal(tubOnly.tub_clean_reminder, 'ON')
        assert.equal(tubOnly.clean_indicator_light, 'OFF')
        assert.equal(tubOnly.automatic_selection, 'OFF')

        assert.equal(feed([EC_SETTINGS_STATUS_LIGHT_OFF]).properties.status_indicator_light, 'OFF')
    })

    test('a settings write snapshots the read-back state, byte for byte as the app sends it', () => {
        // Each pair is a real captured sequence: the readback the appliance had just sent, then the
        // exact packet LG's cloud sent for the next toggle. The snapshot must reproduce the untouched
        // settings from the readback, or a single toggle would reset the rest.
        const chime = feed([EC_SETTINGS_CHIME_ON])
        chime.dev.setProperty('chime_sound', 'OFF')
        assert.deepEqual(commandsSent(chime.outbox), ['aa0ef026000068400001000022bb'])

        const rinse = feed([EC_SETTINGS_RINSE_4])
        rinse.dev.setProperty('rinse_level', '2')
        assert.deepEqual(commandsSent(rinse.outbox), ['aa0ef02602002840000100006cbb'])

        const light = feed([EC_SETTINGS_TUB_ONLY])
        light.dev.setProperty('status_indicator_light', 'OFF')
        assert.deepEqual(commandsSent(light.outbox), ['aa0ef02600000140000000005abb'])
    })

    test('settings writes are refused until a status record has been received', () => {
        // The write is a full snapshot; sent cold it would overwrite every setting with defaults.
        const cold = feed([])
        cold.dev.setProperty('chime_sound', 'OFF')
        cold.dev.setProperty('rinse_level', '2')
        assert.deepEqual(commandsSent(cold.outbox), [])

        // An out-of-range rinse level is refused rather than sent.
        const bad = feed([EC_SETTINGS_RINSE_4])
        bad.dev.setProperty('rinse_level', '9')
        assert.deepEqual(commandsSent(bad.outbox), [])
    })

    // HA rejects a value an enum entity did not declare, and rejects a repeated option, so both
    // halves of the contract are checked against every captured frame rather than by inspection.
    // 'None' is the one value allowed unconditionally — it is what publishProperty sends for an
    // undefined value, and is how an unrecognised code is meant to surface.
    test('every enum entity declares a clean option list, and only ever publishes from it', () => {
        const ALL_FRAMES = [
            EC_REAL_RUNNING,
            EC_REAL_DRYING_DOOR_OPEN,
            EC_REAL_COMPLETE,
            EC_REAL_TURBO_EXTRA_DRY,
            EC_REAL_HEAVY_HIGH_TEMP,
            EC_REAL_DELAYED_START,
            EC_REAL_NORMAL_STEAM,
            EC_REAL_DOWNLOAD_TUB_CLEAN,
            EB_NORMAL_SELECTED,
            EB_NORMAL_SELECTED_DOOR_OPEN,
            EB_STANDBY_NO_COURSE,
            EB_OFF,
        ]

        const { properties, config } = feed(ALL_FRAMES)
        const components = config!.components as unknown as Record<string, Record<string, string[] | string>>

        const enums = Object.entries(components).filter(([, c]) => Array.isArray(c.options))
        // state, course, process and the target_course select.
        assert.equal(enums.length, 4)

        for (const [name, component] of enums) {
            const options = component.options as string[]
            assert.deepEqual(options, [...new Set(options)], `${name} declares a duplicated option`)
            assert.ok(!options.includes('None'), `${name} claims HA's unknown value as an option`)
        }

        // Replayed one frame at a time, so a value that only appears mid-sequence is still checked.
        for (const frame of ALL_FRAMES) {
            const { properties: p } = feed([frame])
            for (const [name, component] of enums) {
                const value = p[(component.state_topic as string).replace('$this/', '')]
                if (value === undefined) continue
                assert.ok(
                    value === 'None' || (component.options as string[]).includes(value as string),
                    `${name} published ${JSON.stringify(value)}, which is not one of its options`,
                )
            }
        }

        // Sanity: the sweep above is only meaningful because these really were populated.
        assert.equal(properties.state, 'Off')
        assert.equal(properties.target_course, 'Auto')
    })

    test('an unrecognised code reports unknown rather than inventing a label', () => {
        // Synthetic, and deliberately so: every code this appliance has been seen to send is mapped.
        // State 0x7F, process 0x7E and course 0x7D are absent from all three tables. HA's unknown
        // value is 'None' — publishing the string 'unknown' would be rejected by an enum entity.
        const unmapped = buf('aa2532eb001d7f7e00031a7d00031a000054000200894464000000400001010203050043bb')
        const { properties } = feed([unmapped])
        assert.equal(properties.state, 'None')
        assert.equal(properties.process, 'None')
        assert.equal(properties.course, 'None')
        // The numeric fields around them still decode; only the unmapped codes drop out.
        assert.equal(properties.initial_time, 3 * 60 + 26)
    })

    test('a 0xEC frame that does not match the expected layout decodes to nothing', () => {
        // Record marker/length guard: same opcode, but the record header is 0x00 0x10 rather than
        // 0x00 0x1D. Better to publish nothing than to publish a misaligned read.
        const badLayout = buf(
            'aa3a32ec00100000000000000000000000000000000000000000000000000010020000011e050001050000500c0203828400004000000000a0bb',
        )
        assertNoStatusDecoded(feed([badLayout]).properties)
    })
})
