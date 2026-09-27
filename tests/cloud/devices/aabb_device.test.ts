import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'AABB', modelName: 'AABB', swVersion: '0.0.0' }

// The properties map alone cannot tell "published 'None'" apart from "the cache swallowed it", since
// an absent key reads as undefined either way. These tests record what actually reached the HA
// connection instead.
function makeDevice() {
    const ha = new MockHAConnection()
    const published: { prop: string; value: string | number | undefined }[] = []
    const inner = ha.publishProperty.bind(ha)
    ha.publishProperty = (id: string, prop: string, value: string | number | undefined) => {
        published.push({ prop, value })
        inner(id, prop, value)
    }

    const dev = new AABBDevice(ha.asConnection(), new MockThinq2Device(DEVICE_ID, META), false)
    return { ha, dev, published }
}

describe('AABBDevice.publishProperty', () => {
    // The regression: with a plain `cache[prop] === value` check, an undefined value on a property
    // that has never been published looks like a cache hit and is dropped. HA would then keep showing
    // whatever was retained from the previous run.
    test('an undefined value on a never-published property is published', () => {
        const { ha, dev, published } = makeDevice()

        dev.publishProperty('course', undefined)

        assert.deepEqual(published, [{ prop: 'course', value: undefined }])
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
    })

    test('a repeated undefined is published only once', () => {
        const { dev, published } = makeDevice()

        dev.publishProperty('course', undefined)
        dev.publishProperty('course', undefined)

        assert.equal(published.length, 1)
    })

    test('every transition into and out of undefined is published', () => {
        const { ha, dev, published } = makeDevice()

        dev.publishProperty('course', undefined)
        dev.publishProperty('course', 'Cotton')
        dev.publishProperty('course', 'Cotton')
        dev.publishProperty('course', undefined)

        assert.deepEqual(published, [
            { prop: 'course', value: undefined },
            { prop: 'course', value: 'Cotton' },
            { prop: 'course', value: undefined },
        ])
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
    })

    test('an unchanged value is published once, a changed one every time', () => {
        const { dev, published } = makeDevice()

        dev.publishProperty('remaining_time', 41)
        dev.publishProperty('remaining_time', 41)
        dev.publishProperty('remaining_time', 40)

        assert.deepEqual(published, [
            { prop: 'remaining_time', value: 41 },
            { prop: 'remaining_time', value: 40 },
        ])
    })

    test('the cache is kept per property', () => {
        const { dev, published } = makeDevice()

        dev.publishProperty('spin', undefined)
        dev.publishProperty('temp', undefined)

        assert.deepEqual(published, [
            { prop: 'spin', value: undefined },
            { prop: 'temp', value: undefined },
        ])
    })

    // The cache is a Map so that property names taken off the wire cannot collide with Object.prototype.
    // A plain object would report `'toString' in cache` as true before anything was ever published.
    test('a property named after an Object.prototype member is not swallowed', () => {
        const { ha, dev, published } = makeDevice()

        dev.publishProperty('toString', undefined)
        dev.publishProperty('constructor', 'Cotton')

        assert.deepEqual(published, [
            { prop: 'toString', value: undefined },
            { prop: 'constructor', value: 'Cotton' },
        ])
        assert.equal(ha.devices[DEVICE_ID].properties.toString, 'None')
    })
})

class RecordingDevice extends AABBDevice {
    processed: string[] = []
    override processAABB(inner: Buffer) {
        this.processed.push(inner.toString('hex'))
    }
}

function makeAckingDevice(autoAck: boolean) {
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new RecordingDevice(new MockHAConnection().asConnection(), thinq, autoAck)
    const acks = () => thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
    return { thinq, dev, acks }
}

// Captured from the ThinQ cloud to an LG dryer while bridged: its ack of the dryer's `30 4d 01`
// course-list request (see tests/bridge/thinq2connection.test.ts).
const CLOUD_ACK_4D = 'AA08F0004D04A6BB'

describe('AABBDevice auto-ack', () => {
    test('a non-envelope frame is acked by type, byte for byte as the cloud does', () => {
        const { thinq, dev, acks } = makeAckingDevice(true)

        thinq.emit('data', AABBDevice.frame(buf('304d01')))

        assert.deepEqual(acks(), [CLOUD_ACK_4D])
        assert.deepEqual(thinq.outbox, [], 'acks do not go out as packets')
        assert.deepEqual(dev.processed, ['304d01'], 'the frame is still processed')
    })

    test('an envelope is acked by its sequence number, whatever its class', () => {
        const { thinq, acks } = makeAckingDevice(true)

        // ST_B_E4H01Y_APL and FAFXU25006 status envelopes, as captured
        thinq.emit('data', buf('aaff310a00230053ed000101030011100b0306100000008a00000000000000059317bb'))
        thinq.emit('data', buf('aaff200a00a2001002000100ec00900aff000e00000000bb'))

        assert.deepEqual(acks(), [
            AABBDevice.frame(buf('f0000a0453ed')).toString('hex').toUpperCase(),
            AABBDevice.frame(buf('f0000a041002')).toString('hex').toUpperCase(),
        ])
    })

    test('a truncated envelope is not acked', () => {
        const { thinq, dev, acks } = makeAckingDevice(true)

        thinq.emit('data', buf('AA08200A01020304BB'))

        assert.deepEqual(acks(), [])
        assert.deepEqual(dev.processed, ['200a010203'])
    })

    // The frames below were injected into a bridged appliance (as FAFXU22007 and Y_VB_Y___W.B32QEUK),
    // and the expected acks are the ThinQ cloud's replies to them, byte for byte.

    test('an envelope needs its full 13-byte header to be acked, in either framing', () => {
        const { thinq, acks } = makeAckingDevice(true)

        thinq.emit('data', buf('aaff200a00120010130001007f0000e91dbb')) // long, 13-byte header
        thinq.emit('data', buf('aaff200a00110010120001007f00decabb')) // long, 12-byte header
        thinq.emit('data', buf('aa11200a00110010b00001007f000063bb')) // short, 13-byte header
        thinq.emit('data', buf('aa10200a00100010c00001007f0011bb')) // short, 12-byte header

        assert.deepEqual(acks(), ['AA0AF0000A04101380BB', 'AA0AF0000A0410B027BB'])
    })

    test('heartbeats other than c3 are acked by type', () => {
        const { thinq, acks } = makeAckingDevice(true)

        thinq.emit('data', buf('aa0720d801ffbb'))
        thinq.emit('data', buf('aa0720720111bb'))
        thinq.emit('data', buf('aa0720e901eebb'))

        assert.deepEqual(acks(), ['AA08F000D8042BBB', 'AA08F00072044DBB', 'AA08F000E904DABB'])
    })

    test("neither the appliance's own acks, its c3 heartbeat nor bare eb/ec status records are acked", () => {
        const { thinq, dev, acks } = makeAckingDevice(true)

        thinq.emit('data', buf('AA084000430060BB')) // WFV474PGV's ack, as captured
        thinq.emit('data', buf('aa0731c302f2bb')) // ST_B_E4H01Y_APL's heartbeat, as captured
        thinq.emit('data', buf('aa0720eb01e8bb'))
        thinq.emit('data', buf('aa0720ec01ebbb'))
        // F_V8_Y___W.B_2QEUK's status record, as captured
        thinq.emit(
            'data',
            buf(
                'aa5420ec002501000000000000000000000000000000000000000001006400000000000000000000000000002501033a033a0100030b04010000000000010002000001006400000400000000000000000000e0bb',
            ),
        )

        assert.deepEqual(acks(), [])
        assert.equal(dev.processed.length, 5)
    })

    test('a non-AABB payload is neither acked nor processed', () => {
        const { thinq, dev, acks } = makeAckingDevice(true)

        thinq.emit('data', buf('0102030405'))

        assert.deepEqual(acks(), [])
        assert.deepEqual(dev.processed, [])
    })

    test('without autoAck, nothing is acked', () => {
        const { thinq, dev, acks } = makeAckingDevice(false)

        thinq.emit('data', AABBDevice.frame(buf('304d01')))
        thinq.emit('data', buf('aaff200a00a2001002000100ec00900aff000e00000000bb'))

        assert.deepEqual(acks(), [])
        assert.equal(dev.processed.length, 2)
    })
})
