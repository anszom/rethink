// A certificate per TLS server name, minted on demand and signed by our CA.
//
// Two things want this. First, the CA used to be served as the server certificate as well,
// and some appliances refuse a certificate that is its own trust anchor. Second, some
// configurations may require us to accept connections directed to a range of LG domains.
//
// The appliance already pinned our CA - it fetched it from /route/certificate - so a name
// it asked for is all that is missing.

import { createSecureContext, SecureContext, SecureContextOptions } from 'node:tls'
import { CA } from './ca'
import { Certificate } from './pki'
import log from './logging'

/** Upper bound on distinct names we mint for, so a peer cannot make us sign indefinitely. */
const MAX_CERTIFICATES = 64

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

export function isPlausibleHostname(name: string) {
    return name.length > 0 && name.length <= 253 && HOSTNAME.test(name)
}

/**
 * Issues leaf certificates signed by our CA, one per TLS server name, and hands them out as
 * SNI contexts. Names that do not look like hostnames, and anything past MAX_CERTIFICATES,
 * fall back to the certificate for `defaultHostname`.
 */
export class CertificateIssuer {
    // Promises, not contexts: several handshakes for the same new name can arrive before
    // the first signature is done, and they should all wait for that one certificate.
    #contexts = new Map<string, Promise<SecureContext>>()

    constructor(
        readonly ca: CA,
        /** Served to connections that ask for nothing, or for something we will not sign. */
        readonly defaultHostname: string,
    ) {}

    issue(servername: string): Promise<Certificate> {
        return this.ca.issueServerCertificate(servername)
    }

    contextFor(servername: string): Promise<SecureContext> | undefined {
        // The default certificate is already the one for this name.
        if (servername === this.defaultHostname) return undefined

        const cached = this.#contexts.get(servername)
        if (cached) return cached

        if (!isPlausibleHostname(servername)) {
            log('status', 'Refusing to issue a certificate for an implausible server name')
            return undefined
        }

        if (this.#contexts.size >= MAX_CERTIFICATES) {
            log('status', `Certificate limit reached, serving the default certificate for ${servername}`)
            return undefined
        }

        const context = this.issue(servername).then((cert) => {
            log('status', `Issued a certificate for ${servername}`)
            return createSecureContext(cert)
        })
        context.catch((err) => {
            // Drop it, so the next handshake for this name gets another try.
            this.#contexts.delete(servername)
            log('status', `Could not issue a certificate for ${servername}: ${err}`)
        })
        this.#contexts.set(servername, context)
        return context
    }

    /** Passed straight to tls/https createServer, together with the default certificate. */
    get SNICallback() {
        return (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => {
            const context = this.contextFor(servername)
            // Undefined means "no context", which makes node fall back to the default one.
            if (!context) return cb(null, undefined)
            context.then(
                (ctx) => cb(null, ctx),
                () => cb(null, undefined),
            )
        }
    }

    /** Options for every TLS listener: the default certificate plus per-name issuance. */
    async listenerOptions(): Promise<SecureContextOptions & { SNICallback: CertificateIssuer['SNICallback'] }> {
        return { ...(await this.issue(this.defaultHostname)), SNICallback: this.SNICallback }
    }
}
