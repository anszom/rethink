const tls = require('tls')
const jsonSplitter = require('./json_splitter.js')

const [host, wifiname, wifipass] = process.argv.slice(2)
const b64ssid = Buffer.from(wifiname, 'utf-8').toString('base64')
const b64password = Buffer.from(wifipass, 'utf-8').toString('base64')

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

console.log(`Connecting to ${host}:5500`)
const socket = tls.connect({host: host, port: 5500, rejectUnauthorized: false }, function() {
	console.log('TLS connection established')
	socket.write(JSON.stringify({type: "request", cmd: "setDeviceInit", data: { set: "true", constantConnect: "Y"}}))
})

function onMessage(json) {
	console.log(json)

	if(json.type === 'response') {
		if(json.data.resul && tjson.data.result !== '000') {
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
		if(json.cmd === 'setCertInfo') 
			socket.write(JSON.stringify({type: "request", cmd: "setApInfo", data: {
				format: "B64", ssid: b64ssid, password: b64password, security: "WPA2_PSK", cipher: "AES", constantConnect: "Y"}}))
		if(json.cmd === 'setApInfo') 
			socket.write(JSON.stringify({type: "request", cmd: "releaseDev", data: {}}))
		if(json.cmd === 'releaseDev') {
			console.log('Setup completed, the device will now connect to your Wi-Fi')
			socket.destroy()
		}
	}
}

const splitter = jsonSplitter()
socket.on('data', (data) => {
	for(const byte of data) 
		splitter(byte, onMessage)
})

socket.on('error', console.log)
