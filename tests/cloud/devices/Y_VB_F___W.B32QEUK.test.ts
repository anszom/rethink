import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/Y_VB_F___W.B32QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'Y_VB_F___W.B32QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.224' }

// All frames are real captures from an LG F4DR711S2BA

const SAMPLE_STANDBY = buf(
    'AAFF200A006000396C000100EC004E000001000000000000000000000000000000000000000008004A0000000000000202322D004101000001000000000000000000000000000000000000000008004A0000000000000202322D0001011266BB',
)

const SAMPLE_WASH_DRY_AUTO = buf(
    'AAFF200A00600039E8000100EC004E000001010C010C1200030106010000000000000003000008004A0000020000000000322D000001000001050F050F1300030A04010200000000000004000008004A0000040000000202322D00010193FBBB',
)

const SAMPLE_WASH_DRY_1H = buf(
    'AAFF200A00600039FD000100EC004E000001032C032C1300030A04010300000000000002000008004A0000040000000202322D000101000001040E040E1300030A04010400000000000002000008004A0000040000000202322D0001012A96BB',
)

const SAMPLE_WASH_DRY_IRON = buf(
    'AAFF200A0060003A01000100EC004E000001050E050E1300030A04010600000000000003000008004A0000040000000202322D000101000001041D041D1300030A04010A00000000000003000008004A0000040000000202322D000101EEACBB',
)

const SAMPLE_WASH_DRY_DELICATE = buf(
    'AAFF200A0060003A03000100EC004E000001041D041D1300030A04010A00000000000003000008004A0000040000000202322D000101000001050205021300030A04010B00000000000003000008004A0000040000000202322D000101CC4BBB',
)

const SAMPLE_COTTON = buf(
    'AAFF200A00600039D3000100EC004E000001003B003B3A00030A04010000000000010002000008004A0000040000000202322D000101000001033103310100030A04010000000000000003000008004A0000040000000202322D0001014917BB',
)

const SAMPLE_DETECTING_DOOR_LOCKED = buf(
    'AAFF200A0060003A0B000100EC004E000004050F050F1300030A04010200000002200001010008004A0000040000000202322D000101000004050F050F1300030A04010200000042200001010008004A0000040000000202322D000101B665BB',
)

const SAMPLE_WASHING = buf(
    'AAFF200A0060003A18000100EC004E000004050F050F1300030A04010200000042200001010008004A0000040000000202322D000101000006021902191300030A04010200000042200001040008004A0000040000000202322D000101BC67BB',
)

const SAMPLE_PAUSED_DOOR_UNLOCKED = buf(
    'AAFF200A0060003A33000100EC004E000002021902191300030A04010200000040000004060008004A0000040000000202322D000101000002021902191300030A04010200000000000004060008004A0000040000000202322D0001015966BB',
)

// Measurement records and a detergent refill, from a real mixed load
const LOG_HEATING = buf(
    'AAFF200A0061004A8C00010102004F0D01026500EF001A0600280402042C000008494849474632342D2F31EFEDEFEEEC000000000000000000000000000000000000000000000000000000000000001F1F1C1C1E014C00000000000F0400D37BBB',
)
const LOG_DRYING = buf(
    'AAFF200A006100562400010102004F0D01026500EF0097090090003A031300001D3F3F3D3E3F35383C3D31FFFFFFFFFF0000000000000000000000000000000000000000000000000000000000000851565A5E4C014C00000000000F1B00FD95BB',
)
const PHASE_RINSE_END = buf(
    'AAFF200A005F00502F00010103004D060D01020600EF004207005D07020601020A01800000000700FCEA01EDFB01A7030608970350083E03F5086E04044C044C01000008000056060002360128024A000000020202322A2D00200001FF18BB',
)
const STATUS_DETERGENT_EMPTY = buf(
    'AAFF200A00600043EE000100EC004E000001033B033B0700030A06010B00004000000004000009004A0000040000000202322D000101000001033B033B0700030A06010B00004000000004000009004A0000040000000202322D0041019B50BB',
)
const STATUS_DETERGENT_REFILLED = buf(
    'AAFF200A00600043FF000100EC004E000001033B033B0700030A06010B00004000000004000009004A0000040000000202322D000001000004033B033B0700030A06010B00004002200001010009004A0000040000000202322D000001658CBB',
)

// Dial positions from a second sweep, this one through all fourteen
const DIAL_DRY_ONLY = buf(
    'AAFF200A00600070B3000100EC004E000001050F050F1300030A0401020000000000000400000A004A0000040000000202322D00000100000100370037180000000000020000000000000600000A004A0000000000000000322D000001DE78BB',
)
const DIAL_SPEED_14 = buf(
    'AAFF200A00600070B4000100EC004E00000100370037180000000000020000000000000600000A004A0000000000000000322D000001000001000E000E0C0003020201000000010000000000000A004A0000010000000202322D000001709BBB',
)
const DIAL_HAND_WOOL = buf(
    'AAFF200A00600070B6000100EC004E000001000E000E0C0003020201000000010000000000000A004A0000010000000202322D000001000001002400241B0003050301000000000000000100000A004A0000030000000101322D00000106C9BB',
)
const DIAL_DELICATES = buf(
    'AAFF200A00600070B7000100EC004E000001002400241B0003050301000000000000000100000A004A0000030000000101322D000001000001002D002D200003050201000000000000000100000A004A0000030000000101322D00000142F6BB',
)
const DIAL_DOWNLOAD_CYCLE = buf(
    'AAFF200A00600070AE000100EC004E000001023002302D00030A0601000000800000000400000A004A0000050000000303322D000001000001002D002D2000030502010000000000000001004A0A004A0000030000000202322D0000011B70BB',
)
const DIAL_TUB_CLEAN = buf(
    'AAFF200A00600070B0000100EC004E000001002D002D2000030502010000000000000001004A0A004A0000030000000202322D000001000001010C010C120003010601000000000000000300000A004A0000020000000000322D0000015A26BB',
)

function props(...frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const frame of frames) thinq.emit('data', frame)
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('standby: nothing selected, drying off, both locks open', () => {
        const p = props(SAMPLE_STANDBY)
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Not selected')
        assert.equal(p.drying_mode, 'Off')
        assert.equal(p.cycles, 8)
        // ON is unlocked for HA's lock class
        assert.equal(p.door_lock, 'ON')
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.ezdispense_detergent, 50)
        assert.equal(p.ezdispense_softener, 45)
    })

    test('a wash-only course leaves the drying mode off', () => {
        const p = props(SAMPLE_COTTON)
        assert.equal(p.course, 'Cotton')
        assert.equal(p.drying_mode, 'Off')
    })

    test('Wash + Dry: course, defaults and the dry levels the panel steps through', () => {
        let p = props(SAMPLE_WASH_DRY_AUTO)
        assert.equal(p.course, 'Wash+Dry (6kg)')
        assert.equal(p.temp, '40 °C')
        assert.equal(p.spin, '1400 rpm')
        assert.equal(p.drying_mode, 'Auto')
        assert.equal(p.remaining_time, 5 * 60 + 15)

        p = props(SAMPLE_WASH_DRY_1H)
        assert.equal(p.drying_mode, '01:00')
        p = props(SAMPLE_WASH_DRY_IRON)
        assert.equal(p.drying_mode, 'Iron')
        p = props(SAMPLE_WASH_DRY_DELICATE)
        assert.equal(p.drying_mode, 'Delicate')
    })

    test('the course select offers Wash + Dry', () => {
        const ha = new MockHAConnection()
        new DUT(ha.asConnection(), new MockThinq2Device(DEVICE_ID, META), META)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, { options?: string[] }>
        assert.ok(components.set_course.options!.includes('Wash+Dry (6kg)'))
        assert.ok(components.drying_mode.options!.includes('Auto'))
    })

    test('running: detecting with the door locked, then washing', () => {
        let p = props(SAMPLE_DETECTING_DOOR_LOCKED)
        assert.equal(p.status, 'Detecting')
        assert.equal(p.door_lock, 'OFF') // locked
        assert.equal(p.remote_start, 'ON')

        p = props(SAMPLE_WASHING)
        assert.equal(p.status, 'Washing')
        assert.equal(p.course, 'Wash+Dry (6kg)')
        assert.equal(p.drying_mode, 'Auto')
        assert.equal(p.remaining_time, 2 * 60 + 25)
        assert.equal(p.door_lock, 'OFF')
    })

    test('paused with Add Item: the door unlocks', () => {
        const p = props(SAMPLE_PAUSED_DOOR_UNLOCKED)
        assert.equal(p.status, 'Paused')
        assert.equal(p.door_lock, 'ON') // unlocked
        assert.equal(p.remote_start, 'OFF')
    })

    test('the dial positions the V8 table names differently, or not at all', () => {
        let p = props(DIAL_DRY_ONLY)
        assert.equal(p.course, 'Dry Only')
        assert.equal(p.drying_mode, 'Auto')
        assert.equal(p.spin, 'Not selected')
        assert.equal(p.remaining_time, 55)

        p = props(DIAL_SPEED_14)
        assert.equal(p.course, 'Speed 14')
        assert.equal(p.remaining_time, 14)
        assert.equal(p.temp, '20 °C')
        assert.equal(p.spin, '400 rpm')

        assert.equal(props(DIAL_HAND_WOOL).course, 'Hand/Wool')
        assert.equal(props(DIAL_DELICATES).course, 'Delicates')

        // the download slot holds Lingerie, whose base course is Delicates
        p = props(DIAL_DOWNLOAD_CYCLE)
        assert.equal(p.course, 'Delicates')
        assert.equal(p.smart_course, 'Lingerie')
    })

    describe('measurements', () => {
        test('the five-minute log gives the tub and drying air temperatures', () => {
            // heating towards 60 C: the ring holds 50 52 45 47 49, of which 52 is the newest
            let p = props(LOG_HEATING)
            assert.equal(p.tub_temperature, 52)
            assert.equal(p.drying_temperature, 31)

            // 13 minutes into drying
            p = props(LOG_DRYING)
            assert.equal(p.tub_temperature, 61)
            assert.equal(p.drying_temperature, 94)
        })

        test('a measurement record leaves the state alone', () => {
            const p = props(SAMPLE_WASHING, LOG_HEATING, PHASE_RINSE_END)
            assert.equal(p.last_spin_speed, undefined) // the phase record's number is not a speed
            assert.equal(p.status, 'Washing')
            assert.equal(p.course, 'Wash+Dry (6kg)')
        })

        test('the detergent tank running empty, and being refilled', () => {
            assert.equal(props(STATUS_DETERGENT_EMPTY).detergent_empty, 'ON')
            assert.equal(props(STATUS_DETERGENT_EMPTY, STATUS_DETERGENT_REFILLED).detergent_empty, 'OFF')
        })
    })

    // Each command below was also sent to the real unit
    describe('commands', () => {
        function device(...frames: Buffer[]) {
            const ha = new MockHAConnection()
            const thinq = new MockThinq2Device(DEVICE_ID, META)
            const dev = new DUT(ha.asConnection(), thinq, META)
            for (const frame of frames) thinq.emit('data', frame)
            thinq.resetRecorder()
            return { ha, thinq, dev }
        }
        const sent = (thinq: MockThinq2Device) => thinq.outbox.map((frame) => hex(frame))
        const last = (thinq: MockThinq2Device) => sent(thinq).slice(-1)[0] ?? ''

        test('choosing a course fills in its panel defaults, which a zeroed F026 would lose', () => {
            const { ha, thinq, dev } = device(SAMPLE_STANDBY)
            dev.setProperty('set_course', 'TurboWash 39')
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.set_spin, '1200 rpm')
            assert.equal(p.set_temp, '40 °C')
            assert.equal(p.set_turbowash, 'ON')
            assert.equal(p.set_drying_mode, 'Off')

            dev.setProperty('run_programme', '')
            // course 31, soil 03, spin 09, temp 04, rinse 01, no drying, TurboWash, both doses Medium
            assert.ok(last(thinq).includes('F02631030904010000000001030000020200'), sent(thinq).join())
        })

        test('Wash + Dry carries the drying mode', () => {
            const { ha, thinq, dev } = device(SAMPLE_STANDBY)
            dev.setProperty('set_course', 'Wash+Dry (6kg)')
            assert.equal(ha.devices[DEVICE_ID].properties.set_drying_mode, 'Auto')
            dev.setProperty('set_drying_mode', '01:00')
            dev.setProperty('run_programme', '')
            assert.ok(last(thinq).includes('F02613030A04010400000000030000020200'), sent(thinq).join())
        })

        test('a start with no course selected is not sent', () => {
            const { thinq, dev } = device(SAMPLE_STANDBY)
            dev.setProperty('run_programme', '')
            assert.deepEqual(sent(thinq), [])
        })

        test('the selects are held to the panel: no 1600 rpm, no 50 C, no rinse hold', () => {
            const { ha, thinq, dev } = device(SAMPLE_STANDBY)
            const components = ha.devices[DEVICE_ID].config!.components as Record<string, { options?: string[] }>
            assert.ok(!components.set_spin.options!.includes('1600 rpm'))
            assert.ok(!components.set_temp.options!.includes('50 °C'))
            assert.ok(!components.set_rinse.options!.includes('Rinse+ + Hold'))
            assert.ok(!components.set_course.options!.includes('Duvet'))

            // Mixed Fabric at 1600 rpm and 50 C was accepted and started by the real unit
            dev.setProperty('set_course', 'Mixed Fabric')
            dev.setProperty('set_spin', '1600 rpm')
            dev.setProperty('set_temp', '50 °C')
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.set_spin, '1000 rpm') // Mixed Fabric's default, unchanged
            assert.equal(p.set_temp, '40 °C')

            // a course the dial does not have is not chosen, so there is nothing to start
            dev.setProperty('set_course', 'Not selected')
            dev.setProperty('set_course', 'Duvet')
            dev.setProperty('run_programme', '')
            assert.deepEqual(sent(thinq), [])
        })

        test('pause and start are not offered: the appliance ignores one and refuses the other', () => {
            const { ha } = device(SAMPLE_STANDBY)
            const components = ha.devices[DEVICE_ID].config!.components as Record<string, { command_topic?: string }>
            assert.equal(components.pause?.command_topic, undefined)
            assert.equal(components.start?.command_topic, undefined)
        })

        test('Dry Only is started with its own zeros, and without dosing', () => {
            const { ha, thinq, dev } = device(SAMPLE_STANDBY)
            dev.setProperty('set_course', 'Dry Only')
            assert.equal(ha.devices[DEVICE_ID].properties.set_drying_mode, 'Auto')
            dev.setProperty('run_programme', '')
            assert.ok(last(thinq).includes('F02618000000000200000000030000000000'), sent(thinq).join())
        })

        test('each course is started with its own dose levels, not the ones last reported', () => {
            // SAMPLE_STANDBY reports both doses at Medium
            const { thinq, dev } = device(SAMPLE_STANDBY)
            dev.setProperty('set_course', 'Tub Clean')
            dev.setProperty('run_programme', '')
            assert.ok(last(thinq).includes('F02612030106010000000000030000000000'), sent(thinq).join())

            dev.setProperty('set_course', 'Hand/Wool')
            dev.setProperty('run_programme', '')
            assert.ok(last(thinq).includes('F0261B030503010000000000030000010100'), sent(thinq).join())

            dev.setProperty('set_course', 'Speed 14')
            dev.setProperty('run_programme', '')
            assert.ok(last(thinq).includes('F0260C030202010000000001030000020200'), sent(thinq).join())
        })

        test('power on is only sent while the appliance is off', () => {
            const { thinq, dev } = device(SAMPLE_STANDBY)
            dev.setProperty('power', 'ON')
            assert.deepEqual(sent(thinq), [])
            dev.setProperty('power', 'OFF')
            assert.ok(last(thinq).includes('F024010100'))
        })
    })
})
