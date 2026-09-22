// Certificate/key generation, done in-process instead of by spawning `openssl`.
//
// Everything here goes through @peculiar/x509, which builds the ASN.1 structures and
// delegates the actual signing to node's WebCrypto. Node has no CSR or certificate
// *issuance* API of its own (`crypto.X509Certificate` only parses), hence the library.
//
// On node 16/17 there is no global `crypto`, so the provider has to be set explicitly;
// without this every call below throws.

import * as x509 from '@peculiar/x509'
import { createPrivateKey, webcrypto } from 'node:crypto'

x509.cryptoProvider.set(webcrypto)

const DAY_MS = 24 * 60 * 60 * 1000

const RSA_SHA256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const
const EC_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const

export type KeyAlgorithm = 'rsa-2048' | 'rsa-4096' | 'ec-p256'

export type KeyPair = { privateKey: string; publicKey: string }
export type CertificateRequest = KeyPair & { csr: string }

/** A private key and the certificate for it, both PEM, as node's tls wants them. */
export type Certificate = { key: string; cert: string }

/**
 * A CA in the form the signing calls need it: the subject and key material parsed out of
 * its PEMs. Building one costs an RSA key import, so callers keep it rather than pass PEMs.
 */
export type Issuer = {
    subject: string
    publicKey: x509.PublicKey
    signingKey: webcrypto.CryptoKey
}

function webcryptoAlgorithm(algorithm: KeyAlgorithm) {
    if (algorithm === 'ec-p256') return { ...EC_SHA256, namedCurve: 'P-256' }
    return {
        ...RSA_SHA256,
        modulusLength: algorithm === 'rsa-2048' ? 2048 : 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
    }
}

// x509.PemConverter omits the trailing newline that openssl emits; keep it, both
// because the files on disk are nicer that way and because the ThinQ cloud is fed
// these PEMs verbatim.
function pem(der: ArrayBuffer, label: string): string {
    return x509.PemConverter.encode(der, label) + '\n'
}

/** A 20-byte serial, as hex, the same shape `openssl req -x509` used to pick. */
function randomSerial(): string {
    return Buffer.from(webcrypto.getRandomValues(new Uint8Array(20))).toString('hex')
}

async function generateKeyPair(algorithm: KeyAlgorithm): Promise<webcrypto.CryptoKeyPair> {
    return (await webcrypto.subtle.generateKey(webcryptoAlgorithm(algorithm), true, [
        'sign',
        'verify',
    ])) as webcrypto.CryptoKeyPair
}

async function exportKeyPair(keys: webcrypto.CryptoKeyPair): Promise<KeyPair> {
    return {
        // PKCS#8, i.e. `BEGIN PRIVATE KEY`. openssl's `ecparam -genkey` produced SEC1
        // (`BEGIN EC PRIVATE KEY`) instead; node's tls accepts either, and keys stored
        // by older versions keep working.
        privateKey: pem(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey), 'PRIVATE KEY'),
        publicKey: pem(await webcrypto.subtle.exportKey('spki', keys.publicKey), 'PUBLIC KEY'),
    }
}

// Accepts any PEM form node can parse (PKCS#8, PKCS#1, SEC1) and hands WebCrypto the
// PKCS#8 it insists on, so CA keys written by earlier openssl-based versions still load.
async function importPrivateKey(keyPem: string, algorithm: KeyAlgorithm): Promise<webcrypto.CryptoKey> {
    const pkcs8 = createPrivateKey(keyPem).export({ type: 'pkcs8', format: 'der' })
    return webcrypto.subtle.importKey('pkcs8', pkcs8, webcryptoAlgorithm(algorithm), false, ['sign'])
}

export async function loadIssuer(ca: Certificate): Promise<Issuer> {
    const certificate = new x509.X509Certificate(ca.cert)
    return {
        subject: certificate.subject,
        publicKey: certificate.publicKey,
        signingKey: await importPrivateKey(ca.key, 'rsa-4096'),
    }
}

const CA_COMMON_NAME = 'Rethink CA'

/**
 * A self-signed RSA-4096 CA. Mirrors what `openssl req -x509 -newkey rsa:4096 -nodes`
 * used to emit: a CN-only subject, a random 20-byte serial, and the v3_ca extensions
 * (no keyUsage — this certificate used to double as the TLS server certificate, and
 * appliances provisioned back then still carry it as their trust anchor).
 */
export async function createSelfSignedCA(days = 3650): Promise<Certificate> {
    const keys = await generateKeyPair('rsa-4096')
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: randomSerial(),
        name: `CN=${CA_COMMON_NAME}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + days * DAY_MS),
        signingAlgorithm: RSA_SHA256,
        keys,
        extensions: [
            new x509.BasicConstraintsExtension(true, undefined, true),
            await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
            await x509.AuthorityKeyIdentifierExtension.create(keys.publicKey),
        ],
    })

    const { privateKey } = await exportKeyPair(keys)
    return { key: privateKey, cert: cert.toString('pem') + '\n' }
}

/**
 * A TLS server certificate for `hostname`, with a fresh key, signed by the CA.
 *
 * The CA itself used to be served as the server certificate. Some appliances reject that
 * (a certificate cannot be both the trust anchor and the leaf for them), and a leaf per
 * name is also what lets us answer for whatever hostname a redirected appliance asks for.
 */
export async function createServerCertificate(hostname: string, issuer: Issuer, days = 3650): Promise<Certificate> {
    const keys = await generateKeyPair('rsa-2048')

    const cert = await x509.X509CertificateGenerator.create({
        serialNumber: randomSerial(),
        subject: `CN=${hostname}`,
        issuer: issuer.subject,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + days * DAY_MS),
        signingAlgorithm: RSA_SHA256,
        publicKey: keys.publicKey,
        signingKey: issuer.signingKey,
        extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
            new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
            new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
            await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
            await x509.AuthorityKeyIdentifierExtension.create(issuer.publicKey),
        ],
    })

    const { privateKey } = await exportKeyPair(keys)
    return { key: privateKey, cert: cert.toString('pem') + '\n' }
}

/** A fresh key plus a PKCS#10 certificate request for it, all as PEM. */
export async function createCertificateRequest(subject: string, algorithm: KeyAlgorithm): Promise<CertificateRequest> {
    const keys = await generateKeyPair(algorithm)
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: subject,
        keys,
        signingAlgorithm: algorithm === 'ec-p256' ? EC_SHA256 : RSA_SHA256,
    })
    return { ...(await exportKeyPair(keys)), csr: csr.toString('pem') + '\n' }
}

/**
 * Sign someone else's CSR with the CA. Like `openssl x509 -req`, only the subject and
 * public key are taken from the request; any extensions it asks for are ignored.
 */
export async function signCertificateRequest(
    csrPem: string,
    issuer: Issuer,
    serialNumber: string,
    days = 3650,
): Promise<string> {
    const request = new x509.Pkcs10CertificateRequest(csrPem)
    const cert = await x509.X509CertificateGenerator.create({
        serialNumber,
        subject: request.subject,
        issuer: issuer.subject,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + days * DAY_MS),
        signingAlgorithm: RSA_SHA256,
        publicKey: request.publicKey,
        signingKey: issuer.signingKey,
    })
    return cert.toString('pem') + '\n'
}
