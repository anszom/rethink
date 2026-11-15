import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/VIC2_799_US_FACTORY'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'VIC2_799_US_FACTORY'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// Real frames captured from a WM3500CW through rethink-capture, each next to the LG cloud's own reading.
// The comments name the cloud fields that confirmed them.

// error:"ERROR_DE1" (rec[7] = 0x11) after Start with the door not shut, on the Downloaded position with
// downloadedCourseFLUpper25inchBaseUS:"ECONOWASH" (rec[21] = 0x6a).
const DOOR_OPEN_ERROR = buf(
    'aa3a20ec001805012301230a00030502020000000010000000006a0b0000001805012301230a11030502020000000010000000006a0b000054bb',
)

// Denim downloaded from the app: downloadedCourseFLUpper25inchBaseUS:"DENIM" (rec[21] = 0x37).
const DOWNLOADED_DENIM = buf(
    'aa3a20ec001805000000000000000000000000000000000000006a0b0000001805010301030a0003030202000000000000000000370b060056bb',
)

// freshCare:"FRESHCARE_ON" on Towels (rec[16] bit 0x01).
const FRESH_CARE_ON = buf(
    'aa3a20ec00180501010101080003050403000000000000000700332c000000180501010101080003050403000000000100000700332c000078bb',
)

// apCourseFLUpper25inchBaseUS:"WHITE", no error.
const BRIGHT_WHITES = buf(
    'aa3a20ec001805011d011d010000030002000000040000000700332c0000001805010c010c020003050603000000000000000700332c00003cbb',
)

function feed(frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('VIC2_799_US_FACTORY', () => {
    test('error code', () => {
        const p = feed([DOOR_OPEN_ERROR])
        assert.equal(p.error, 'ON')
        assert.equal(p.error_message, 'Door open error (DE1)')
        assert.equal(p.course, 'Downloaded (Econo Wash)')
    })

    test('a downloaded cycle is named from rec[21]', () => {
        assert.equal(feed([DOWNLOADED_DENIM]).course, 'Downloaded (Denim)')
    })

    test('Fresh Care', () => {
        const p = feed([FRESH_CARE_ON])
        assert.equal(p.course, 'Towels')
        assert.equal(p.fresh_care, 'ON')
    })

    test('courses of its own table, no error', () => {
        const p = feed([BRIGHT_WHITES])
        assert.equal(p.course, 'Bright Whites')
        assert.equal(p.error, 'OFF')
        assert.equal(p.error_message, 'OK')
        assert.equal(p.fresh_care, 'OFF')
    })
})
