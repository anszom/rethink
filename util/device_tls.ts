import type * as tls from 'node:tls'
import type { CA } from './config'

/**
 * TLS options for listeners that talk to appliance Wi‑Fi modules.
 *
 * Some CLIP/RTK firmwares (seen on protocolVer 4.8 washers) only offer legacy
 * CBC suites such as ECDHE-RSA-AES128-SHA / AES128-SHA256 — no GCM. Default
 * OpenSSL 3 / Node SECLEVEL rejects those, so the server aborts with
 * fatal handshake_failure before any HTTP /route request is logged.
 */
export function deviceTlsOptions(ca: CA): tls.SecureContextOptions {
    return {
        key: ca.key,
        cert: ca.cert,
        minVersion: 'TLSv1',
        // Keep modern ciphers first, but allow SECLEVEL=0 so SHA1-CBC suites work.
        ciphers: 'DEFAULT:@SECLEVEL=0',
        honorCipherOrder: true,
    }
}
