import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest, createServer } from 'node:http'
import { after, before, test } from 'node:test'
import express from 'express'
import { getDeviceMetadata, routes } from '@/cloud/thinq1/http'
import type { Config } from '@/util/config'

let baseUrl: string
const app = express()
app.use(routes({} as Config))
const server = createServer(app)

before(async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
    server.close()
    await once(server, 'close')
})

async function postMetadata(deviceId: string, body = '<lgedmRoot><modelName>model</modelName></lgedmRoot>') {
    return fetch(`${baseUrl}/lgehadm/api/Device/TotalDeviceInfoSvc`, {
        method: 'POST',
        headers: {
            'content-type': 'text/xml',
            'x-lgedm-deviceid': deviceId,
            'x-lgedm-devicetype': '101',
        },
        body,
    })
}

test('metadata round-trips through the store, even under a __proto__ id', async () => {
    const id = 'device-0001'
    const accepted = await postMetadata(id)
    assert.equal(accepted.status, 200)
    assert.deepEqual(getDeviceMetadata(id), {
        deviceType: '101',
        modelId: 'model',
        modelName: 'model',
    })

    // A hostile device id lands in the Map, not on Object.prototype.
    const polluted = await postMetadata('__proto__')
    assert.equal(polluted.status, 200)
    assert.ok(getDeviceMetadata('__proto__'))
    assert.equal(({} as Record<string, unknown>).modelName, undefined)
})

test('malformed, oversized, and aborted XML streams are contained', async () => {
    assert.equal((await postMetadata('malformed-device', '<lgedmRoot>')).status, 400)
    assert.equal((await postMetadata('oversized-device', 'x'.repeat(1_000_001))).status, 413)
    assert.equal(getDeviceMetadata('malformed-device'), undefined)
    assert.equal(getDeviceMetadata('oversized-device'), undefined)

    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise<void>((resolve) => {
        const req = httpRequest(
            {
                host: '127.0.0.1',
                port: address.port,
                path: '/lgehadm/api/Device/TotalDeviceInfoSvc',
                method: 'POST',
                headers: {
                    'content-type': 'text/xml',
                    'x-lgedm-deviceid': 'aborted-device',
                    'x-lgedm-devicetype': '101',
                },
            },
            () => {},
        )
        req.on('error', () => resolve())
        req.write('<lgedmRoot><modelName>')
        req.destroy()
        setImmediate(resolve)
    })

    const healthy = await postMetadata('healthy-device')
    assert.equal(healthy.status, 200)
    assert.ok(getDeviceMetadata('healthy-device'))
    assert.equal(getDeviceMetadata('aborted-device'), undefined)
})
