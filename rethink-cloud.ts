import express from 'express'
import stripJsonComments from 'strip-json-comments'
import { mkdirSync, readFileSync } from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { dirname, resolve } from 'node:path'
import { Broker } from './cloud/mqtt-broker'
import * as tls from 'node:tls'
import * as net from 'node:net'
import { X509Certificate } from 'node:crypto'
import { routes as thinq1Routes } from './cloud/thinq1/http'
import { routes as thinq2Routes } from './cloud/thinq2/provisioning'
import { DeviceAcceptor as T1Acceptor } from './cloud/thinq1/device'
import { DeviceAcceptor as T2Acceptor } from './cloud/thinq2/device'
import { Connection as HA_connection } from './cloud/homeassistant'
import HA_bridge from './cloud/ha_bridge'
import { normalize as normalizeConfig, RawConfig } from './util/config'
import * as Management from './management'
import { CA } from './util/ca'
import { CertificateIssuer } from './util/sni'
import { revision } from './util/version'

import log, { setFilter as setLogFilter } from './util/logging'
import { DeviceManager } from './cloud/devmgr'
import { Bridge } from './bridge'
import { JSONStorage } from './bridge/state'
import { setServers as setResolverServers } from './bridge/resolver'

const configPath = resolve(process.argv[2] ?? './config.json')
const configDir = dirname(configPath)
const config = normalizeConfig(JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as RawConfig)

config.ca_key_file = resolve(configDir, config.ca_key_file)
config.ca_cert_file = resolve(configDir, config.ca_cert_file)
if (config.custom_root_cert_file) config.custom_root_cert_file = resolve(configDir, config.custom_root_cert_file)
if (config.bridge) config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)

if (!config.log) config.log = ['status', 'incoming', 'HTTPS']

const enabled = Object.fromEntries(config.log.map((key) => [key, true]))
setLogFilter((topic) => {
    return enabled[topic] || enabled['all']
})

const ca = await CA.loadOrCreate(config.ca_key_file, config.ca_cert_file)

// The CA signs the server certificates, it is not one itself: some appliances reject a
// certificate that is also their trust anchor, and an appliance that reaches us by
// redirection asks for an LG hostname rather than for ours. Every TLS listener serves a
// leaf for config.hostname, and mints one on demand for whatever name is asked for.
const issuer = new CertificateIssuer(ca, config.hostname)
const tlsOptions = await issuer.listenerOptions()

// Read now, not per request: a missing or unusable file should stop us at startup rather
// than hand out a broken trust anchor once a device asks. It is served verbatim, and only
// its first block is parsed, as a check.
function loadRootCertificate(file: string): string {
    const pem = readFileSync(file).toString('utf-8')
    try {
        new X509Certificate(pem)
    } catch (err) {
        throw new Error(`${file} is not a certificate: ${err}`)
    }
    return pem
}

const rootCertificate = config.custom_root_cert_file ? loadRootCertificate(config.custom_root_cert_file) : ca.cert

// Thinq1
function t1setup(manager: DeviceManager) {
    // Thinq1 HTTPS server
    const app = express()
    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    app.use(thinq1Routes(config))

    // fallback
    app.use((req, res) => {
        res.json({})
    })

    if (config.thinq1_http_port.bind) http.createServer(app).listen(config.thinq1_http_port.bind)

    if (config.thinq1_https_port.bind) https.createServer(tlsOptions, app).listen(config.thinq1_https_port.bind)

    const acceptor = new T1Acceptor()

    if (config.thinq1_port.bind)
        tls.createServer(tlsOptions, acceptor.accept.bind(acceptor)).listen(config.thinq1_port.bind)

    acceptor.on('newDevice', manager.accept.bind(manager))
}

// Thinq2
function t2setup(manager: DeviceManager) {
    // Thinq2 HTTPS server
    const app = express()
    app.use(express.json())

    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    app.use(thinq2Routes(config, ca, rootCertificate))

    // fallback
    app.use((req, res) => {
        res.header('content-type', 'text/xml;charset=utf-8')
        res.end('')
    })

    if (config.http_port.bind) http.createServer(app).listen(config.http_port.bind)

    if (config.https_port.bind) https.createServer(tlsOptions, app).listen(config.https_port.bind)

    // internal MQTT broker
    const broker = new Broker()

    if (config.mqtt) {
        if (config.mqtts_port.bind)
            tls.createServer(tlsOptions, broker.accept.bind(broker)).listen(config.mqtts_port.bind)

        if (config.mqtt_port.bind) net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port.bind)
    }

    const acceptor = new T2Acceptor(broker)
    acceptor.on('newDevice', manager.accept.bind(manager))
}

// HA connector
const ha = new HA_bridge(new HA_connection(config.homeassistant))
const manager = new DeviceManager()
manager.on('newDevice', (dev) => ha.newDevice(dev))

t1setup(manager)
t2setup(manager)

let bridge: Bridge | undefined
if (config.bridge) {
    mkdirSync(config.bridge.storage_path, { recursive: true })
    setResolverServers(config.bridge.dns)
    const storage = new JSONStorage(config.bridge.storage_path)
    bridge = new Bridge(storage, manager)
}

if (config.management_port.bind) Management.app(ha, manager, bridge).listen(config.management_port.bind)

console.log(`Rethink cloud ${revision} ready`)
