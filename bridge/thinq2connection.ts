import * as mqtt from 'mqtt'
import { Thinq2Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import log from '@/util/logging'

type ConnectionEvents = {
    data: (buffer: Buffer) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    mqtt: mqtt.MqttClient
    mid = 10000
    private destroyed = false
    private readonly pendingOperations = new Set<(error: Error) => void>()

    constructor(
        readonly device: Thinq2Device,
        mqttClient?: mqtt.MqttClient,
    ) {
        super()
        const state = this.device.state!
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        this.mqtt =
            mqttClient ??
            mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), {
                ca: state.caCertificate,
                key: state.privateKey,
                cert: state.certificate,
                clientId: this.device.deviceId,
                reconnectPeriod: 0, // no auto-reconnect
            })

        this.mqtt.on('message', (topic, message, packet) => {
            try {
                if (topic === this.device.state!.subTopic) {
                    const payload = JSON.parse(message.toString('utf-8'))
                    if (payload.cmd === 'completeProvisioning') {
                        //msgtopic=payload.data.appInfo.publication.message
                        this.mqtt.publish(
                            this.device.state!.pubTopic,
                            JSON.stringify({
                                mid: ++this.mid,
                                did: this.device.deviceId,
                                kind: this.device.meta.modelName,
                                cmd: 'completeProvisioning_ack',
                                rssi: -48,
                                fs: 'idle',
                                data: null,
                                type: 1,
                            }),
                        )
                    }

                    if (payload.cmd === 'packet') {
                        log('bridge', `${this.device.deviceId} <- ${payload.data}`)
                        this.emit('data', Buffer.from(payload.data, 'hex'))
                    }
                }
            } catch (err) {
                console.log(err)
            }
        })

        // mqtt.js does not await its listeners, so a rejection from an async 'connect' handler had
        // nowhere to go and surfaced as an unhandled rejection. Catch it, tear the connection down,
        // and forward it to the same 'error' event mqtt errors already use.
        this.mqtt.on('connect', () => {
            void this.handleConnect().catch((error: Error) => {
                if (this.destroyed) return
                this.destroy()
                this.emit('error', error)
            })
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => this.emit('error', err))
    }

    private async handleConnect() {
        if (this.destroyed) return
        log('bridge', `${this.device.deviceId} connected`)
        await this.subscribe(this.device.state!.subTopic)
        if (this.destroyed) return
        await this.publish(
            this.device.state!.provTopic,
            JSON.stringify({
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
                cmd: 'preDeploy',
                rssi: -48,
                fs: 'idle',
                data: {
                    appInfo: {
                        modelName: this.device.meta.modelName,
                        modelLanguage: this.device.state!.countryCode,
                        softVer: '690409',
                        ruleVer: '2.0.11',
                        countryCode: this.device.state!.countryCode,
                        subCountryCode: this.device.state!.countryCode,
                        appVersion: 'clip_hna_v1.9.183',
                        modemType: 'RTK_RTL8711am',
                        regionalCode: 'eic',
                        timezone: '+0100',
                        svcCode: 'SVC202',
                        HomeApSsid: 'whatever',
                        DeviceType: '',
                        ruleEngine: 'y',
                        protocolVer: '1',
                        oneshot: 'y',
                        size: 1572864,
                        fwUpgradeInfo: {
                            upgSched: {
                                cmd: 'none',
                                upgUtc: '0',
                            },
                        },
                    },
                    platformInfo: {
                        provisioningKey: this.device.meta.modelName,
                        version: 'clip_v2.00.15.05-RTK_RTL8711am-SDK-8-RELEASE',
                    },
                },
                type: 0,
            }),
            { qos: 1 },
        )
    }

    private subscribe(topic: string) {
        return this.mqttOperation((done) => this.mqtt.subscribe(topic, done))
    }

    private publish(topic: string, payload: string, options: mqtt.IClientPublishOptions) {
        return this.mqttOperation((done) => this.mqtt.publish(topic, payload, options, done))
    }

    // A subscribe or publish callback never fires once the client is gone, so every in-flight
    // operation registers a cancel hook that destroy() settles with an error.
    private mqttOperation(invoke: (done: (error?: Error | null) => void) => unknown) {
        return new Promise<void>((resolve, reject) => {
            let settled = false
            const cancel = (error: Error) => finish(error)
            const finish = (error?: Error | null) => {
                if (settled) return
                settled = true
                this.pendingOperations.delete(cancel)
                if (error) reject(error)
                else resolve()
            }

            this.pendingOperations.add(cancel)
            if (this.destroyed) {
                cancel(new Error('MQTT connection destroyed'))
                return
            }

            try {
                invoke(finish)
            } catch (error) {
                finish(error as Error)
            }
        })
    }

    send(data: string | Buffer) {
        if (this.destroyed) return
        if (Buffer.isBuffer(data)) data = data.toString('hex').toUpperCase()

        log('bridge', `${this.device.deviceId} -> ${data}`)
        this.mqtt.publish(
            this.device.state!.pubTopic,
            JSON.stringify({
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
                cmd: 'device_packet',
                rssi: -48,
                fs: 'idle',
                data,
                type: 1,
            }),
        )
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        const error = new Error('MQTT connection destroyed')
        for (const cancel of [...this.pendingOperations]) cancel(error)
        this.mqtt.end(true)
    }
}
