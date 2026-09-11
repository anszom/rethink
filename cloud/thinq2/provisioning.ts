import { Router } from 'express'
import { CA, Config } from '@/util/config'
import { ClipDeployMessage } from './clip'
import { subprocess } from '@/bridge/util'

export function routes(config: Config, ca: CA) {
    const router = Router()
    router.get('/route', (req, res) => {
        res.json({
            resultCode: '0000',
            result: {
                apiServer: 'https://' + config.hostname + ':' + config.https_port.advertise,
                mqttServer: 'ssl://' + config.hostname + ':' + config.mqtts_port.advertise,
            },
        })
    })

    router.get('/route/certificate', (req, res) => {
        if (req.query.name) {
            res.json({ resultCode: '0000', result: { certificatePem: ca.cert } })
        } else {
            res.json({ resultCode: '0000', result: ['common-server', 'aws-iot'] })
        }
    })

    router.post('/device/:deviceId/certificate', async (req, res) => {
        // subprocess() (vs a raw spawn()) gives this a timeout and bounded output - unlike a
        // direct spawn, a hung or misbehaving openssl can't tie up the request indefinitely.
        try {
            const certificatePem = (
                await subprocess(
                    'openssl',
                    [
                        'x509',
                        '-req',
                        '-in',
                        '-',
                        '-days',
                        '3650',
                        '-CA',
                        config.ca_cert_file,
                        '-CAkey',
                        config.ca_key_file,
                        '-set_serial',
                        '0100',
                        '-out',
                        '-',
                    ],
                    String(req.body?.csr ?? ''),
                )
            ).replace(/\r/g, '')
            // Warning: we don't supply MQTT topics at this point. Maybe we should?
            // OTOH, the firmware seems to ignore it outright...
            res.json({
                resultCode: '0000',
                result: { certificatePem },
            })
        } catch (err) {
            console.warn(`Certificate signing failed: ${err}`)
            res.status(500).end()
        }
    })
    return router
}

export function generateDeployResponse(payload: ClipDeployMessage) {
    return {
        did: payload.did,
        mid: Date.now(),
        cmd: 'completeProvisioning',
        type: 0,
        data: {
            result: 0,
            host: 'message',
            appInfo: {
                host: 'message',
                publication: {
                    // this path is arbitrary
                    message: 'clip/message/devices/' + payload.did,

                    // This path is not-so-arbitrary, because the device will cache it
                    // and try to reuse it on a next provisioning attempt. We pick the
                    // default path that is used by the firmware, so that we can be sure
                    // that it will keep working if you revert to the official cloud.

                    // The paths ARE sent by the API server during certificate generation
                    // but the firmware I've worked with seems to ignore them.
                    provisioning: 'clip/provisioning/devices/' + payload.did,
                },
            },
            provisioningType: payload.cmd,
            deployInterval: 600,
        },
    }
}
