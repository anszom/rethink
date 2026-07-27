import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, SecureContext } from 'node:tls'
import { CA } from './config'
import log from './logging'

// Appliances that were never set up through SoftAP reach us because their traffic is redirected,
// so they still ask for whatever LG hostname their firmware was built with - and units of the same
// model do not agree on which one. The API port does not check the certificate, but the MQTT port
// does, so a single certificate named after config.hostname only ever satisfies one of them.
//
// Minting a certificate per requested name fixes that. The appliance already pinned our CA (it
// fetched it from /route/certificate), so anything this CA signs is trusted; only the name has to
// line up.

/** Upper bound on distinct names we will mint for, so a peer cannot make us fork indefinitely. */
const MAX_CERTIFICATES = 64

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

export function isPlausibleHostname(name: string) {
    return name.length > 0 && name.length <= 253 && HOSTNAME.test(name)
}

function openssl(args: string[]) {
    const result = spawnSync('openssl', args)
    if (result.status !== 0)
        throw new Error(`openssl ${args[0]} failed: ${result.stderr?.toString('utf-8').trim() ?? result.status}`)
}

/**
 * Issues short leaf certificates signed by our CA, one per TLS server name, and hands them out as
 * SNI contexts. Names that do not look like hostnames, and anything past MAX_CERTIFICATES, fall
 * back to the default certificate.
 */
export class CertificateIssuer {
    #contexts = new Map<string, SecureContext>()
    #serial = 0x1000

    constructor(
        readonly caCertFile: string,
        readonly caKeyFile: string,
        /** Served as-is; no leaf is minted for this name. */
        readonly defaultHostname: string,
    ) {}

    issue(servername: string): CA {
        const dir = mkdtempSync(join(tmpdir(), 'rethink-sni-'))
        try {
            const key = join(dir, 'key.pem')
            const csr = join(dir, 'csr.pem')
            const cert = join(dir, 'cert.pem')
            const ext = join(dir, 'ext.cnf')

            writeFileSync(ext, `subjectAltName=DNS:${servername}\n`)

            // Two steps on purpose: `openssl req -x509` combined with -CA changes what -key means
            // between OpenSSL versions, while `x509 -req` signs the same way everywhere. It is also
            // what cloud/thinq2/provisioning.ts already does for appliance certificates.
            openssl([
                'req',
                '-new',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-keyout',
                key,
                '-out',
                csr,
                '-subj',
                '/CN=' + servername,
            ])

            openssl([
                'x509',
                '-req',
                '-in',
                csr,
                '-CA',
                this.caCertFile,
                '-CAkey',
                this.caKeyFile,
                '-set_serial',
                String(++this.#serial),
                '-days',
                '3650',
                '-extfile',
                ext,
                '-out',
                cert,
            ])

            return { key: readFileSync(key, 'utf-8'), cert: readFileSync(cert, 'utf-8') }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    contextFor(servername: string): SecureContext | undefined {
        if (servername === this.defaultHostname) return undefined
        if (!isPlausibleHostname(servername)) {
            log('status', `Refusing to issue a certificate for an implausible server name`)
            return undefined
        }

        const cached = this.#contexts.get(servername)
        if (cached) return cached

        if (this.#contexts.size >= MAX_CERTIFICATES) {
            log('status', `Certificate limit reached, serving the default certificate for ${servername}`)
            return undefined
        }

        try {
            const context = createSecureContext(this.issue(servername))
            this.#contexts.set(servername, context)
            log('status', `Issued a certificate for ${servername}`)
            return context
        } catch (err) {
            log('status', `Could not issue a certificate for ${servername}: ${err}`)
            return undefined
        }
    }

    /** Passed straight to tls/https createServer. */
    get SNICallback() {
        return (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => {
            cb(null, this.contextFor(servername))
        }
    }
}
