import * as tls from 'node:tls'
import jsonSplitter from './util/json_splitter.js'
import * as mtosp from './util/mtosp.js'

if(process.argv.length != 5) {
	console.warn(
`Usage:
	tsx rethink-setup.ts hostname wifi_ssid wifi_password

	hostname is usually 192.168.120.254
`)
	process.exit()
}

const [host, wifiname, wifipass] = process.argv.slice(2)

async function request(xml: string) {
	const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
		const socket = tls.connect({host: host, port: 5500, rejectUnauthorized: false }, () => resolve(socket))
		socket.on('error', reject)
	})

	try {
		socket.write(mtosp.format(xml))

		return await new Promise<string>((resolve, reject) => {
			socket.on('error', reject)

			const splitter = mtosp.splitter()
			socket.on('data', (data) => {
				try {
					for(const byte of data)
						splitter(byte, resolve)
				} catch(err) {
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
	let resp = await request(`<mTosp><data type="deviceinfo"><time>${Date.now()}</time><reg>000</reg><errorCode>N</errorCode></data></mTosp>`)
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
	// This is the public key used by the official LG cloud. We don't know the
	// private key.
	// If we wanted to decrypt the data from the WiFi module, we would generate our
	// own keypair. But we don't need to verify anything, so why bother. this makes
	// the setup process simpler.
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
		const socket = tls.connect({host: host, port: 5500, rejectUnauthorized: false }, function() {
			console.log('TLS connection established')
			socket.write(JSON.stringify({type: "request", cmd: "setDeviceInit", data: { set: "true", constantConnect: "Y"}}))
		})

		function onMessage(json) {
			console.log(json)

			if(json.type === 'response') {
				if(json.data.result && json.data.result !== '000') {
					console.warn("Error code returned!")
					return
				}

				if(json.cmd === 'setDeviceInit') 
					socket.write(JSON.stringify({type: "request", cmd: "getDeviceInfo", data: { 
						subCountryCode: "DE", regionalCode: "eic", timezone: "+0100",
						publicKey, constantConnect: "Y" }}))
				if(json.cmd === 'getDeviceInfo') 
					socket.write(JSON.stringify({type: "request", cmd: "setCertInfo", data: { 
						// svcphase is normally OP. Setting it to QA or ST enables the debug UART :)
						otp: "0123456789abcdef0123456789abcdef0123456789abcdef", svccode: "SVC202", svcphase: "QA", constantConnect: "Y"}}))
				if(json.cmd === 'setCertInfo') {
					const b64ssid = Buffer.from(wifiname, 'utf-8').toString('base64')
					const b64password = Buffer.from(wifipass, 'utf-8').toString('base64')

					socket.write(JSON.stringify({type: "request", cmd: "setApInfo", data: {
						format: "B64", ssid: b64ssid, password: b64password, security: "WPA2_PSK", cipher: "AES", constantConnect: "Y"}}))
				}
				if(json.cmd === 'setApInfo') 
					socket.write(JSON.stringify({type: "request", cmd: "releaseDev", data: {}}))
				if(json.cmd === 'releaseDev') {
					console.log('Setup completed, the device will now connect to your Wi-Fi')
					socket.destroy()

					console.log('ThinQ2 setup successful, see rethink-cloud logs for a follow-up')
					resolve()
				}
			}
		}

		const splitter = jsonSplitter()
		socket.on('data', (data) => {
			for(const byte of data) 
				splitter(byte, onMessage)
		})

		socket.on('error', reject)
	})
}

(async () => {
	// We try the ThinQ 1 protocol first. The formatting should be rejected by ThinQ2 appliances. Hopefully.
	try {
		console.log('Trying ThinQ 1 setup')
		await thinq1Setup();

	} catch(err) {
		console.log('ThinQ 1 setup failed', err.toString())
		console.log('Trying ThinQ 2 setup')
		thinq2Setup();
	}
})()

process.on('exit', () => console.log(`

    Author's request: 

    Once you finish setting up rethink (or encounter a problem), please let
    me know about your experiences by filling out this form:
    		https://forms.gle/B4vUGGZHa8HsfsQW6 
    Thanks!
`))

