import {
    Client as ThinqClient,
    Device as ClientDevice,
    Environment,
    signInUrl,
    Thinq1Device,
    Thinq2Device,
} from './thinqApi'
import { AnyDevice, DeviceManager } from '../cloud/devmgr'
import * as OAuth2 from './oauth2'
import { BridgeState } from './state'
import { Connection as Thinq1Connection } from './thinq1connection'
import { Connection as Thinq2Connection } from './thinq2connection'
import { Device as T1Downstream } from '@/cloud/thinq1/device'
import { Device as T2Downstream } from '@/cloud/thinq2/device'
import { TypedEmitter } from 'tiny-typed-emitter'
import * as HTTPS from 'node:https'

type StatusCallback = (status: string) => void

const RECONNECT_PERIOD = 5000

class BridgedDevice {
    // upstream - our connection to the ThinQ cloud
    // downstream - the physical device
    constructor(
        readonly upstream: ClientDevice,
        readonly downstream: AnyDevice,
        readonly thinq1Agent: HTTPS.Agent,
    ) {
        // we create the functions at runtime so that they have unique identities that can be removed with removeListener
        this.onDownstreamData = (packet: Buffer) => this.connection?.send(packet)
        this.onDownstreamClose = () => this.destroy()

        if (this.upstream.platformType !== this.downstream.platform) {
            console.warn("Bridge device types don't match")
            return
        }

        downstream.on('data', this.onDownstreamData)
        downstream.on('close', this.onDownstreamClose)

        this.reconnectNow()
    }

    onDownstreamData: (packet: Buffer) => void
    onDownstreamClose: () => void

    connection: Thinq1Connection | Thinq2Connection | undefined

    reconnectNow() {
        const U = this.upstream
        const D = this.downstream
        if (U instanceof Thinq1Device && D instanceof T1Downstream) {
            this.connection = new Thinq1Connection(U, { httpsAgent: this.thinq1Agent })
            // feed the initial state to the connection
            if (D.lastReport) this.connection.send(D.lastReport)

            this.connection.on('data', (payload) => D.send(payload))
        } else if (U instanceof Thinq2Device && D instanceof T2Downstream) {
            this.connection = new Thinq2Connection(U)
            this.connection.on('data', (payload) => D.send_packet(payload))
        } else {
            console.warn("Can't connect bridge")
            return
        }

        this.connection.on('close', () => this.disconnect())
        this.connection.on('error', console.log)
    }

    reconnectTimeout: NodeJS.Timeout | undefined

    disconnect() {
        if (this.connection) {
            this.connection.destroy()
            this.connection = undefined
            clearTimeout(this.reconnectTimeout)
            this.reconnectTimeout = setTimeout(() => this.reconnectNow(), RECONNECT_PERIOD)
        }
    }

    destroy() {
        if (this.connection) {
            this.connection.destroy()
            this.connection = undefined
        }
        this.downstream.removeListener('data', this.onDownstreamData)
        this.downstream.removeListener('close', this.onDownstreamClose)
        clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = undefined
    }
}

type BridgeEvents = {
    loggedIn: () => void
    loggedOut: () => void
    namesChanged: () => void
    started: (id: string) => void
    stopped: (id: string) => void
}

export class Bridge extends TypedEmitter<BridgeEvents> {
    bridgedDevices = new Map<string, BridgedDevice>()
    private readonly thinq1Agent = new HTTPS.Agent({ keepAlive: true })

    /*
     * What the owner calls each appliance, from the ThinQ account - the same names the app shows.
     *
     * rethink knows a device by its id and its model, which is enough to talk to it and useless for
     * telling four identical ceiling cassettes apart. The account already holds the answer; it was
     * only ever read while registering a device (see registrationPlan), so it never reached the panel.
     */
    deviceNames = new Map<string, string>()

    constructor(
        readonly state: BridgeState,
        readonly manager: DeviceManager,
    ) {
        super()
        this.manager.on('newDevice', this.#start.bind(this))
        this.manager.on('dropDevice', this.#stop.bind(this))
        Object.values(this.manager.allDevices).forEach(this.#start.bind(this))
    }

    name(id: string) {
        return this.deviceNames.get(id)
    }

    /*
     * Best-effort: the panel is perfectly usable without the names, so a cloud that will not answer
     * costs a log line and nothing else. Logging out takes the same path - no credentials, no names.
     *
     * An existing `client` can be reused
     */
    async refreshNames(client?: ThinqClient) {
        const creds = this.state.getCredentials()
        if (!creds) return this.clearNames()

        try {
            if (!client) {
                client = new ThinqClient(creds.env)
                await client.auth(creds.refreshToken)
            }

            const devices = await client.listDevices()

            // race against login/logout lost
            if (this.state.getCredentials()?.refreshToken !== creds.refreshToken) return

            this.deviceNames = new Map(devices.filter((dev) => dev.alias).map((dev) => [dev.deviceId, dev.alias]))
            this.emit('namesChanged')
        } catch (err) {
            console.warn('Could not read the device names from the ThinQ account:', err)
        }
    }

    clearNames() {
        if (this.deviceNames.size === 0) return

        this.deviceNames = new Map()
        this.emit('namesChanged')
    }

    #start(dev: AnyDevice) {
        const clientDevice = this.loadSavedDevice(dev)
        if (!clientDevice) return

        const bridged = new BridgedDevice(clientDevice, dev, this.thinq1Agent)
        this.bridgedDevices.set(dev.id, bridged)
        this.emit('started', dev.id)
    }

    #stop(id: string) {
        const bridged = this.bridgedDevices.get(id)
        if (bridged) {
            this.bridgedDevices.delete(id)
            this.emit('stopped', id)
            bridged.destroy()
        }
    }

    status(id: string) {
        const dev = this.manager.allDevices[id]
        if (!dev) return undefined

        if (this.bridgedDevices.has(id)) return true

        return false
    }

    async enable(id: string, devType?: string, statusCallback?: StatusCallback) {
        if (this.bridgedDevices.has(id)) return true

        const dev = this.manager.allDevices[id]
        if (!dev) return false

        const creds = this.state.getCredentials()
        if (!creds) return false
        const client = new ThinqClient(creds.env)
        await client.auth(creds.refreshToken)

        const clientDevice = await this.register(client, dev, devType, statusCallback)
        if (!clientDevice) return false

        const bridged = new BridgedDevice(clientDevice, dev, this.thinq1Agent)
        this.bridgedDevices.set(dev.id, bridged)
        this.emit('started', dev.id)
        void this.refreshNames(client) // registering may have just given this appliance its name
        return true
    }

    disable(id: string) {
        this.state.setDeviceState(id, undefined)
        this.#stop(id)
    }

    // Fetches the modelJSON of a device that is registered with the ThinQ cloud, ie. one that
    // bridge mode has been enabled for.
    async getModelJson(id: string) {
        const creds = this.state.getCredentials()
        if (!creds) throw new Error('Not logged in')

        const dev = this.manager.allDevices[id]
        if (!dev) throw new Error('Unknown device')

        if (!this.bridgedDevices.has(id)) throw new Error('Bridge mode is not enabled for this device')

        const client = new ThinqClient(creds.env)
        await client.auth(creds.refreshToken)
        return { modelName: dev.meta.modelName, modelJson: await client.getModelJson(id, dev.meta.modelName) }
    }

    isLoggedIn() {
        return !!this.state.getCredentials()
    }

    async beginLogin(env: Environment): Promise<URL> {
        const client = new ThinqClient(env)
        const base = await client.getUrls()
        return signInUrl(base.webUrl, env.countryCode)
    }

    async completeLogin(env: Environment, url: URL) {
        const client = new ThinqClient(env)
        const base = await client.getUrls()
        const code = url.searchParams.get('code')
        if (!code) return false

        try {
            const token = await OAuth2.fromCode(base.authUrl, code)
            this.state.setCredentials({
                env,
                refreshToken: token.refreshToken,
            })

            void this.refreshNames()
            this.emit('loggedIn')
            return true
        } catch (err) {
            return false
        }
    }

    logout() {
        this.state.setCredentials(undefined)
        // FIXME? drop all devices
        this.clearNames() // with the credentials gone, this clears the names
        this.emit('loggedOut')
    }

    async register(client: ThinqClient, device: AnyDevice, deviceType?: string, statusCallback?: StatusCallback) {
        if (!statusCallback) statusCallback = () => {}

        if (!deviceType) deviceType = device.meta.deviceType

        if (!deviceType) throw new Error('Device type must be specified')

        statusCallback('Removing device from home')
        await client.removeDevice(device.id)

        let clientDevice: Thinq1Device | Thinq2Device

        if (device.platform === 'thinq1') {
            const gateway = await client.gateway
            const state = {
                httpServer: gateway.thinq1Uri.replace(/\/api$/, ''),
                rtiServer: gateway.rtiUri,
            }

            clientDevice = new Thinq1Device(device.id, device.meta, state)
            statusCallback('Adding device to home')

            await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType)
        } else if (device.platform === 'thinq2') {
            statusCallback('Fetching otp key')
            const otp = await client.prepareNewT2Device()

            const t2 = new Thinq2Device(device.id, device.meta)
            clientDevice = t2

            statusCallback('Registering new device')
            let ciphertext
            try {
                ciphertext = await t2.pair(client.env, otp)
            } catch (err) {
                statusCallback('Pairing failed. Make sure that common.lgthinq.com is not redirected')
                throw err
            }

            statusCallback('Adding device to home')
            await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType, ciphertext)
        } else {
            throw new Error('Unknown device platform')
        }

        statusCallback('Device registered successfully')

        this.state.setDeviceState(device.id, clientDevice.state)
        return clientDevice
    }

    loadSavedDevice(device: AnyDevice) {
        const state = this.state.getDeviceState(device.id)
        if (state) {
            if ('rtiServer' in state) {
                // thinq1
                return new Thinq1Device(device.id, device.meta, state)
            } else if ('mqttServer' in state) {
                // thinq2
                return new Thinq2Device(device.id, device.meta, state)
            }
        }

        return undefined
    }
}
