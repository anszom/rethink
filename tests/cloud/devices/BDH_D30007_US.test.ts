import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/BDH_D30007_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'BDH_D30007_US'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames captured live from the appliance via rethink-capture, each cross-checked
// against the LG cloud's own decoded washerDryer state at matching timestamps, not guessed from static
// analysis. The comments name the cloud field that confirmed each one.

// Tub Clean selected: cloud course:"TUBCLEAN", ecoHybrid:"ECOHYBRID_TURBO", remainTimeMinute:160.
const TUB_CLEAN = buf(
    'aaff300a0066004f45000100ec005400030200020700000000640000010000000000040700000000000481070000000000000000000000000000000300021300000000a000000100000200000413000000000000810700000000000000000000000000317ebb',
)

// Time Dry: cloud course:"TIMEDRY", ecoHybrid:"ECOHYBRID_NORMAL", and a 30-minute estimate that shows
// in both the countdown and the cycle-length field.
const TIME_DRY = buf(
    'aaff300a0066004f48000100ec005400000300021300000000a000000100000200000413000000000000810700000000000000000000000000000002000215000000001e001e0100000200000415000000000000810700000000000000000000000000b665bb',
)

// The AI dial position: cloud course:"AI_COURSE". This is the one place rec[5] and rec[20] disagree:
// 44 on the dial, 28 for the cycle it loads, so it is what proves rec[5] is the field the cloud names.
const AI_COURSE = buf(
    'aaff300a0066004f5d000100ec005400000200020400000000c3001e010000020000040400000000000081070000000000000000000000000000000200022c0000000064001e010000000000041c00000000000481070000000000000000000000000039cabb',
)

// Towels: cloud course:"TOWELS" with detectLoad:"DETECT_LOAD_ON" (rec[26] bit 0x04).
const TOWELS = buf(
    'aaff300a0066004f51000100ec00540000030002100000000096001e01000001000004100000000000008107000000000000000000000000000000020002020000000064001e0100000000000402000000000004810700000000000000000000000000e470bb',
)

// Mid-run on Bedding: cloud course:"BEDDING", state:"DRYING" with preState:"PAUSE" (this frame is the
// resume), remainTimeMinute:193 against an initialTimeMinute of 195, courseSpendPower:3.
const DRYING = buf(
    'aaff300a0066004e58000100ec005400000200020400000000c200c3070300020002040400000000004081070000000000000000000000000000000200020400000000c100c30703000200030404000000000040810700000000000000000000000000959ebb',
)

// Dry level stepped to the top: cloud dryLevel:"DRYLEVEL_VERYDRY" (rec[1] = 5).
const DRY_LEVEL_VERY = buf(
    'aaff300a0066004f13000100ec00540004020002070000000064000001000000000004070000002000048107000000000000000000000000000005020002070000000064000001000000000004070000002000048107000000000000000000000000004992bb',
)

// Eco Hybrid stepped to Eco: cloud ecoHybrid:"ECOHYBRID_ECO" (rec[2] = 1), with the dry level parked
// at Iron in the same record.
const ECO_HYBRID_ECO = buf(
    'aaff300a0066004f05000100ec005400030200020700000000640000010000000000040700000020000481070000000000000000000000000000030100020700000000640000010000000000040700000020000481070000000000000000000000000002b3bb',
)

// Buzzer turned off: cloud buzzer:"BUZZER_OFF" (rec[19] = 0). Unlike the RV13B6ES, this model's beeper
// setting is reported by the cloud, so the scale is confirmed rather than read off the panel LEDs.
const BUZZER_OFF = buf(
    'aaff300a0066004f26000100ec005400030200020700000000640000010000000000040700000000000481070000000000000000000000000000030200020700000000640000010000000000000700000000000481070000000000000000000000000000b1bb',
)

// Wrinkle Care on: cloud wrinkleCare:"WRINKLECARE_ON" (rec[24] bit 0x08), with the neighbouring bits
// in the same byte clear.
const WRINKLE_CARE_ON = buf(
    'aaff300a0066004f3b000100ec00540003020002070000000064000001000000000004070000000000048107000000000000000000000000000003020002070000000064000001000000000004070000000800048107000000000000000000000000002692bb',
)

// Damp Dry Beep on: cloud dampDryBeep:"DAMPDRYBEEP_ON" (rec[24] bit 0x40), the other bit of that byte.
const DAMP_DRY_BEEP_ON = buf(
    'aaff300a0066004f20000100ec005400030200020700000000640000010000000000040700000000000481070000000000000000000000000000030200020700000000640000010000000000040700000040000481070000000000000000000000000086bfbb',
)

// Remote Start enabled at the panel: rec[26] went 0x04 to 0x44 with nothing else in the record moving,
// and the cloud reported remoteStart:"REMOTE_START_ON" in the same notification.
const REMOTE_START_ON = buf(
    'aaff300a0066004f6b000100ec00540003020002070000000064001e01000000000004070000000000048107000000000000000000000000000003020002070000000064001e0100000000000407000000000044810700000000000000000000000000a3d4bb',
)

// Paused: cloud state:"PAUSE" with preState:"DRYING", and the drum light coming on with it
// (rec[24] bit 0x20, cloud drumLight:"DRUMLIGHT_ON").
const PAUSES = buf(
    'aaff300a0066004e86000100ec005400000200020400000000bf00c3070300020006040400000000004081070000000000000000000000000000000200020400000000bf00c303070002000a0404000000200000810700000000000000000000000000e6fdbb',
)

// Powered off from the pause: cloud state:"POWEROFF" with preState:"PAUSE". The course and the timers
// clear, but the 10 Wh the part-run used is still in rec[17:19].
const POWERS_OFF = buf(
    'aaff300a0066004e8f000100ec005400000200020400000000bf00c303070002000a04040000002000008107000000000000000000000000000000000002000000000000000000030000000a0400000000000000810700000000000000000000000000f3b5bb',
)

// The end of a 195-minute Bedding cycle: state 7 DRYING gives way to 17 CONDENSER_CLEAN and rec[26]
// goes 0x40 to 0x60 in the same frame, the previous-state record still holding the old pair. The cloud
// feed had lapsed an hour earlier, so this frame is confirmed against the state byte beside it; the
// cloud pairing came from a later run, in CONDENSER_CLEAN_CLOUD below.
const CONDENSER_CLEAN = buf(
    'aaff300a0066005f34000100ec0054000002000204000000001500c30703000406f70404000000000040830700000000000000000000000000000002000204000000001400c31107000506fd0404000000000060830700000000000000000000000000ed51bb',
)

// Five minutes later the condenser clean ends: state 17 gives way to 8 COOLING and the 0x20 bit clears
// again, which is the other half of the pairing.
const COOLING = buf(
    'aaff300a0066005f7f000100ec0054000002000204000000001000c31107000507040404000000000060830700000000000000000000000000000002000204000000001000c30811000507060404000000000040830700000000000000000000000000c820bb',
)

// The same cycle finishing. Because it had been remote-started, it settles into state 22
// END_REMOTE_MAINTAIN_ON rather than 4 END, and lights the drum as it does so.
const END_REMOTE_MAINTAIN = buf(
    'aaff300a0066006060000100ec0054000002000204000000000100c30811000507180404000000000040830700000000000000000000000000000002000204000000000100c316080007071a0404000000200040830700000000000000000000000000c4ebbb',
)

// Remote Maintain coming on as a Normal cycle reaches DRYING: rec[27] goes 0x81 to 0x83 between the
// previous-state and current-state records, and the cloud reported remoteMaintain:"REMOTE_MAINTAIN_ON"
// in the same second.
const REMOTE_MAINTAIN_ON = buf(
    'aaff300a0066006191000100ec0054000302000207000000006400640e0100000000040700000000004481070000000000000000000000000000030200020700000000680069070e0002000a040700000000004083070000000000000000000000000000a8bb',
)

// And going off again as the previous cycle's remote-maintain end is powered off: 0x83 back to 0x81,
// with the cloud reporting REMOTE_MAINTAIN_OFF a second later.
const REMOTE_MAINTAIN_OFF = buf(
    'aaff300a00660060fe000100ec0054000002000204000000000100c316080007071a04040000000000408307000000000000000000000000000000000002000000000000000000160000071c0400000000000000810700000000000000000000000000b025bb',
)

// Remote Start switched OFF at the panel with the machine idle: rec[26] goes 0x44 to 0x04 and the
// cloud reports remoteStart:"REMOTE_START_OFF", which is what shows the bit is the setting itself.
const REMOTE_START_SWITCHED_OFF = buf(
    'aaff300a0066007b9f000100ec0054000302000207000000006400000100000000000407000000000044810700000000000000000000000000000302000207000000006400000100000000000407000000000004810700000000000000000000000000bd50bb',
)

// And a cycle started BY HAND moments later, with the setting still off: the byte goes straight back
// to 0x44 as the machine enters DETECTING and the cloud reports REMOTE_START_ON again. The appliance
// turns the setting on by itself when a cycle starts, which the matching LG range exposes as its
// "Auto Remote" setting and this dryer does not.
const HAND_STARTED_WITH_REMOTE_OFF = buf(
    'aaff300a0066006eac000100ec0054000000000200000000000000000100000000000400000000200000810700000000000000000000000000000302000207000000006400640e010000000004070000000000448107000000000000000000000000002823bb',
)

// The same transition on a later run with the feed live, which names the field: the cloud reported
// selfCleaning:"SELFCLEANING_ON" with state "CONDENSER_CLEAN" in the frame rec[26] went 0x40 to 0x60.
const CONDENSER_CLEAN_CLOUD = buf(
    'aaff300a006600738c000100ec005400030200020700000000150055070e000402500407000000000040830700000000000000000000000000000302000207000000001400551107000502590407000000000060830700000000000000000000000000b6f9bb',
)

// Cycle Optimization switched off from the app and back on, cloud autoCourseArrange OFF then ON.
// rec[27] bit 0x01 is the only bit of the record to move either way, which is what separates it from
// the remote maintain bit sharing the byte.
const CYCLE_OPTIMIZATION_OFF = buf(
    'aaff300a0066007c2e000100ec0054000301000207000000006400640100000000000407000000200004810700000000000000000000000000000302000207000000006400640100000000000407000000200004800700000000000000000000000000aaf8bb',
)
const CYCLE_OPTIMIZATION_ON = buf(
    'aaff300a0066007c61000100ec0054000302000207000000006400640100000000000207000000200004800700000000000000000000000000000302000207000000006400640100000000000207000000200004810700000000000000000000000000ee33bb',
)

// Three cycles reachable only from the app, none of them on the dial. Quick Dry, which the cloud
// calls BABYWEAR while calling a different cycle QUICKDRY, and Shrinkage Relief, where rec[5] reads
// 46 for CLOTHCARE while rec[20] loads 32 for LOWTEMPDRY.
const APP_QUICK_DRY = buf(
    'aaff300a0066007d2d000100ec005400000000020d000000001e001e010000050000020d000000000000810700000000000000000000000000000002000217000000003c001e0100000200000217000000000000810700000000000000000000000000662cbb',
)
const APP_SHRINKAGE_RELIEF = buf(
    'aaff300a0066007d1e000100ec0054000003000216000000003c001e010000010000021600000000000081070000000000000000000000000000020200022e000000006e001e0100000200000220000000000000810700000000000000000000000000f7e8bb',
)

// A cycle pushed to the appliance from the app: rec[5] is the 255 DOWNLOAD sentinel rather than a
// course code, and which cycle it actually is sits in rec[23]. Cloud: course "DOWNLOAD" with
// downloadCourse "MINIMIZEWRINKLES", which the panel calls Wrinkle Prevention.
const DOWNLOADED_CYCLE = buf(
    'aaff300a0066007d52000100ec00540000030002320000000028001e01000002000002220000000000008107000000000000000000000000000003020002ff000000006400280100000000000207000072080004810700000000000000000000000000ede3bb',
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

describe('BDH_D30007_US', () => {
    test('the course table covers the whole dial', () => {
        assert.equal(feed([TUB_CLEAN]).course, 'Drum Care')
        assert.equal(feed([TIME_DRY]).course, 'Timed Dry')
        assert.equal(feed([TOWELS]).course, 'Towels')
        assert.equal(feed([DRYING]).course, 'Bedding')
        assert.equal(feed([DRY_LEVEL_VERY]).course, 'Normal')
    })

    test('cycles reachable only from the app are named from the panel, not the cloud', () => {
        // The cloud calls this one BABYWEAR. The panel calls it Quick Dry, and calls the cycle the
        // cloud names QUICKDRY "Small Load", so publishing LG's identifiers would swap the two.
        assert.equal(feed([APP_QUICK_DRY]).course, 'Quick Dry')
        assert.equal(feed([TIME_DRY]).course, 'Timed Dry')

        // rec[5] and rec[20] part company here as well as on the AI position
        assert.equal(feed([APP_SHRINKAGE_RELIEF]).course, 'Shrinkage Relief')
    })

    test('a downloaded cycle is a sentinel course plus its own identifier', () => {
        const p = feed([DOWNLOADED_CYCLE])
        assert.equal(p.course, 'Downloaded cycle') // rec[5] is 255, cloud course DOWNLOAD
        assert.equal(p.download_course, 'Wrinkle Prevention') // cloud downloadCourse MINIMIZEWRINKLES

        // and an ordinary cycle reports no downloaded one
        assert.equal(feed([TOWELS]).download_course, 'None')
    })

    test('the AI dial position is read from rec[5], not the loaded-cycle byte', () => {
        // rec[5] is 44 and rec[20] is 28 in this frame; the cloud calls it AI_COURSE, which is rec[5].
        // The panel calls that position "AI Dry", which is the name published.
        const p = feed([AI_COURSE])
        assert.equal(p.course, 'AI Dry')
    })

    test('the minute counters are big-endian, unlike the matching washer', () => {
        // 160 arrives as 00 a0. Read little-endian this would be 41 minutes.
        const tub = feed([TUB_CLEAN])
        assert.equal(tub.remaining_time, 160)

        // and a course where the countdown and the cycle length differ
        const drying = feed([DRYING])
        assert.equal(drying.remaining_time, 193)
        assert.equal(drying.initial_time, 195)
        assert.equal(drying.spent_power, 3) // cloud: courseSpendPower 3 Wh
    })

    test('dry level and eco hybrid each read from their own byte', () => {
        const very = feed([DRY_LEVEL_VERY])
        assert.equal(very.dry_level, 'Very Dry') // cloud: DRYLEVEL_VERYDRY
        assert.equal(very.eco_hybrid, 'Normal')

        const eco = feed([ECO_HYBRID_ECO])
        assert.equal(eco.eco_hybrid, 'Eco') // cloud: ECOHYBRID_ECO
        assert.equal(eco.dry_level, 'Iron') // and the dry level is undisturbed

        assert.equal(feed([TUB_CLEAN]).eco_hybrid, 'Turbo')
        // a course that does not sense dryness reports the 0 sentinel, not a level
        assert.equal(feed([TUB_CLEAN]).dry_level, 'None')
    })

    test('the buzzer volume is cloud-confirmed on this model', () => {
        assert.equal(feed([BUZZER_OFF]).buzzer, 'Off') // cloud: BUZZER_OFF
        assert.equal(feed([TUB_CLEAN]).buzzer, '4') // cloud: BUZZER_4
    })

    test('wrinkle care, the drum light and the damp dry beep share rec[24] without collision', () => {
        const wrinkle = feed([WRINKLE_CARE_ON])
        assert.equal(wrinkle.wrinkle_care, 'ON')
        assert.equal(wrinkle.damp_dry_beep, 'OFF')
        assert.equal(wrinkle.drum_light, 'OFF')

        const beep = feed([DAMP_DRY_BEEP_ON])
        assert.equal(beep.damp_dry_beep, 'ON')
        assert.equal(beep.wrinkle_care, 'OFF')
        assert.equal(beep.drum_light, 'OFF')
    })

    test('cycle optimization is the low bit of the byte remote maintain sits in', () => {
        const off = feed([CYCLE_OPTIMIZATION_OFF])
        assert.equal(off.cycle_optimization, 'OFF') // cloud: autoCourseArrange OFF
        assert.equal(off.remote_maintain, 'OFF') // 0x02 of the same byte, untouched

        const on = feed([CYCLE_OPTIMIZATION_ON])
        assert.equal(on.cycle_optimization, 'ON') // cloud: autoCourseArrange ON
        assert.equal(on.remote_maintain, 'OFF')

        // and it reads on through a run, where remote maintain is on beside it
        assert.equal(feed([DRYING]).cycle_optimization, 'ON')
        assert.equal(feed([DRYING]).remote_maintain, 'OFF')
    })

    test('remote start is the setting, which the appliance switches on at every cycle start', () => {
        // Switched off at the panel with the machine idle, which is the half that shows the bit is
        // the setting and not merely "a cycle is running".
        const off = feed([REMOTE_START_SWITCHED_OFF])
        assert.equal(off.remote_start, 'OFF') // cloud: remoteStart REMOTE_START_OFF
        assert.equal(off.status, 'Initial')
        assert.equal(off.detect_load, 'ON') // 0x04 of the same byte is untouched

        // Then a cycle started by hand, with the setting still off, brings it back by itself.
        const started = feed([REMOTE_START_SWITCHED_OFF, HAND_STARTED_WITH_REMOTE_OFF])
        assert.equal(started.status, 'Detecting') // cloud: state DETECTING
        assert.equal(started.pre_state, 'Initial')
        assert.equal(started.remote_start, 'ON') // cloud: remoteStart REMOTE_START_ON
        assert.equal(started.course, 'Normal')
    })

    test('remote start and detect load share rec[26]', () => {
        const remote = feed([REMOTE_START_ON])
        assert.equal(remote.remote_start, 'ON')
        assert.equal(remote.detect_load, 'ON')

        const towels = feed([TOWELS])
        assert.equal(towels.detect_load, 'ON')
        assert.equal(towels.remote_start, 'OFF')

        // Tub Clean does not weigh a load, so the bit is clear there
        assert.equal(feed([TUB_CLEAN]).detect_load, 'OFF')
    })

    test('the condenser clean flag tracks the state that names it', () => {
        const clean = feed([CONDENSER_CLEAN])
        assert.equal(clean.status, 'Condenser clean')
        assert.equal(clean.condenser_clean, 'ON')
        assert.equal(clean.remote_start, 'ON') // the run was remote-started, and 0x40 stays up

        const cooling = feed([CONDENSER_CLEAN, COOLING])
        assert.equal(cooling.status, 'Cooling')
        assert.equal(cooling.pre_state, 'Condenser clean')
        assert.equal(cooling.condenser_clean, 'OFF')
        assert.equal(cooling.remote_start, 'ON')

        // and it is clear on a course that never runs one
        assert.equal(feed([TUB_CLEAN]).condenser_clean, 'OFF')

        // the same transition with the cloud watching, which is what named the field
        const witnessed = feed([CONDENSER_CLEAN_CLOUD])
        assert.equal(witnessed.status, 'Condenser clean') // cloud: state CONDENSER_CLEAN
        assert.equal(witnessed.condenser_clean, 'ON') // cloud: selfCleaning SELFCLEANING_ON
        assert.equal(witnessed.pre_state, 'Drying')
    })

    test('a remote-started cycle ends into the remote-maintain state, not plain End', () => {
        const p = feed([COOLING, END_REMOTE_MAINTAIN])
        assert.equal(p.status, 'End remote maintain on')
        assert.equal(p.pre_state, 'Cooling')
        assert.equal(p.power, 'ON')
        assert.equal(p.remaining_time, 1)
        assert.equal(p.spent_power, 1818) // what the whole 195-minute Bedding cycle used
        assert.equal(p.drum_light, 'ON')
    })

    test('remote maintain is rec[27] bit 0x02, not part of either options byte', () => {
        const on = feed([REMOTE_MAINTAIN_ON])
        assert.equal(on.status, 'Drying') // cloud: state DRYING
        assert.equal(on.remote_maintain, 'ON') // cloud: remoteMaintain REMOTE_MAINTAIN_ON

        const off = feed([REMOTE_MAINTAIN_OFF])
        assert.equal(off.status, 'Off') // cloud: state POWEROFF
        assert.equal(off.pre_state, 'End remote maintain on')
        assert.equal(off.remote_maintain, 'OFF') // cloud: remoteMaintain REMOTE_MAINTAIN_OFF

        // and it is clear on a course selected but never started
        assert.equal(feed([TUB_CLEAN]).remote_maintain, 'OFF')
    })

    test('pausing lights the drum and keeps the state it came from', () => {
        const p = feed([PAUSES])
        assert.equal(p.status, 'Pause') // cloud: state PAUSE
        assert.equal(p.pre_state, 'Drying') // cloud: preState DRYING
        assert.equal(p.drum_light, 'ON') // cloud: drumLight DRUMLIGHT_ON
        assert.equal(p.remaining_time, 191)
        assert.equal(p.power, 'ON')

        const resumed = feed([PAUSES, DRYING])
        assert.equal(resumed.status, 'Drying')
        assert.equal(resumed.pre_state, 'Pause')
        assert.equal(resumed.drum_light, 'OFF')
    })

    test('powering off clears the cycle but not the energy it used', () => {
        const p = feed([PAUSES, POWERS_OFF])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off') // cloud: state POWEROFF
        assert.equal(p.pre_state, 'Pause') // cloud: preState PAUSE
        assert.equal(p.course, 'None') // the course byte resets to 0
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.spent_power, 10) // what the part-run had used
    })

    test('start() requests a status snapshot, so a reconnect does not leave HA blank', () => {
        // Without this the driver is purely passive: the dryer only volunteers a frame when something
        // changes, so after a restart HA would sit at unknown until someone touched the machine.
        const { thinq, dev } = makeDevice()
        dev.start()

        // AA | length | 0xF0ED status query | checksum | BB. LG's own query, taken verbatim from the
        // cloud's traffic and byte for byte the same one it sends the matching washer.
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa12f0ed1121010000001804111200005ebb'],
        )
    })

    test('frames that are not status records publish nothing', () => {
        const junk = [
            'aa0730d82b91bb', // short 0xd8 heartbeat
            'aa09307200c80048bb', // 0x72 ping
            'aaff300a0066004f45000100ec0054000302000207', // truncated 0xEC
            // a washer frame: right shape, wrong class byte, must not be decoded with dryer offsets
            'aaff200a00a2001002000100ec00900aff000e000000000000000000000100000001002e0001006400000e2004ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000002700270000002e0101006400000e2004ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff01000049b8bb',
        ]
        for (const frame of junk) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(frame))
            assert.deepEqual(ha.devices[DEVICE_ID]?.properties ?? {}, {}, `frame ${frame} should publish nothing`)
        }
    })
})
