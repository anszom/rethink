import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RC90U2_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RC90U2_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.9.61' }

// All fixtures are REAL frames captured live from an RC9DN9029 via rethink on 2026-09-08 while
// driving the panel; the comments say what the panel showed. Field meanings come from LG's modelJson
// for RC90U2_WW, whose Monitoring.protocol the 25-byte record follows byte for byte.

// Reply to the F0ED status request: on, Cotton selected, Cupboard, Eco, estimate 2:30.
const EB_READY_COTTON = buf('aa2130eb001901021e00000700030102000000000804000000000000006b00f1bb')

// Power button: Ready/Cotton -> Off. The off record keeps the option base bits and shows 01 at byte 19.
const POWER_OFF = buf(
    'AA3C30EC001901021E00000700030102000000000804000000000000006B00001900000000000000000000000000000804000000010000006B0004BB',
)
// Power button again: Off -> on with no course yet (all course fields zero).
const POWER_ON_NO_COURSE = buf(
    'AA3C30EC001900000000000000000000000000000804000000010000006B00001901000000000000000000000000000804000000000000006B0071BB',
)
// Knob: -> Mixed Fabric, Cupboard, Eco Hybrid "Time", estimate 1:10.
const COURSE_MIXED = buf(
    'AA3C30EC001901021E00000700030102000000000804000000000000006B00001901010A00000600030302000000000804000000000000006B003FBB',
)
// Knob: -> Duvet, no dry level (timed course), Eco Hybrid "Time", estimate 2:55.
const COURSE_DUVET = buf(
    'AA3C30EC001901010A00000600030302000000000804000000000000006B00001901023700000400000302000000000804000000000000006B002ABB',
)
// Delay End button: reserve hours 0 -> 3 in both reserve fields and Option1 bit 0 set (0x08 -> 0x09).
const DELAY_END_ON = buf(
    'AA3C30EC001901021E00000700030102000000000804000000000000006B00001901021E00000700030102030003000904000000000000006B00D0BB',
)
// Dry level button: Cotton Cupboard/Eco -> Cotton Iron/Time, estimate 1:30.
const DRY_LEVEL_IRON = buf(
    'AA3C30EC001901021E00000700030102000000000804000000000000006B00001901011E00000700010302000000000804000000000000006B0028BB',
)
// Knob: Allergy Care, timed course (no dry level), Eco Hybrid "Time", 3:00.
const COURSE_ALLERGY_CARE = buf(
    'AA3C30EC001901023700000400000302000000000004000000000000006B00001901030000001000000302000000000004000000000000006B003BBB',
)
// Knob: the Downloaded Course position, holding Deodorization (rec[20] = 0x6B on base course 0x01), 0:39.
const COURSE_DOWNLOADED_DEODORIZATION = buf(
    'AA3C30EC001901001E00000900000302000000000004000000000000006B00001901002700000100000304000000000004000000006B00006B008FBB',
)
// Knob: Cool Air, no Eco Hybrid, sub-phase byte 5 (cooling) while idle, 1:00.
const COURSE_COOL_AIR = buf(
    'AA3C30EC001901010F00000E00000102000000000004000000000000006B00001901010000000D00000005000000000004000000000000006B001DBB',
)
// Start button on Cool Air 0:30: State 01 -> 02, initial time filled in, ProcessState 5 (cooling).
const START_COOL_AIR = buf(
    'AA3C30EC001901001E00000D00000005000000000004000000000000006B00001902001E001E0D00000005000000000005000000010000006B00C0BB',
)
// Short 0x72 frame seen right after Start; must be ignored.
const START_EVENT = buf('AA09307200C9004BBB')
// Serial/part-number frame sent on connect; must be ignored.
const SERIAL_FRAME = buf(
    'AA3730310201534141333939333530303900007FD200008000000000000253414133393933343931320000A36700004000000000000FBB',
)
// Five-byte power events around power toggles; must be ignored.
const POWER_EVENT = buf('AA07301900AFBB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, props: () => ha.devices[DEVICE_ID].properties }
}

describe(MODEL_ID, () => {
    test('start() asks for a status snapshot with the family-wide F0ED request', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa0ef0ed1121010000001800b5bb'],
        )
    })

    test('0xEB reply decodes Ready / Cotton / Cupboard / Eco / 2:30', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_READY_COTTON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.phase, 'None') // sub-phase is stale while idle
        assert.equal(props.course, 'Cotton')
        assert.equal(props.dry_level, 'Cupboard')
        assert.equal(props.eco_hybrid, 'Eco')
        assert.equal(props.remaining_time, 150)
        assert.equal(props.initial_time, 0)
        assert.equal(props.reserve_time, 0)
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.delay, 'OFF')
        assert.equal(props.anti_crease, 'No')
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.energy, 0)
    })

    test('0xEC frames use the second (current) record: power off keeps the course selects', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_READY_COTTON)
        thinq.emit('data', POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        // the selects are also what Start selected cycle sends, so they keep the last course
        assert.equal(props.course, 'Cotton')
        assert.equal(props.dry_level, 'Cupboard')
        assert.equal(props.eco_hybrid, 'Eco')
        assert.equal(props.remaining_time, 0)
    })

    test('power on without a course reads Ready and leaves the course select alone', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.start()
        thinq.emit('data', POWER_ON_NO_COURSE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton') // the default
        assert.equal(props.remaining_time, 0)
    })

    test('course knob: Mixed Fabric and Duvet with their defaults', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COURSE_MIXED)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Mixed Fabric')
        assert.equal(props.dry_level, 'Cupboard')
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.remaining_time, 70)

        thinq.emit('data', COURSE_DUVET)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Duvet')
        assert.equal(props.dry_level, 'Cupboard') // timed course, no dry level: the select keeps the last one
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.remaining_time, 175)
    })

    test('timed courses, a downloaded course and Cool Air decode from the knob sweep', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COURSE_ALLERGY_CARE)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.dry_level, 'Cupboard') // timed course, no dry level: the select keeps its default
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.remaining_time, 180)

        thinq.emit('data', COURSE_DOWNLOADED_DEODORIZATION)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Deodorization') // downloaded course overrides base course 0x01
        assert.equal(props.remaining_time, 39)

        thinq.emit('data', COURSE_COOL_AIR)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cool Air')
        assert.equal(props.eco_hybrid, 'Time') // Cool Air has no Eco Hybrid: the select keeps the last one
        assert.equal(props.phase, 'None') // sub-phase is not published while idle
        assert.equal(props.remaining_time, 60)
    })

    test('Delay End sets the reserve time and the Reservation option bit', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DELAY_END_ON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.delay, 'ON')
        assert.equal(props.reserve_time, 180)
        assert.equal(props.course, 'Cotton')
        // the always-on base bit 0x08 must not leak into any option entity
        assert.equal(props.anti_crease, 'No')
        assert.equal(props.child_lock, 'OFF')
    })

    test('dry level button: Cupboard -> Iron changes the estimate', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRY_LEVEL_IRON)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.dry_level, 'Iron')
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.remaining_time, 90)
    })

    test('Start on Cool Air: Running with the cooling phase and the full time left', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', START_COOL_AIR)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Running')
        assert.equal(props.phase, 'Cooling')
        assert.equal(props.course, 'Cool Air')
        // no dry level nor Eco Hybrid on Cool Air: the selects keep their defaults
        assert.equal(props.dry_level, 'Cupboard')
        assert.equal(props.eco_hybrid, 'Eco')
        assert.equal(props.remaining_time, 30)
        assert.equal(props.initial_time, 30)
        assert.equal(props.delay, 'OFF')
        assert.equal(props.error, 'OFF')
        assert.equal(props.remote_start, 'ON') // held while a cycle runs
        assert.equal(props.energy, 0)
    })

    test('serial, power-event and start-event frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SERIAL_FRAME)
        thinq.emit('data', POWER_EVENT)
        thinq.emit('data', START_EVENT)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('a 0xEC frame with a wrong length is rejected', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('aa0830ec0019010000bb'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})

// Commands, energy and Remote start, with real frames from a second RC90U2 (cash83/rethink-lan-addon).
describe(`${MODEL_ID} commands`, () => {
    // Off after a completed cycle: everything zeroed except the retained cycle energy (0x04f1 = 1265 Wh).
    const IDLE = buf('aa2130eb0019000000000000000000000000000000040004f1040000006b0032bb')
    // Paused inside a Mixed Fabric cycle, Extra, Time: 43 min left of 1:20, 964 Wh so far.
    const PAUSED = buf('aa2130eb001903002b011406000403040000000000040003c4020000006b00debb')
    // The moment the same cycle starts: the energy counter restarts.
    const STARTED = buf(
        'aa3c30ec001902011401140600040302000000000005500000010000006b00001902011401140600040302000000000005000000010000006b0089bb',
    )
    // Panel, Cotton at 2:30: Anti crease switched on (Option1 bit 1) and, 37 s later, Remote Start held
    // on (Option2 bit 0). Both matched against the icons on the display.
    const ANTI_CREASE_ON = buf(
        'aa3c30ec001901021e00000700030102000000000004000000000000006b00001901021e00000700030102000000000204000000000000006b0025bb',
    )
    const REMOTE_START_ON = buf(
        'aa3c30ec001901021e00000700030102000000000005200000000000006b00001901021e00000700030102000000000005000000000000006b00c5bb',
    )
    // Ready on Cotton before and after downloading "Full Size Load" from the ThinQ app: SmartCourse
    // 00 -> 74, the dry level 00 -> 04 and the time 2:30 -> 2:40.
    const READY_COTTON = buf('aa2130eb001901021e0300070000030200000000000500000003000000000062bb')
    const READY_DOWNLOADED = buf('aa2130eb00190102280300070004030200000000000500000003740000740078bb')

    const WRITE_STATUS_REQUEST = 'AA0EF0ED1121010000001800B5BB'
    const WRITE_POWER_ON = 'AA08F02A010098BB'
    const WRITE_POWER_OFF = 'AA09F0240101009CBB'
    const WRITE_START_PAUSE = 'AA09F02404010099BB'

    test('off: the last cycle energy is retained', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', IDLE)
        assert.equal(props().power, 'OFF')
        assert.equal(props().energy, 1265)
        assert.equal(props().remote_start, 'OFF')
    })

    test('paused and started frames: course, settings, times, phase and energy', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', PAUSED)
        assert.equal(props().status, 'Paused')
        assert.equal(props().phase, 'Drying')
        assert.equal(props().course, 'Mixed Fabric')
        assert.equal(props().dry_level, 'Extra')
        assert.equal(props().eco_hybrid, 'Time')
        assert.equal(props().remaining_time, 43)
        assert.equal(props().initial_time, 80)
        assert.equal(props().energy, 964)
        assert.equal(props().remote_start, 'OFF', 'dropped in pause')

        thinq.emit('data', STARTED)
        assert.equal(props().status, 'Running')
        assert.equal(props().remaining_time, 80)
        assert.equal(props().energy, 0)
    })

    test('Anti crease and Remote start are separate bits', () => {
        const a = makeDevice()
        a.thinq.emit('data', ANTI_CREASE_ON)
        assert.equal(a.props().anti_crease, 'Yes')
        assert.equal(a.props().remote_start, 'OFF')

        const b = makeDevice()
        b.thinq.emit('data', REMOTE_START_ON)
        assert.equal(b.props().anti_crease, 'No')
        assert.equal(b.props().remote_start, 'ON')
    })

    test('a course downloaded from the app is shown, but not started remotely', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', READY_DOWNLOADED)
        assert.equal(props().course, 'Full Size Load')
        assert.equal(props().dry_level, 'Extra')
        assert.equal(props().remaining_time, 160)

        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('the panel is mirrored into the selects, without overriding a choice made in HA', () => {
        const { thinq, dev, props } = makeDevice()
        dev.start()
        assert.equal(props().course, 'Cotton', 'default')

        thinq.emit('data', PAUSED)
        assert.equal(props().course, 'Mixed Fabric')
        assert.equal(props().dry_level, 'Extra')
        assert.equal(props().eco_hybrid, 'Time')

        dev.setProperty('course', 'Quick Dry')
        thinq.emit('data', PAUSED)
        assert.equal(props().course, 'Quick Dry', 'an unchanged appliance value does not overwrite HA')

        thinq.emit('data', READY_COTTON)
        assert.equal(props().course, 'Cotton', 'a new value on the dial does')
    })

    test('Start selected cycle sends F0 26 with the selected settings', () => {
        const { thinq, dev, props } = makeDevice()
        dev.start()
        assert.equal(props().dry_level, 'Cupboard')
        assert.equal(props().eco_hybrid, 'Eco')
        assert.equal(props().anti_crease, 'No')
        assert.equal(props().start_delay_end, 0)

        dev.setProperty('course', 'Mixed Fabric')
        dev.setProperty('dry_level', 'Extra')
        dev.setProperty('eco_hybrid', 'Time')
        dev.setProperty('anti_crease', 'Yes')

        thinq.resetRecorder()
        dev.setProperty('start', '')
        // course 0x06, dry level 0x04, Time 0x03, [11] Anti crease, [12] operation 0x01
        assert.equal(hex(thinq.outbox.pop()!), 'AA14F0260604030000000000000201000000B1BB')

        // an unknown value is ignored rather than encoded
        dev.setProperty('course', 'Not a course')
        assert.equal(props().course, 'Mixed Fabric')
    })

    test('Start selected cycle sends only what the course takes', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        dev.setProperty('dry_level', 'Extra')
        dev.setProperty('eco_hybrid', 'Eco')

        // Quick Dry has no dry level and runs on Time only
        dev.setProperty('course', 'Quick Dry')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox.pop()!), 'AA14F0260900030000000000000001000000B4BB')

        // Rack Dry is time-based: its 180 minutes go into [5]
        dev.setProperty('course', 'Rack Dry')
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox.pop()!), 'AA14F0260C0001B400000000000001000000C3BB')

        // Easy Care has Iron and Cupboard only: Extra falls back to its default, Cupboard
        dev.setProperty('course', 'Easy Care')
        dev.setProperty('start', '')
        const cmd = thinq.outbox.pop()!
        assert.equal(cmd[5], 0x03)
        assert.equal(cmd[6], 0x01, 'Eco is kept')
    })

    test('Delay end of the next start: clamped to 3..19 h, goes into [8] and is cleared after a start', () => {
        const { thinq, dev, props } = makeDevice()
        dev.start()
        dev.setProperty('course', 'Cotton Soft')
        dev.setProperty('eco_hybrid', 'Time')

        // Same course, Eco Hybrid and delay as the ThinQ app's own "end in 3 hours" on Cotton Soft.
        dev.setProperty('start_delay_end', '3')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        const cmd = thinq.outbox.pop()!
        assert.equal(cmd[4], 0x02) // Cotton Soft
        assert.equal(cmd[6], 0x03) // Time
        assert.equal(cmd[10], 3) // hours
        assert.equal(props().start_delay_end, 0, 'cleared after the start')

        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.pop()![10], 0, 'the next start is not delayed')

        assert.equal(DUT.clampDelay('1'), 3)
        assert.equal(DUT.clampDelay('25'), 19)
        assert.equal(DUT.clampDelay('0'), 0)
        assert.equal(DUT.clampDelay('nope'), 0)
    })

    test('mid-cycle, F0 26 is preceded by a pause', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STARTED)
        dev.setProperty('course', 'Quick Dry')
        thinq.resetRecorder()

        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]!), WRITE_START_PAUSE)

        tickMockTimers(t, 1300)
        assert.equal(thinq.outbox.length, 2)
        assert.ok(hex(thinq.outbox[1]!).startsWith('AA14F02609'))
    })

    test('a reconnect keeps the choices made in HA', () => {
        const { ha, thinq, dev, props } = makeDevice()
        thinq.emit('data', PAUSED)
        dev.setProperty('course', 'Quick Dry')
        dev.setProperty('start_delay_end', '4')

        const thinqAgain = new MockThinq2Device(DEVICE_ID, META)
        const replacement = new DUT(ha.asConnection(), thinqAgain, META)
        replacement.takeOver(dev)
        replacement.start()
        thinqAgain.emit('data', PAUSED)

        assert.equal(props().course, 'Quick Dry')
        assert.equal(props().start_delay_end, 4)
    })

    test('status request on start, power and Start/Pause commands', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(hex(thinq.outbox.pop()!), WRITE_STATUS_REQUEST)

        dev.setProperty('power', 'ON')
        assert.equal(hex(thinq.outbox.pop()!), WRITE_POWER_ON)
        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox.pop()!), WRITE_POWER_OFF)
        dev.setProperty('start_pause', '')
        assert.equal(hex(thinq.outbox.pop()!), WRITE_START_PAUSE)
    })
})

// RC90V9_WW (RC91V9EV2Q) uses the same records; live captures over a Cotton / Extra / Eco cycle.
describe('RC90V9_WW', () => {
    const meta: Metadata = { modelId: 'RC90V9_WW', modelName: 'RC90V9_WW', swVersion: '2.9.61' }
    const QUICK_30 = buf(
        'AA3C30EC001901021400000200000302000000000804000000000000006B00001901001E00000900000302000000000804000000000000006B0038BB',
    )
    const DRYING = buf(
        'AA3C30EC0019020224030007000401020000000000050000AD0100000071000019020224030007000401030000000000050000AE010000007100A5BB',
    )
    const COOLING = buf(
        'AA3C30EC00190200030300070004010400000000000500043F010000007100001902000203000700040105000000002005000444010000007100A8BB',
    )
    const END = buf(
        'AA3C30EC00190200010300070004010500000000200500044801000000710000190400010300070004010700000000000400044902000000710058BB',
    )
    const CHILD_LOCK = buf(
        'AA3C30EC001901000000000000000000000000000004000000000000007100001901000000000000000000000000001004700000000000007100F5BB',
    )

    test('decodes the knob, a full cycle and the child lock', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        new DUT(ha.asConnection(), thinq, meta)
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', QUICK_30)
        assert.deepEqual([props().status, props().course, props().remaining_time], ['Ready', 'Quick Dry', 30])
        thinq.emit('data', DRYING)
        assert.deepEqual(
            [props().status, props().phase, props().course, props().dry_level, props().remaining_time],
            ['Running', 'Drying', 'Cotton', 'Extra', 156],
        )
        assert.equal(props().energy, 174)
        thinq.emit('data', COOLING)
        assert.deepEqual([props().phase, props().remaining_time, props().energy], ['Cooling', 2, 1092])
        thinq.emit('data', END)
        assert.deepEqual([props().status, props().energy], ['End', 1097]) // retained after the cycle
        thinq.emit('data', CHILD_LOCK)
        assert.equal(props().child_lock, 'ON')
    })
})
