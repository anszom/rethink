import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { request, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { advertisedHost, routes } from '@/cloud/thinq2/provisioning'
import { normalize, RawConfig, CA } from '@/util/config'
import { createCa, generateKeyAndCsr } from '@/util/pki'

const HOSTNAME = 'rethink.lan'
// The name a Korean unit asks for when it was never set up against us and only arrives redirected.
const LG_HOST = 'common.iot.kic.lgthinq.com'

const CA_STUB: CA = { key: '', cert: '' }

function makeConfig(overrides: Partial<RawConfig> = {}) {
    return normalize({
        hostname: HOSTNAME,
        homeassistant: {
            mqtt_url: 'mqtt://127.0.0.1:1883',
            discovery_prefix: 'homeassistant',
            rethink_prefix: 'rethink',
            mqtt_user: '',
            mqtt_pass: '',
        },
        ca_key_file: 'ca.key',
        ca_cert_file: 'ca.cert',
        https_port: 443,
        mqtts_port: 8883,
        mqtt_port: 1884,
        ...overrides,
    })
}

describe('advertisedHost', () => {
    test('advertises config.hostname by default', () => {
        assert.equal(advertisedHost(makeConfig(), LG_HOST), HOSTNAME)
    })

    test('echoes the requested name when the option is on', () => {
        assert.equal(advertisedHost(makeConfig({ advertise_requested_host: true }), LG_HOST), LG_HOST)
    })

    test('falls back to config.hostname when there is no Host header', () => {
        assert.equal(advertisedHost(makeConfig({ advertise_requested_host: true }), undefined), HOSTNAME)
    })

    test('refuses an address - the appliance would store it and be pinned to one machine', () => {
        const config = makeConfig({ advertise_requested_host: true })
        assert.equal(advertisedHost(config, '10.1.1.45'), HOSTNAME)
        assert.equal(advertisedHost(config, '::1'), HOSTNAME)
    })

    test('refuses anything that is not a hostname', () => {
        const config = makeConfig({ advertise_requested_host: true })
        for (const bad of ['', 'a b', 'evil.com/../x', '.leading', 'trailing.', 'a'.repeat(254)])
            assert.equal(advertisedHost(config, bad), HOSTNAME, `${JSON.stringify(bad)} must be refused`)
    })
})

describe('GET /route', () => {
    let server: Server
    let port: number
    let config = makeConfig()

    before(async () => {
        const app = express()
        // Read `config` at request time so a test can swap it.
        app.use((req, res, next) => routes(config, CA_STUB)(req, res, next))
        server = app.listen(0, '127.0.0.1')
        await new Promise((resolve) => server.once('listening', resolve))
        port = (server.address() as AddressInfo).port
    })

    after(async () => {
        await new Promise((resolve) => server.close(resolve))
    })

    // Not fetch: Host is a forbidden header there, so it would silently send 127.0.0.1 instead.
    async function route(host: string) {
        const body = await new Promise<string>((resolve, reject) => {
            const req = request({ host: '127.0.0.1', port, path: '/route', headers: { Host: host } }, (res) => {
                const chunks: Buffer[] = []
                res.on('data', (c: Buffer) => chunks.push(c))
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
            })
            req.on('error', reject)
            req.end()
        })
        return JSON.parse(body) as { result: { apiServer: string; mqttServer: string } }
    }

    test('points the appliance at config.hostname by default', async () => {
        config = makeConfig()
        const { result } = await route(LG_HOST)

        assert.equal(result.apiServer, `https://${HOSTNAME}:443`)
        assert.equal(result.mqttServer, `ssl://${HOSTNAME}:8883`)
    })

    test('leaves a redirected appliance on the name it already uses', async () => {
        config = makeConfig({ advertise_requested_host: true })
        const { result } = await route(LG_HOST)

        assert.equal(result.apiServer, `https://${LG_HOST}:443`)
        assert.equal(result.mqttServer, `ssl://${LG_HOST}:8883`)
    })

    test('keeps advertising the bind-vs-advertise port split', async () => {
        config = makeConfig({
            advertise_requested_host: true,
            https_port: { bind: 4433, advertise: 443 },
            mqtts_port: { bind: 8884, advertise: 8883 },
        })
        const { result } = await route(LG_HOST)

        assert.equal(result.apiServer, `https://${LG_HOST}:443`)
        assert.equal(result.mqttServer, `ssl://${LG_HOST}:8883`)
    })
})

describe('POST /device/:deviceId/certificate', () => {
    let server: Server
    let port: number
    let dir: string
    let caCertFile: string

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-provisioning-test-'))
        caCertFile = join(dir, 'ca.cert')
        const caKeyFile = join(dir, 'ca.key')
        createCa(HOSTNAME, { certFile: caCertFile, keyFile: caKeyFile })

        const config = makeConfig({ ca_cert_file: caCertFile, ca_key_file: caKeyFile })
        const app = express()
        app.use(express.json())
        app.use(routes(config, CA_STUB))
        server = app.listen(0, '127.0.0.1')
        await new Promise((resolve) => server.once('listening', resolve))
        port = (server.address() as AddressInfo).port
    })

    after(async () => {
        await new Promise((resolve) => server.close(resolve))
        rmSync(dir, { recursive: true, force: true })
    })

    async function sign(body: unknown) {
        const payload = JSON.stringify(body)
        const raw = await new Promise<string>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/device/aaaabbbb-cccc-dddd-eeee-ffff00001111/certificate',
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
                },
                (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (c: Buffer) => chunks.push(c))
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
                },
            )
            req.on('error', reject)
            req.end(payload)
        })
        return JSON.parse(raw) as { resultCode: string; result?: { certificatePem: string } }
    }

    test('signs an appliance CSR with the CA the appliance pinned', async () => {
        const { csr } = generateKeyAndCsr('/CN=*.clip.com/O=LGE/C=KR', 'ec')
        const response = await sign({ csr })

        assert.equal(response.resultCode, '0000')
        const cert = new X509Certificate(response.result!.certificatePem)
        assert.equal(cert.verify(new X509Certificate(readFileSync(caCertFile, 'utf-8')).publicKey), true)
    })

    // The failure this guards against: answering with resultCode 0000 and an empty certificatePem,
    // which the appliance can only report as some later, unrelated problem.
    test('refuses a request with no CSR instead of reporting success', async () => {
        const response = await sign({})

        assert.notEqual(response.resultCode, '0000')
        assert.equal(response.result?.certificatePem, undefined)
    })

    test('refuses a CSR openssl cannot read', async () => {
        const response = await sign({ csr: '-----BEGIN CERTIFICATE REQUEST-----\nnot base64\n' })

        assert.notEqual(response.resultCode, '0000')
        assert.equal(response.result?.certificatePem, undefined)
    })
})
