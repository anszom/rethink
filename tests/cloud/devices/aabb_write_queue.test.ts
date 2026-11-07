import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import AABBDevice from '@/cloud/devices/aabb_device'
import { WriteQueueMultiplexer, type WriteProtocol } from '@/cloud/devices/aabb_write_queue'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockThinq2Device } from '@/tests/helpers/mocks'
import { customPayload, fromRxPacket, txAck, txPacket, type ClipPayload } from '@/cloud/thinq2/clip'

const META: Metadata = { modelId: 'AABB', modelName: 'AABB', swVersion: '0.0.0' }

// Writes are `f0 e5 <n>`; the reply to one is `20 e6`.
const PROTOCOL: WriteProtocol = {
    isWrite: (inner) => inner[0] === 0xf0 && inner[1] === 0xe5,
    isReply: (inner) => inner[0] === 0x20 && inner[1] === 0xe6,
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
const write = (n: number) => txPacket(AABBDevice.frame(buf(`f0e5${hex2(n)}`)))
const REPLY = AABBDevice.frame(buf('20e6'))
const REPLY_INNER = buf('20e6')

// What a stream hears, as the framed bytes
const rx = (p: ClipPayload) => fromRxPacket(p)!

function setup() {
    const thinq = new MockThinq2Device('test-id', META)
    const mux = new WriteQueueMultiplexer(thinq, false, PROTOCOL)
    thinq.setMux(mux)
    const driver = mux.openStream()
    const bridge = mux.openStream()
    const writes = () => thinq.outbox.map((b) => b[4]) // the byte after f0 e5
    return { thinq, mux, driver, bridge, writes }
}

describe('WriteQueueMultiplexer', () => {
    test("one stream's write waits for the reply to the other's, in either order", () => {
        const { thinq, driver, bridge, writes } = setup()
        driver.send(write(1))
        bridge.send(write(2))
        driver.send(write(3))
        assert.deepEqual(writes(), [1])
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [1, 2])
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [1, 2, 3])
    })

    test('the reply reaches the callback of the stream that wrote, and no other', () => {
        const { thinq, driver, bridge } = setup()
        const got: [string, Buffer | undefined][] = []
        driver.sendDeferred(
            () => write(1),
            (r) => got.push(['driver', r]),
        )
        bridge.sendDeferred(
            () => write(2),
            (r) => got.push(['bridge', r]),
        )
        thinq.emit('data', REPLY)
        assert.deepEqual(got, [['driver', REPLY_INNER]])
        thinq.emit('data', REPLY)
        assert.deepEqual(got, [
            ['driver', REPLY_INNER],
            ['bridge', REPLY_INNER],
        ])
    })

    test('a reply reaches only the stream that wrote', () => {
        const { thinq, driver, bridge } = setup()
        const data: Buffer[][] = [[], []]
        ;[driver, bridge].forEach((s, i) => s.on('packet', (p) => data[i].push(rx(p))))
        bridge.send(write(7))
        thinq.emit('data', REPLY)
        assert.deepEqual(data, [[], [REPLY]])
    })

    test('any other frame reaches every stream, also while a write is out', () => {
        const { thinq, driver, bridge } = setup()
        const data: Buffer[][] = [[], []]
        ;[driver, bridge].forEach((s, i) => s.on('packet', (p) => data[i].push(rx(p))))
        const record = AABBDevice.frame(buf('20eb00'))
        bridge.send(write(7))
        thinq.emit('data', record)
        assert.deepEqual(data, [[record], [record]])
    })

    test('a frame that is no reply releases nothing', () => {
        const { thinq, driver, writes } = setup()
        driver.send(write(1))
        driver.send(write(2))
        thinq.emit('data', AABBDevice.frame(buf('20eb00')))
        thinq.emit('data', Buffer.from('not a frame'))
        assert.deepEqual(writes(), [1])
    })

    test('a reply with no write out is delivered to every stream', () => {
        const { thinq, driver, bridge } = setup()
        const data: Buffer[][] = [[], []]
        ;[driver, bridge].forEach((s, i) => s.on('packet', (p) => data[i].push(rx(p))))
        thinq.emit('data', REPLY)
        assert.deepEqual(data, [[REPLY], [REPLY]])
    })

    test('anything that is not a write goes straight out, past a queue', () => {
        const { thinq, driver, bridge, writes } = setup()
        driver.send(write(1))
        bridge.send(txPacket(AABBDevice.frame(buf('f0ed11'))))
        bridge.send(txAck(AABBDevice.frame(buf('f000e504'))))
        bridge.send(customPayload('custom', 0, null))
        assert.deepEqual(writes(), [1, 0x11])
        assert.deepEqual(
            thinq.sent.map((m) => m.cmd),
            ['ack', 'custom'],
        )
    })

    test('a deferred non-write waits its turn, goes out unanswered and gets an empty callback', () => {
        const { thinq, driver, bridge, writes } = setup()
        const got: (Buffer | undefined)[] = []
        driver.send(write(1))
        bridge.sendDeferred(
            () => txPacket(AABBDevice.frame(buf('f0ed11'))),
            (r) => got.push(r),
        )
        driver.send(write(2))
        assert.deepEqual(writes(), [1])
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [1, 0x11, 2])
        assert.deepEqual(got, [undefined])
    })

    test('a deferred write is built when its turn comes, after the sender has seen the reply', () => {
        const { thinq, driver, bridge, writes } = setup()
        let seen = 0
        driver.on('packet', () => seen++)
        driver.send(write(1))
        bridge.sendDeferred(() => write(seen))
        assert.deepEqual(writes(), [1])
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [1, 1])
    })

    test('a write queued while a reply is being delivered goes out after it', () => {
        const { thinq, driver, writes } = setup()
        let seen = 0
        driver.on('packet', () => driver.sendDeferred(() => write(seen)))
        driver.on('packet', () => seen++)
        driver.send(write(9))
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [9, 1])
    })

    test('a deferred write building nothing is skipped, without its callback', () => {
        const { driver, writes } = setup()
        let called = 0
        driver.sendDeferred(
            () => undefined,
            () => called++,
        )
        driver.send(write(2))
        assert.deepEqual(writes(), [2])
        assert.equal(called, 0)
    })

    test('an unanswered write holds the queue for the timeout, then gets an empty callback', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { driver, bridge, writes } = setup()
        const got: (Buffer | undefined)[] = []
        driver.sendDeferred(
            () => write(1),
            (r) => got.push(r),
        )
        bridge.send(write(2))
        t.mock.timers.tick(WriteQueueMultiplexer.WRITE_TIMEOUT_MS - 1)
        assert.deepEqual(writes(), [1])
        assert.deepEqual(got, [])
        t.mock.timers.tick(1)
        assert.deepEqual(writes(), [1, 2])
        assert.deepEqual(got, [undefined])
    })

    test("a reply cancels the write's timeout", (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { thinq, driver, writes } = setup()
        const got: (Buffer | undefined)[] = []
        driver.sendDeferred(
            () => write(1),
            (r) => got.push(r),
        )
        thinq.emit('data', REPLY)
        driver.send(write(2))
        t.mock.timers.tick(WriteQueueMultiplexer.WRITE_TIMEOUT_MS - 1)
        assert.deepEqual(writes(), [1, 2])
        assert.deepEqual(got, [REPLY_INNER])
    })

    test("a destroyed stream's queued writes are dropped, and it gets nothing more", () => {
        const { thinq, driver, bridge, writes } = setup()
        const data: Buffer[] = []
        bridge.on('packet', (p) => data.push(rx(p)))
        driver.send(write(1))
        bridge.send(write(2))
        driver.send(write(3))
        bridge.destroy()
        bridge.destroy()
        bridge.send(write(4))
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [1, 3])
        assert.deepEqual(data, [])
    })

    test("a destroyed stream's write in flight is still waited for, and its reply reaches no stream", () => {
        const { thinq, driver, bridge, writes } = setup()
        let called = 0
        const data: Buffer[] = []
        driver.on('packet', (p) => data.push(rx(p)))
        bridge.sendDeferred(
            () => write(1),
            () => called++,
        )
        driver.send(write(2))
        bridge.destroy()
        assert.deepEqual(writes(), [1])
        thinq.emit('data', REPLY)
        assert.deepEqual(writes(), [1, 2])
        assert.equal(called, 0)
        assert.deepEqual(data, [])
    })

    test('closing the device drops the queue and the timeout', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { thinq, driver, writes } = setup()
        let called = 0
        driver.sendDeferred(
            () => write(1),
            () => called++,
        )
        driver.send(write(2))
        thinq.emit('close')
        t.mock.timers.tick(WriteQueueMultiplexer.WRITE_TIMEOUT_MS)
        assert.deepEqual(writes(), [1])
        assert.equal(called, 0)
    })
})
