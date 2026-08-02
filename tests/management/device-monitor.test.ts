import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
import type HA_bridge from '@/cloud/ha_bridge'
import { DeviceManager } from '@/cloud/devmgr'
import { app } from '@/management'
import { MockThinq1Device } from '../helpers/mocks'

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

    assert.equal(device.listenerCount('data'), 1)
    assert.equal(device.listenerCount('sendData'), 1)
    assert.equal(manager.listenerCount('newDevice'), 2)
    assert.equal(manager.listenerCount('dropDevice'), 2)

    ws.close()
    await once(ws, 'close')

    assert.equal(device.listenerCount('data'), 0)
    assert.equal(device.listenerCount('sendData'), 0)
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

    assert.equal(device.listenerCount('data'), 0)
    assert.equal(device.listenerCount('sendData'), 0)
    assert.equal(manager.listenerCount('newDevice'), 0)
    assert.equal(manager.listenerCount('dropDevice'), 0)
    assert.equal(haStatus.listenerCount('statusChanged'), 0)
})
