import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/N02'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'N02'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1' }

// All frames below are REAL, captured 2026-10-06 against a real unit in bridge mode via
// tools/rethink-capture.ts, with the LG app as ground truth for every toggle. Timestamps are UTC.

// 02:03:02Z — the appliance's first frame after being powered on at the panel: Off -> Ready, the
// default course (Normal) selected, rinse level 2, door open (nothing closes it until later).
const EC_POWER_ON = buf(
    'aa4432ec001800000002190000000100000200000080006300000000000101020305000018010000021905000219000052000200880463000000000001010203050081bb',
)

// 02:09:43Z — door closed while idle in Standby. Isolates the door bit: this frame's prev/cur differ
// in flags1 only (0x52 -> 0x50).
const EC_DOOR_CLOSED = buf(
    'aa4432ec001804000002190000021900005200020088046300000000000101020305000018040000021900000219000050000200880463000000000001010203050019bb',
)

// 02:11:39Z — the moment Remote Start was armed at the panel and the door closed again (both
// readable in this one frame's cur half: flags1 settles at 0x50 (door closed), flags2 at 0x8a).
const EC_REMOTE_START_ARMED = buf(
    'aa4432ec00180100000219050002190000520002008a0463000000000001010203050000180100000219050002190000500002008a0463000000000001010203050001bb',
)

// 02:57:41Z — selecting Flex Zone's "Dual" mode on the panel, before Start is even pressed: course
// already shows Normal (the default), door still open.
const EC_FLEX_ZONE_SELECTED = buf(
    'aa4432ec0018010000021905000219000022000100000063000000000001010203050000180100000219050002190000221001000000630000000000010102030500bdbb',
)
// 02:59:40Z — the same selection carried into a real Start, pressed on the panel (no app involved,
// so there is no captured command - only this before/after status pair).
const EC_FLEX_ZONE_RUNNING = buf(
    'aa4432ec0018010000021905000219000022100100000063000000000001010203050000180202000219050002190000201001000000630000000000010102030500acbb',
)

// 03:43:10Z — Flex Zone's "Upper" mode, started from the app: the real command and readback.
const CMD_START_FLEX_ZONE_UPPER = buf('aa0df0261005000040000077bb')
const EC_FLEX_ZONE_UPPER_RUNNING = buf(
    'aa4432ec001801000001320300013200002000010002006300000000000101020305000018020200020c0500020c00002040010002006300000000000101020305007abb',
)

// 03:47:40Z — Flex Zone's "Lower" mode, started from the app: the real command and readback.
const CMD_START_FLEX_ZONE_LOWER = buf('aa0df0261005000020000057bb')
const EC_FLEX_ZONE_LOWER_RUNNING = buf(
    'aa4432ec0018010000020c0500020c00002040010002006300000000000101020305000018020200021305000213000020200100020063000000000001010203050040bb',
)

// 03:03:26Z — Dry Boost Low, confirmed against the display, started from the panel.
const EC_DRY_BOOST_LOW_RUNNING = buf(
    'aa4432ec001801000002280500022800002200010010006300000000000101020305000018020200022805000228000020000100100063000000000001010203050060bb',
)
// 03:06:06Z — Dry Boost High, confirmed against the display, started from the panel.
const EC_DRY_BOOST_HIGH_RUNNING = buf(
    'aa4432ec0018010000023205000232000022000100300063000000000001010203050000180202000232050002320000200001003000630000000000010102030500c8bb',
)

// 03:08:16Z — selecting Night Dry on for Normal (off by default for this course), panel session.
const EC_NIGHT_DRY_SELECTED = buf(
    'aa4432ec0018010000023205000232000022000100300063000000000001010203050000180100000232050002320000a2000100300063000000000001010203050049bb',
)
// 03:08:20Z — the same carried into Running.
const EC_NIGHT_DRY_RUNNING = buf(
    'aa4432ec00180100000232050002320000a2000100300063000000000001010203050000180202000232050002320000a00001003000630000000000010102030500c8bb',
)

// 03:16:29Z — Dry Boost High alone, started from the app with remote start armed: the real command.
const CMD_START_DRY_BOOST_HIGH = buf('aa0df02610050000000300b0bb')
// 03:19:10Z — Night Dry alone, started from the app: the real command.
const CMD_START_NIGHT_DRY = buf('aa0df02610050000000400b3bb')
// 03:22:55Z — Steam alone, started from the app: the real command.
const CMD_START_STEAM = buf('aa0df0261005000080000037bb')
// 03:24:08Z — High Temp alone, started from the app: the real command.
const CMD_START_HIGH_TEMP = buf('aa0df02610050000080000bfbb')

// 03:30:26Z — selecting "1 Hour" on the panel: initial time reads exactly 1:00, matching the name.
const EC_ONE_HOUR_SELECTED = buf(
    'aa4432ec0018010000021905000219000022000100000063000000000001010203050000180100000100120001000000220001000000630000000000010102030500e4bb',
)
// 03:30:45Z — the same course carried into a real Start.
const EC_ONE_HOUR_RUNNING = buf(
    'aa4432ec0018010000010012000100000022000100000063000000000001010203050000180202000100120001000000200001000000630000000000010102030500debb',
)

// The settings-write commands captured for each toggle, and the readback frame immediately after.
// Every command is the exact bytes LG's own app sent; every readback is the exact next status frame.
const CMD_RINSE_LEVEL_1 = buf('aa0ef02601007c00000000001ebb')
const EC_RINSE_LEVEL_1 = buf(
    'aa4432ec00180100000219050002190000500002008a0463000000000001010203050000180100000219050002190000500001008a0463000000000001010203050004bb',
)

const CMD_MC_REMINDER_ON = buf('aa0ef02601007d000000000019bb')
const EC_MC_REMINDER_ON = buf(
    'aa4432ec00180100000219050002190000500001008a0463000000000001010203050000180100000219050002190000700001008a0463000000000001010203050025bb',
)

const CMD_TIME_INDICATOR_OFF = buf('aa0ef02601006d000000000069bb')
const EC_TIME_INDICATOR_OFF = buf(
    'aa4432ec00180100000219050002190000700001008a0463000000000001010203050000180100000219050002190000700001008204630000000000010102030500ddbb',
)

const CMD_CHIME_OFF = buf('aa0ef02601006900000000006dbb')
const EC_CHIME_OFF = buf(
    'aa4432ec001801000002190500021900007000010082046300000000000101020305000018010000021905000219000070000100020463000000000001010203050055bb',
)

const CMD_AUTO_SELECT_OFF = buf('aa0ef02601004900000000004dbb')
const EC_AUTO_SELECT_OFF = buf(
    'aa4432ec001801000002190500021900007000010002046300000000000101020305000018010000021905000219000060000100020463000000000001010203050025bb',
)

const CMD_CLEAN_LIGHT_OFF = buf('aa0ef026010041000000000045bb')
const EC_CLEAN_LIGHT_OFF = buf(
    'aa4432ec001801000002190500021900006000010002046300000000000101020305000018010000021905000219000020000100020463000000000001010203050075bb',
)

// 02:24:59Z — a real remote start of Normal, no options, with Remote Start already armed.
const CMD_START_NORMAL = buf('aa0df02610050000000000b7bb')
// 03:35:45Z — a real app-driven start of Auto.
const CMD_START_AUTO = buf('aa0df026100100000000008bbb')
// 03:39:41Z — Heavy with a real 1-hour delay, started from the app: the real command.
const CMD_START_HEAVY_DELAYED = buf('aa0df02610020100000000b5bb')
// The resulting readback: Running with process "Delayed Start", 59 of the 60 minutes left.
const EC_HEAVY_DELAYED_RUNNING = buf(
    'aa4432ec001801000002220100022200002000010002006300000000000101020305000018020100022f0200022f003b20010100020063000000000001010203050018bb',
)
// 03:49:03Z — Delicate with a real 10-hour delay, started from the app: the real command and readback.
const CMD_START_DELICATE_DELAYED = buf('aa0df02610030a00000000bfbb')
const EC_DELICATE_DELAYED_RUNNING = buf(
    'aa4432ec001801000002130500021300002020010002006300000000000101020305000018020100013203000132093b20010100020063000000000001010203050034bb',
)
// 03:52:00Z — Refresh with Night Dry, started from the app: the real command and readback.
const CMD_START_REFRESH = buf('aa0df026100700008004003dbb')
const EC_REFRESH_RUNNING = buf(
    'aa4432ec0018010000013203000132000020000100020063000000000001010203050000180203000039070000390000a080010002006300000000000101020305001dbb',
)
// 03:54:42Z — "Download Cycle", started from the app: the real command. The readback reports
// whichever course was actually loaded in that slot (Machine Clean, this unit's default) rather
// than 0x0b itself.
const CMD_START_DOWNLOAD_CYCLE = buf('aa0df026100b0000000000bdbb')
const EC_DOWNLOAD_CYCLE_RUNNING = buf(
    'aa4432ec00180100000039070000390000a080010002006300000000000101020305000018020200010e0901010e000020000100020063000001000001010203050052bb',
)

// 03:59:25Z — a different cycle (Rinse, the app's "Rinse (P3)") downloaded into the slot via the new
// F0 25 03 command (not implemented - see COURSES's comment), then "Download Cycle" run again:
// the same 0x0b command as above, but this time reporting Rinse (6) rather than Machine Clean.
const EC_DOWNLOAD_SLOT_NOW_RINSE = buf(
    'aa4432ec0018010000010e0901010e0000600002000a046300000100000101020305000018010000000c0601000c0000600002000a046300000300000301020305001cbb',
)
const EC_DOWNLOAD_CYCLE_RINSE_RUNNING = buf(
    'aa4432ec0018010000000c0601000c0000600002000a046300000300000303020305000018020300000c0601000c0000600002000a0463000003000003030203050019bb',
)
const EC_RUNNING = buf(
    'aa4432ec00180100000219050002190000200001000200630000000000010102030500001802020002190500021900002000010002006300000000000101020305008ebb',
)

const CMD_PAUSE = buf('aa07f026138fbb')
const EC_PAUSED = buf(
    'aa4432ec001802020002190500021800002000010002006300000000000101020305000018030200021905000218000020000100020063000000000001010203050088bb',
)

const CMD_CANCEL = buf('aa07f026118dbb')
const CMD_RESUME = buf('aa07f026148ebb')
// The drain: state stays Running while process reports Cancel (0x63) and the course clears.
const EC_CANCEL_DRAINING = buf(
    'aa4432ec001803020002190500021800002000010002006300000000000101020305000018026300021900000001000000000000020064000000000001010203050055bb',
)

// ~67 s after cancel, the drain finished on its own: Standby, remote start cleared.
const EC_STANDBY_AFTER_CANCEL = buf(
    'aa4432ec001802630002190000000100000000000002006400000000000101020305000818040000021900000001000000000000000064000000000001010203050092bb',
)

const STATISTICS_ZERO = buf('aa0b323e000000000070bb')

// Real, undecoded frame types seen this session: the parts-manifest burst (fails the simple AABB
// checksum, same as N17's), the opcode-echo ack, the post-settings-write marker, and the transition
// marker D0211 decodes as a tub-clean counter — context here (right after a cancel, value 0) doesn't
// match D0211's documented rinse-to-dry trigger, so it is left undecoded rather than guessed.
const REAL_0A = buf(
    'aaff320a005f00028100010a86004d0a053230342d3100053230342d3200053230342d33000644572d312d35000644572d332d33000644572d352d3100053230342d3600063230342d313100063230342d313200063230342d313300feeabb',
)
const REAL_00_ACK = buf('aa08320026005fbb')
const REAL_27_MARKER = buf('aa073227005fbb')
const REAL_D8 = buf('aa0732d800eebb')

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

describe('N02', () => {
    test('connect sends the family-wide status query', () => {
        const { outbox } = feed([])
        assert.equal(outbox.length, 1)
        assert.equal(outbox[0].toString('hex'), 'aa0ef0ed1121010000001800b5bb')
    })

    test('power-on reports Ready, the default course, and an open door', () => {
        const { properties } = feed([EC_POWER_ON])
        assert.equal(properties.status, 'Ready')
        assert.equal(properties.course, 'Normal')
        assert.equal(properties.rinse_level, 2)
        assert.equal(properties.door, 'ON')
        assert.equal(properties.remote_start, 'OFF')
    })

    test('the door bit is isolated by a real close', () => {
        assert.equal(feed([EC_POWER_ON]).properties.door, 'ON')
        assert.equal(feed([EC_DOOR_CLOSED]).properties.door, 'OFF')
    })

    test('remote start arms at the panel and is read back independently of the door', () => {
        const { properties } = feed([EC_REMOTE_START_ARMED])
        assert.equal(properties.remote_start, 'ON')
        assert.equal(properties.door, 'OFF')
    })

    test('the start button is available only while remote start is armed', () => {
        const { config } = feed([EC_REMOTE_START_ARMED])
        const components = config!.components as unknown as Record<string, { availability?: object[] }>
        assert.deepEqual(components.start_course.availability?.[2], {
            topic: '$this/remote_start',
            payload_available: 'ON',
            payload_not_available: 'OFF',
        })
    })

    test('flex zone Dual is read from the options byte, selected before Start and carried through', () => {
        const selected = feed([EC_FLEX_ZONE_SELECTED]).properties
        assert.equal(selected.status, 'Ready')
        assert.equal(selected.flex_zone, 'Dual')

        const running = feed([EC_FLEX_ZONE_RUNNING]).properties
        assert.equal(running.status, 'Running')
        assert.equal(running.flex_zone, 'Dual')
    })

    test('flex zone Dual reproduces the confirmed options bit in the start command', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_flex_zone', 'Dual')
        dev.setProperty('start_course', 'PRESS')
        // aa 0d f0 26 10 <course> <delay> 00 <opt3> ... - opt3 is the 9th byte, hex chars 16-18.
        assert.equal(commandsSent(outbox)[0].slice(16, 18), '10')
    })

    test('flex zone Upper reproduces a real captured command and readback', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_flex_zone', 'Upper')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_FLEX_ZONE_UPPER.toString('hex')])

        assert.equal(feed([EC_FLEX_ZONE_UPPER_RUNNING]).properties.flex_zone, 'Upper')
    })

    test('flex zone Lower reproduces a real captured command and readback', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_flex_zone', 'Lower')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_FLEX_ZONE_LOWER.toString('hex')])

        assert.equal(feed([EC_FLEX_ZONE_LOWER_RUNNING]).properties.flex_zone, 'Lower')
    })

    test('dry boost reads Off/Low/High from flags2, confirmed against the display at each step', () => {
        assert.equal(feed([EC_DRY_BOOST_LOW_RUNNING]).properties.dry_boost, 'Low')
        assert.equal(feed([EC_DRY_BOOST_HIGH_RUNNING]).properties.dry_boost, 'High')
    })

    test('night dry is read from flags1, selected before Start and carried through', () => {
        const selected = feed([EC_NIGHT_DRY_SELECTED]).properties
        assert.equal(selected.status, 'Ready')
        assert.equal(selected.night_dry, 'ON')

        const running = feed([EC_NIGHT_DRY_RUNNING]).properties
        assert.equal(running.status, 'Running')
        assert.equal(running.night_dry, 'ON')
        // Dry Boost High was still selected in this same session; flags1/flags2 are independent.
        assert.equal(running.dry_boost, 'High')
    })

    test('dry boost, night dry, steam and high temp each reproduce a real isolated start', () => {
        const dryBoost = feed([EC_REMOTE_START_ARMED])
        dryBoost.dev.setProperty('target_dry_boost', 'High')
        dryBoost.dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(dryBoost.outbox), [CMD_START_DRY_BOOST_HIGH.toString('hex')])

        const nightDry = feed([EC_REMOTE_START_ARMED])
        nightDry.dev.setProperty('target_night_dry', 'ON')
        nightDry.dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(nightDry.outbox), [CMD_START_NIGHT_DRY.toString('hex')])

        const steam = feed([EC_REMOTE_START_ARMED])
        steam.dev.setProperty('target_steam', 'ON')
        steam.dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(steam.outbox), [CMD_START_STEAM.toString('hex')])

        const highTemp = feed([EC_REMOTE_START_ARMED])
        highTemp.dev.setProperty('target_high_temp', 'ON')
        highTemp.dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(highTemp.outbox), [CMD_START_HIGH_TEMP.toString('hex')])
    })

    test('a settings write snapshots the read-back state, byte for byte as the app sent it', () => {
        const rinse = feed([EC_REMOTE_START_ARMED])
        rinse.dev.setProperty('rinse_level', '1')
        assert.deepEqual(commandsSent(rinse.outbox), [CMD_RINSE_LEVEL_1.toString('hex')])
        assert.equal(feed([EC_RINSE_LEVEL_1]).properties.rinse_level, 1)

        const mc = feed([EC_RINSE_LEVEL_1])
        mc.dev.setProperty('machine_clean_reminder', 'ON')
        assert.deepEqual(commandsSent(mc.outbox), [CMD_MC_REMINDER_ON.toString('hex')])
        assert.equal(feed([EC_MC_REMINDER_ON]).properties.machine_clean_reminder, 'ON')

        const time = feed([EC_MC_REMINDER_ON])
        time.dev.setProperty('time_indicator', 'OFF')
        assert.deepEqual(commandsSent(time.outbox), [CMD_TIME_INDICATOR_OFF.toString('hex')])
        assert.equal(feed([EC_TIME_INDICATOR_OFF]).properties.time_indicator, 'OFF')

        const chime = feed([EC_TIME_INDICATOR_OFF])
        chime.dev.setProperty('chime_sound', 'OFF')
        assert.deepEqual(commandsSent(chime.outbox), [CMD_CHIME_OFF.toString('hex')])
        assert.equal(feed([EC_CHIME_OFF]).properties.chime_sound, 'OFF')

        const auto = feed([EC_CHIME_OFF])
        auto.dev.setProperty('auto_select', 'OFF')
        assert.deepEqual(commandsSent(auto.outbox), [CMD_AUTO_SELECT_OFF.toString('hex')])
        assert.equal(feed([EC_AUTO_SELECT_OFF]).properties.auto_select, 'OFF')

        const clean = feed([EC_AUTO_SELECT_OFF])
        clean.dev.setProperty('clean_light_reminder', 'OFF')
        assert.deepEqual(commandsSent(clean.outbox), [CMD_CLEAN_LIGHT_OFF.toString('hex')])
        assert.equal(feed([EC_CLEAN_LIGHT_OFF]).properties.clean_light_reminder, 'OFF')
    })

    test('settings writes are refused until a status record has been received', () => {
        const cold = feed([])
        cold.dev.setProperty('rinse_level', '1')
        cold.dev.setProperty('chime_sound', 'OFF')
        assert.deepEqual(commandsSent(cold.outbox), [])

        const bad = feed([EC_RINSE_LEVEL_1])
        bad.dev.setProperty('rinse_level', '9')
        assert.deepEqual(commandsSent(bad.outbox), [])
    })

    test('a start reproduces, byte for byte, the command LG was captured sending', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_NORMAL.toString('hex')])

        const { properties } = feed([EC_RUNNING])
        assert.equal(properties.status, 'Running')
        assert.equal(properties.process, 'Washing')
        assert.equal(properties.course, 'Normal')
    })

    test('"1 Hour" is also selectable and matches a real panel session', () => {
        const selected = feed([EC_ONE_HOUR_SELECTED]).properties
        assert.equal(selected.course, '1 Hour')
        assert.equal(selected.initial_time, 60) // 1:00, matching the course name

        const running = feed([EC_ONE_HOUR_RUNNING]).properties
        assert.equal(running.status, 'Running')
        assert.equal(running.course, '1 Hour')

        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', '1 Hour')
        dev.setProperty('start_course', 'PRESS')
        // aa 0d f0 26 10 <course> ... - course is the 6th byte, hex chars 10-12.
        assert.equal(commandsSent(outbox)[0].slice(10, 12), '12')
    })

    test('Auto reproduces the real app-driven start command', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', 'Auto')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_AUTO.toString('hex')])
    })

    test('Heavy with a real delay reproduces the command and the "Delayed Start" readback', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', 'Heavy')
        dev.setProperty('target_delay', '1')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_HEAVY_DELAYED.toString('hex')])

        const { properties } = feed([EC_HEAVY_DELAYED_RUNNING])
        assert.equal(properties.status, 'Running')
        assert.equal(properties.process, 'Delayed Start')
        assert.equal(properties.course, 'Heavy')
        assert.equal(properties.delay_start_time, 59)
    })

    test('Delicate with a 10-hour delay reproduces the real command and readback', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', 'Delicate')
        dev.setProperty('target_delay', '10')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_DELICATE_DELAYED.toString('hex')])

        const { properties } = feed([EC_DELICATE_DELAYED_RUNNING])
        assert.equal(properties.course, 'Delicate')
        assert.equal(properties.process, 'Delayed Start')
        assert.equal(properties.delay_start_time, 599) // 9:59, just under the commanded 10:00
    })

    test('Refresh reproduces a real start, Steam included as the app sent it', () => {
        // The manual says Refresh can't have Steam turned off, but rethink does not enforce that
        // itself - the app evidently sends Steam explicitly, which this reproduces byte for byte.
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', 'Refresh')
        dev.setProperty('target_steam', 'ON')
        dev.setProperty('target_night_dry', 'ON')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_REFRESH.toString('hex')])

        const { properties } = feed([EC_REFRESH_RUNNING])
        assert.equal(properties.course, 'Refresh')
        assert.equal(properties.process, 'Rinsing')
        assert.equal(properties.night_dry, 'ON')
    })

    test('Download Cycle reproduces the real command; the readback reports the underlying course', () => {
        const { dev, outbox } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', 'Download Cycle')
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_DOWNLOAD_CYCLE.toString('hex')])

        const { properties } = feed([EC_DOWNLOAD_CYCLE_RUNNING])
        assert.equal(properties.status, 'Running')
        assert.equal(properties.course, 'Machine Clean')
    })

    test('a different downloaded cycle reports its own course once the slot changes', () => {
        assert.equal(feed([EC_DOWNLOAD_SLOT_NOW_RINSE]).properties.course, 'Rinse')

        const { properties } = feed([EC_DOWNLOAD_CYCLE_RINSE_RUNNING])
        assert.equal(properties.status, 'Running')
        assert.equal(properties.process, 'Rinsing')
        assert.equal(properties.course, 'Rinse')
    })

    test('a course outside the observed set is refused rather than started', () => {
        // Machine Clean is a real course here, but was never confirmed as a direct start - only
        // reached via "Download Cycle".
        const { dev, outbox, properties } = feed([EC_REMOTE_START_ARMED])
        dev.setProperty('target_course', 'Machine Clean')
        assert.equal(properties.target_course, 'Normal') // unchanged from the seeded default
        dev.setProperty('start_course', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_START_NORMAL.toString('hex')]) // still Normal
    })

    test('pause and resume send the captured packets', () => {
        const { dev, outbox } = feed([EC_RUNNING])
        dev.setProperty('pause', 'PRESS')
        dev.setProperty('resume', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_PAUSE.toString('hex'), CMD_RESUME.toString('hex')])
        assert.equal(feed([EC_PAUSED]).properties.status, 'Pause')
    })

    test('cancel sends the captured packet; the drain reports Running with process Cancel', () => {
        const { dev, outbox } = feed([EC_PAUSED])
        dev.setProperty('cancel', 'PRESS')
        assert.deepEqual(commandsSent(outbox), [CMD_CANCEL.toString('hex')])

        const { properties } = feed([EC_CANCEL_DRAINING])
        assert.equal(properties.status, 'Running')
        assert.equal(properties.process, 'Cancel')
        assert.equal(properties.course, 'Off')
    })

    test('the drain finishes on its own into Standby and clears remote start', () => {
        const { properties } = feed([EC_STANDBY_AFTER_CANCEL])
        assert.equal(properties.status, 'Standby')
        assert.equal(properties.remote_start, 'OFF')
    })

    test('0x3E statistics publish accumulated watt-hours', () => {
        assert.equal(feed([STATISTICS_ZERO]).properties.energy, 0)
    })

    test('the undecoded frame types this appliance really sends publish nothing', () => {
        assertNoStatusDecoded(feed([REAL_0A, REAL_00_ACK, REAL_27_MARKER, REAL_D8]).properties)
    })

    test('a frame from another appliance class is ignored', () => {
        // Synthetic: class byte 0x30 (a dryer in this family), never seen from this device.
        const foreign = buf('aa2330eb001b000029002900000000000100000000280000000100000064000000b6bb')
        assertNoStatusDecoded(feed([foreign]).properties)
    })
})
