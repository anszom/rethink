import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { Client, ErrorCodes, RemoteError, Thinq2Device } from '@/bridge/thinqApi'
import { registrationPlan } from '@/bridge/index'
import type { Metadata } from '@/cloud/thinq'

const COUNTRY = 'KR'
const HOME_ID = 'home-1'
const DEVICE_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'RAC_056905_WW', swVersion: '249003' }

type Recorded = { url: string; body: Record<string, unknown> }

// A stand-in for the ThinQ2 REST API. Client.gatewayCache is a public static, so pre-seeding it
// keeps the constructor from reaching out to route.lgthinq.com and points every call here.
class FakeThinqApi {
    server!: Server
    requests: Recorded[] = []
    /** resultCode returned for POST /service/homes/:homeId/devices. '0000' means success. */
    addDeviceResult = '0000'

    async listen() {
        this.server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8')
                this.requests.push({ url: req.url!, body: raw ? JSON.parse(raw) : {} })
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify(this.respond(req)))
            })
        })

        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    }

    respond(req: IncomingMessage) {
        if (req.url!.endsWith('/service/homes/' + HOME_ID + '/devices'))
            return { resultCode: this.addDeviceResult, result: {} }

        return { resultCode: '0000', result: {} }
    }

    async close() {
        await new Promise((resolve) => this.server.close(resolve))
    }

    postsTo(suffix: string) {
        return this.requests.filter((r) => r.url.endsWith(suffix))
    }
}

describe('bridge registration', () => {
    let api: FakeThinqApi
    let baseUrl: string

    before(async () => {
        api = new FakeThinqApi()
        baseUrl = await api.listen()
        Client.gatewayCache[COUNTRY] = Promise.resolve({
            rtiUri: baseUrl,
            thinq1Uri: baseUrl,
            thinq2Uri: baseUrl,
            uris: { empOauthBaseUri: baseUrl, empFrontBaseUri2: baseUrl },
        })
    })

    after(async () => {
        delete Client.gatewayCache[COUNTRY]
        await api.close()
    })

    beforeEach(() => {
        api.requests = []
        api.addDeviceResult = '0000'
    })

    function makeClient() {
        const client = new Client({ countryCode: COUNTRY })
        client.homeId = HOME_ID
        return client
    }

    test('addDevice registers a device that is not yet in the home', async () => {
        const client = makeClient()
        await client.addDevice(new Thinq2Device(DEVICE_ID, META), 'Bedroom AC', '401')

        const posts = api.postsTo('/devices')
        assert.equal(posts.length, 1)
        assert.equal(posts[0].body.deviceId, DEVICE_ID)
        assert.equal(posts[0].body.aliasPrefix, 'Bedroom AC')
        assert.equal(posts[0].body.initDevice, false)
    })

    test('addDevice accepts an already-registered device without re-creating it', async () => {
        api.addDeviceResult = ErrorCodes.ERROR_ALREADY_DEVICES_REGISTERED_IN_HOME
        const client = makeClient()

        // Must not throw: the existing registration is what we want to keep.
        await client.addDevice(new Thinq2Device(DEVICE_ID, META), 'Bedroom AC', '401')

        const posts = api.postsTo('/devices')
        assert.equal(posts.length, 1, 'no retry is attempted')
        assert.equal(
            posts[0].body.initDevice,
            false,
            'initDevice=true would make LG delete and re-create the registration',
        )
    })

    test('addDevice still reports unrelated failures', async () => {
        api.addDeviceResult = ErrorCodes.ERROR_NO_PERMISSIONS
        const client = makeClient()

        await assert.rejects(
            () => client.addDevice(new Thinq2Device(DEVICE_ID, META), 'Bedroom AC', '401'),
            (err: unknown) => err instanceof RemoteError && err.resultCode === ErrorCodes.ERROR_NO_PERMISSIONS,
        )
    })
})

describe('registrationPlan', () => {
    test('keeps the registration and the name of an appliance already in the home', () => {
        const plan = registrationPlan(
            [
                { deviceId: 'other-device', alias: 'Dryer' },
                { deviceId: DEVICE_ID, alias: '침실 에어컨' },
            ],
            DEVICE_ID,
        )

        assert.equal(plan.removeFirst, false)
        assert.equal(plan.alias, '침실 에어컨')
    })

    test('falls back to a generated name for an appliance the account does not have', () => {
        const plan = registrationPlan([{ deviceId: 'other-device', alias: 'Dryer' }], DEVICE_ID)

        assert.equal(plan.removeFirst, true)
        assert.equal(plan.alias, 'Rethink aaaabbbb')
    })
})
