const mqtt=require('mqtt')
const EventEmitter = require('events')

function recursiveReplace(obj, replacements) {
	if(Array.isArray(obj)) {
		return obj.map((v) => recursiveReplace(v, replacements))

	} else if(typeof(obj) === 'object') {
		const rv = {}
		for(let k in obj) {
			rv[k] = recursiveReplace(obj[k], replacements)
		}
		return rv

	} else if(typeof(obj) === 'string') {
		for(let pattern in replacements) {
			obj = obj.replaceAll(pattern, replacements[pattern])
		}
		return obj

	} else
		return obj
}

class HA extends EventEmitter {
	constructor(config) {
		super()
		this.config = config

		// mqtt module has builtin reconnection support
		this.client = mqtt.connect(this.config.mqtt_url, {
			will: {
				topic: config.rethink_prefix + '/availability',
				payload: 'offline',
			},
			username: this.config.mqtt_user,
			password: this.config.mqtt_pass
		})
		this.client.on('connect', this.connected.bind(this))
		this.client.on('close', this.disconnected.bind(this))
		this.client.on('message', this.received.bind(this))
	}

	connected() {
		console.log('HA mqtt connection established')
		// homeassistant/status
		this.client.subscribe(this.config.discovery_prefix + '/status')
		// rethink/ID/PROPERTY/set
		this.client.subscribe(this.config.rethink_prefix + '/+/+/set')
	}

	disconnected() {
		console.log('HA mqtt connection lost')
	}

	received(topic, message) {
		try {
			if(topic === this.config.discovery_prefix + '/status' && message.toString('utf-8') === 'online') {
				console.log('HA online, starting discovery process')
				this.emit('discovery')
			}

			if(topic.startsWith(this.config.rethink_prefix + '/')) {
				const pathelements = topic.substr(this.config.rethink_prefix.length+1).split('/')
				if(pathelements.length === 3 && pathelements[2] === 'set') {
					const [id, prop] = pathelements
					this.emit('setProperty', id, prop, message.toString('utf-8'))
				}
			}

		} catch(err) {
			console.warn(`Error processing MQTT packet: ${err}`)
		}
	}

	publishConfig(id, haClass, config) {
		const discoveryTopic = `${this.config.discovery_prefix}/${haClass}/rethink/${id}`
		const deviceTopic = `${this.config.rethink_prefix}/${id}`
		const replacements = {
			'$this': deviceTopic,
			'$rethink': this.config.rethink_prefix,
			'$deviceid': id
		}
		const configPayload = JSON.stringify(recursiveReplace(config, replacements))
		this.client.publish(discoveryTopic + '/config' , configPayload)
	}

	publishProperty(id, property, value, options) {
		if(!options)
			options = {retain:true} // FIXME?

		if(typeof(value) === 'number')
			value = value.toString()

		const deviceTopic = `${this.config.rethink_prefix}/${id}`
		this.client.publish(deviceTopic + '/' + property, value, options)
	}
}

module.exports = HA
