// This script connects to a rethink server instance (as a mqtt client) AND to
// the official LG ThinQ cloud (as a device). Messages are forwarded between
// the device and the cloud, allowing the official ThinQ app to control the
// device.
// A single instance of this script supports a single device.
// Runtime state is stored in .oauth.json and .bridge_${deviceId}.json

import * as fs from 'node:fs'
import readline from 'node:readline'
import * as OAuth2 from './oauth2.js'
import { Client, Device, Environment, signInUrl } from './thinq2api.js'
import * as mqtt from 'mqtt'

import { Connection } from './deviceConnection.js'

// login flow inspired by the 'wideq' project
async function oauth2SignIn(client: Client) {
	const base = await client.getUrls()
    console.log(`Use your browser to log in at ${signInUrl(base.webUrl, client.env.countryCode).toString()}`)
    
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    let code = ''

    while(1) {
        const outUrl = await new Promise((resolve) => 
			terminal.question('Paste the post-login URL here: ', resolve))

        try {
            const params = new URL(outUrl).searchParams
            code = params.get('code') ?? ''
            void params.get('user_number')
        } catch(err) {}

        if(code) 
            break;
        console.log(`This URL doesn't look right. It should contain a code= parameter.`)
    }
    terminal.close()
    
    console.log(`Found code: ${code}`)
	const tokens = await OAuth2.fromCode(base.authUrl, code)
	return tokens.refreshToken
}

async function run(rethinkMqtt: string, env: Environment, deviceType: string, modelName: string, deviceId: string) {
	console.log(`Connecting to ${rethinkMqtt}`)
	const client = await new Promise<mqtt.MqttClient>((resolve, reject) => {
		const client = mqtt.connect(rethinkMqtt)
		client.once('close', reject)
		client.once('error', reject)
		client.once('connect', () => resolve(client))
	})

	return start(client, env, deviceType, modelName, deviceId)
}

async function start(mqtt: mqtt.MqttClient, env: Environment, deviceType: string, modelName: string, deviceId: string) {
	const client = new Client(env)
	let device: Device
	const configFile = `.bridge_${deviceId}.json`

	try {
		const state = JSON.parse(fs.readFileSync(configFile).toString('utf-8'))
		device = new Device(env, deviceId, deviceType, modelName, state)

	} catch(e) {
		device = await register(client, deviceId, deviceType, modelName)
		fs.writeFileSync(configFile, Buffer.from(JSON.stringify(device.state)))
	}

	console.log('Starting bridging')
	await bridge(mqtt, device)
}
async function register(client: Client, deviceId: string, deviceType: string, modelName: string) {
	console.log('Trying to register device with ThinQ cloud')
	let refreshToken = ''
	try {
		({ refreshToken } = JSON.parse(fs.readFileSync('.oauth.json').toString('utf-8')))

	} catch(err) {
	}

	if(!refreshToken) {
		refreshToken = await oauth2SignIn(client)
		fs.writeFileSync('.oauth.json', JSON.stringify({refreshToken}))
	}

	await client.auth(refreshToken)

	console.log('Listing devices')
	console.log((await client.listDevices()).map(({deviceId}) => deviceId))
	
	console.log('Removing device from home')
	await client.removeDevice(deviceId)

	console.log('Fetching otp key')
	const otp = await client.prepareNewDevice()

	console.log('Registering new device')
	const device = new Device(client.env, deviceId, deviceType, modelName)
	const ciphertext = await device.pair(otp)

	console.log('Adding device to home')
	await client.addDevice(device, `Device ${deviceType}`, ciphertext)
	return device;
}

async function bridge(mqtt: mqtt.MqttClient, device: Device) {
	console.log('Starting simulated appliance')

	const con = new Connection(device)

	con.on('data', (data) => {
		mqtt.publish(`lime/devices/${device.deviceId}`, JSON.stringify({
			did: device.deviceId, mid: Date.now(), cmd: "packet", type: 1,
			data: data.toString('hex')
		}) + ' ')
    })

	function trimNull(buf: Buffer) {
		if(!buf.length || buf[buf.length-1])
			return buf
		return buf.subarray(0, buf.length-1)
	}

	const messageTopic = `clip/message/devices/${device.deviceId}`
	mqtt.on('message', (topic, message, packet) => {
		try {
			if(topic === messageTopic) {
				const payload = JSON.parse(trimNull(message).toString('utf-8'))
				if(payload.cmd === 'device_packet') 
					con.send(payload.data)
			}
		} catch(err) {
			console.log(err)
		}
	})

	await Promise.all([
		con.start(),
		mqtt.subscribe(messageTopic)
	])
}

{
	if(process.argv.length !== 7) {
			console.warn(
`Usage:
	tsx bridge.ts [rethinkMqtt] [countryCode] [deviceType] [modelName] [deviceId]

	rethinkMqtt - mqtt (unencrypted) url to a local rethink server
	countryCode - two-character country code identifier matching your ThinQ account
	deviceType  - device type identifiers...
	modelName   - ...these are sent by the device during provisioning
	
Example:
	tsx bridge.ts mqtt://rethink.lan:1884/ PL 401 RAC_056905_WW 68b5784e-3ae6-40ce-86d6-111fec8838e8
`)
		process.exit()
	}
	const [ rethinkMqtt, countryCode, deviceType, modelName, deviceId ] = process.argv.slice(2)

	const env = {
		countryCode
	}

	run(rethinkMqtt, env, deviceType, modelName, deviceId)
}