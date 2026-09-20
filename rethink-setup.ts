import * as tls from 'node:tls'
import * as net from 'node:net'
import { constants as cryptoConstants } from 'node:crypto'
import * as whisen from './util/whisen'
import jsonSplitter from './util/json_splitter'
import * as mtosp from './util/mtosp'

if (process.argv.length != 5 && process.argv.length != 6) {
    console.warn(
        `Usage:
	tsx rethink-setup.ts hostname wifi_ssid wifi_password [nation]

	hostname is usually 192.168.120.254 (ThinQ1/ThinQ2 on port 5500)
	or 192.168.1.1 for appliances whose SoftAP hands out 192.168.1.x addresses;
	those speak the HTTP-over-TLS "Whisen" protocol on port 9000 and are detected automatically.
	nation is the two-letter country code sent to Whisen appliances (default WW).
`,
    )
    process.exit()
}

const [host, wifiname, wifipass, nation = 'WW'] = process.argv.slice(2)

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
    return new Promise<void>((resolve, reject) => {
        console.log(`Connecting to ${host}:5500`)
        const socket = tls.connect({ host: host, port: 5500, rejectUnauthorized: false }, function () {
            console.log('TLS connection established')
            socket.write(
                JSON.stringify({ type: 'request', cmd: 'setDeviceInit', data: { set: 'true', constantConnect: 'Y' } }),
            )
        })

        function onMessage(json: any) {
            console.log(json)

            if (json.type === 'response') {
                if (json.data.result && json.data.result !== '000') {
                    console.warn('Error code returned!')
                    return
                }

                if (json.cmd === 'setDeviceInit')
                    socket.write(
                        JSON.stringify({
                            type: 'request',
                            cmd: 'getDeviceInfo',
                            data: {
                                subCountryCode: 'DE',
                                regionalCode: 'eic',
                                timezone: '+0100',
                                publicKey,
                                constantConnect: 'Y',
                            },
                        }),
                    )
                if (json.cmd === 'getDeviceInfo')
                    socket.write(
                        JSON.stringify({
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
                        }),
                    )
                if (json.cmd === 'setCertInfo') {
                    const b64ssid = Buffer.from(wifiname, 'utf-8').toString('base64')
                    const b64password = Buffer.from(wifipass, 'utf-8').toString('base64')

                    socket.write(
                        JSON.stringify({
                            type: 'request',
                            cmd: 'setApInfo',
                            data: {
                                format: 'B64',
                                ssid: b64ssid,
                                password: b64password,
                                security: 'WPA2_PSK',
                                cipher: 'AES',
                                constantConnect: 'Y',
                            },
                        }),
                    )
                }
                if (json.cmd === 'setApInfo')
                    socket.write(JSON.stringify({ type: 'request', cmd: 'releaseDev', data: {} }))
                if (json.cmd === 'releaseDev') {
                    console.log('Setup completed, the device will now connect to your Wi-Fi')
                    socket.destroy()

                    console.log('ThinQ2 setup successful, see rethink-cloud logs for a follow-up')
                    resolve()
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

function portOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ host, port })
        sock.setTimeout(3000)
        sock.on('connect', () => {
            sock.destroy()
            resolve(true)
        })
        sock.on('timeout', () => {
            sock.destroy()
            resolve(false)
        })
        sock.on('error', () => resolve(false))
    })
}

// --- Whisen (HTTP over TLS on port 9000) ----------------------------------------------
// The module presents a 1024-bit certificate with legacy suites, hence the relaxed TLS profile.

function whisenRequest(path: string, body: string, headers?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        const socket = tls.connect(
            {
                host,
                port: whisen.WHISEN_PORT,
                rejectUnauthorized: false,
                minVersion: 'TLSv1.2',
                maxVersion: 'TLSv1.2',
                ciphers: 'ALL:@SECLEVEL=0',
                secureOptions:
                    cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION |
                    cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT,
            },
            () => {
                console.log(`Request: POST ${path}`)
                socket.write(whisen.request(path, body, headers))
            },
        )
        socket.setTimeout(15000)
        socket.on('data', (d: Buffer) => chunks.push(d))
        socket.on('timeout', () => socket.destroy(new Error('timeout')))
        socket.on('error', reject)
        socket.on('close', () => {
            const reply = Buffer.concat(chunks).toString('utf8')
            console.log('response:', JSON.stringify(reply))
            resolve(reply)
        })
    })
}

async function whisenSetup() {
    console.log(`Connecting to ${host}:${whisen.WHISEN_PORT}`)
    await whisenRequest('/SetDeviceInit', '')

    // Answers 500 on the RAC_056905_WW firmware
    const info = whisen.parseMembers(await whisenRequest('/GetDeviceInfo', ''))
    if (info) console.log('device info:', info)

    // regionalCode is a fake one, `rethink`, so the appliance attempts connections to rethink.lgthinq.com.
    // Must precede SetDeviceConfig: ReleaseDevAp at the end takes the SoftAP down.
    const infoReply = await whisenRequest('/SetDeviceInfo', whisen.deviceInfoBody(nation, 'rethink'))
    if (whisen.statusCode(infoReply) !== 200) throw new Error('SetDeviceInfo rejected')

    const tz = whisen.timezone(-new Date().getTimezoneOffset())
    const cfgReply = await whisenRequest(
        '/SetDeviceConfig',
        whisen.deviceConfigBody(wifiname, wifipass, tz),
        whisen.DEVICE_CONFIG_HEADERS,
    )
    if (whisen.statusCode(cfgReply) !== 200) throw new Error('SetDeviceConfig rejected, appliance left in AP mode')

    await whisenRequest('/ReleaseDevAp', '')
    console.log('Whisen setup successful, see rethink-cloud logs for a follow-up')
}

;(async () => {
    // Appliances speaking the Whisen protocol only listen on 9000; the others only on 5500.
    if (!(await portOpen(5500)) && (await portOpen(whisen.WHISEN_PORT))) {
        console.log('Port 9000 open and 5500 closed, trying Whisen setup')
        await whisenSetup()
        return
    }

    // We try the ThinQ 1 protocol first. The formatting should be rejected by ThinQ2 appliances. Hopefully.
    try {
        console.log('Trying ThinQ 1 setup')
        await thinq1Setup()
    } catch (err) {
        console.log('ThinQ 1 setup failed', err)
        console.log('Trying ThinQ 2 setup')
        thinq2Setup()
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
