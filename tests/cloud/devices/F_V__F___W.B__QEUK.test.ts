import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V__F___W.B__QEUK'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'F_V__F___W.B__QEUK', modelName: 'CV9011EC4', swVersion: '1.0' }

// The current half of a real F_V__F___W.B_1QEUK standby capture (Cotton, 1000 rpm, 40 C), with the course byte
// set to the dial's Cotton+ code
const CAPTURE = buf(
    'AA5420EC002501040C040C0100030904010400000000010002000010006400000400000000000000000000002501030603060100030704010400000100010002000010006400000400000000000000000000FCBB',
)
const RECORD = Buffer.from(AABBDevice.unframe(CAPTURE)!.subarray(2 + 39))
RECORD[7] = 0x04

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function bare(record: Buffer) {
    return AABBDevice.frame(Buffer.concat([Buffer.from([0x20, 0xeb]), record]))
}

// 0x20 0a [len16] [seq16] 00 00 00 EB [inner len16] [records], laid out as AABBDevice.processEnvelopedStatus reads it
function enveloped(record: Buffer) {
    const header = Buffer.from([0x20, 0x0a, 0, 0, 0, 0, 1, 0, 0, 0, 0xeb, 0, record.length])
    return AABBDevice.frame(Buffer.concat([header, record]))
}

describe('F_V__F___W.B__QEUK', () => {
    test('course 0x04 is Cotton+', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', bare(RECORD))
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Cotton+')
    })

    test('status inside the 0x20 envelope is decoded like a bare one', () => {
        const a = makeDevice()
        a.thinq.emit('data', bare(RECORD))
        const b = makeDevice()
        b.thinq.emit('data', enveloped(RECORD))
        assert.deepEqual(b.ha.devices[DEVICE_ID].properties, a.ha.devices[DEVICE_ID].properties)
        assert.equal(b.ha.devices[DEVICE_ID].properties.status, 'Standby')
        assert.equal(b.ha.devices[DEVICE_ID].properties.course, 'Cotton+')
    })
})
