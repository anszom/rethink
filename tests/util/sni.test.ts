import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import * as tls from 'node:tls'
import { AddressInfo } from 'node:net'
import { createCa } from '@/util/pki'
import { CertificateIssuer } from '@/util/sni'

const HOSTNAME = 'rethink.lan'
// Two names taken from Korean units of the same model that disagree about which one they ask for.
const MQTT_SNI = 'common.iot.kic.lgthinq.com'
const API_SNI = 'kic-mclip.lgthinq.com'

let dir: string
let caCertFile: string
let caKeyFile: string
let issuer: CertificateIssuer

before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rethink-sni-test-'))
    caCertFile = join(dir, 'ca.cert')
    caKeyFile = join(dir, 'ca.key')

    // The same CA that rethink-cloud.ts creates on first start.
    createCa(HOSTNAME, { certFile: caCertFile, keyFile: caKeyFile })

    issuer = new CertificateIssuer({ certFile: caCertFile, keyFile: caKeyFile }, HOSTNAME)
})

after(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe('CertificateIssuer', () => {
    test('names the certificate after the requested server name', () => {
        const { cert } = issuer.issue(MQTT_SNI)
        const x509 = new X509Certificate(cert)

        assert.equal(x509.checkHost(MQTT_SNI), MQTT_SNI)
        assert.equal(x509.subject, 'CN=' + MQTT_SNI)
    })

    test('signs with the CA the appliance already pinned', () => {
        const { cert } = issuer.issue(API_SNI)
        const caCert = new X509Certificate(readFileSync(caCertFile, 'utf-8'))

        assert.equal(new X509Certificate(cert).verify(caCert.publicKey), true)
        assert.equal(new X509Certificate(cert).issuer, 'CN=' + HOSTNAME)
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
    // The point of the whole change: a client that pins our CA and validates the hostname - which
    // is what appliances do on the MQTT port - must complete a handshake against a name that is
    // not config.hostname.
    async function handshake(servername: string) {
        const ca = readFileSync(caCertFile, 'utf-8')
        const server = tls.createServer(
            { ...issuer.issue(HOSTNAME === servername ? servername : HOSTNAME), SNICallback: issuer.SNICallback },
            (socket) => socket.end(),
        )

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo

        try {
            return await new Promise<string>((resolve, reject) => {
                const socket = tls.connect(
                    { host: '127.0.0.1', port, servername, ca: [ca], rejectUnauthorized: true },
                    () => {
                        const subject = socket.getPeerCertificate().subject.CN
                        socket.end()
                        resolve(subject)
                    },
                )
                socket.on('error', reject)
            })
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    }

    test('a validating client accepts an LG server name', async () => {
        assert.equal(await handshake(MQTT_SNI), MQTT_SNI)
    })

    test('the same client is rejected when only config.hostname is served', async () => {
        // Control: this is the failure the SNI callback exists to prevent. Without it an appliance
        // asking for an LG name gets a certificate for rethink.lan and drops the connection.
        const ca = readFileSync(caCertFile, 'utf-8')
        const server = tls.createServer(issuer.issue(HOSTNAME), (socket) => socket.end())
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo

        try {
            await assert.rejects(
                () =>
                    new Promise<void>((resolve, reject) => {
                        const socket = tls.connect(
                            { host: '127.0.0.1', port, servername: MQTT_SNI, ca: [ca], rejectUnauthorized: true },
                            () => {
                                socket.end()
                                resolve()
                            },
                        )
                        socket.on('error', reject)
                    }),
                /altnames|Hostname\/IP does not match/i,
            )
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    })

    test('two units asking for different names both get a matching certificate', async () => {
        assert.equal(await handshake(API_SNI), API_SNI)
        assert.equal(await handshake(MQTT_SNI), MQTT_SNI)
    })
})
