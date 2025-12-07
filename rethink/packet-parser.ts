import * as TLV from './util/tlv.js'
import crc16 from './util/crc16.js'
import { readFileSync } from 'node:fs'
import * as mqtt from 'mqtt'

if(process.argv.length === 4 && process.argv[2] === '-message') {
	const buf = Buffer.from(process.argv[3], 'hex')
	if(crc16(buf.subarray(2)) != 0)
		console.warn("CRC16 mismatch!")

	TLV.parse(buf.subarray(11, buf.length-2)).forEach((el) => {
		console.log('t=', el.t.toString(16), 'v=', el.v)
	})
	process.exit()
}

if(process.argv.length !== 3) {
	console.warn(
`Usage:
	tsx packet-parser.ts device-uuid
	tsx packet-parser.ts -message HEX-STRING
`)
	process.exit()
}

const deviceId = process.argv[2]

const config = JSON.parse(readFileSync('./config.json').toString('utf-8'))
const client = mqtt.connect("mqtt://" + config.hostname + ":" + config.mqtt_port)

client.on('connect', () => {
	var msgtopic
	var mid =10000
	client.on('message', (topic, message, packet) => {
		if(topic === 'clip/message/devices/' + deviceId) {
			const payload = JSON.parse(message.subarray(0, message.length-1).toString('utf-8'))
			if(payload.cmd === 'device_packet') {
				console.log(Date.now(), payload.data)
				const buf = Buffer.from(payload.data, 'hex')
				try {
					if(crc16(buf.subarray(2)) != 0)
						console.warn("CRC16 mismatch!")
					TLV.parse(buf.subarray(11, buf.length-2)).forEach((el) => {
						console.log('t=', el.t.toString(16), 'v=', el.v)
					})

				} catch(err) {
					console.log(err)
				}
			}
		}
	})

	client.subscribe('clip/message/devices/' + deviceId)
})
