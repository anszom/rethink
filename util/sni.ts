import { createSecureContext, SecureContext } from 'node:tls'
import { CaFiles, KeyAndCert, isPlausibleHostname, issueServerCertificate } from './pki'
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

/**
 * Issues leaf certificates signed by our CA, one per TLS server name, and hands them out as SNI
 * contexts. Names that do not look like hostnames, and anything past MAX_CERTIFICATES, fall back to
 * the default certificate.
 */
export class CertificateIssuer {
    #contexts = new Map<string, SecureContext>()

    constructor(
        readonly ca: CaFiles,
        /** Served by the default context, which the caller mints with issue(); no SNI leaf for it. */
        readonly defaultHostname: string,
    ) {}

    issue(servername: string): KeyAndCert {
        return issueServerCertificate(this.ca, servername)
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
