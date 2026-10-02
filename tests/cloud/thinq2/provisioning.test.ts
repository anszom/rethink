// End-to-end PKI behaviour of a running rethink instance.
//
// This boots the real entry point against a scratch config and talks to it the way an
// appliance does: pull the CA from /route/certificate, check that the hosts /route
// advertises actually present a chain back to it, then have a CSR signed and inspect the
// certificate that comes back. Everything here is black-box, so it holds regardless of
// how the certificates are produced.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { X509Certificate, webcrypto } from 'node:crypto'
import { Pkcs10CertificateRequestGenerator, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

// The appliances resolve a name, and the advertised URLs are derived from it; 'localhost'
// is the one name that is guaranteed to point back at us.
const HOSTNAME = 'localhost'
const DEVICE_SUBJECT = 'CN=*.clip.com, O=LGE, C=KR'
// A name no appliance was told about here, but that redirected units ask for anyway.
const REDIRECTED_SNI = 'common.iot.kic.lgthinq.com'
// Only a ceiling for a boot that hangs: a first boot generates an RSA-4096 CA, which can take several
// seconds on a busy CI runner.
const BOOT_TIMEOUT_MS = 20_000

type Ports = { https: number; mqtts: number; thinq1Https: number; thinq1: number; management: number }

/** Bind ephemeral ports, note which ones we got, and hand them over. */
async function reservePorts(): Promise<Ports> {
    const servers = await Promise.all(
        Array.from({ length: 5 }, () => {
            return new Promise<net.Server>((resolve, reject) => {
                const server = net.createServer()
                server.on('error', reject)
                server.listen(0, '127.0.0.1', () => resolve(server))
            })
        }),
    )
    const [https, mqtts, thinq1Https, thinq1, management] = servers.map(
        (server) => (server.address() as net.AddressInfo).port,
    )
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
    return { https, mqtts, thinq1Https, thinq1, management }
}

function request(
    url: string,
    options: https.RequestOptions & { body?: string } = {},
): Promise<{ status: number; body: string; peerCertificate?: X509Certificate }> {
    return new Promise((resolve, reject) => {
        const { body, ...requestOptions } = options
        // node's global agent pools keep-alive sockets, which would hold the test runner's
        // event loop open long after the assertions are done
        const req = https.request(url, { agent: false, ...requestOptions }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () =>
                resolve({
                    status: res.statusCode ?? 0,
                    body: Buffer.concat(chunks).toString('utf-8'),
                    peerCertificate: (res.socket as tls.TLSSocket).getPeerX509Certificate(),
                }),
            )
        })
        req.on('error', reject)
        req.end(body)
    })
}

async function getResult<T>(url: string, options: https.RequestOptions & { body?: string } = {}): Promise<T> {
    const response = await request(url, options)
    assert.equal(response.status, 200, `GET ${url} returned ${response.status}`)
    const parsed = JSON.parse(response.body) as { resultCode: string; result: T }
    assert.equal(parsed.resultCode, '0000', `GET ${url} returned resultCode ${parsed.resultCode}`)
    return parsed.result
}

/** Open a TLS connection the way a device would and report what the server presented. */
function peerCertificateOf(host: string, port: number, options: tls.ConnectionOptions = {}) {
    return new Promise<X509Certificate>((resolve, reject) => {
        const socket = tls.connect({ host, port, servername: host, ...options }, () => {
            const certificate = socket.getPeerX509Certificate()
            socket.destroy()
            certificate ? resolve(certificate) : reject(new Error('no peer certificate'))
        })
        socket.on('error', reject)
    })
}

/** A device-side key pair and certificate request, built independently of util/pki. */
async function createCsr(): Promise<{ csr: string; publicKey: Buffer }> {
    cryptoProvider.set(webcrypto as never)
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
    const keys = (await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
    const request = await Pkcs10CertificateRequestGenerator.create({
        name: DEVICE_SUBJECT,
        keys,
        signingAlgorithm: algorithm,
    })
    return {
        csr: request.toString('pem'),
        publicKey: Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)),
    }
}

/** A root certificate from somewhere else entirely - a reverse proxy's, as far as we care. */
async function createForeignRoot(): Promise<string> {
    cryptoProvider.set(webcrypto as never)
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }
    const keys = (await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair
    const certificate = await X509CertificateGenerator.createSelfSigned({
        serialNumber: '01',
        name: 'CN=Some Proxy Root',
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: algorithm,
        keys,
    })
    return certificate.toString('pem') + '\n'
}

/** Poll until the port is accepting connections, or stops accepting them. */
async function waitForPort(port: number, accepting: boolean) {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
        const connected = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port }, () => {
                socket.destroy()
                resolve(true)
            })
            socket.on('error', () => resolve(false))
        })
        if (connected === accepting) return
        await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error(`port ${port} is still ${accepting ? 'refusing' : 'accepting'} connections`)
}

class Instance {
    private child?: ChildProcess
    private ports?: Ports

    constructor(readonly directory: string) {}

    get configFile() {
        return join(this.directory, 'config.json')
    }

    writeConfig(ports: Ports, extra: Record<string, unknown> = {}) {
        this.ports = ports
        writeFileSync(
            this.configFile,
            JSON.stringify({
                ...extra,
                hostname: HOSTNAME,
                homeassistant: {
                    // deliberately dead: the HA connection must not be a precondition for
                    // handing out certificates
                    mqtt_url: 'mqtt://127.0.0.1:1',
                    discovery_prefix: 'homeassistant',
                    rethink_prefix: 'rethink',
                    mqtt_user: '',
                    mqtt_pass: '',
                },
                ca_key_file: 'ca.key',
                ca_cert_file: 'ca.cert',
                https_port: { bind: ports.https, address: '127.0.0.1' },
                mqtts_port: { bind: ports.mqtts, address: '127.0.0.1' },
                thinq1_https_port: { bind: ports.thinq1Https, address: '127.0.0.1' },
                thinq1_port: { bind: ports.thinq1, address: '127.0.0.1' },
                management_port: { bind: ports.management, address: '127.0.0.1' },
                log: ['status'],
            }),
        )
    }

    async start() {
        const child = spawn(process.execPath, ['--import', 'tsx', 'rethink-cloud.ts', this.configFile], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        this.child = child

        const output: string[] = []
        child.stdout.setEncoding('utf-8')
        child.stderr.setEncoding('utf-8')
        child.stdout.on('data', (chunk: string) => output.push(chunk))
        child.stderr.on('data', (chunk: string) => output.push(chunk))

        await new Promise<void>((resolve, reject) => {
            // Left running, the child's pipes would keep the test runner alive indefinitely.
            const timer = setTimeout(() => {
                child.kill('SIGKILL')
                reject(new Error(`rethink did not start in ${BOOT_TIMEOUT_MS}ms:\n${output.join('')}`))
            }, BOOT_TIMEOUT_MS)
            const check = () => {
                if (!output.join('').includes('Rethink cloud')) return
                clearTimeout(timer)
                resolve()
            }
            child.stdout.on('data', check)
            child.on('exit', (code) => {
                clearTimeout(timer)
                reject(new Error(`rethink exited with code ${code}:\n${output.join('')}`))
            })
        })

        // The ready line is printed before listen() can report a failure, so don't call it
        // started until the socket answers.
        await waitForPort(this.ports!.https, true)
    }

    async stop() {
        const child = this.child
        if (!child || child.exitCode !== null) return
        this.child = undefined
        await new Promise<void>((resolve) => {
            child.on('exit', () => resolve())
            child.kill('SIGKILL')
        })
        // the listening sockets outlive the exit briefly; a restart would hit EADDRINUSE
        if (this.ports) await waitForPort(this.ports.https, false)
    }
}

describe('thinq2 provisioning PKI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rethink-provisioning-'))
    const instance = new Instance(directory)

    let ports: Ports
    let insecure: https.RequestOptions
    let caPem: string
    let ca: X509Certificate
    let advertised: { apiServer: string; mqttServer: string }

    /** Submit a CSR to the provisioning endpoint over a verified connection. */
    async function issueCertificate(csr: string): Promise<string> {
        const result = await getResult<{ certificatePem: string }>(
            `${advertised.apiServer}/device/0123456789ab/certificate`,
            {
                ca: [caPem],
                rejectUnauthorized: true,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ csr }),
            },
        )
        return result.certificatePem
    }

    before(async () => {
        ports = await reservePorts()
        instance.writeConfig(ports)
        await instance.start()

        // A device arrives with no trust anchor at all; this bootstrap fetch is the only
        // place the test is allowed to skip verification.
        insecure = { rejectUnauthorized: false }
        advertised = await getResult(`https://${HOSTNAME}:${ports.https}/route`, insecure)
        const route = await getResult<{ certificatePem: string }>(
            `https://${HOSTNAME}:${ports.https}/route/certificate?name=aws-iot`,
            insecure,
        )
        caPem = route.certificatePem
        ca = new X509Certificate(caPem)
    })

    after(async () => {
        await instance.stop()
        rmSync(directory, { recursive: true, force: true })
    })

    test('/route/certificate hands out a CA certificate', () => {
        assert.equal(ca.ca, true)
        assert.equal(ca.subject, 'CN=Rethink CA')
        assert.equal(ca.issuer, ca.subject)
        assert.equal(ca.checkHost(HOSTNAME), undefined)
        assert.equal(ca.verify(ca.publicKey), true, 'the CA must be self-signed')

        const lifetimeDays = (Date.parse(ca.validTo) - Date.parse(ca.validFrom)) / 86_400_000
        assert.ok(lifetimeDays > 3000, `the CA should be long-lived, got ${lifetimeDays} days`)
    })

    test('/route advertises the hosts that were actually bound', () => {
        assert.equal(advertised.apiServer, `https://${HOSTNAME}:${ports.https}`)
        assert.equal(advertised.mqttServer, `ssl://${HOSTNAME}:${ports.mqtts}`)
    })

    // The point of the whole exercise: what a device is told to connect to has to be
    // verifiable with what it was just given.
    for (const server of ['apiServer', 'mqttServer'] as const) {
        test(`the advertised ${server} chains to the certificate from /route/certificate`, async () => {
            const url = new URL(advertised[server])
            const presented = await peerCertificateOf(url.hostname, Number(url.port), {
                ca: [caPem],
                rejectUnauthorized: true,
            })

            assert.equal(presented.checkHost(HOSTNAME), HOSTNAME)
            assert.equal(presented.verify(ca.publicKey), true, 'presented certificate is not signed by the CA')
            assert.equal(presented.checkIssued(ca), true)
            // A leaf, not the CA itself: some appliances reject a certificate that is also
            // the trust anchor they were given.
            assert.equal(presented.ca, false)
            assert.notEqual(presented.fingerprint256, ca.fingerprint256)
        })

        test(`the advertised ${server} answers for a server name it was never configured with`, async () => {
            // An appliance that arrives by redirection asks for the LG hostname its firmware
            // carries, not for ours, and verifies it on the MQTT port.
            const url = new URL(advertised[server])
            const presented = await peerCertificateOf(REDIRECTED_SNI, Number(url.port), {
                host: url.hostname,
                ca: [caPem],
                rejectUnauthorized: true,
            })

            assert.equal(presented.checkHost(REDIRECTED_SNI), REDIRECTED_SNI)
            assert.equal(presented.subject, `CN=${REDIRECTED_SNI}`)
            assert.equal(presented.verify(ca.publicKey), true, 'presented certificate is not signed by the CA')
        })
    }

    test('a strict client can re-fetch the CA over a verified connection', async () => {
        const result = await getResult<{ certificatePem: string }>(
            `${advertised.apiServer}/route/certificate?name=aws-iot`,
            { ca: [caPem], rejectUnauthorized: true },
        )
        assert.equal(result.certificatePem, caPem)
    })

    test('the csr endpoint issues a certificate for the submitted request', async () => {
        const { csr, publicKey } = await createCsr()
        const issued = new X509Certificate(await issueCertificate(csr))
        assert.equal(issued.subject.split('\n').join(', '), DEVICE_SUBJECT)
        assert.equal(issued.issuer, ca.subject)
        assert.equal(issued.ca, false)
        assert.equal(issued.verify(ca.publicKey), true, 'the issued certificate is not signed by the CA')
        assert.equal(issued.checkIssued(ca), true)
        assert.deepEqual(
            issued.publicKey.export({ type: 'spki', format: 'der' }),
            publicKey,
            'the issued certificate must carry the key from the request',
        )

        const lifetimeDays = (Date.parse(issued.validTo) - Date.parse(issued.validFrom)) / 86_400_000
        assert.ok(lifetimeDays > 30, `the device certificate should be long-lived, got ${lifetimeDays} days`)
    })

    test('each request gets a certificate for its own key', async () => {
        const [first, second] = await Promise.all([createCsr(), createCsr()])
        const issued = await Promise.all(
            [first, second].map(async ({ csr, publicKey }) => {
                const cert = new X509Certificate(await issueCertificate(csr))
                assert.deepEqual(cert.publicKey.export({ type: 'spki', format: 'der' }), publicKey)
                assert.equal(cert.verify(ca.publicKey), true)
                return cert
            }),
        )
        assert.notEqual(issued[0].fingerprint256, issued[1].fingerprint256)
    })

    test('restarting reuses the CA that was already handed out', async () => {
        await instance.stop()
        await instance.start()

        const result = await getResult<{ certificatePem: string }>(
            `${advertised.apiServer}/route/certificate?name=aws-iot`,
            { ca: [caPem], rejectUnauthorized: true },
        )
        assert.equal(
            new X509Certificate(result.certificatePem).fingerprint256,
            ca.fingerprint256,
            'the CA must survive a restart, or every provisioned device is orphaned',
        )
    })
})

// Only a CA that isn't there yet may be created. Anything else is a broken installation,
// and starting over would orphan every device that pinned what used to be here.
describe('a damaged CA on disk', () => {
    const directories: string[] = []

    after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
    /** A fresh instance without CA keys */
    async function empty() {
        const directory = mkdtempSync(join(tmpdir(), 'rethink-ca-'))
        directories.push(directory)

        const instance = new Instance(directory)
        instance.writeConfig(await reservePorts())
        return {
            instance,
            key: join(directory, 'ca.key'),
            cert: join(directory, 'ca.cert'),
        }
    }

    function contentsOf(paths: string[]) {
        return paths.map((path) => {
            try {
                return readFileSync(path, 'utf-8')
            } catch {
                return undefined
            }
        })
    }

    /**
     * Start, expecting the process to die, and confirm it left the files alone. `message`
     * is only ever matched against text this repo produces - what node says about a
     * malformed PEM is its own business and may well be reworded.
     */
    async function refusesToStart(files: { instance: Instance; key: string; cert: string }, message?: RegExp) {
        const before = contentsOf([files.key, files.cert])

        await assert.rejects(
            () => files.instance.start(),
            (err: Error) => {
                // Instance.start() says this when the child exits instead of coming up.
                assert.match(err.message, /exited with code/)
                if (message) assert.match(err.message, message)
                return true
            },
        )

        assert.deepEqual(contentsOf([files.key, files.cert]), before, 'a failed start must not rewrite the CA')
    }

    test('a key belonging to another CA is refused', async () => {
        // Any key that doesn't match the certificate; a second instance would mean a second RSA-4096 CA.
        const files = await empty()
        writeFileSync(files.cert, FIXED_CERT)
        writeFileSync(files.key, MISMATCHED_KEY)

        await refusesToStart(files, /are not a usable CA/)
    })

    test('an unparseable certificate is refused', async () => {
        const files = await empty()
        writeFileSync(files.cert, 'this is not a certificate')
        writeFileSync(files.key, FIXED_KEY)

        await refusesToStart(files)
    })

    test('half a pair is refused', async () => {
        const files = await empty()
        writeFileSync(files.cert, FIXED_CERT)

        await refusesToStart(files, /ca\.key is missing/)
    })
})

// Long constants intentionally placed at the bottom.

const FIXED_CERT = `-----BEGIN CERTIFICATE-----
MIIFDTCCAvWgAwIBAgIUNhNEHboD/cCRSQ4CTS8wSXTORrwwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLcmV0aGluay5sYW4wHhcNMjMxMTE4MjI0ODM4WhcNMzMx
MTE1MjI0ODM4WjAWMRQwEgYDVQQDDAtyZXRoaW5rLmxhbjCCAiIwDQYJKoZIhvcN
AQEBBQADggIPADCCAgoCggIBAJ3C/pLRaU06DMHp9DDocmTsPDZvmoNK2DaZrty1
g/k2N6/8yTfzndJSnkUhjw0/Z7b4s5ylDxTJd75wkpOPrC/qQovxSTI3sbwFNa7O
wZOFOe0wnR7xBIc9dPm71aOXR0gpbKEqT2QC4EpybzRZqmwqYPqJvXCneuArGaHF
3AwDT44uJqUr6Mr/Hc44AhHPbjnS39KhLZGufRGR3EhVtwpz9Q1jypfqfF5137hX
jjMoITr0cyGXJwoBbvtgBVSExB/G0AoYWhg4GAZ/ZI14IPZpZ/bDrg614fuiiD8o
zA4EUtV3u6IEt9SYhRYCO9V6GRRheCxue61laLdLlJPvNsgIu1kOPYqVlBqwtY0u
6AtJiJr8oznDDHe/USOWjTu85Gg1qm4r2jAQqphMAnPFNI1iwCQnRO5tFzIfYrrb
WH68qwxbmqlR1mwOP8YANll8U4VIdcsv7ZOYYAXcpTynxTAUdYurE0TClsvpCA2X
mjegzWhbQBucjqz56TfUAAQ4EIy0uWlrE/EsOKiggGSBvGi7rW6deryW2z4r3RpI
AQLVRjDGEWtp/tPA6MF+KORX1G93fOUnhz4myuDUcLrYXHx2oy0CmZqz3Jd0owEu
mNWT5vIbKoKrHQn4z4+0V1nhUJPqKpqEWbk7s3GaNSoIPYqAAFZbrK8gEXgb6gO5
eu2xAgMBAAGjUzBRMB0GA1UdDgQWBBQ0DTWQJMzMdOR1gJxSDJEc0KLHlzAfBgNV
HSMEGDAWgBQ0DTWQJMzMdOR1gJxSDJEc0KLHlzAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4ICAQBXBB6ar8M+VS7yXd0fodooGpscJCzCgOraV2k99uBZ
enJe2k+nOO2cQff/kK+K02yRdCmxTxoMkB1aypriGVZHjHLdi9V007eRkWVQO+TO
ap7+jnXts2USh21Acwrn605jkArpalIdLZTle/4EAtfro/gp7HmMf1xS+Y/P7Upr
Md/tvZydNOBvXRNs/pzNcLbKs/VNw0vXH8WpAIzrLebKXUNr1dhJr7Fgcmkf3iZA
cWOugWyxhlWvWguFmpsLOm3jWR5xBBh/kT/noMuUH8Tk0MPN1bgTuahmnJj2T/1F
6GHs5T+WlXFWljn288Z3fQttz4m2mekCmEe3Gd6+cxoDaaKdyOvoBUFXwTqL5v1i
wRNLE0wKRJu2ukw2uS6QttkxoT2W+hAezclJyT2xxByIkR7iB4F1xbNc4IKCl3Xe
jkwjKDzLradi9atm3eA3G28ZJQVHcK5mwK8t7ji54k23zc6lBe9IDHvEaBgGx4jH
KAyAuxTG0233LAYJY6F6Nd4Ywd0OWH5EEraGc5Okygd9IDsTXwaUJWUVrGxu8Z+Q
MOPFBf4O3xe1XiAk88OOZXW+nRJmiD/uOStrrKEwhWgClxqqaff7wJPgWXWQG8IP
+oOxmM8ISvAzz8prV0RyJWDeU4sTJBNdIfsxKgplZK5aFXIzPjCH8ogocugGO2PW
ig==
-----END CERTIFICATE-----
`

const FIXED_KEY = `-----BEGIN PRIVATE KEY-----
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
CKlpvfXchVdB216OpyKGzPS5XHTcC8k=
-----END PRIVATE KEY-----
`

const MISMATCHED_KEY = `-----BEGIN PRIVATE KEY-----
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
4+URzoXudoBBkpGmlVPHM5K1GdbGik4=
-----END PRIVATE KEY-----
`
