import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import * as https from 'node:https'
import * as tls from 'node:tls'
import { Duplex } from 'node:stream'
import express from 'express'
import { Bridge } from '@/bridge/index'
import { Connection as Thinq1Connection } from '@/bridge/thinq1connection'
import type { BridgeState, Credentials } from '@/bridge/state'
import type { Thinq1DeviceState, Thinq2DeviceState } from '@/bridge/thinqApi'
import { DeviceManager } from '@/cloud/devmgr'
import { isAck, MON_START, MON_STOP, type Message, type MessageBody } from '@/cloud/thinq1/rti'
import { Device, DeviceAcceptor } from '@/cloud/thinq1/device'
import { routes } from '@/cloud/thinq1/http'
import type { Config } from '@/util/config'
import { make as makeFrame, splitter } from '@/util/length_prefixed_frame'
import { createSelfSignedCA, type Certificate } from '@/util/pki'
import '../helpers/mocks'

const DEVICE_ID = '48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53'
const DEVICE_TYPE = '201'
const MODEL_NAME = 'WT_TEST'

// Message shapes captured from a washer (QC_Modem_1.2.80), see anszom/rethink#16
const DEV_INFO: MessageBody = {
    CmdWId: '7f6816e0-99a3-11f0-b166-7c1c4ec8cc53',
    Cmd: 'DevInfo',
    Format: 'B64',
    Data: 'UnVsZVZlcj0xLjMsRndWZXI9UUNfTW9kZW1fMS4yLjgwLHJlZ0ZhaWw9Tg==',
}
const ALIVE: MessageBody = { CmdWId: '8571a6f0-99a3-11f0-856f-7c1c4ec8cc53', Cmd: 'Alive' }

function status(firstByte: number): MessageBody {
    return {
        CmdWId: `n-${DEVICE_ID}`,
        ReturnCode: '0000',
        Format: 'B64',
        Data: Buffer.concat([Buffer.from([firstByte]), Buffer.alloc(27)]).toString('base64'),
    }
}

const CLOUD_START: MessageBody = { CmdWId: `n-${DEVICE_ID}`, Cmd: 'Mon', CmdOpt: 'Start' }
const CLOUD_STOP: MessageBody = { CmdWId: `n-${DEVICE_ID}`, Cmd: 'Mon', CmdOpt: 'Stop' }

// Sync messages have no meaning. Each direction is ordered, so a test can check that something was
// not forwarded by waiting for a sync message sent after it.
const SYNC = 'Sync'

class FakeState implements BridgeState {
    deviceStates = new Map<string, Thinq1DeviceState | Thinq2DeviceState>()
    getCredentials(): Credentials | undefined {
        return undefined
    }
    setCredentials() {}
    getDeviceState(id: string) {
        return this.deviceStates.get(id)
    }
    setDeviceState() {}
}

async function until(cond: () => boolean, what: string, ms = 2000) {
    const end = Date.now() + ms
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 5))
    }
}

function frame(body: MessageBody) {
    return makeFrame(JSON.stringify({ Header: { 'x-lgedm-deviceId': DEVICE_ID }, Body: body } satisfies Message))
}

// The appliance's end of its connection to rethink.
class FakeAppliance {
    written: MessageBody[] = []
    socket: Duplex

    constructor() {
        const split = splitter((payload: Buffer) =>
            this.written.push((JSON.parse(payload.toString()) as Message).Body!),
        )
        this.socket = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
                split(chunk)
                callback()
            },
        })
    }

    send(body: MessageBody) {
        this.socket.push(frame(body))
    }

    // what rethink has asked the appliance to do, without the acks and the generated CmdWId
    commands() {
        return this.written
            .filter((body) => body.Cmd !== undefined && body.Cmd !== SYNC)
            .map(({ CmdWId, ...command }) => command)
    }
}

// The ThinQ cloud's two servers: the HTTP API that the bridge calls first, then the RTI server.
class FakeCloud {
    httpRequests: IncomingMessage[] = []
    connections: { socket: tls.TLSSocket; received: MessageBody[] }[] = []
    private http: https.Server
    private rti: tls.Server
    private httpGate = Promise.resolve()
    releaseHttp = () => {}

    constructor(cert: Certificate) {
        this.http = https.createServer(cert, (req, res) => {
            this.httpRequests.push(req)
            req.resume()
            req.on('end', async () => {
                await this.httpGate
                res.end('<lgedmRoot><returnCd>0000</returnCd></lgedmRoot>')
            })
        })
        this.rti = tls.createServer(cert, (socket) => {
            const received: MessageBody[] = []
            this.connections.push({ socket, received })
            socket.on('error', () => {})
            socket.on(
                'data',
                splitter((payload: Buffer) => received.push((JSON.parse(payload.toString()) as Message).Body!)),
            )
        })
    }

    // HTTP responses wait for releaseHttp()
    holdHttp() {
        this.httpGate = new Promise((resolve) => (this.releaseHttp = resolve))
    }

    async listen() {
        await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve))
        await new Promise<void>((resolve) => this.rti.listen(0, '127.0.0.1', resolve))
        return {
            httpServer: `https://127.0.0.1:${(this.http.address() as AddressInfo).port}`,
            rtiServer: `127.0.0.1:${(this.rti.address() as AddressInfo).port}`,
        }
    }

    async close() {
        for (const { socket } of this.connections) socket.destroy()
        this.http.closeAllConnections()
        await new Promise((resolve) => this.http.close(resolve))
        await new Promise((resolve) => this.rti.close(resolve))
    }

    get current() {
        return this.connections[this.connections.length - 1]
    }

    send(body: MessageBody) {
        this.current.socket.write(frame(body))
    }

    // what the appliance has told the cloud, without the bridge's own keepalives and acks
    forwarded() {
        return this.current.received.filter((body) => body.Cmd !== 'Alive' && body.Cmd !== SYNC && !isAck(body))
    }
}

// The real path from a socket to the cloud: Connection -> DeviceAcceptor -> Device -> Multiplexer ->
// Bridge -> BridgedDevice -> Thinq1Connection, between a fake appliance and a fake cloud.
describe('Thinq1Connection, bridged', () => {
    let cert: Certificate
    let metadataServer: HttpServer
    let cloud: FakeCloud
    let appliance: FakeAppliance
    let device: Device
    let bridge: Bridge
    let syncs = 0

    before(async () => {
        cert = await createSelfSignedCA()

        // an appliance is only accepted after it has announced itself over HTTP
        metadataServer = express()
            .use(routes({} as Config))
            .listen(0, '127.0.0.1')
        await new Promise((resolve) => metadataServer.once('listening', resolve))
        const resp = await fetch(
            `http://127.0.0.1:${(metadataServer.address() as AddressInfo).port}/lgehadm/api/Device/TotalDeviceInfoSvc`,
            {
                method: 'POST',
                headers: { 'x-lgedm-deviceid': DEVICE_ID, 'x-lgedm-devicetype': DEVICE_TYPE },
                body: `<lgedmRoot><modelName>${MODEL_NAME}</modelName></lgedmRoot>`,
            },
        )
        assert.equal(resp.status, 200)
    })

    after(async () => {
        await new Promise((resolve) => metadataServer.close(resolve))
    })

    afterEach(async () => {
        appliance.socket.destroy()
        await until(() => cloud.connections.every(({ socket }) => socket.closed), 'the bridge to disconnect')
        await cloud.close()
    })

    // The appliance opens with DevInfo, as the real one does. The bridge's connection comes up later,
    // which is what makes the multiplexer's DevInfo replay necessary.
    async function connect() {
        await connectAppliance()

        await until(() => bridge.status(DEVICE_ID) === 'online', 'the bridge to connect')
        // the client's handshake completes before the server's
        await until(() => cloud.connections.length > 0, 'the cloud to see the connection')
        await until(() => cloud.forwarded().length > 0, 'the DevInfo')
    }

    async function connectAppliance({ holdHttp = false } = {}) {
        cloud = new FakeCloud(cert)
        if (holdHttp) cloud.holdHttp()
        const state = new FakeState()
        state.deviceStates.set(DEVICE_ID, await cloud.listen())

        const manager = new DeviceManager()
        bridge = new Bridge(state, manager)

        const acceptor = new DeviceAcceptor()
        acceptor.on('newDevice', (dev) => {
            device = dev
            manager.accept(dev)
        })

        appliance = new FakeAppliance()
        acceptor.accept(appliance.socket)
        appliance.send(DEV_INFO)
    }

    async function syncToCloud() {
        const CmdWId = `sync-${++syncs}`
        appliance.send({ CmdWId, Cmd: SYNC })
        await until(() => cloud.current.received.some((body) => body.CmdWId === CmdWId), 'the appliance sync message')
    }

    async function syncToAppliance() {
        const count = appliance.written.filter((body) => body.Cmd === SYNC).length
        cloud.send({ CmdWId: `sync-${++syncs}`, Cmd: SYNC })
        await until(
            () => appliance.written.filter((body) => body.Cmd === SYNC).length > count,
            'the cloud sync message',
        )
    }

    test('announces the device over HTTP before connecting', async () => {
        await connect()
        assert.equal(cloud.httpRequests.length, 1)
        assert.equal(cloud.httpRequests[0].url, '/lgehadm/api/Device/TotalDeviceInfoSvc')
        assert.equal(cloud.httpRequests[0].headers['x-lgedm-deviceid'], DEVICE_ID)
        assert.equal(cloud.httpRequests[0].headers['x-lgedm-devicetype'], DEVICE_TYPE)
    })

    test('the DevInfo sent before the bridge connected reaches the cloud unchanged', async () => {
        await connect()
        assert.deepEqual(cloud.forwarded(), [DEV_INFO])
    })

    test('rethink acks the DevInfo to the appliance, without waiting for the cloud', async () => {
        await connect()
        assert.deepEqual(appliance.written, [{ CmdWId: DEV_INFO.CmdWId, ReturnCode: '0000' }])
    })

    test("the cloud's ack of a forwarded message does not reach the appliance", async () => {
        await connect()
        cloud.send({ CmdWId: DEV_INFO.CmdWId, ReturnCode: '0000' })
        await syncToAppliance()
        assert.deepEqual(appliance.written.filter((body) => body.Cmd !== SYNC).length, 1) // only the DevInfo ack
    })

    test("the appliance's Alive is acked locally and not forwarded", async () => {
        await connect()
        appliance.send(ALIVE)
        await syncToCloud()
        assert.ok(appliance.written.some((body) => body.CmdWId === ALIVE.CmdWId && body.ReturnCode === '0000'))
        assert.ok(!cloud.current.received.some((body) => body.CmdWId === ALIVE.CmdWId))
    })

    test('the connection sends keepalives of its own', async () => {
        await connect()
        await until(() => cloud.current.received.some((body) => body.Cmd === 'Alive'), 'an Alive')
    })

    test('status is not forwarded until the cloud asks for it', async () => {
        await connect()
        appliance.send(status(1))
        await syncToCloud()
        assert.deepEqual(cloud.forwarded(), [DEV_INFO])
    })

    test("the cloud's Start is acked, reaches the appliance and turns on the status", async () => {
        await connect()
        cloud.send(CLOUD_START)
        await until(() => appliance.commands().length > 0, 'the Start')
        assert.deepEqual(appliance.commands(), [MON_START])

        await until(
            () => cloud.current.received.some((body) => isAck(body) && body.CmdWId === CLOUD_START.CmdWId),
            'the ack of the Start',
        )

        appliance.send(status(1))
        appliance.send(status(2))
        await syncToCloud()
        assert.deepEqual(cloud.forwarded(), [DEV_INFO, status(1), status(2)])
    })

    test("the appliance's ack of the Start is not forwarded", async () => {
        await connect()
        cloud.send(CLOUD_START)
        await until(() => appliance.commands().length > 0, 'the Start')

        const start = appliance.written.find((body) => body.Cmd === 'Mon')!
        appliance.send({ CmdWId: start.CmdWId, ReturnCode: '0000' })
        await syncToCloud()
        assert.ok(!cloud.current.received.some((body) => body.CmdWId === start.CmdWId))
    })

    test("the cloud's Stop reaches the appliance and turns off the status", async () => {
        await connect()
        cloud.send(CLOUD_START)
        appliance.send(status(1))
        await until(() => appliance.commands().length > 0, 'the Start')

        cloud.send(CLOUD_STOP)
        await until(() => appliance.commands().length > 1, 'the Stop')
        assert.deepEqual(appliance.commands(), [MON_START, MON_STOP])

        const before = cloud.forwarded().length
        appliance.send(status(2))
        await syncToCloud()
        assert.equal(cloud.forwarded().length, before)
    })

    test('other commands from the cloud reach the appliance', async () => {
        await connect()
        const { CmdWId, ...command } = {
            CmdWId: 'b2ed9c50-99a3-11f0-b166-7c1c4ec8cc53',
            Cmd: 'Control',
            CmdOpt: 'Set',
            Format: 'B64',
            Data: 'AQID',
        }
        cloud.send({ CmdWId, ...command })
        await until(() => appliance.commands().length > 0, 'the command')
        assert.deepEqual(appliance.commands(), [command])
    })

    describe('next to a driver that is already monitoring', () => {
        async function connectWithDriver() {
            await connect()
            const driver = device.openStream()
            const driverGot: MessageBody[] = []
            driver.on('packet', (body) => driverGot.push(body))
            driver.send(MON_START)
            await until(() => appliance.commands().length > 0, "the driver's Start")
            return driverGot
        }

        test("the cloud's Start gets the cached status and is not repeated to the appliance", async () => {
            await connectWithDriver()
            appliance.send(status(1))
            await syncToCloud()
            assert.deepEqual(cloud.forwarded(), [DEV_INFO])

            cloud.send(CLOUD_START)
            await until(() => cloud.forwarded().length > 1, 'the cached status')
            assert.deepEqual(cloud.forwarded(), [DEV_INFO, status(1)])

            await syncToAppliance()
            assert.deepEqual(appliance.commands(), [MON_START])
        })

        test('status reaches both streams while the cloud is monitoring', async () => {
            const driverGot = await connectWithDriver()
            cloud.send(CLOUD_START)
            await syncToAppliance()

            appliance.send(status(1))
            await syncToCloud()
            assert.deepEqual(cloud.forwarded(), [DEV_INFO, status(1)])
            assert.ok(driverGot.some((body) => body.Data === status(1).Data))
        })

        test("the cloud's Stop does not stop the driver's monitoring", async () => {
            const driverGot = await connectWithDriver()
            cloud.send(CLOUD_START)
            cloud.send(CLOUD_STOP)
            await syncToAppliance()
            assert.deepEqual(appliance.commands(), [MON_START])

            appliance.send(status(1))
            await syncToCloud()
            assert.deepEqual(cloud.forwarded(), [DEV_INFO])
            assert.ok(driverGot.some((body) => body.Data === status(1).Data))
        })
    })

    describe('when the cloud connection drops', () => {
        async function dropCloud() {
            cloud.current.socket.destroy()
            await until(() => bridge.status(DEVICE_ID) === 'offline', 'the bridge to notice')
        }

        function reconnect() {
            const connections = cloud.connections.length
            bridge.bridgedDevices.get(DEVICE_ID)!.reconnectNow()
            return Promise.all([
                until(() => cloud.connections.length > connections, 'the new connection'),
                until(() => bridge.status(DEVICE_ID) === 'online', 'the bridge to reconnect'),
            ])
        }

        test("monitoring on the cloud's behalf is stopped", async () => {
            await connect()
            cloud.send(CLOUD_START)
            await until(() => appliance.commands().length > 0, 'the Start')

            await dropCloud()
            await until(() => appliance.commands().length > 1, 'the Stop')
            assert.deepEqual(appliance.commands(), [MON_START, MON_STOP])
        })

        test('the next connection gets the DevInfo again, and no status until it asks', async () => {
            await connect()
            cloud.send(CLOUD_START)
            appliance.send(status(1))
            await syncToCloud()

            await dropCloud()
            await reconnect()
            await until(() => cloud.forwarded().length > 0, 'the DevInfo')

            appliance.send(status(2))
            await syncToCloud()
            assert.deepEqual(cloud.forwarded(), [DEV_INFO])
        })
    })

    test('disabling the bridge during the HTTP announcement stops the connection from coming up', async () => {
        await connectAppliance({ holdHttp: true })
        await until(() => cloud.httpRequests.length > 0, 'the announcement')

        const upstream = bridge.bridgedDevices.get(DEVICE_ID)!.upstream as Thinq1Connection
        let ready = false
        upstream.once('ready', () => (ready = true))

        bridge.disable(DEVICE_ID)
        cloud.releaseHttp()

        // A connection started now has further to go than the disabled one, so once this one is up,
        // the disabled one would have come up too.
        const later = new Thinq1Connection(upstream.device)
        await new Promise<void>((resolve) => later.once('ready', resolve))
        later.destroy()

        // close a leaked connection before asserting, otherwise it keeps the test process alive
        const socket = upstream.socket
        upstream.destroy()

        assert.equal(ready, false)
        assert.equal(socket, undefined)
        assert.equal(device.listenerCount('rawPacket'), 1) // only the multiplexer, no bridge stream
    })

    test('the cloud connection closes when the appliance disconnects', async () => {
        await connect()
        appliance.socket.destroy()
        await until(() => cloud.current.socket.closed, 'the cloud connection to close')
        assert.equal(bridge.bridgedDevices.has(DEVICE_ID), false)
    })
})
