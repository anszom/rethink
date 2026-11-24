import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EventEmitter } from 'node:events'
import { Multiplexer } from '@/cloud/thinq1/multiplexer'
import { MON_START, MON_STOP, type MessageBody } from '@/cloud/thinq1/rti'
import type { Device } from '@/cloud/thinq1/device'

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

function collect(stream: { on(ev: 'packet', cb: (b: MessageBody) => void): unknown }) {
    const got: MessageBody[] = []
    stream.on('packet', (b) => got.push(b))
    return got
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve))

// Captured from a washer (QC_Modem_1.2.80), see anszom/rethink#16
const status1: MessageBody = {
    CmdWId: 'n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53',
    ReturnCode: '0000',
    Format: 'B64',
    Data: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAABgBkAAAAAA==',
}
const status2: MessageBody = {
    CmdWId: 'n-48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53',
    ReturnCode: '0000',
    Format: 'B64',
    Data: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAABgBkAAAAAA==',
}
const devInfo: MessageBody = {
    CmdWId: '7f6816e0-99a3-11f0-b166-7c1c4ec8cc53',
    Cmd: 'DevInfo',
    Format: 'B64',
    Data: 'UnVsZVZlcj0xLjMsRndWZXI9UUNfTW9kZW1fMS4yLjgwLHJlZ0ZhaWw9Tg==',
}

describe('thinq1 Multiplexer', () => {
    test('first Mon Start is forwarded to the device, later ones are coalesced', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        a.send(MON_START)
        b.send(MON_START)
        assert.deepEqual(dev.sent, [MON_START])
        assert.equal(mux.monitoringStreams, 2)
    })

    test('Mon Stop is forwarded only when the last stream stops', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        a.send(MON_START)
        b.send(MON_START)
        a.send(MON_STOP)
        assert.deepEqual(dev.sent, [MON_START])
        b.send(MON_STOP)
        assert.deepEqual(dev.sent, [MON_START, MON_STOP])
        assert.equal(mux.monitoringStreams, 0)
    })

    test('duplicate Mon Start from one stream is not counted twice', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        a.send(MON_START)
        a.send(MON_START)
        assert.equal(mux.monitoringStreams, 1)
        // the duplicate is swallowed
        assert.deepEqual(dev.sent, [MON_START])
    })

    test('other commands are passed straight to the device', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const cmd = { Cmd: 'Control', CmdOpt: 'Set' }
        a.send(cmd)
        assert.deepEqual(dev.sent, [cmd])
    })

    test('device data reaches only live streams', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        const gotB = collect(b)
        a.send(MON_START)
        dev.emit('rawPacket', status1)
        assert.deepEqual(gotA, [status1])
        assert.deepEqual(gotB, [])
    })

    test('stream stops receiving data after Mon Stop', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        a.send(MON_START)
        b.send(MON_START)
        a.send(MON_STOP)
        dev.emit('rawPacket', status1)
        assert.deepEqual(gotA, [])
    })

    test('a repeated Mon Stop does not unbalance the counter', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        a.send(MON_START)
        b.send(MON_START)
        a.send(MON_STOP)
        a.send(MON_STOP)
        assert.equal(mux.monitoringStreams, 1)
        assert.deepEqual(
            dev.sent.filter((m) => m === MON_STOP),
            [],
        )
    })

    test('late-starting stream gets the cached status', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        a.send(MON_START)
        dev.emit('rawPacket', status1)
        dev.emit('rawPacket', status2)

        const b = mux.openStream()
        const gotB = collect(b)
        b.send(MON_START)
        assert.deepEqual(gotB, [status2])
    })

    test('first stream does not get a cached status', () => {
        const { mux } = setup()
        const a = mux.openStream()
        const gotA = collect(a)
        a.send(MON_START)
        assert.deepEqual(gotA, [])
    })

    test('status is not cached while nobody is monitoring', () => {
        const { dev, mux } = setup()
        dev.emit('rawPacket', status1)
        assert.equal(mux.lastStatus, undefined)
    })

    test('cached status is dropped when monitoring stops', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        a.send(MON_START)
        dev.emit('rawPacket', status1)
        assert.equal(mux.lastStatus, status1)
        a.send(MON_STOP)
        assert.equal(mux.lastStatus, undefined)

        const b = mux.openStream()
        const gotB = collect(b)
        b.send(MON_START)
        assert.deepEqual(gotB, [])
        assert.deepEqual(dev.sent, [MON_START, MON_STOP, MON_START])
    })

    test('destroy() of a live stream stops monitoring and detaches', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const gotA = collect(a)
        a.send(MON_START)
        a.destroy()
        assert.deepEqual(dev.sent, [MON_START, MON_STOP])
        assert.equal(mux.monitoringStreams, 0)
        assert.equal(dev.listenerCount('rawPacket'), 1) // only the mux itself
        dev.emit('rawPacket', status1)
        assert.deepEqual(gotA, [])
    })

    test('destroy() of a non-live stream does not touch the monitor count', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        a.send(MON_START)
        b.destroy()
        assert.equal(mux.monitoringStreams, 1)
        assert.deepEqual(dev.sent, [MON_START])
    })

    test('DevInfo reaches non-live streams and is not cached as a status', () => {
        const { dev, mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        const gotA = collect(a)
        const gotB = collect(b)
        a.send(MON_START)
        dev.emit('rawPacket', devInfo)
        assert.deepEqual(gotA, [devInfo])
        assert.deepEqual(gotB, [devInfo])
        assert.equal(mux.lastStatus, undefined)
    })

    test('a stream opened after DevInfo receives it once the caller had a chance to subscribe', async () => {
        const { dev, mux } = setup()
        dev.emit('rawPacket', devInfo)

        const a = mux.openStream()
        const gotA = collect(a)
        assert.deepEqual(gotA, [])
        await nextTick()
        assert.deepEqual(gotA, [devInfo])
    })

    test('destroy() cancels a pending DevInfo delivery', async () => {
        const { dev, mux } = setup()
        dev.emit('rawPacket', devInfo)

        const a = mux.openStream()
        const gotA = collect(a)
        a.destroy()
        await nextTick()
        assert.deepEqual(gotA, [])
    })

    test('destroy() twice does not unbalance the counter', () => {
        const { mux } = setup()
        const a = mux.openStream()
        const b = mux.openStream()
        a.send(MON_START)
        b.send(MON_START)
        a.destroy()
        a.destroy()
        assert.equal(mux.monitoringStreams, 1)
    })
})
