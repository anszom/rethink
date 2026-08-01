import { Router } from 'express'
import { CA, Config } from '@/util/config'
import { isPlausibleHostname, signCsr } from '@/util/pki'
import log from '@/util/logging'
import { ClipDeployMessage } from './clip'

/**
 * Which name /route tells the appliance to use from now on.
 *
 * Normally that is config.hostname: the appliance was pointed at us during setup, and it needs a
 * name it can resolve to reach us afterwards.
 *
 * That breaks down when the appliance was never set up against us and only arrives because its
 * traffic is redirected. Handing it config.hostname makes it resolvable-name-dependent again, and
 * the appliance stores what it is told - so it keeps looking for that name even after the
 * redirection is removed, and no longer finds its way back to the manufacturer. Echoing the name it
 * asked for keeps the redirection the only thing standing between the appliance and the cloud.
 *
 * Off by default: it is wrong for appliances set up through SoftAP, which have no redirection to
 * carry them here.
 */
export function advertisedHost(config: Config, requestedHost: string | undefined) {
    if (!config.advertise_requested_host) return config.hostname

    // An address would be stored by the appliance and pin it to one machine, and anything that is
    // not a hostname has no business on a command line or in a URL.
    if (!isPlausibleHostname(requestedHost)) return config.hostname

    return requestedHost
}

export function routes(config: Config, ca: CA) {
    const router = Router()
    router.get('/route', (req, res) => {
        const host = advertisedHost(config, req.hostname)
        res.json({
            resultCode: '0000',
            result: {
                apiServer: 'https://' + host + ':' + config.https_port.advertise,
                mqttServer: 'ssl://' + host + ':' + config.mqtts_port.advertise,
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
        // Whatever CSR the appliance sends is signed as it stands: the otp is not checked and the
        // subject is not tied to :deviceId. That is deliberate - this is the appliance's own local
        // cloud, and the CA it pins here is one we made for it. What is checked is that a CSR
        // arrived at all, because the alternative is answering a malformed request with a success
        // code and an empty certificate, which the appliance can only report as something else.
        const csr = req.body?.csr
        if (typeof csr !== 'string' || !csr.includes('CERTIFICATE REQUEST')) {
            log('status', `No CSR in the certificate request for ${req.params.deviceId}`)
            res.json({ resultCode: '9999' })
            return
        }

        try {
            const certificatePem = signCsr({ certFile: config.ca_cert_file, keyFile: config.ca_key_file }, csr)

            // Warning: we don't supply MQTT topics at this point. Maybe we should?
            // OTOH, the firmware seems to ignore it outright...
            res.json({ resultCode: '0000', result: { certificatePem } })
        } catch (err) {
            log('status', `Could not sign the CSR for ${req.params.deviceId}: ${err}`)
            res.json({ resultCode: '9999' })
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
