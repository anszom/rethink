import { Client as ThinqClient, Device as ClientDevice, Environment, signInUrl, Thinq1Device, Thinq2Device} from "./thinqApi.js"
import { AnyDevice, DeviceManager } from "../cloud/devmgr.js"
import * as OAuth2 from './oauth2.js'
import { BridgeState } from "./state.js"
import { Connection as Thinq1Connection } from "./thinq1connection.js"
import { Connection as Thinq2Connection } from "./thinq2connection.js"
import { Device as T1Downstream } from '../cloud/thinq1/device.js'
import { Device as T2Downstream } from '../cloud/thinq2/device.js'
import { TypedEmitter } from 'tiny-typed-emitter';

type StatusCallback = (string) => void

const RECONNECT_PERIOD = 5000

class BridgedDevice {
    // upstream - our connection to the ThinQ cloud
    // downstream - the physical device
    constructor(readonly upstream: ClientDevice, readonly downstream: AnyDevice) {
        if(this.upstream.platformType !== this.downstream.platform) {
            console.warn("Bridge device types don't match");
            return;
        }
        // we create the functions at runtime so that they have unique identities that can be removed with removeListener
        this.onDownstreamData = (packet: Buffer) => this.connection?.send(packet);
        this.onDownstreamClose = () => this.destroy()

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
        if(U instanceof Thinq1Device && D instanceof T1Downstream) {
            this.connection = new Thinq1Connection(U)
            // feed the initial state to the connection
            if(D.lastReport)
                this.connection.send(D.lastReport)

            this.connection.on('data', (payload) => D.send(payload))

        } else if(U instanceof Thinq2Device && D instanceof T2Downstream) {
            this.connection = new Thinq2Connection(U)
            this.connection.on('data', (payload) => D.send(payload))
        } else {
            console.warn("Can't connect bridge")
            return
        }

        this.connection.on('close', () => this.disconnect())

        this.connection.on('data', (data: Buffer | object) => {
            this.downstream.send(data as any)
        })

        this.connection.on('error', console.log)
    }

    reconnectTimeout: NodeJS.Timeout | undefined

    disconnect() {
        if(this.connection) {
            this.connection.destroy()
            this.connection = undefined
            clearTimeout(this.reconnectTimeout)
            this.reconnectTimeout = setTimeout(() => this.reconnectNow(), RECONNECT_PERIOD)
        }
    }

    destroy() {
        if(this.connection) {
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
    loggedIn: () => void;
    loggedOut: () => void;
    started: (id: string) => void;
    stopped: (id: string) => void;
}

export class Bridge extends TypedEmitter<BridgeEvents>{
    bridgedDevices = new Map<string, BridgedDevice>();

    constructor(readonly state: BridgeState, readonly manager: DeviceManager) {
        super()
        this.manager.on('newDevice', this.#start.bind(this))
        this.manager.on('dropDevice', this.#stop.bind(this))
        Object.values(this.manager.allDevices).forEach(this.#start.bind(this))
    }

    #start(dev: AnyDevice) {
        const clientDevice = this.loadSavedDevice(dev)
        if(!clientDevice) 
            return
            
        const bridged = new BridgedDevice(clientDevice, dev)
        this.bridgedDevices.set(dev.id, bridged)
        this.emit('started', dev.id)
    }

    #stop (id: string) {
        const bridged = this.bridgedDevices.get(id)
        if(bridged) {
            this.bridgedDevices.delete(id);
            this.emit('stopped', id)
            bridged.destroy()
        }
    }

    status(id: string) {
        const dev = this.manager.allDevices[id]
        if(!dev)
            return undefined

        if(this.bridgedDevices.has(id))
            return true;

        return false
    }

    async enable(id: string, devType?: string, statusCallback?: StatusCallback) {
        if(!this.isLoggedIn())
            return false;

        if(this.bridgedDevices.has(id))
            return true;

        const dev = this.manager.allDevices[id]
        if(!dev)
            return false;

        const clientDevice = await this.register(dev, devType, statusCallback)
        if(!clientDevice)
            return false;

        const bridged = new BridgedDevice(clientDevice, dev)
        this.bridgedDevices.set(dev.id, bridged)
        this.emit('started', dev.id)
        return true
    }

    disable(id: string) {
        this.state.setDeviceState(id, undefined)
        this.#stop(id)
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
        if(!code)
            return false;

        try {
            const token = await OAuth2.fromCode(base.authUrl, code)
            this.state.setCredentials({
                env, refreshToken: token.refreshToken
            })
            this.emit('loggedIn')
            return true;

        } catch(err) {
            return false;
        }
    }

    logout() {
        this.state.setCredentials(undefined)
        // FIXME? drop all devices
        this.emit('loggedOut')
    }

    async register(device: AnyDevice, deviceType?: string, statusCallback?: StatusCallback) {
        if(!statusCallback)
            statusCallback = ()=>{}

        const creds = this.state.getCredentials()
        if(!creds)
            throw new Error("Not logged in")

        if(!deviceType)
            deviceType = device.meta.deviceType

        if(!deviceType)
            throw new Error("Device type must be specified")

        const client = new ThinqClient(creds.env)
        await client.auth(creds.refreshToken)
    
        statusCallback('Removing device from home')
        await client.removeDevice(device.id)
 
        let clientDevice: Thinq1Device | Thinq2Device

        if(device.platform === 'thinq1') {
            const gateway = (await client.gateway)
            const state = {
                httpServer: gateway.thinq1Uri.replace(/\/api$/, ''),
                rtiServer: gateway.rtiUri
            }
            
            clientDevice = new Thinq1Device(device.id, device.meta, state)
            statusCallback('Adding device to home')

            await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType)

        } else if(device.platform === 'thinq2') {
            statusCallback('Fetching otp key')
            const otp = await client.prepareNewT2Device()
        
            const t2 = new Thinq2Device(device.id, device.meta)
            clientDevice = t2

            statusCallback('Registering new device')
            const ciphertext = await t2.pair(client.env, otp)
        
            statusCallback('Adding device to home')
            await client.addDevice(clientDevice, `Rethink ${device.id.substring(0, 8)}`, deviceType, ciphertext)

        } else {
            throw new Error('Unknown device platform')
            return;
        }

        statusCallback('Device registered successfully')
        
        this.state.setDeviceState(device.id, clientDevice.state)
        return clientDevice;
    }

    loadSavedDevice(device: AnyDevice) {
        const state = this.state.getDeviceState(device.id)
        if(state) {
            if('rtiServer' in state) {
                // thinq1            
                return new Thinq1Device(device.id, device.meta, state)

            } else if('mqttServer' in state){
                // thinq2
                return new Thinq2Device(device.id, device.meta, state)
            }
        }

        return undefined
    }
}