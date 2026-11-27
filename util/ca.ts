// The certificate authority every appliance is told to trust, and everything we sign with it.
//
// It is kept as a whole - the PEMs we hand out, the parsed certificate, and the key material
// the signing calls need - so that none of that has to be re-derived from text per request.

import { createPrivateKey, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
    Certificate,
    createSelfSignedCA,
    createServerCertificate,
    Issuer,
    loadIssuer,
    signCertificateRequest,
} from './pki'
import log from './logging'

/** The file's contents, or undefined if it does not exist. Any other error is fatal. */
function readIfPresent(path: string): string | undefined {
    try {
        return readFileSync(path).toString('utf-8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
    }
}

export class CA {
    readonly certificate: X509Certificate

    /** Parsed lazily, and only once: importing the RSA key is not free. */
    #issuer?: Promise<Issuer>

    constructor(
        readonly key: string,
        readonly cert: string,
    ) {
        this.certificate = new X509Certificate(cert)

        // The key has to be the one that signed the certificate, or nothing we issue
        // verifies against the CA the devices were given.
        if (!this.certificate.checkPrivateKey(createPrivateKey(key)))
            throw new Error('the CA private key does not belong to the CA certificate')
    }

    private issuer(): Promise<Issuer> {
        return (this.#issuer ??= loadIssuer(this))
    }

    /** A TLS server certificate for `hostname`, with a fresh key of its own. */
    async issueServerCertificate(hostname: string): Promise<Certificate> {
        return createServerCertificate(hostname, await this.issuer())
    }

    /** Sign a device's certificate request, as PEM. */
    async signCertificateRequest(csrPem: string, serialNumber: string): Promise<string> {
        return signCertificateRequest(csrPem, await this.issuer(), serialNumber)
    }

    static async create(): Promise<CA> {
        const { key, cert } = await createSelfSignedCA()
        return new CA(key, cert)
    }

    /**
     * A CA that isn't there yet is the first run and gets created. Anything else -
     * unreadable files, a malformed certificate, a key that does not belong to it, half of
     * the pair gone - is a broken installation, and we throw. Silently issuing a new CA
     * there would be far worse: every appliance provisioned so far has the old one pinned
     * and would refuse to connect.
     */
    static async loadOrCreate(keyFile: string, certFile: string): Promise<CA> {
        const key = readIfPresent(keyFile)
        const cert = readIfPresent(certFile)

        if (key === undefined && cert === undefined) {
            log('status', 'Creating a new key/certificate for the CA')
            const ca = await CA.create()
            mkdirSync(dirname(keyFile), { recursive: true })
            mkdirSync(dirname(certFile), { recursive: true })
            writeFileSync(keyFile, ca.key, { mode: 0o600 })
            writeFileSync(certFile, ca.cert)
            return ca
        }

        if (key === undefined) throw new Error(`${keyFile} is missing, but ${certFile} is not`)
        if (cert === undefined) throw new Error(`${certFile} is missing, but ${keyFile} is not`)

        try {
            return new CA(key, cert)
        } catch (err) {
            throw new Error(`${certFile} and ${keyFile} are not a usable CA: ${err}`)
        }
    }
}
