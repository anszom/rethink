import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import WebSocket from 'ws'
import type HA_bridge from '@/cloud/ha_bridge'
import { DeviceManager } from '@/cloud/devmgr'
import { app } from '@/management'
import { revision } from '@/util/version'
import { MockThinq1Device } from '../helpers/mocks'

const AABB = 'aa16f0263a03ff040100000000000300000000004fbb'
const FROM_DEVICE = '000004000000870204690b8ca036458cd059ace001de6ac9'

function listen() {
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
    return { server, device }
}

test('panel frames, detail, decode, and history match the management UI', async () => {
    const { server, device } = listen()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`

    device.emit('data', Buffer.from('aabbcc', 'hex'))
    device.send({ cmd: 'ping' })

    const frames = await fetch(`${base}/api/devices/device-1/frames`).then((r) => r.json())
    assert.equal(frames.ok, true)
    assert.equal(frames.count, 2)
    assert.equal(frames.frames[0].dir, 'rx')
    assert.equal(frames.frames[0].hex, 'aabbcc')
    assert.equal(frames.frames[0].type, 'packet')
    assert.equal(frames.frames[0].injected, false)
    assert.equal(typeof frames.frames[0].ts, 'number')
    assert.equal(frames.frames[1].dir, 'tx')
    assert.equal(frames.frames[1].hex, JSON.stringify({ cmd: 'ping' }))

    const detail = await fetch(`${base}/api/devices/device-1`).then((r) => r.json())
    assert.equal(detail.ok, true)
    assert.equal(detail.modelId, 'model-id')
    assert.equal(detail.modelName, 'model-name')
    assert.equal(detail.platform, 'thinq1')
    assert.equal(detail.deviceType, '401')
    assert.equal(detail.mapped, false)
    assert.equal(detail.bridged, false)
    assert.equal(detail.haConnected, true)

    const missing = await fetch(`${base}/api/devices/missing`)
    assert.equal(missing.status, 404)

    const aabb = await fetch(`${base}/api/re/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hex: AABB, direction: 'toDevice', model_id: 'H11' }),
    }).then((r) => r.json())
    assert.equal(aabb.ok, true)
    assert.equal(aabb.decode.protocol, 'Aabb')
    assert.equal(aabb.decode.binaryAnalysis.checksum_ok, true)
    assert.equal(aabb.decode.binaryAnalysis.kind, 0xf0)
    assert.match(aabb.text, /modelId: H11/)
    assert.match(aabb.text, /checksumOk: true/)

    const tlv = await fetch(`${base}/api/re/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hex: FROM_DEVICE, direction: 'fromDevice' }),
    }).then((r) => r.json())
    assert.equal(tlv.ok, true)
    assert.equal(tlv.decode.protocol, 'Tlv')
    assert.equal(tlv.decode.crcOk, true)
    assert.ok(tlv.decode.elements.length > 0)
    assert.equal(typeof tlv.decode.elements[0].byteStart, 'number')

    const bad = await fetch(`${base}/api/re/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hex: '   ' }),
    })
    assert.equal(bad.status, 400)

    const html = await fetch(`${base}/`).then((r) => r.text())
    assert.equal(html.includes('__RETHINK_GIT_SHA__'), false)
    assert.ok(html.includes(revision))
    assert.match(html, /Rethink management/)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/device?id=device-1`)
    const [first] = await once(ws, 'message')
    const history = JSON.parse(first.toString())
    assert.equal(history.count, 2)
    assert.equal(history.history[0].rx, 'aabbcc')
    assert.equal(history.history[1].tx, JSON.stringify({ cmd: 'ping' }))
    ws.close()
    await once(ws, 'close')

    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
    })
})
