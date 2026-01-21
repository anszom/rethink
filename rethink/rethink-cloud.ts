import express from 'express'
import { readFileSync } from 'node:fs'
import * as https from 'node:https'
import { spawnSync } from 'node:child_process'
import { Broker } from './cloud/mqtt-broker.js'
import * as tls from 'node:tls'
import * as net from 'node:net'
import { X509Certificate } from 'node:crypto'
import { routes as thinq1Routes } from './cloud/thinq1/http.js'
import { routes as thinq2Routes } from './cloud/thinq2/provisioning.js'
import { DeviceManager as T1DeviceManager } from './cloud/thinq1/devmgr.js'
import { DeviceManager as T2DeviceManager } from './cloud/thinq2/devmgr.js'
import { Connection as HA_connection } from './cloud/homeassistant.js'
import HA_bridge from './cloud/ha_bridge.js'
import { Config, CA } from './util/config.js'

import log, { setFilter as setLogFilter } from './util/logging.js'

const config = JSON.parse(readFileSync('./config.json').toString('utf-8')) as Config

if(!config.log) 
	config.log = [ 'status', 'incoming', 'HTTPS', ]

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

// Thinq1
function t1setup(bridge: HA_bridge) {
	// Thinq1 HTTPS server
	const app = express()
	app.use(function(req,res, next) {
		log('HTTPS', req.hostname, req.url)
		next()
	})

	app.use(thinq1Routes(config))

	// fallback
	app.use((req, res) => {
		res.json({})
	})

	https.createServer(ca, app).listen(config.thinq1_https_port ?? 46030)
	const manager = new T1DeviceManager();
	tls.createServer(ca, manager.accept.bind(manager)).listen(config.thinq1_port ?? 47878)
	
	manager.on('newDevice', bridge.newT1Device.bind(bridge))
}

// Thinq2
function t2setup(bridge: HA_bridge) {
	// Thinq2 HTTPS server
	const app = express()
	app.use(express.json())

	app.use(function(req,res, next) {
		log('HTTPS', req.hostname, req.url)
		next()
	})

	app.use(thinq2Routes(config, ca))

	// fallback
	app.use((req, res) => {
		res.header('content-type', 'text/xml;charset=utf-8')
		res.end('')
	})

	https.createServer(ca, app).listen(config.https_port)
	
	// internal MQTT broker
	const broker = new Broker()

	if(config.mqtt !== false) {
		tls.createServer(ca, broker.accept.bind(broker)).listen(config.mqtts_port)
		net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port)
	}

	const devices = new T2DeviceManager(broker)
	devices.on('newDevice', bridge.newT2Device.bind(bridge))
}

// HA connector
const HA = new HA_connection(config.homeassistant)
const bridge = new HA_bridge(HA)

t1setup(bridge)
t2setup(bridge)

console.log('Rethink cloud ready')