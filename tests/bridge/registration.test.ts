import { describe, test, before, after, beforeEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import {
    Client,
    ErrorCodes,
    RemoteError,
    Thinq2Device,
    type Device as ClientDevice,
    type Thinq1DeviceState,
    type Thinq2DeviceState,
} from '@/bridge/thinqApi'
import { Bridge } from '@/bridge/index'
import type { BridgeState, Credentials } from '@/bridge/state'
import { DeviceManager } from '@/cloud/devmgr'
import type { Metadata } from '@/cloud/thinq'
import { MockThinq1Device } from '../helpers/mocks'

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

    /** Every call succeeds. A test that needs a failure mocks this for as many calls as it wants. */
    respond(_req: IncomingMessage) {
        return { resultCode: '0000', result: {} }
    }

    async close() {
        await new Promise((resolve) => this.server.close(resolve))
    }

    postsTo(suffix: string) {
        return this.requests.filter((r) => r.url.endsWith(suffix))
    }
}

describe('Client.addDevice', () => {
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
    })

    function makeClient() {
        const client = new Client({ countryCode: COUNTRY })
        client.homeId = HOME_ID
        return client
    }

    /** Fails the next API call with `resultCode`; later calls succeed. Undone when the test ends. */
    function failNextCall(t: TestContext, resultCode: string) {
        t.mock.method(api, 'respond').mock.mockImplementationOnce(() => ({ resultCode, result: {} }))
    }

    test('registers a device that is not yet in the home', async () => {
        const client = makeClient()
        await client.addDevice(new Thinq2Device(DEVICE_ID, META), 'Bedroom AC', '401')

        const posts = api.postsTo('/devices')
        assert.equal(posts.length, 1)
        assert.equal(posts[0].body.deviceId, DEVICE_ID)
        assert.equal(posts[0].body.aliasPrefix, 'Bedroom AC')
        assert.equal(posts[0].body.initDevice, false)
    })

    // The caller only reaches addDevice for an appliance the home does not list, so a leftover
    // registration here is one the delete failed to clear. initDevice=true is what lets the cloud
    // replace it; Bridge.register is responsible for never asking when the registration is wanted.
    test('replaces a leftover registration with initDevice=true', async (t) => {
        failNextCall(t, ErrorCodes.ERROR_ALREADY_DEVICES_REGISTERED_IN_HOME)
        const client = makeClient()

        await client.addDevice(new Thinq2Device(DEVICE_ID, META), 'Bedroom AC', '401')

        const posts = api.postsTo('/devices')
        assert.equal(posts.length, 2, 'the add is retried once')
        assert.equal(posts[0].body.initDevice, false)
        assert.equal(posts[1].body.initDevice, true)
    })

    test('still reports unrelated failures', async (t) => {
        failNextCall(t, ErrorCodes.ERROR_NO_PERMISSIONS)
        const client = makeClient()

        await assert.rejects(
            () => client.addDevice(new Thinq2Device(DEVICE_ID, META), 'Bedroom AC', '401'),
            (err: unknown) => err instanceof RemoteError && err.resultCode === ErrorCodes.ERROR_NO_PERMISSIONS,
        )
    })
})

type Added = { deviceId: string; alias: string; deviceType: string }

// Only the calls Bridge.register makes on its way through the thinq1 path. The thinq2 path differs
// just in the pairing step, which talks to common.lgthinq.com and needs the appliance itself.
class FakeClient {
    homeDevices: { deviceId: string; alias: string }[] = []
    removed: string[] = []
    added: Added[] = []

    env = { countryCode: COUNTRY }
    gateway = Promise.resolve({
        rtiUri: 'ssl://rti.example:47878',
        thinq1Uri: 'https://thinq1.example/api',
        thinq2Uri: 'https://thinq2.example',
        uris: { empOauthBaseUri: '', empFrontBaseUri2: '' },
    })

    async listDevices() {
        return this.homeDevices
    }

    async removeDevice(deviceId: string) {
        this.removed.push(deviceId)
    }

    async addDevice(device: ClientDevice, alias: string, deviceType: string) {
        this.added.push({ deviceId: device.deviceId, alias, deviceType })
    }

    /** Cast to the real Client type for Bridge.register. */
    asClient() {
        return this as unknown as Client
    }
}

class FakeState implements BridgeState {
    credentials: Credentials | undefined
    deviceStates = new Map<string, Thinq1DeviceState | Thinq2DeviceState>()

    getCredentials() {
        return this.credentials
    }

    setCredentials(credentials: Credentials | undefined) {
        this.credentials = credentials
    }

    getDeviceState(id: string) {
        return this.deviceStates.get(id)
    }

    setDeviceState(id: string, state: Thinq1DeviceState | Thinq2DeviceState | undefined) {
        if (state) this.deviceStates.set(id, state)
        else this.deviceStates.delete(id)
    }
}

describe('Bridge.register', () => {
    let client: FakeClient
    let state: FakeState
    let bridge: Bridge
    let statuses: string[]

    beforeEach(() => {
        client = new FakeClient()
        state = new FakeState()
        bridge = new Bridge(state, new DeviceManager())
        statuses = []
    })

    function register(deviceType = '401') {
        const device = new MockThinq1Device(DEVICE_ID, META)
        return bridge.register(client.asClient(), device, deviceType, (status) => statuses.push(status))
    }

    test('leaves the registration of an appliance already in the home alone', async () => {
        client.homeDevices = [
            { deviceId: 'other-device', alias: 'Dryer' },
            { deviceId: DEVICE_ID, alias: '침실 에어컨' },
        ]

        const clientDevice = await register()

        // Re-registering would rename the appliance to "Rethink xxxxxxxx", announce the removal to
        // every app on the account, and rebind it to credentials rethink just created.
        assert.deepEqual(client.removed, [])
        assert.deepEqual(client.added, [])
        assert.ok(!statuses.includes('Removing device from home'))
        assert.ok(!statuses.includes('Adding device to home'))

        // The bridge still gets what it runs on: the thinq1 servers, saved under the device id.
        assert.equal(clientDevice.state, state.getDeviceState(DEVICE_ID))
        assert.deepEqual(clientDevice.state, {
            httpServer: 'https://thinq1.example',
            rtiServer: 'ssl://rti.example:47878',
        })
    })

    test('registers an appliance the account does not have', async () => {
        client.homeDevices = [{ deviceId: 'other-device', alias: 'Dryer' }]

        await register('401')

        assert.deepEqual(client.removed, [DEVICE_ID], 'a stale registration is cleared first')
        assert.deepEqual(client.added, [{ deviceId: DEVICE_ID, alias: 'Rethink aaaabbbb', deviceType: '401' }])
        assert.ok(state.getDeviceState(DEVICE_ID))
    })

    test('falls back to the device type from the metadata', async () => {
        const device = new MockThinq1Device(DEVICE_ID, { ...META, deviceType: '101' })
        await bridge.register(client.asClient(), device)

        assert.deepEqual(client.added, [{ deviceId: DEVICE_ID, alias: 'Rethink aaaabbbb', deviceType: '101' }])
    })

    test('refuses a device whose type is unknown', async () => {
        const device = new MockThinq1Device(DEVICE_ID, META)
        await assert.rejects(() => bridge.register(client.asClient(), device), /Device type must be specified/)

        assert.deepEqual(client.removed, [], 'nothing is touched in the home')
    })
})
