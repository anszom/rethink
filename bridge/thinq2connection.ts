import * as mqtt from 'mqtt'
import type { ConnectionOptions } from 'node:tls'
import { Thinq2Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import type { DeployAppInfo, DeployPayload, DeployPlatformInfo } from '@/cloud/thinq2/clip'
import log from '@/util/logging'
import { lookup } from './resolver'

type ConnectionEvents = {
    ready: () => void
    data: (buffer: Buffer) => void
    close: () => void
    error: (error: Error) => void
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    mqtt: mqtt.MqttClient
    mid = 10000

    constructor(
        readonly device: Thinq2Device,
        // The appliance's deploy message is forwarded mostly verbatim, so the cloud sees its true
        // protocolVer - which decides how it frames its reservation polls.
        readonly deployAppInfo: DeployAppInfo,
        readonly deployPlatformInfo: DeployPlatformInfo,
    ) {
        super()
        const state = this.device.state!
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        // mqtt.js passes the options on to tls.connect, but its typings don't list `lookup`
        const options: mqtt.IClientOptions & Pick<ConnectionOptions, 'lookup'> = {
            ca: state.caCertificate,
            key: state.privateKey,
            cert: state.certificate,
            clientId: this.device.deviceId,
            reconnectPeriod: 0, // no auto-reconnect
            lookup,
        }
        this.mqtt = mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), options)

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

        this.mqtt.on('connect', async () => {
            log('bridge', `${this.device.deviceId} connected`)
            this.emit('ready')
            await this.mqtt.subscribe(this.device.state!.subTopic)
            await this.mqtt.publish(
                this.device.state!.provTopic,
                JSON.stringify({
                    mid: ++this.mid,
                    did: this.device.deviceId,
                    kind: this.device.meta.modelName,
                    cmd: 'preDeploy',
                    rssi: -48,
                    fs: 'idle',
                    data: {
                        appInfo: this.deployAppInfo,
                        platformInfo: this.deployPlatformInfo,
                    } satisfies DeployPayload,
                    type: 0,
                }),
                { qos: 1 },
            )
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => {
            log('bridge', `Error communicating with ${state.mqttServer}: ${err}`)
            this.emit('error', err)
        })
    }

    send(data: string | Buffer) {
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
        this.mqtt.end()
    }
}
