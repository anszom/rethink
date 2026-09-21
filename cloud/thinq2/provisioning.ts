import { Router } from 'express'
import { CA, Config } from '@/util/config'
import { signCertificateRequest } from '@/util/pki'
import log from '@/util/logging'
import { ClipDeployMessage } from './clip'

export function routes(config: Config, ca: CA) {
    const router = Router()
    router.get('/route', (req, res) => {
        res.json({
            resultCode: '0000',
            result: {
                apiServer: config.https_port.advertise_url,
                mqttServer: config.mqtts_port.advertise_url,
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

    router.post('/device/:deviceId/certificate', (req, res) => {
        // 0x64 is what openssl made of the `-set_serial 0100` we used to pass (it reads
        // unprefixed values as decimal). Every device gets the same serial, as before.
        signCertificateRequest(String(req.body.csr), ca, '64').then(
            (certificatePem) => {
                // Warning: we don't supply MQTT topics at this point. Maybe we should?
                // OTOH, the firmware seems to ignore it outright...
                res.json({ resultCode: '0000', result: { certificatePem } })
            },
            (err) => {
                log('status', `Failed to sign a certificate for ${req.params.deviceId}: ${err}`)
                res.status(500).json({ resultCode: '9999', result: {} })
            },
        )
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
