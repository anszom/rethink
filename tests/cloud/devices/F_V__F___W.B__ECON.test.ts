import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V__F___W.B__ECON'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V__F___W.B__ECON'

const META: Metadata = {
    modelId: MODEL_ID,
    modelName: 'CV9014WC2',
    swVersion: 'test',
}

function packet(...parts: string[]) {
    return Buffer.from(parts.join(''), 'hex')
}

/*
 * Captured while manually changing the selected course from
 * Cotton+ to TurboWash 39 on an LG CV9014WC2.
 *
 * ECON 0x60 packets contain two consecutive state snapshots.
 * The first/older snapshot reports Cotton+, while the
 * second/newer snapshot reports TurboWash 39.
 */
const COURSE_CHANGE_60 = packet(
    'aaff200a006000a7a0000100ec004e00',
    '0002041804180400030a060100000000',
    '40000004040014003c00000200000000',
    '00000000000000000600270027310003',
    '0904010000000142200001010014003c',
    '00000100000000000000000000034abb',
)

/*
 * Captured while manually changing from Synthetics to
 * Allergy Care.
 *
 * The second/newer snapshot reports spin byte 0x0a,
 * which the CV9014WC2 reports as 1400 RPM.
 */
const ALLERGY_CARE_1400RPM_60 = packet(
    'aaff200a006000a7bb000100ec004e00',
    '0004023102310200030a040100000000',
    '42210001010014003c00000300000000',
    '000000000000000004023002302d0003',
    '0a06010000008002200001010014003c',
    '000005000000000000000000000b95bb',
)

/*
 * Captured while manually selecting the Drying course.
 *
 * The second/newer snapshot reports course 0x18 (Drying)
 * and dry mode 0x02 (Auto).
 */
const DRYING_AUTO_60 = packet(
    'aaff200a006000a897000100ec004e00',
    '0006000e000e0c000302020100000001',
    '42200001010014003c00000100000000',
    '00000000000000000201000100180000',
    '0000000200000040000006090014003c',
    '00000000000000000000000000d3dfbb',
)

/*
 * Captured with Cotton selected at 40 °C and 1200 RPM.
 */
const COTTON_40C_1200RPM_39 = packet(
    'aaff200a0039006fec00010ae200270000',
    '040217021701000309040100000000022100010100190000000004000109',
    '00000000000000da09bb',
)

/*
 * Exact F026 start-program frames captured from the CV9014WC2.
 *
 * These validate the per-course defaults used when a course is staged
 * and then started without overriding its spin, temperature, rinse,
 * dry mode, delay, or option values.
 */
const START_PROGRAM_CAPTURES = [
    {
        program: 'Cotton',
        frame: 'AA16F0260103FF04010000000000030000000000B4BB',
    },
    {
        program: 'Synthetics',
        frame: 'AA16F0260203FF04010000000000030000000000B7BB',
    },
    {
        program: 'Cotton+',
        frame: 'AA16F0260403FF06010000000000030000000000B3BB',
    },
    {
        program: 'Mix',
        frame: 'AA16F02607030704010000000000030000000000BABB',
    },
    {
        program: 'Steam refresh',
        frame: 'AA16F0260D00000000000000008003000000000033BB',
    },
    {
        program: 'Quick 14',
        frame: 'AA16F0260C030202010000000001030000000000BBBB',
    },
] as const

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)

    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('device handler can be constructed', () => {
        const { ha, dev } = makeDevice()

        assert.ok(dev)
        assert.ok(ha.devices[DEVICE_ID])
        assert.ok(ha.devices[DEVICE_ID].config)
    })

    test('0x60 packet publishes the second/newer ECON snapshot', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', COURSE_CHANGE_60)

        const properties = ha.devices[DEVICE_ID].properties

        /*
         * First/older snapshot:
         *   course 0x04 = Cotton+
         *
         * Second/newer snapshot:
         *   course 0x31 = TurboWash 39
         *   remaining/initial time = 39 min
         *   spin = 1200 RPM
         *   temperature = 40 °C
         *
         * These assertions therefore also ensure that the handler did
         * not publish the first/older snapshot.
         */
        assert.equal(properties.course, 'TurboWash 39')
        assert.equal(properties.remaining_time, 39)
        assert.equal(properties.initial_time, 39)
        assert.equal(properties.spin, 1200)
        assert.equal(properties.temp, 40)
        assert.equal(properties.dry, 'Off')
        assert.equal(properties.turbo_wash, 'ON')
        assert.equal(properties.remote_start, 'ON')
    })

    test('0x60 packet decodes reported 0x0a spin as 1400 RPM', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', ALLERGY_CARE_1400RPM_60)

        const properties = ha.devices[DEVICE_ID].properties

        assert.equal(properties.course, 'Allergy Care')
        assert.equal(properties.remaining_time, 168)
        assert.equal(properties.initial_time, 168)
        assert.equal(properties.spin, 1400)
        assert.equal(properties.temp, 60)
        assert.equal(properties.dry, 'Off')
        assert.equal(properties.steam, 'ON')
        assert.equal(properties.remote_start, 'ON')
    })

    test('0x60 packet decodes captured Drying course and Auto dry mode', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', DRYING_AUTO_60)

        const properties = ha.devices[DEVICE_ID].properties

        assert.equal(properties.course, 'Drying')
        assert.equal(properties.dry, 'Auto')
        assert.equal(properties.remaining_time, 60)
        assert.equal(properties.initial_time, 60)
    })

    test('0x39 packet decodes a captured Cotton cycle state', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', COTTON_40C_1200RPM_39)

        const properties = ha.devices[DEVICE_ID].properties

        assert.equal(properties.power, 'ON')
        assert.equal(properties.status, 'Measuring')
        assert.equal(properties.error, 'OFF')
        assert.equal(properties.course, 'Cotton')
        assert.equal(properties.remaining_time, 143)
        assert.equal(properties.initial_time, 143)
        assert.equal(properties.spin, 1200)
        assert.equal(properties.temp, 40)
        assert.equal(properties.dry, 'Off')
        assert.equal(properties.remote_start, 'ON')
        assert.equal(properties.child_lock, 'OFF')
        assert.equal(properties.steam, 'OFF')
        assert.equal(properties.cycles, 25)
        assert.equal(properties.energy, 9)
    })

    for (const { program, frame } of START_PROGRAM_CAPTURES) {
        test(`start_program sends captured ${program} command`, () => {
            const { thinq, dev } = makeDevice()

            thinq.resetRecorder()

            dev.setProperty('stage_program', program)

            /*
             * Staging only changes the local staged values.
             * The packet should not be sent until start_program is pressed.
             */
            assert.equal(thinq.outbox.length, 0)

            dev.setProperty('start_program', '')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), frame)
        })
    }
})
