const TLV = require('./util/tlv.js')
const crc16 = require('./util/crc16.js')

if(process.argv.length === 4 && process.argv[2] === '-message') {
	const buf = Buffer.from(process.argv[3], 'hex')
	if(crc16(buf.subarray(2)) != 0)
		console.warn("CRC16 mismatch!")

	TLV.parse(buf.subarray(11, buf.length-2)).forEach((el) => {
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
