const express = require('express')
const fs = require('fs')
const app = express()
const https = require('https')
const child = require('child_process')
const Broker = require('./cloud/mqtt-broker.js')
const tls = require('tls')
const net = require('net')
const crypto = require('crypto')

const Provisioning = require('./cloud/provisioning.js')
const DeviceManager = require('./cloud/devmgr.js')
const HA_connection = require('./cloud/ha_connection.js')
const HA_bridge = require('./cloud/ha_bridge.js')
const config = JSON.parse(fs.readFileSync('./config.json'))

// if you add spaces here, you will have to fix quoting in the code below
// the CA is also the server
function loadOrCreateCert() {
	var keypem, certpem
	try {
		keypem = fs.readFileSync(config.ca_key_file).toString('utf-8')
		certpem = fs.readFileSync(config.ca_cert_file).toString('utf-8')

		if(!new crypto.X509Certificate(certpem).checkHost(config.hostname))
			throw new Error("invalid subject, creating new certificate")

	} catch(err) {
		console.log(err)
		console.log("Creating a new key/certificate for the CA")
		child.spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:4096', '-keyout', config.ca_key_file, '-out', config.ca_cert_file, '-sha256', '-days', '3650', '-nodes', '-subj', '/CN=' + config.hostname ])
		keypem = fs.readFileSync(config.ca_key_file).toString('utf-8')
		certpem = fs.readFileSync(config.ca_cert_file).toString('utf-8')
	}

	return { key: keypem, cert: certpem }
}

const CA = loadOrCreateCert()

// HTTPS server
app.use(express.json())

app.use(function(req,res, next) {
	console.log(req.hostname, req.url)
	next()
})

Provisioning.setupHttp(app, config, CA)

app.use((req, res) => {
	res.json({})
})

https.createServer(CA, app).listen(config.https_port)

// HA connector
const HA = new HA_connection(config.homeassistant)

// internal MQTT broker
const broker = new Broker()
const devices = new DeviceManager(broker, app)
const bridge = new HA_bridge(devices, HA)

if(config.mqtt !== false) {
	tls.createServer(CA, broker.accept.bind(broker)).listen(config.mqtts_port)
	net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port)
}

console.log('Rethink cloud ready')
console.log(`During setup, please ensure that connections to common.lgthinq.com:443 are redirected to ${config.hostname}:${config.https_port}`)
