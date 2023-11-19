const express = require('express')
const fs = require('fs')
const app = express()
const https = require('https')
const child = require('child_process')
const mqttCon = require('mqtt-connection')
const tls = require('tls')
const net = require('net')
const crypto = require('crypto')

const config = JSON.parse(fs.readFileSync('./config.json'))

// the CA is also the server
function loadOrCreateCert() {
	var keypem, certpem
	try {
		keypem = fs.readFileSync('ca.key').toString('utf-8')
		certpem = fs.readFileSync('ca.cert').toString('utf-8')

		if(!new crypto.X509Certificate(certpem).checkHost(config.hostname))
			throw new Error("invalid subject, creating new certificate")

	} catch(err) {
		console.log(err)
		console.log("Creating a new key/certificate for the CA")
		child.execSync("openssl req -x509 -newkey rsa:4096 -keyout ca.key -out ca.cert -sha256 -days 3650 -nodes -subj '/CN=" + config.hostname + "'")
		keypem = fs.readFileSync('ca.key').toString('utf-8')
		certpem = fs.readFileSync('ca.cert').toString('utf-8')
	}

	return { key: keypem, cert: certpem }
}

const CA = loadOrCreateCert()

app.use(express.json())
app.use(function(req,res, next) {
	console.log(req.hostname, req.url)
	next()
})

app.get('/route', (req, res) => {
	res.json({
		"resultCode": "0000",
		"result": {
			"apiServer": "https://" + config.hostname + ":" + config.https_port, 
			"mqttServer": "ssl://" + config.hostname + ":" + config.mqtts_port 
		}
	})
})

app.get('/route/certificate', (req, res) => {
	if(req.query.name) {
		res.json({"resultCode":"0000", "result":{"certificatePem": CA.cert}})
	} else {
		res.json({"resultCode": "0000", "result": ["common-server", "aws-iot"]})
	}
})

app.post('/device/:deviceId/certificate', (req, res) => {
	const x509 = child.spawn('openssl', ['x509', '-req', '-in', '-', 
		'-days', '3650', '-CA', 'ca.cert', '-CAkey', 'ca.key', '-set_serial', '0100', '-out', '-'])
	const out = []
	x509.stdout.on('data', (data) => {
		out.push(data)
	})
	x509.stderr.on('data', () => {})
	x509.on('close', (code) => {	
		res.json({"resultCode": "0000", "result": {"certificatePem": Buffer.concat(out).toString('utf-8').replace(/\r/g,"")}})
	})
	x509.stdin.end(req.body.csr)
});

app.use((req, res) => {
	res.json({})
})

https.createServer(CA, app).listen(config.https_port)

var msgid=0
var clients = new Set();

function mqtt(stream) {
	const client = mqttCon(stream)
	const cinfo = {
		client,
		subs: new Set()
	}
	clients.add(cinfo)

	client.on('connect', function(packet) {
		client.connack({returnCode: 0})
	})

	client.on('publish', function(packet) {
		console.log(packet.topic, packet.payload.toString('utf-8'))
		if(packet.qos > 0)
			client.puback({messageId: packet.messageId||++msgid})

		try {
			const payload = JSON.parse(packet.payload.subarray(0, packet.payload.length-1))
			if(packet.topic === 'clip/provisioning/devices/' + payload.did) {
				if(payload.cmd === 'preDeploy' || payload.cmd === 'deploy') {
					var resp={
						topic: 'lime/devices/' + payload.did,
						retain: false,
						qos: 0,
						dup: false,
						payload: JSON.stringify({
							"did": payload.did,
							"mid": Date.now(),
							"cmd": "completeProvisioning",
							"type":0,
							"data": {
								"result":0,
								"host": "message",
								"appInfo": {
									"host":"message",
									"publication":{
										// this path is arbitrary
										"message": "clip/message/devices/" + payload.did,

										// this path is not-so-arbitrary, because the device will cache it
										// and try to reuse it on a next provisioning attempt. We pick the
										// default path that is used by the firmware, so that we can be sure
										// that it will keep working if you revert to the official cloud.
										"provisioning": "clip/provisioning/devices/" + payload.did
									}
								},
								"provisioningType": payload.cmd,
								"deployInterval":600
							}
						})
					}

					client.publish(resp)
				}
			}

			if(packet.topic === 'clip/message/devices/' + payload.did) {
				if(payload.cmd === 'completeProvisioning_ack') {
					console.log(`Device ${payload.did} provisioning completed`)
				}
			}
		}catch(err) {
			console.log(err)
			console.log(packet.payload.toString('hex'))
		}

		for (const ci of clients) {
			if(ci.subs.has(packet.topic)) {
				ci.client.publish(packet)
			}
		}
	})

	client.on('pingreq', function() {
		client.pingresp()
	})

	client.on('subscribe', function(packet) {
		console.log(packet)
		client.suback({granted: [packet.qos], messageId: packet.messageId})
		packet.subscriptions.forEach((el) => cinfo.subs.add(el.topic))
	})
	
	stream.setTimeout(1000*60*5)
	client.on('close', function() { 
		console.log('close')
		clients.delete(cinfo)
		client.destroy() 
	})
	client.on('error', function(err) { 
		console.warn(err)
		clients.delete(cinfo)
		client.destroy() 
	})
	client.on('disconnect', function() { 
		console.log('disconnect')
		clients.delete(cinfo)
		client.destroy() 
	})
	stream.on('timeout', function() { 
		console.log('timeout')
		clients.delete(cinfo)
		client.destroy()
	})
}

tls.createServer(CA, mqtt).listen(config.mqtts_port)
net.createServer({}, mqtt).listen(config.mqtt_port)

console.log('Rethink cloud ready')
console.log(`During setup, please ensure that connections to common.lgthinq.com:443 are redirected to ${config.hostname}:${config.https_port}`)
