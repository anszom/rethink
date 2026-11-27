import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import * as tls from 'node:tls'
import { AddressInfo } from 'node:net'
import { CertificateIssuer, isPlausibleHostname } from '@/util/sni'
import { CA } from '@/util/ca'

const HOSTNAME = 'rethink.lan'
// Two names taken from Korean units of the same model that disagree about which one they ask for.
const MQTT_SNI = 'common.iot.kic.lgthinq.com'
const API_SNI = 'kic-mclip.lgthinq.com'

let ca: CA
let issuer: CertificateIssuer
let server: tls.Server
let port: number

before(async () => {
    ca = await CA.create()
    issuer = new CertificateIssuer(ca, HOSTNAME)

    server = tls.createServer(await issuer.listenerOptions(), (socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
})

after(async () => {
    await new Promise((resolve) => server.close(resolve))
})

/** Connect the way an appliance does: pin our CA, and check the name it asked for. */
function handshake(servername: string): Promise<X509Certificate> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect(
            { host: '127.0.0.1', port, servername, ca: [ca.cert], rejectUnauthorized: true },
            () => {
                const certificate = socket.getPeerX509Certificate()
                socket.destroy()
                certificate ? resolve(certificate) : reject(new Error('no peer certificate'))
            },
        )
        socket.on('error', reject)
    })
}

describe('isPlausibleHostname', () => {
    test('accepts the names appliances actually ask for', () => {
        assert.equal(isPlausibleHostname(MQTT_SNI), true)
        assert.equal(isPlausibleHostname(HOSTNAME), true)
        assert.equal(isPlausibleHostname('kic-common.lgthinq.com'), true)
    })

    test('rejects anything that is not a hostname', () => {
        for (const bad of ['', '/CN=evil', 'a b', 'x/../y', '.leading', 'trailing.', 'a'.repeat(254)])
            assert.equal(isPlausibleHostname(bad), false, `${JSON.stringify(bad)} must be rejected`)
    })
})

describe('CertificateIssuer', () => {
    test('signs a leaf, not the CA itself', async () => {
        const { cert } = await issuer.issue(MQTT_SNI)
        const leaf = new X509Certificate(cert)
        const caCert = ca.certificate

        assert.equal(leaf.subject, 'CN=' + MQTT_SNI)
        assert.equal(leaf.checkHost(MQTT_SNI), MQTT_SNI)
        assert.equal(leaf.ca, false)
        assert.equal(leaf.issuer, 'CN=Rethink CA')
        assert.equal(leaf.verify(caCert.publicKey), true)
        assert.equal(leaf.checkIssued(caCert), true)
    })

    test('serves the default certificate for its own hostname', () => {
        assert.equal(issuer.contextFor(HOSTNAME), undefined)
    })

    test('serves the default certificate rather than minting for a bogus name', () => {
        assert.equal(issuer.contextFor('/CN=evil'), undefined)
    })

    test('reuses the context for a repeated server name', () => {
        const first = issuer.contextFor(MQTT_SNI)
        assert.ok(first)
        assert.equal(issuer.contextFor(MQTT_SNI), first)
    })
})

describe('TLS handshake', () => {
    test('a validating client gets a certificate for the configured hostname', async () => {
        const presented = await handshake(HOSTNAME)
        assert.equal(presented.subject, 'CN=' + HOSTNAME)
        assert.equal(presented.ca, false, 'the CA must not be served as the server certificate')
    })

    test('two units asking for different names both get a matching certificate', async () => {
        assert.equal((await handshake(API_SNI)).subject, 'CN=' + API_SNI)
        assert.equal((await handshake(MQTT_SNI)).subject, 'CN=' + MQTT_SNI)
    })

    test('a name we will not sign falls back to the default certificate', async () => {
        // The client asked for something implausible, so the handshake still completes but
        // with our own certificate - and a verifying client rejects that, as it should.
        await assert.rejects(() => handshake('not a hostname'), /altnames|Hostname\/IP does not match/i)
    })
})
