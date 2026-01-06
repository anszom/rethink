import express from 'express'
import { readFileSync } from 'node:fs'
import * as https from 'node:https'
import { spawnSync } from 'node:child_process'
import { Broker } from './cloud/mqtt-broker.js'
import * as tls from 'node:tls'
import * as net from 'node:net'
import { X509Certificate } from 'node:crypto'
import { setupHttp } from './cloud/provisioning.js'
import { DeviceManager } from './cloud/devmgr.js'
import { Connection as HA_connection } from './cloud/homeassistant.js'
import HA_bridge from './cloud/ha_bridge.js'
import { Config, CA } from './util/clip.js'

import log, { setFilter as setLogFilter } from './util/logging.js'

const app = express()
const config = JSON.parse(readFileSync('./config.json').toString('utf-8')) as Config

if(!config.log) 
	config.log = [ 'status', 'incoming' ]

const enabled = Object.fromEntries(config.log.map((key) => [ key, true ]))
setLogFilter((topic) => { return enabled[topic] || enabled['all'] })

// if you add spaces here, you will have to fix quoting in the code below
// the CA is also the server
function loadOrCreateCert(): CA {
	let keypem: string, certpem: string
	try {
		keypem = readFileSync(config.ca_key_file).toString('utf-8')
		certpem = readFileSync(config.ca_cert_file).toString('utf-8')

		if(!new X509Certificate(certpem).checkHost(config.hostname))
			throw new Error("invalid subject, creating new certificate")

	} catch(err) {
		log('status', "Creating a new key/certificate for the CA")
		spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:4096', '-keyout', config.ca_key_file, '-out', config.ca_cert_file, '-sha256', '-days', '3650', '-nodes', '-subj', '/CN=' + config.hostname ])
		keypem = readFileSync(config.ca_key_file).toString('utf-8')
		certpem = readFileSync(config.ca_cert_file).toString('utf-8')
	}

	return { key: keypem, cert: certpem }
}

const ca = loadOrCreateCert()

// HTTPS server
app.use(express.json())

app.use(function(req,res, next) {
	log('HTTPS', req.hostname, req.url)
	next()
})

setupHttp(app, config, ca)

app.use((req, res) => {
	res.json({})
})

https.createServer(ca, app).listen(config.https_port)

// HA connector
const HA = new HA_connection(config.homeassistant)

// internal MQTT broker
const broker = new Broker()
const devices = new DeviceManager(broker)
const bridge = new HA_bridge(devices, HA)

if(config.mqtt !== false) {
	tls.createServer(ca, broker.accept.bind(broker)).listen(config.mqtts_port)
	net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port)
}

console.log('Rethink cloud ready')
console.log(`During setup, please ensure that connections to common.lgthinq.com:443 are redirected to ${config.hostname}:${config.https_port}`)
