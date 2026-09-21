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

/**
 * A self-signed RSA-4096 CA. Mirrors what `openssl req -x509 -newkey rsa:4096 -nodes`
 * used to emit: a CN-only subject, a random 20-byte serial, and the v3_ca extensions
 * (no keyUsage — this certificate doubles as the TLS server certificate).
 */
export async function createSelfSignedCA(commonName: string, days = 3650): Promise<{ key: string; cert: string }> {
    const keys = await generateKeyPair('rsa-4096')
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(20))).toString('hex'),
        name: `CN=${commonName}`,
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
    ca: { key: string; cert: string },
    serialNumber: string,
    days = 3650,
): Promise<string> {
    const request = new x509.Pkcs10CertificateRequest(csrPem)
    const issuer = new x509.X509Certificate(ca.cert)
    const cert = await x509.X509CertificateGenerator.create({
        serialNumber,
        subject: request.subject,
        issuer: issuer.subject,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + days * DAY_MS),
        signingAlgorithm: RSA_SHA256,
        publicKey: request.publicKey,
        signingKey: await importPrivateKey(ca.key, 'rsa-4096'),
    })
    return cert.toString('pem') + '\n'
}
