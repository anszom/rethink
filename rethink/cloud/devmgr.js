// This class handles the devices connecting to the internal MQTT broker. This includes both device provisioning
// and actual data exchange (including TLV parsing/building)

const TLV = require('../util/tlv.js')
const crc16 = require('../util/crc16.js')
const Provisioning = require('./provisioning.js')
const EventEmitter = require('events')

class Device extends EventEmitter {
	// this could be a stream but why bother...
	constructor(broker, topic, id) {
		super()
		this.id = id
		this.broker = broker
		this.topic = topic
	}

	send(header, tlv) {
		const [b0, b1, b2, b3, b4] = header
		let tlvArray = TLV.build(tlv)
		let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
		let result = crc16(buf)
		buf = [ b0, b1 ].concat(buf, [ result >> 8, result & 0xff])
		const messagestr = JSON.stringify({"did": this.id,"mid":Date.now(),"cmd":"packet","type":1,"data":Buffer.from(buf).toString("hex")})
		
		this.broker.publish({topic: this.topic, retain: false, qos: 0, dup: false, payload: messagestr})
	}
}

class DeviceManager extends EventEmitter {
	constructor(broker) {
		super()
		this.broker = broker
		this.clientsById = {}

		broker.on('publish', function(packet, client) {
			console.log(packet.topic, packet.payload.toString('utf-8'))

			try {
				function trimNull(buf) {
					if(!buf || !buf.length || buf[buf.length-1])
						return buf
					return buf.subarray(0, buf.length-1)
				}

				if(packet.topic.startsWith('clip/')) {
					const payload = JSON.parse(trimNull(packet.payload))
					this.mqtt(packet.topic, payload, client)
				}
			} catch(err) {
				console.log(err)
				console.log(packet.payload.toString('hex'))
			}
		}.bind(this))
					
		broker.on('disconnect', this.disconnected.bind(this))
	}

	mqtt(topic, payload, client) {
		if(topic === 'clip/message/devices/' + payload.did) {
			if(payload.cmd === 'completeProvisioning_ack') {
				this.completeProvisioning(payload.did, payload, client)
			}

			if(payload.cmd === 'device_packet' && client.deviceObj && payload.did === client.deviceObj.id) {
				const buf = Buffer.from(payload.data, 'hex')
				if(buf[2] == 0x04 && buf[3] == 0x00 && buf[4] == 0x00 && buf[5] == 0x00 && buf[6] == 0x87 && buf[7] == 0x02 && buf[8] == 0x04
					/* && buf[9] is a "sequence" number */ && buf[10] == buf.length-13) {

					// ignore the CRC, we assume that the modem verifies it :/
					const tlv = TLV.parse(buf.subarray(11, buf.length-2))
					client.deviceObj.emit('data', tlv)
				}
			}
		}
	
		if(topic === 'clip/provisioning/devices/' + payload.did) {
			if(payload.cmd === 'preDeploy' || payload.cmd === 'deploy') {
				client.deployMsg = payload
				this.broker.publish({
						topic: 'lime/devices/' + payload.did,
						retain: false,
						qos: 0,
						dup: false,
						payload: JSON.stringify(Provisioning.generateDeployResponse(payload))})
			}
		}
	}

	completeProvisioning(deviceId, payload, client) {
		if(!client.deployMsg) {
			console.warn("completeProvisioning_ack received without deploy/preDeploy")
			return
		}

		if(client.deviceObj) {
			console.warn("completeProvisioning_ack received twice?")
			return
		}
		
		if(this.clientsById[deviceId]) {
			console.warn(`device ${deviceId} already connected, dropping the old one`)
			this.clientsById[deviceId].destroy()
		}

		this.clientsById[deviceId] = client
		
		const dev = new Device(this.broker, 'lime/devices/' + deviceId, deviceId)
		client.deviceObj = dev
		this.emit('newDevice', dev, client.deployMsg)
	}

	disconnected(client) {
		if(client.deviceObj) {
			delete this.clientsById[client.deviceObj.id]
			client.deviceObj.emit('close')
			client.deviceObj = null
		}
	}
}

module.exports = DeviceManager
