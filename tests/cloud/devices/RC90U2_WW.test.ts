import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RC90U2_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

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
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'status',
            'phase',
            'error',
            'error_message',
            'course',
            'dry_level',
            'eco_hybrid',
            'remaining_time',
            'initial_time',
            'reserve_time',
            'delay',
            'anti_crease',
            'child_lock',
            'damp_dry_beep',
            'hand_iron',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Running'))
        assert.ok((components.course.options as string[]).includes('Cotton'))
        assert.ok((components.dry_level.options as string[]).includes('Cupboard'))
    })

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
        assert.equal(props.anti_crease, 'OFF')
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.damp_dry_beep, 'OFF')
        assert.equal(props.hand_iron, 'OFF')
    })

    test('0xEC frames use the second (current) record: power off clears the course fields', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.course, 'None')
        assert.equal(props.dry_level, 'None')
        assert.equal(props.eco_hybrid, 'None')
        assert.equal(props.remaining_time, 0)
    })

    test('power on without a course reads Ready with unknown course', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWER_ON_NO_COURSE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'None')
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
        assert.equal(props.dry_level, 'None') // timed course, no dry level
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.remaining_time, 175)
    })

    test('timed courses, a downloaded course and Cool Air decode from the knob sweep', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COURSE_ALLERGY_CARE)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.dry_level, 'None')
        assert.equal(props.eco_hybrid, 'Time')
        assert.equal(props.remaining_time, 180)

        thinq.emit('data', COURSE_DOWNLOADED_DEODORIZATION)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Deodorization') // downloaded course overrides base course 0x01
        assert.equal(props.remaining_time, 39)

        thinq.emit('data', COURSE_COOL_AIR)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cool Air')
        assert.equal(props.eco_hybrid, 'None')
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
        assert.equal(props.anti_crease, 'OFF')
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
        assert.equal(props.dry_level, 'None')
        assert.equal(props.eco_hybrid, 'None')
        assert.equal(props.remaining_time, 30)
        assert.equal(props.initial_time, 30)
        assert.equal(props.delay, 'OFF')
        assert.equal(props.error, 'OFF')
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
