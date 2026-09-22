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
const BOOT_TIMEOUT_MS = 5_000

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
            const timer = setTimeout(
                () => reject(new Error(`rethink did not start in ${BOOT_TIMEOUT_MS}ms:\n${output.join('')}`)),
                BOOT_TIMEOUT_MS,
            )
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

    /** An instance that has run once, so its directory holds a config and a real CA. */
    async function provisioned() {
        const directory = mkdtempSync(join(tmpdir(), 'rethink-ca-'))
        directories.push(directory)

        const instance = new Instance(directory)
        instance.writeConfig(await reservePorts())
        await instance.start()
        await instance.stop()

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
        const [mine, other] = await Promise.all([provisioned(), provisioned()])
        writeFileSync(mine.key, readFileSync(other.key))

        await refusesToStart(mine, /are not a usable CA/)
    })

    test('an unparseable certificate is refused', async () => {
        const files = await provisioned()
        writeFileSync(files.cert, 'this is not a certificate\n')

        await refusesToStart(files)
    })

    test('half a pair is refused', async () => {
        const files = await provisioned()
        unlinkSync(files.key)

        await refusesToStart(files, /ca\.key is missing/)
    })
})
