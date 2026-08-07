import * as tls from 'node:tls'
import jsonSplitter from './util/json_splitter'
import * as mtosp from './util/mtosp'

if (process.argv.length != 5) {
    console.warn(
        `Usage:
	tsx rethink-setup.ts hostname wifi_ssid wifi_password

	hostname is usually 192.168.120.254
	Always quote the password (special chars like ! $ etc.):
	  npx tsx rethink-setup.ts 192.168.120.254 'MySSID' 'MyPassword!'

	Optional env (for modules that accept setApInfo but never join STA):
	  SETUP_SECURITY=WPA2_PSK|WPA_PSK   (default WPA2_PSK)
	  SETUP_FORMAT=B64|plain           (default B64)
	  SETUP_CIPHER=AES                 (default AES)
	  SETUP_RELEASE_DELAY_MS=3000      (delay before releaseDev)
	  SETUP_FREQ=2417                  (force AP frequency MHz; else taken from scan)
	  SETUP_AP_BSSID=aa:bb:cc:dd:ee:ff (home AP MAC if known — not the SoftAP IP)
	  SETUP_SSID_AS_BSSID=1            (also send B64 SSID in legacy "bssid" field; default on)
`,
    )
    process.exit()
}

const [host, wifiname, wifipass] = process.argv.slice(2)

async function request(xml: string) {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const socket = tls.connect({ host: host, port: 5500, rejectUnauthorized: false }, () => resolve(socket))
        socket.on('error', reject)
    })

    try {
        socket.write(mtosp.format(xml))

        return await new Promise<string>((resolve, reject) => {
            socket.on('error', reject)

            const splitter = mtosp.splitter()
            socket.on('data', (data) => {
                try {
                    for (const byte of data) splitter(byte, resolve)
                } catch (err) {
                    reject(err)
                }
            })
        })
    } finally {
        socket.destroy()
    }
}

async function thinq1Setup() {
    console.log(`Connecting to ${host}:5500`)
    console.log('Request: deviceinfo')
    let resp = await request(
        `<mTosp><data type="deviceinfo"><time>${Date.now()}</time><reg>000</reg><errorCode>N</errorCode></data></mTosp>`,
    )
    console.log('response:', resp)
    const b64ssid = Buffer.from(wifiname, 'utf-8').toString('base64')
    const b64password = Buffer.from(wifipass, 'utf-8').toString('base64')

    console.log('Request: apinfo')
    // we set the region code to a fake one, `rethink` so that the device will attempt connections to rethink.lgthinq.com
    resp = await request(`<mTosp><data type="apinfo">
		<format>B64</format>
		<bssid>${b64ssid}</bssid>
		<security>WPA_PSK</security>
		<password>${b64password}</password>
		<subCountryCode>DE</subCountryCode>
		<regionalCode>rethink</regionalCode>
	</data></mTosp>`)
    console.log('response:', resp)

    console.log('ThinQ2 setup successful, see rethink-cloud logs for a follow-up')
}

function thinq2Setup() {
    // NOTE: keep the base64 lines at column 0 — no leading whitespace *inside* the PEM. The
    // RTL8720cm "CLIP" firmware (DeviceType 202, protocolVer 4.9) uses a strict PEM parser that
    // rejects in-band tabs/spaces: with indentation it fails its RSA-encrypt step in getDeviceInfo
    // (returns encrypt_val:'' and extra ...encryptRes:ffff) and then loops on /route forever. Older
    // firmware tolerates the whitespace. Same key bytes, just clean framing.
    const publicKey = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApYRAZXRWijMuWNr9LHOJ
fcPcZHDYcO3CwRF9olsPvtJpkrDXR7jEDA6qPHF1jvJ7ArxDLVj8rbkwXb3oXNmN
Sc+n0DPNDiRgghDaDyJpN0qfzmt06MKdihVScwghyYKWD+oA9d1+j3wy3W32he+X
7FnS+yUmmbQ8cT0PYS7p2E8YtbgHrH+SbUzHAgBbaS8E92l7f0qOpQFmYEyP/OX+
1n0dLdXXJ8kFxCLP2n8Wy6XXTutrT0YuZCxabPVYSKsjLh86MuHEM6V8BdBoZItW
qA1bDeDvjP7QC93lGxmwIYR0H8VVQq7gBZYWpPfsRSfwsE/PCMrF1WS4sPnSauaV
QwIDAQAB
-----END PUBLIC KEY-----
`
    // Optional overrides for firmwares that accept setApInfo but fail STA join
    // (seen on some RTK_RTL8711am modules — fridges/washers). Examples:
    //   SETUP_SECURITY=WPA_PSK SETUP_RELEASE_DELAY_MS=5000 SETUP_FREQ=2417
    const security = process.env.SETUP_SECURITY ?? 'WPA2_PSK'
    const cipher = process.env.SETUP_CIPHER ?? 'AES'
    const format = (process.env.SETUP_FORMAT ?? 'B64').toUpperCase() // B64 | PLAIN
    const releaseDelayMs = Number(process.env.SETUP_RELEASE_DELAY_MS ?? '3000')
    const forceFreq = process.env.SETUP_FREQ
    const apBssid = process.env.SETUP_AP_BSSID // real AP MAC, e.g. 7a:83:c2:…
    const ssidAsBssid = (process.env.SETUP_SSID_AS_BSSID ?? '1') !== '0'

    // Always log lengths so shell mangling is obvious (do not log the password).
    console.log(
        `Wi-Fi credentials: ssid_len=${wifiname.length} pass_len=${wifipass.length} security=${security} format=${format}`,
    )

    function send(socket: tls.TLSSocket, obj: object) {
        // Trailing newline: some CLIP JSON framers are line-oriented.
        socket.write(JSON.stringify(obj) + '\n')
    }

    function buildApInfoData(extra: Record<string, string | number> = {}) {
        const useB64 = format === 'B64'
        const ssid = useB64 ? Buffer.from(wifiname, 'utf-8').toString('base64') : wifiname
        const password = useB64 ? Buffer.from(wifipass, 'utf-8').toString('base64') : wifipass
        const data: Record<string, string | number> = {
            format: useB64 ? 'B64' : 'plain',
            ssid,
            password,
            security,
            cipher,
            // Same region fields as ThinQ1 apinfo — some modules store these with the STA profile.
            subCountryCode: 'DE',
            regionalCode: 'eic',
            constantConnect: 'Y',
            // Multi-profile firmwares (supportsMultiProfile=Y) sometimes need an explicit default slot.
            multiProfile: 'Y',
            ...extra,
        }
        // ThinQ1 SoftAP used the field name "bssid" for the (B64) SSID. Some RTK firmwares
        // still read that key. Optional SETUP_AP_BSSID overrides with the real AP MAC.
        if (apBssid) {
            data.bssid = apBssid
        } else if (ssidAsBssid) {
            data.bssid = ssid
        }
        if (forceFreq) data.frequency = Number(forceFreq) || forceFreq
        return data
    }

    return new Promise<void>((resolve, reject) => {
        console.log(`Connecting to ${host}:5500`)
        const socket = tls.connect({ host: host, port: 5500, rejectUnauthorized: false }, function () {
            console.log('TLS connection established')
            send(socket, { type: 'request', cmd: 'setDeviceInit', data: { set: 'true', constantConnect: 'Y' } })
        })

        /** After the first setApInfo, modules often return a scan hit (freq/security). Re-send once with those. */
        let apInfoPass = 0

        function onMessage(json: any) {
            console.log(json)

            if (json.type === 'response') {
                if (json.data.result && json.data.result !== '000') {
                    console.warn('Error code returned!')
                    return
                }

                if (json.cmd === 'setDeviceInit')
                    send(socket, {
                        type: 'request',
                        cmd: 'getDeviceInfo',
                        data: {
                            subCountryCode: 'DE',
                            regionalCode: 'eic',
                            timezone: '+0100',
                            publicKey,
                            constantConnect: 'Y',
                        },
                    })
                if (json.cmd === 'getDeviceInfo') {
                    const info = json.data || {}
                    console.log(
                        `Device: model=${info.modelName} type=${info.deviceType} protocol=${info.protocolVer} modem=${info.demandType || info.modemType} multiProfile=${info.supportsMultiProfile} wpa3=${info.supportsWpa3}`,
                    )
                    send(socket, {
                        type: 'request',
                        cmd: 'setCertInfo',
                        data: {
                            otp: '0123456789abcdef0123456789abcdef0123456789abcdef',
                            svccode: 'SVC202',
                            // OP is the default. On some firmwares this value affects the target hostname in
                            // the initial HTTPS request, so let's not mess with it without a good reason.
                            // Setting it to QA or ST enables the debug UART :)
                            svcphase: 'OP',
                            constantConnect: 'Y',
                        },
                    })
                }
                if (json.cmd === 'setCertInfo') {
                    apInfoPass = 1
                    const data = buildApInfoData()
                    console.log(
                        `setApInfo pass ${apInfoPass}: keys=${Object.keys(data).filter((k) => k !== 'password').join(',')}`,
                    )
                    send(socket, { type: 'request', cmd: 'setApInfo', data })
                }
                if (json.cmd === 'setApInfo') {
                    const hn = json.data?.homeNetwork
                    if (apInfoPass === 1 && hn && !forceFreq) {
                        // Second pass: pin frequency (and security/cipher) from the module's scan.
                        // Several RTK firmwares accept pass-1 with result 000 but only associate
                        // after a follow-up that includes the scanned BSS frequency.
                        apInfoPass = 2
                        const extra: Record<string, string | number> = {}
                        if (hn.freq != null) extra.frequency = Number(hn.freq) || hn.freq
                        if (hn.security) extra.security = hn.security
                        if (hn.encryption) extra.cipher = hn.encryption
                        console.log(
                            `setApInfo pass 2 (scan refine): freq=${hn.freq} security=${hn.security} encryption=${hn.encryption} oui=${hn.oui}`,
                        )
                        send(socket, { type: 'request', cmd: 'setApInfo', data: buildApInfoData(extra) })
                        return
                    }

                    // Give the modem time to commit STA credentials before leaving SoftAP.
                    const delay = Number.isFinite(releaseDelayMs) ? Math.max(0, releaseDelayMs) : 3000
                    console.log(`setApInfo ok (pass ${apInfoPass}); waiting ${delay}ms before releaseDev`)
                    setTimeout(() => {
                        send(socket, { type: 'request', cmd: 'releaseDev', data: { constantConnect: 'Y' } })
                    }, delay)
                }
                if (json.cmd === 'releaseDev') {
                    console.log('Setup completed, the device will now connect to your Wi-Fi')
                    // Keep SoftAP TCP up briefly so the module can finish teardown cleanly.
                    setTimeout(() => {
                        socket.destroy()
                        console.log('ThinQ2 setup successful, see rethink-cloud logs for a follow-up')
                        resolve()
                    }, 1500)
                }
            }
        }

        const splitter = jsonSplitter()
        socket.on('data', (data) => {
            for (const byte of data) splitter(byte, onMessage)
        })

        socket.on('error', reject)
    })
}

;(async () => {
    // We try the ThinQ 1 protocol first. The formatting should be rejected by ThinQ2 appliances. Hopefully.
    try {
        console.log('Trying ThinQ 1 setup')
        await thinq1Setup()
    } catch (err) {
        console.log('ThinQ 1 setup failed', err)
        console.log('Trying ThinQ 2 setup')
        await thinq2Setup()
    }
})()

process.on('exit', () =>
    console.log(`

    Author's request: 

    Once you finish setting up rethink (or encounter a problem), please let
    me know about your experiences by filling out this form:
    		https://forms.gle/B4vUGGZHa8HsfsQW6 
    Thanks!
`),
)
