import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every certificate rethink handles is made by shelling out to openssl. node:crypto can generate a
// key and parse a certificate, but it cannot build a CSR or sign one, and a crypto library is a
// heavier dependency than the openssl binary the Dockerfile already installs.
//
// This module exists because the call sites that shell out - the CA, the appliance certificates the
// provisioning route signs, the key a bridged appliance registers with, the monitor's AWS-IoT
// subscription - each grew their own way of doing it, and disagreed on the parts that matter:
// whether a failure is noticed at all, whether the serial is unique, whether a name reaches the
// command line unchecked. They now share one implementation of each.
//
// Everything openssl reads or writes here is a file in a temporary directory. Two openssl habits
// make that the only reliable option: `req` cannot take a key on stdin, and writing two outputs to
// stdout fails when stdout is a pipe - which is exactly what node hands a child process. The
// previous workaround was to wrap the call in `sh -c 'cat | openssl ... /dev/stdin'`, which also
// meant a shell had to exist in the image.

/** Runs openssl, reporting whatever it wrote to stderr rather than leaving a failure silent. */
export function openssl(args: string[]) {
    const result = spawnSync('openssl', args)
    if (result.error) throw new Error(`openssl ${args[0]} could not be run: ${result.error.message}`)
    if (result.status !== 0)
        throw new Error(
            `openssl ${args[0]} failed: ${result.stderr?.toString('utf-8').trim() || `exit ${result.status}`}`,
        )
}

function inTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'rethink-pki-'))
    try {
        return fn(dir)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

/**
 * Whether a name may be used as a certificate subject or advertised to an appliance.
 *
 * Addresses are refused along with everything else that is not a hostname. An address in a
 * certificate has to be carried as an IP: subjectAltName - a DNS: one is simply not checked against
 * it - and an address advertised to an appliance would be stored and pin it to one machine.
 */
export function isPlausibleHostname(name: string | undefined): name is string {
    if (!name || name.length > 253) return false
    if (isIP(name)) return false
    return HOSTNAME.test(name)
}

/** The CA on disk. openssl needs both as files, so they are kept as paths rather than as PEM. */
export type CaFiles = { certFile: string; keyFile: string }

/** A private key and the certificate that goes with it, shaped for tls.createServer. */
export type KeyAndCert = { key: string; cert: string }

export type KeyAndCsr = { privateKey: string; publicKey: string; csr: string }

/**
 * A fresh key and a CSR for it. `ec` is what an appliance registration uses and `rsa` what the
 * AWS-IoT subscription and our own server certificates use; both are what the LG cloud accepted
 * from the code this replaced.
 */
export function generateKeyAndCsr(subject: string, algorithm: 'ec' | 'rsa' = 'ec'): KeyAndCsr {
    return inTempDir((dir) => {
        const key = join(dir, 'key.pem')
        const pub = join(dir, 'pub.pem')
        const csr = join(dir, 'csr.pem')

        if (algorithm === 'ec') openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key])
        else openssl(['genrsa', '-out', key, '2048'])

        openssl(['req', '-new', '-key', key, '-subj', subject, '-out', csr])
        openssl(['pkey', '-in', key, '-pubout', '-out', pub])

        return {
            privateKey: readFileSync(key, 'utf-8'),
            publicKey: readFileSync(pub, 'utf-8'),
            csr: readFileSync(csr, 'utf-8'),
        }
    })
}

/**
 * A serial no other certificate of ours will carry. Certificates from one issuer are identified by
 * their serial, so the fixed one this replaced meant every appliance held a certificate claiming to
 * be the same one. The top bit is cleared to keep the value positive.
 */
function serialNumber() {
    const bytes = randomBytes(16)
    bytes[0] &= 0x7f
    return '0x' + bytes.toString('hex')
}

export type SignOptions = {
    days?: number
    /** An openssl subjectAltName value, e.g. `DNS:rethink.lan`. See altNameFor(). */
    subjectAltName?: string
}

/**
 * Signs a CSR with our CA.
 *
 * Signing is `x509 -req` rather than `req -x509 -CA` on purpose: combining -x509 with -CA changes
 * what -key means between OpenSSL versions, while `x509 -req` behaves the same everywhere.
 */
export function signCsr(ca: CaFiles, csrPem: string, options: SignOptions = {}): string {
    return inTempDir((dir) => {
        const csr = join(dir, 'csr.pem')
        const cert = join(dir, 'cert.pem')
        writeFileSync(csr, csrPem)

        const args = [
            'x509',
            '-req',
            '-in',
            csr,
            '-CA',
            ca.certFile,
            '-CAkey',
            ca.keyFile,
            '-set_serial',
            serialNumber(),
            '-days',
            String(options.days ?? 3650),
            '-out',
            cert,
        ]

        if (options.subjectAltName) {
            const ext = join(dir, 'ext.cnf')
            writeFileSync(ext, `subjectAltName=${options.subjectAltName}\n`)
            args.push('-extfile', ext)
        }

        openssl(args)
        return readFileSync(cert, 'utf-8').replace(/\r/g, '')
    })
}

/** A subjectAltName for one name, of the type a client will actually check it against. */
export function altNameFor(name: string) {
    return isIP(name) ? `IP:${name}` : `DNS:${name}`
}

/**
 * A leaf certificate for one server name, signed by our CA.
 *
 * The name goes in a subjectAltName, not only in the subject: a certificate carrying just a CN is
 * accepted today because the clients involved fall back to it, but nothing modern is obliged to.
 */
export function issueServerCertificate(ca: CaFiles, hostname: string, days = 3650): KeyAndCert {
    const { privateKey, csr } = generateKeyAndCsr('/CN=' + hostname, 'rsa')
    return { key: privateKey, cert: signCsr(ca, csr, { days, subjectAltName: altNameFor(hostname) }) }
}

/**
 * Creates the CA, which is the trust anchor an appliance pins when it fetches /route/certificate.
 *
 * Its subject is not used to match a hostname - the certificates we serve are leaves issued by
 * issueServerCertificate() - so this runs once, when there is no CA on disk yet.
 */
export function createCa(hostname: string, ca: CaFiles) {
    openssl([
        'req',
        '-x509',
        '-newkey',
        'rsa:4096',
        '-keyout',
        ca.keyFile,
        '-out',
        ca.certFile,
        '-sha256',
        '-days',
        '3650',
        '-nodes',
        '-subj',
        '/CN=' + hostname,
    ])
}
