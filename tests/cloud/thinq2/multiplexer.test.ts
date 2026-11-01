import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EventEmitter } from 'node:events'
import { Multiplexer } from '@/cloud/thinq2/multiplexer'
import type { Device } from '@/cloud/thinq2/device'

class FakeDevice extends EventEmitter {
    sent: object[] = []
    sendRaw(body: object) {
        this.sent.push(body)
    }
}

function setup() {
    const dev = new FakeDevice()
    const mux = new Multiplexer(dev as unknown as Device)
    return { dev, mux }
}

function collect(stream: { on(ev: 'data', cb: (b: Buffer) => void): unknown }) {
    const got: Buffer[] = []
    stream.on('data', (b) => got.push(b))
    return got
}

describe('thinq2 Multiplexer', () => {
    test('device data is delivered to all streams', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        const gotB = collect(b)
        const pkt = Buffer.from('hello')
        dev.emit('rawData', pkt)
        assert.deepEqual(gotA, [pkt])
        assert.deepEqual(gotB, [pkt])
    })

    test('send() forwards the body to the device untouched', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const body1 = { cmd: 'one' }
        const body2 = { cmd: 'two' }
        a.send(body1)
        b.send(body2)
        assert.deepEqual(dev.sent, [body1, body2])
        assert.equal(dev.sent[0], body1)
    })

    test('send() invokes the callback', () => {
        const { mux } = setup()
        const a = mux.openStream()
        let called = 0
        a.send({}, () => called++)
        assert.equal(called, 1)
        a.send({}) // no callback must not throw
    })

    test('destroy() detaches only that stream', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        const gotB = collect(b)
        a.destroy()
        dev.emit('rawData', Buffer.from('x'))
        assert.deepEqual(gotA, [])
        assert.equal(gotB.length, 1)
        assert.equal(dev.listenerCount('rawData'), 1)
    })

    test('destroy() twice is harmless', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        a.destroy()
        a.destroy()
        assert.equal(dev.listenerCount('rawData'), 0)
    })

    test('streams opened later only see later data', () => {
        const { dev, mux } = setup()
        dev.emit('rawData', Buffer.from('early'))
        const a = mux.openStream()
        const gotA = collect(a)
        assert.deepEqual(gotA, [])
    })
})
