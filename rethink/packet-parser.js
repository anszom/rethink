const TLV = require('./tlv.js')

if(process.argv.length === 4 && process.argv[2] === '-message') {
	const buf = Buffer.from(process.argv[3], 'hex')
	TLV.parse(buf.subarray(11)).forEach((el) => {
		console.log('t=', el.t.toString(16), 'v=', el.v)
	})
	return
}

if(process.argv.length !== 3) {
	console.warn(
`Usage:
	node packet-parser.js device-uuid
	node packet-parser.js -message HEX-STRING
`)
	return
}

const deviceId = process.argv[2]

const fs=require('fs')
const mqtt=require('mqtt')
const config = JSON.parse(fs.readFileSync('./config.json'))
const client = mqtt.connect("mqtt://" + config.hostname + ":" + config.mqtt_port)

client.on('connect', () => {
	var msgtopic
	var mid =10000
	client.on('message', (topic, message, packet) => {
		if(topic === 'clip/message/devices/' + deviceId) {
			const payload = JSON.parse(message.subarray(0, message.length-1))
			if(payload.cmd === 'device_packet') {
				console.log(Date.now(), payload.data)
				const buf = Buffer.from(payload.data, 'hex')
				TLV.parse(buf.subarray(11)).forEach((el) => {
					console.log('t=', el.t.toString(16), 'v=', el.v)
				})
			}
		}
	})

	client.subscribe('clip/message/devices/' + deviceId)
})
