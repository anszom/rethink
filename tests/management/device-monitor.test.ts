import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, test } from 'node:test'
import WebSocket from 'ws'
import type HA_bridge from '@/cloud/ha_bridge'
import { DeviceManager } from '@/cloud/devmgr'
import { app } from '@/management'
import { Device as T2Device } from '@/cloud/thinq2/device'
import type { AnyDevice } from '@/cloud/devmgr'
import { MockThinq1Device, MockThinq2Device } from '../helpers/mocks'
import { customPayload, rxPacket, txAck, txPacket } from '@/cloud/thinq2/clip'

// The wire format that html/monitor.js, tools/rethink-capture.ts and tools/mcp-server.ts rely on.
describe('device monitor protocol', () => {
    const META = { modelId: 'model-id', modelName: 'model-name', deviceType: '401' }
    let server: ReturnType<typeof app> | undefined

    afterEach(async () => {
        await new Promise((resolve) => server?.close(resolve))
    })

    async function monitor(device: AnyDevice) {
        const haStatus = Object.assign(new EventEmitter(), { isConnected: true })
        const manager = new DeviceManager()
        manager.accept(device)

        server = app({ HA: haStatus, haDevices: new Map() } as unknown as HA_bridge, manager, undefined)
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')

        const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/device?id=${device.id}`)
        const messages: unknown[] = []
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())))
        await once(ws, 'message') // status: online
        messages.length = 0

        return {
            ws,
            messages,
            async received(count: number) {
                for (let i = 0; i < 200 && messages.length < count; i++) await new Promise((r) => setTimeout(r, 5))
                return messages
            },
        }
    }

    // Hex payloads may come in either case; lower-case them so they compare case-insensitively.
    function lowerHex(messages: unknown[]) {
        return messages.map((m) => {
            const { rx, tx, ...rest } = m as { rx?: unknown; tx?: unknown }
            return {
                ...rest,
                ...(typeof rx === 'string' && { rx: rx.toLowerCase() }),
                ...(typeof tx === 'string' && { tx: tx.toLowerCase() }),
            }
        })
    }

    test('ThinQ1 status is reported as a hex rx packet', async () => {
        const device = new MockThinq1Device('device-1', META)
        const { received } = await monitor(device)
        device.inject(Buffer.from([0x01, 0xab]))
        assert.deepEqual(lowerHex(await received(1)), [{ rx: '01ab', injected: false, type: 'packet' }])
    })

    test('ThinQ1 messages with a payload are reported, others are not', async () => {
        const device = new MockThinq1Device('device-1', META)
        const { received } = await monitor(device)
        device.emit('rawPacket', { CmdWId: 'a', Cmd: 'Alive' })
        device.emit('rawPacket', { CmdWId: 'b', ReturnCode: '0000' })
        device.emit('rawPacket', { CmdWId: 'c', Cmd: 'DevInfo', Format: 'B64', Data: 'AQI=' })
        assert.deepEqual(lowerHex(await received(1)), [{ rx: '0102', injected: false, type: 'packet' }])
    })

    test('ThinQ1 commands are reported as a JSON string', async () => {
        const device = new MockThinq1Device('device-1', META)
        const { ws, received } = await monitor(device)
        const command = { Cmd: 'Mon', CmdOpt: 'Start' }
        ws.send(JSON.stringify({ sendToDevice: command }))
        assert.deepEqual(await received(1), [{ tx: JSON.stringify(command), injected: true, type: 'packet' }])
        assert.deepEqual(device.sent, [command])
    })

    test('ThinQ1 sendFromDevice takes hex and is reported as injected', async () => {
        const device = new MockThinq1Device('device-1', META)
        const { ws, received } = await monitor(device)
        ws.send(JSON.stringify({ sendFromDevice: '01ab' }))
        assert.deepEqual(lowerHex(await received(1)), [{ rx: '01ab', injected: true, type: 'packet' }])
    })

    test('ThinQ2 packets from the device are reported as hex', async () => {
        const device = new MockThinq2Device('device-2', META)
        const { received } = await monitor(device)
        device.onPacket(rxPacket(Buffer.from([0xaa, 0xbb])))
        assert.deepEqual(lowerHex(await received(1)), [{ rx: 'aabb', injected: false, type: 'packet' }])
    })

    test('ThinQ2 packets and acks to the device are reported as hex, with their type', async () => {
        const device = new MockThinq2Device('device-2', META)
        const { received } = await monitor(device)
        device.sendRaw(customPayload('somethingElse', 1, 'AABB')) // not a packet, not reported
        device.sendRaw(txPacket(Buffer.from([0xaa, 0x01])))
        device.sendRaw(txAck(Buffer.from([0xaa, 0x02])))
        assert.deepEqual(lowerHex(await received(2)), [
            { tx: 'aa01', injected: false, type: 'packet' },
            { tx: 'aa02', injected: false, type: 'ack' },
        ])
    })

    test('ThinQ2 sendToDevice takes hex and is reported as injected', async () => {
        const device = new MockThinq2Device('device-2', META)
        const { ws, received } = await monitor(device)
        ws.send(JSON.stringify({ sendToDevice: 'aa01' }))
        assert.deepEqual(lowerHex(await received(1)), [{ tx: 'aa01', injected: true, type: 'packet' }])
        assert.deepEqual(device.outbox, [Buffer.from([0xaa, 0x01])])
    })

    test('ThinQ2 sendFromDevice takes hex and is reported as injected', async () => {
        const device = new MockThinq2Device('device-2', META)
        const { ws, received } = await monitor(device)
        ws.send(JSON.stringify({ sendFromDevice: 'aa01' }))
        assert.deepEqual(lowerHex(await received(1)), [{ rx: 'aa01', injected: true, type: 'packet' }])
    })
})

test('device monitor detaches device and manager listeners after a real WebSocket close', async () => {
    const haStatus = Object.assign(new EventEmitter(), { isConnected: true })
    const ha = { HA: haStatus, haDevices: new Map() } as unknown as HA_bridge
    const manager = new DeviceManager()
    const device = new MockThinq1Device('device-1', {
        modelId: 'model-id',
        modelName: 'model-name',
        deviceType: '401',
    })
    manager.accept(device)

    const server = app(ha, manager, undefined)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?id=device-1`)
    const firstMessage = once(ws, 'message')
    await once(ws, 'open')
    await firstMessage

    assert.equal(device.listenerCount('rawPacket'), 1)
    assert.equal(device.listenerCount('sendRawPacket'), 1)
    assert.equal(manager.listenerCount('newDevice'), 2)
    assert.equal(manager.listenerCount('dropDevice'), 2)

    ws.close()
    await once(ws, 'close')
    // The client's close event can fire before the server has run its own close handler.
    for (let i = 0; i < 100 && device.listenerCount('rawPacket') > 0; i++) await new Promise((r) => setTimeout(r, 10))

    assert.equal(device.listenerCount('rawPacket'), 0)
    assert.equal(device.listenerCount('sendRawPacket'), 0)
    assert.equal(manager.listenerCount('newDevice'), 1)
    assert.equal(manager.listenerCount('dropDevice'), 1)

    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
    assert.equal(manager.listenerCount('newDevice'), 0)
    assert.equal(manager.listenerCount('dropDevice'), 0)
    assert.equal(haStatus.listenerCount('statusChanged'), 0)
})

test('server shutdown closes a connected device monitor and detaches all listeners', async () => {
    const haStatus = Object.assign(new EventEmitter(), { isConnected: true })
    const ha = { HA: haStatus, haDevices: new Map() } as unknown as HA_bridge
    const manager = new DeviceManager()
    const device = new MockThinq1Device('device-1', {
        modelId: 'model-id',
        modelName: 'model-name',
        deviceType: '401',
    })
    manager.accept(device)

    const server = app(ha, manager, undefined)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?id=device-1`)
    const firstMessage = once(ws, 'message')
    await once(ws, 'open')
    await firstMessage

    const websocketClosed = once(ws, 'close')
    const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
    await Promise.all([websocketClosed, serverClosed])

    assert.equal(device.listenerCount('rawPacket'), 0)
    assert.equal(device.listenerCount('sendRawPacket'), 0)
    assert.equal(manager.listenerCount('newDevice'), 0)
    assert.equal(manager.listenerCount('dropDevice'), 0)
    assert.equal(haStatus.listenerCount('statusChanged'), 0)
})
