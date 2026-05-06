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

    constructor(readonly device: Thinq2Device) {
        super()
        const state = this.device.state!
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        this.mqtt = mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), {
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

        this.mqtt.on('connect', async () => {
            log('bridge', `${this.device.deviceId} connected`)
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
        })

        this.mqtt.on('close', () => this.emit('close'))
        this.mqtt.on('error', (err) => this.emit('error', err))
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
