import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_V8_F___W.B32QEUK'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_V8_F___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.207' }

// Captured from an LG FWY916WBTN1 (modem clip_hna_v1.9.237), November 2026.

// Eco 40-60 selected from Home Assistant, in Standby just before its start
const ECO_STANDBY = buf(
    'AAFF200A003900AE45000100EB0027000001032603260400030A0401000000000000000300000E000000000200000000000000000000D0C7BB',
)
// Eco 40-60, remotely started, washing: door locked and the remote control bit set
const ECO_WASHING = buf(
    'AAFF200A006000F65D000100EC004E000004032603260400030A0401000000004220000101000F000000000200000000000000000000000006022D022D0400030A0401000000004220000104000F000000000200000000000000000000D995BB',
)
// the end of that programme: 254 Wh used, 14 washes since the last Tub Clean
const ECO_END = buf(
    'AAFF200A006000B748000100EC004E0000080001021B0400000A0000000000004000000107000E00000000020000FE0000000000000000000A0000021B040000000000000000004000000108000E00000000020000FE00000000000000CE60BB',
)
// switched off: the record is all zeros but for s[21]
const OFF_ALL_ZERO = buf(
    'AAFF200A006000E9CB000100EC004E00000000000000000000000000000000000000000001000D0071000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000008F07BB',
)
// in Standby with no programme selected, straight after a download: zeros again
const STANDBY_NO_PROGRAMME = buf(
    'AAFF200A006000A59E000100EC004E00000100370037000000000000000000000200000600000E00450000000100000000000000000000000100000000000000000000000000000200000000000000000000000100000000000000000066AABB',
)
// switched on after ECO_END: the count has gone up to 15
const POWER_ON_COUNTED = buf(
    'AAFF200A006000B76B000100EC004E0000000000021B04000000000000000000000000020A000E00000000020000FE0000000000000000000100000000000000000000000000000000000000000F00000000000000FE000000000000001D3ABB',
)
// AI Wash turned to on the dial, with Drain in the download slot
const AI_WASH = buf(
    'AAFF200A006000A2F0000100EC004E00000100000000000000000000000000000000000000000E007900000000000000000000000000000001003B003B3A00030A0401000000000001000200000E007900000400000000000000000000EFFCBB',
)
// Baby Care downloaded from the LG app: Cotton at 60 °C, 1000 rpm, Rinse+, pre wash and medic rinse
const BABY_CARE = buf(
    'AAFF200A006000A41B000100EC004E000001023002302D00030A0601000000804200000400000E00790000050000000000000000000000000104320432010003070602000000504200000500470E0047000005000000000000000000002C95BB',
)
// Dry 30 downloaded from the LG app: Dry Only, drying level 00:30
const DRY_30 = buf(
    'AAFF200A006000A470000100EC004E00000100010001170000010000000000004200000000790E007900000000000000000000000000000001001E001E180000000000030000004200000100430E004300000000000000000000000000858DBB',
)
// Dry Only turned to on the dial, with Air condensing switched on on the panel
const AIR_CONDENSING = buf(
    'AAFF200A006000A312000100EC004E00000100370037180000000000020000000000000600000E00790000000000000000000000000000000101000100180000000000020000080000000600000E007900000000000000000000000000CF99BB',
)
// Rinse + Spin downloaded from Home Assistant, in Standby
const RINSE_SPIN = buf(
    'AAFF200A006000A671000100EC004E000001040D040D010003090601000000400000000400340E003400000500000000000000000000000001001500150E00030A0001000000000000000100640E0064000001000000000000000000007555BB',
)
// Eco 40-60 started from the LG app with a 3 h delayed end
const DELAYED = buf(
    'AAFF200A006000E9EE000100EC004E000004032603260400030A0401000300004220000101000D007100000200000000000000000000000003021B021B0400030A0401000300004220000104000D0071000002000000000000000000001FB8BB',
)
// Eco 40-60 paused
const PAUSED = buf(
    'AAFF200A006000E84A000100EC004E000006021B021B0400030A0401000000004020000104000D007100000200000000000000000000000002021B021B0400030A0401000000004000000206000D00710000020000000000000000000013DDBB',
)

// The washer's answers: 20 00 <command> <result>
const RUN_ACCEPTED = buf('AA0820002600ADBB')
const SELECT_ACCEPTED = buf('AA0820002500A2BB')
const COMMAND_REFUSED = buf('AA08200024FFA0BB')

// Commands, each as the washer accepted it
const SELECT_ECO = 'AA18F025031504030A0401000000000002000000000052BB' // sent from Home Assistant
const RUN_ECO = 'AA16F02604030A04010000000000020000000000BBBB' // from Home Assistant; the wash ran to its end
const RUN_ECO_DELAYED_3H = 'AA16F02604030A04010003000000030000000000A7BB' // from the LG app
const RUN_RINSE_SPIN = 'AA16F0260E030A000100000000000200640000000DBB' // from Home Assistant
const RESUME_ECO = 'AA16F02604030A040100FFFF0000020000000000B9BB' // from the LG app
const POWER_ON = 'AA08F02A010098BB'
const STATUS_REQUEST = 'AA0EF0ED1121010000001800B5BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    const props = ha.devices[DEVICE_ID].properties
    return { ha, thinq, dev, props }
}

describe(MODEL_ID, () => {
    test('only entities seen on this washer are offered', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const key of [
            'start',
            'child_lock',
            'wrinkle_care',
            'crease_care',
            'set_crease_care',
            'set_steam_softener',
        ])
            assert.equal(components[key], undefined, key)
        const programmes = components.set_course.options as string[]
        assert.equal(programmes.length, 13 + 30)
        assert.ok(programmes.every((name) => typeof name === 'string'))
        assert.deepEqual(programmes.slice(0, 3), ['AI Wash', 'Cotton', 'Eco 40-60'])
        assert.ok(programmes.includes('Steam Refresh'))
        // this washer's LG app spells it so; the shared table has MicroPlastic Care
        assert.ok(programmes.includes('Microplastic Care'))
        assert.ok((components.smart_course.options as string[]).includes('Microplastic Care'))
    })

    test('a remotely started Eco 40-60', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', ECO_WASHING)
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Eco 40-60')
        assert.equal(props.set_course, 'Eco 40-60')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1400 rpm')
        assert.equal(props.soil, 'Normal')
        assert.equal(props.rinse, 'Normal')
        assert.equal(props.remaining_time, 2 * 60 + 45)
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF') // locked
        assert.equal(props.drying_mode, 'Off')
        assert.equal(props.cycles, 15)
        assert.equal(props.energy, 0)
    })

    test('a status envelope is acked', () => {
        const { thinq } = makeDevice()
        thinq.resetRecorder()
        thinq.emit('data', ECO_WASHING)
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, [hex(AABBDevice.frame(buf('f0000a04f65d')))])
    })

    test('dial courses carry the panel names', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', AI_WASH)
        assert.equal(props.course, 'AI Wash')
        assert.equal(props.set_course, 'AI Wash')
        assert.equal(props.ai_dd, 'ON') // set only while AI Wash is selected
        assert.equal(props.downloaded_program, 'Drain')
    })

    test('a downloaded programme', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', BABY_CARE)
        assert.equal(props.course, 'Baby Care') // as the panel and the LG app show it; it runs on Cotton
        assert.equal(props.smart_course, 'Baby Care')
        assert.equal(props.downloaded_program, 'Baby Care')
        assert.equal(props.set_course, 'Baby Care')
        assert.equal(props.temp, '60 °C')
        assert.equal(props.spin, '1000 rpm')
        assert.equal(props.rinse, 'Rinse+')
        assert.equal(props.prewash, 'ON')
        assert.equal(props.medic_rinse, 'ON')
        assert.equal(props.steam, 'OFF')
    })

    test('drying', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', DRY_30)
        assert.equal(props.course, 'Dry 30')
        assert.equal(props.smart_course, 'Dry 30')
        assert.equal(props.drying_mode, '00:30')
        assert.equal(props.air_condensing, 'OFF')

        thinq.emit('data', AIR_CONDENSING)
        assert.equal(props.course, 'Dry Only')
        assert.equal(props.set_course, 'Dry Only')
        assert.equal(props.drying_mode, 'Auto')
        assert.equal(props.air_condensing, 'ON')
    })

    test('a delayed end', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', DELAYED)
        assert.equal(props.status, 'Delayed')
        assert.equal(props.reserve_time, 3 * 60)
    })

    test('records with no programme selected do not reset the cycle count or the energy', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', ECO_END)
        assert.equal(props.status, 'End')
        assert.equal(props.energy, 254)
        assert.equal(props.cycles, 14)

        thinq.emit('data', OFF_ALL_ZERO)
        assert.equal(props.status, 'Off')
        assert.equal(props.power, 'OFF')
        assert.equal(props.energy, 254)
        assert.equal(props.cycles, 14)

        thinq.emit('data', STANDBY_NO_PROGRAMME)
        assert.equal(props.status, 'Standby')
        assert.equal(props.energy, 254)
        assert.equal(props.cycles, 14)

        // the count goes up when the washer is next switched on
        thinq.emit('data', POWER_ON_COUNTED)
        assert.equal(props.cycles, 15)
    })

    test('set_course selects the programme at once, in Standby only', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', OFF_ALL_ZERO)
        thinq.resetRecorder()
        dev.setProperty('set_course', 'Eco 40-60')
        assert.deepEqual(thinq.outbox, [])

        thinq.emit('data', POWER_ON_COUNTED)
        dev.setProperty('set_course', 'Eco 40-60')
        assert.deepEqual(thinq.outbox.map(hex), [SELECT_ECO])
        thinq.emit('data', SELECT_ACCEPTED)
        assert.equal(props.last_command, 'Set course: accepted')
    })

    test('run_programme sends what the washer accepted', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', ECO_STANDBY)
        thinq.resetRecorder()
        dev.setProperty('run_programme', '')
        assert.deepEqual(thinq.outbox.map(hex), [RUN_ECO])
        thinq.emit('data', RUN_ACCEPTED)
        assert.equal(props.last_command, 'Run programme: accepted')
    })

    test('run_programme with a delayed end', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ECO_STANDBY)
        thinq.resetRecorder()
        dev.setProperty('set_delay_end', '3')
        dev.setProperty('run_programme', '')
        assert.deepEqual(thinq.outbox.map(hex), [RUN_ECO_DELAYED_3H])
    })

    test('run_programme carries the downloaded course', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', RINSE_SPIN)
        thinq.resetRecorder()
        dev.setProperty('run_programme', '')
        assert.deepEqual(thinq.outbox.map(hex), [RUN_RINSE_SPIN])
    })

    test('resume only from Paused', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ECO_STANDBY)
        thinq.resetRecorder()
        dev.setProperty('resume', '')
        assert.deepEqual(thinq.outbox, [])

        thinq.emit('data', PAUSED)
        dev.setProperty('resume', '')
        assert.deepEqual(thinq.outbox.map(hex), [RESUME_ECO])
    })

    test('power on is only sent to a washer that is off, then its status is requested', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.emit('data', ECO_STANDBY)
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.deepEqual(thinq.outbox, [], 'the command toggles: it would switch the washer off')

        thinq.emit('data', OFF_ALL_ZERO)
        dev.setProperty('power', 'ON')
        assert.deepEqual(thinq.outbox.map(hex), [POWER_ON])
        tickMockTimers(t, 15000)
        assert.deepEqual(thinq.outbox.map(hex), [POWER_ON, STATUS_REQUEST, STATUS_REQUEST])
    })

    test('last_command reports only answers to our own commands', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', ECO_WASHING)
        thinq.emit('data', COMMAND_REFUSED) // an answer to the LG app
        assert.equal(props.last_command, undefined)

        dev.setProperty('pause', '')
        thinq.emit('data', COMMAND_REFUSED)
        assert.equal(props.last_command, 'Pause: refused')
    })
})
