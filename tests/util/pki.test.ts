import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate, createPublicKey } from 'node:crypto'
import {
    altNameFor,
    createCa,
    generateKeyAndCsr,
    isPlausibleHostname,
    issueServerCertificate,
    openssl,
    signCsr,
} from '@/util/pki'

const HOSTNAME = 'rethink.lan'
const LG_HOST = 'common.iot.kic.lgthinq.com'

let dir: string
let ca: { certFile: string; keyFile: string }

before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rethink-pki-test-'))
    ca = { certFile: join(dir, 'ca.cert'), keyFile: join(dir, 'ca.key') }
    createCa(HOSTNAME, ca)
})

after(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe('openssl', () => {
    // The point of the wrapper: the code this replaced resolved with whatever was on stdout no
    // matter how openssl exited, so a failure travelled on as an empty key, CSR or certificate.
    test('reports a failure rather than returning nothing', () => {
        assert.throws(
            () => openssl(['x509', '-in', join(dir, 'does-not-exist.pem')]),
            (err: Error) => /openssl x509 failed/.test(err.message),
        )
    })

    test('carries what openssl wrote to stderr', () => {
        try {
            openssl(['x509', '-in', join(dir, 'does-not-exist.pem')])
            assert.fail('should have thrown')
        } catch (err) {
            assert.ok((err as Error).message.length > 'openssl x509 failed: '.length, 'stderr must be included')
        }
    })
})

describe('isPlausibleHostname', () => {
    test('accepts the names appliances actually ask for', () => {
        assert.equal(isPlausibleHostname(LG_HOST), true)
        assert.equal(isPlausibleHostname('rethink.lan'), true)
        assert.equal(isPlausibleHostname('kic-common.lgthinq.com'), true)
    })

    test('rejects names that could reach the openssl command line', () => {
        for (const bad of ['', '/CN=evil', 'a b', '-subj', 'x/../y', '.leading', 'trailing.', 'a'.repeat(254)])
            assert.equal(isPlausibleHostname(bad), false, `${JSON.stringify(bad)} must be rejected`)
    })

    test('rejects addresses, which a DNS: altname cannot describe', () => {
        for (const address of ['192.168.1.5', '10.0.0.1', '::1', 'fe80::1'])
            assert.equal(isPlausibleHostname(address), false, `${address} must be rejected`)
    })

    test('rejects a missing name', () => {
        assert.equal(isPlausibleHostname(undefined), false)
    })
})

describe('altNameFor', () => {
    test('types the altname the way a client will check it', () => {
        assert.equal(altNameFor(LG_HOST), 'DNS:' + LG_HOST)
        assert.equal(altNameFor('192.168.1.5'), 'IP:192.168.1.5')
    })
})

describe('generateKeyAndCsr', () => {
    for (const algorithm of ['ec', 'rsa'] as const) {
        test(`${algorithm}: the public key belongs to the private key`, () => {
            const { privateKey, publicKey } = generateKeyAndCsr('/CN=' + HOSTNAME, algorithm)

            assert.equal(
                createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(),
                createPublicKey(publicKey).export({ type: 'spki', format: 'pem' }).toString(),
            )
        })

        test(`${algorithm}: the CSR is well formed and carries the requested subject`, () => {
            const subject = '/CN=*.clip.com/O=LGE/C=KR'
            const { csr } = generateKeyAndCsr(subject, algorithm)
            assert.match(csr, /BEGIN CERTIFICATE REQUEST/)

            // Signing it is the check that matters: a CSR openssl refuses would fail here, and the
            // subject that comes out is the one the LG cloud sees.
            const cert = new X509Certificate(signCsr(ca, csr))
            assert.equal(cert.subject.split('\n').sort().join(','), 'C=KR,CN=*.clip.com,O=LGE')
        })
    }
})

describe('signCsr', () => {
    test('signs with the CA and honours the requested altname', () => {
        const { csr } = generateKeyAndCsr('/CN=' + LG_HOST, 'rsa')
        const cert = new X509Certificate(signCsr(ca, csr, { subjectAltName: altNameFor(LG_HOST) }))

        assert.equal(cert.checkHost(LG_HOST), LG_HOST)
        assert.equal(cert.issuer, 'CN=' + HOSTNAME)
        assert.equal(cert.verify(new X509Certificate(readFileSync(ca.certFile, 'utf-8')).publicKey), true)
    })

    test('gives every certificate its own serial', () => {
        // The fixed serial this replaced meant every appliance held a certificate that claimed, to
        // anything identifying certificates by issuer and serial, to be the same one.
        const serials = new Set<string>()
        for (let i = 0; i < 4; i++) {
            const { csr } = generateKeyAndCsr('/CN=' + HOSTNAME, 'rsa')
            serials.add(new X509Certificate(signCsr(ca, csr)).serialNumber)
        }

        assert.equal(serials.size, 4)
    })

    test('reports a bad CSR rather than producing an empty certificate', () => {
        assert.throws(() => signCsr(ca, 'this is not a CSR'))
    })
})

describe('issueServerCertificate', () => {
    // rethink's own default certificate goes through this, so it is what a connection that sends no
    // SNI is served. The CA it replaced there carried a subject and nothing else.
    test('carries a subjectAltName, not just a subject', () => {
        const cert = new X509Certificate(issueServerCertificate(ca, HOSTNAME).cert)

        assert.equal(cert.subjectAltName, 'DNS:' + HOSTNAME)
        assert.equal(cert.checkHost(HOSTNAME), HOSTNAME)
    })

    test('the CA itself has no altname, which is why a leaf is served instead', () => {
        assert.equal(new X509Certificate(readFileSync(ca.certFile, 'utf-8')).subjectAltName, undefined)
    })
})
