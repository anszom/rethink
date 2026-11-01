import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EventEmitter } from 'node:events'
import { T2Multiplexer } from '@/cloud/thinq2/multiplexer'
import type { Device } from '@/cloud/thinq2/device'
import { rxPacket, type ClipPayload } from '@/cloud/thinq2/clip'

class FakeDevice extends EventEmitter {
    sent: object[] = []
    sendRaw(body: object) {
        this.sent.push(body)
    }
}

function setup() {
    const dev = new FakeDevice()
    const mux = new T2Multiplexer(dev as unknown as Device)
    return { dev, mux }
}

function collect(stream: { on(ev: 'packet', cb: (b: ClipPayload) => void): unknown }) {
    const got: ClipPayload[] = []
    stream.on('packet', (b) => got.push(b))
    return got
}

describe('thinq2 Multiplexer', () => {
    test('device data is delivered to all streams', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        const gotB = collect(b)
        const pkt = rxPacket(Buffer.from('hello'))
        dev.emit('rawPacket', pkt)
        assert.deepEqual(gotA, [pkt])
        assert.deepEqual(gotB, [pkt])
    })

    test('send() forwards the body to the device untouched', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const body1 = { cmd: 'one', type: 1, data: null }
        const body2 = { cmd: 'two', type: 1, data: null }
        a.send(body1)
        b.send(body2)
        assert.deepEqual(dev.sent, [body1, body2])
        assert.equal(dev.sent[0], body1)
    })

    test('destroy() detaches only that stream', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        const gotB = collect(b)
        a.destroy()
        dev.emit('rawPacket', rxPacket(Buffer.from('x')))
        assert.deepEqual(gotA, [])
        assert.equal(gotB.length, 1)
        assert.equal(dev.listenerCount('rawPacket'), 1)
    })

    test('destroy() twice is harmless', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        a.destroy()
        a.destroy()
        assert.equal(dev.listenerCount('rawPacket'), 0)
    })

    test('streams opened later only see later data', () => {
        const { dev, mux } = setup()
        dev.emit('rawPacket', rxPacket(Buffer.from('early')))
        const a = mux.openStream()
        const gotA = collect(a)
        assert.deepEqual(gotA, [])
    })
})
