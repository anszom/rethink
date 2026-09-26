import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { Bridge } from '@/bridge/index'
import type { BridgeState, Credentials } from '@/bridge/state'
import type { Thinq1DeviceState, Thinq2DeviceState } from '@/bridge/thinqApi'
import { Broker } from '@/cloud/mqtt-broker'
import { DeviceManager } from '@/cloud/devmgr'
import type { Metadata } from '@/cloud/thinq'
import { MockThinq2Device } from '../helpers/mocks'

const DEVICE_ID = 'eff416a1-7832-132c-a6e7-3034db631a60'
const META: Metadata = { modelId: 'BDVG_FX0003_US', modelName: 'BDVG_FX0003_US', swVersion: '0.0.0' }
const SUB_TOPIC = `clip/message/devices/${DEVICE_ID}`
const PROV_TOPIC = `clip/provisioning/devices/${DEVICE_ID}`

// Captured from the ThinQ cloud to an LG dryer while bridged (2026-09-24): its ack of the dryer's
// `30 4d 01` course-list request.
const CLOUD_ACK = 'AA08F0004D04A6BB'
const CLOUD_PACKET = 'AA12F0ED1121010000001804111200005EBB'

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
        await new Promise((r) => setTimeout(r, 10))
    }
}

// The real Bridge -> BridgedDevice -> Thinq2Connection path, with rethink's own broker standing in for
// the ThinQ cloud's and a mock appliance downstream.
describe('Thinq2Connection, bridged', () => {
    let broker: Broker
    let server: Server
    let sockets: Set<Socket>
    let device: MockThinq2Device
    let preDeployed: boolean

    beforeEach(async () => {
        broker = new Broker()
        sockets = new Set()
        server = createServer((s) => {
            sockets.add(s)
            broker.accept(s)
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

        const state = new FakeState()
        state.deviceStates.set(DEVICE_ID, {
            countryCode: 'US',
            apiServer: 'http://127.0.0.1:1',
            mqttServer: `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        // preDeploy is published after the subscribe, so once it arrives the connection can receive
        preDeployed = false
        broker.on('publish', (packet) => {
            if (packet.topic === PROV_TOPIC) preDeployed = true
        })

        const manager = new DeviceManager()
        new Bridge(state, manager)
        device = new MockThinq2Device(DEVICE_ID, META)
        manager.accept(device)
        await until(() => preDeployed, 'preDeploy')
    })

    afterEach(async () => {
        device.emit('close') // ends the bridge's MQTT client; let it close its socket before the server goes
        await until(() => [...sockets].every((s) => s.closed), 'the client to disconnect')
        await new Promise((resolve) => server.close(resolve))
    })

    function fromCloud(cmd: string, data: string) {
        const payload = Buffer.from(JSON.stringify({ did: DEVICE_ID, cmd, type: 1, data }))
        broker.publish({ topic: SUB_TOPIC, payload, qos: 0, dup: false, retain: false }, null)
    }

    test("the cloud's ack reaches the appliance as an ack, not a packet", async () => {
        fromCloud('ack', CLOUD_ACK)
        await until(() => device.sent.length > 0, 'the ack')
        assert.deepEqual(device.sent, [{ cmd: 'ack', type: 1, data: CLOUD_ACK }])
        assert.deepEqual(device.outbox, [])
    })

    test('a packet still reaches the appliance as a packet', async () => {
        fromCloud('packet', CLOUD_PACKET)
        await until(() => device.outbox.length > 0, 'the packet')
        assert.deepEqual(
            device.outbox.map((b) => b.toString('hex').toUpperCase()),
            [CLOUD_PACKET],
        )
        assert.deepEqual(device.sent, [])
    })

    test('any other command is not forwarded', async () => {
        fromCloud('somethingNew', 'AA00')
        fromCloud('packet', CLOUD_PACKET) // same connection, so it arrives after the one above
        await until(() => device.outbox.length > 0, 'the packet')
        assert.equal(device.outbox.length, 1)
        assert.deepEqual(device.sent, [])
    })
})
