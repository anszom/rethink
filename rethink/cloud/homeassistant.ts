import * as mqtt from 'mqtt'
import EventEmitter from 'node:events'
import { HAConfig } from '../util/clip.js'

// Notes on availability topic handling:
// 1. We want HA to be able to tell if a device is available.
// 2. When rethink stops, all devices should turn "offline"
// 3. But we can register only a single LWT topic at the MQTT broker
// 4. We define two availability topics. One per-device, the other - global
// 5. In a previous attempt, we had used availablility_mode: latest, and published all availability
// 	  messages with retain=off. This had one flaw: if HA was not already subscribed to the per-device
//    topic, it would miss the message and display the device as "offline" until it reconnected.
// 6. If we publish the per-device availability message with retain=true, then HA will received it
//    once it subscribes. It will also mean that these messages can survive from one `rethink` run
//	  to another. This would cause these "phatom" devices to appear "online" as soon as the new
//	  `rethink` instance starts.
// 7. To solve this, we subscribe to the availability topics and clean up all the retained "online"
// 	  messages on startup.

function recursiveReplace(obj: unknown, replacements: Record<string, string>) {
	if(Array.isArray(obj)) {
		return obj.map((v) => recursiveReplace(v, replacements))

	} else if(typeof(obj) === 'object') {
		const rv = {}
		for(let k in obj) {
			rv[k] = recursiveReplace(obj[k], replacements)
		}
		return rv

	} else if(typeof(obj) === 'string') {
		let str: string = obj
		for(let pattern in replacements) {
			str = str.replaceAll(pattern, replacements[pattern])
		}
		return str

	} else
		return obj
}

export class Connection extends EventEmitter {
	client: mqtt.MqttClient

	// record for which devices we have published the availability topic during this connection
	readonly publishedAvailability = new Set<string>();

	constructor(readonly config: HAConfig) {
		super()

		// mqtt module has builtin reconnection support
		this.client = mqtt.connect(this.config.mqtt_url, {
			will: {
				topic: config.rethink_prefix + '/availability',
				payload: Buffer.from('offline'),
				retain: true,
			},
			username: this.config.mqtt_user,
			password: this.config.mqtt_pass
		})
		this.client.on('connect', this.connected.bind(this))
		this.client.on('close', this.disconnected.bind(this))
		this.client.on('message', this.received.bind(this))
	}

	connected() {
		this.publishedAvailability.clear();
		console.log('HA mqtt connection established')
		// homeassistant/status
		this.client.subscribe(this.config.discovery_prefix + '/status')
		// rethink/ID/PROPERTY/set
		this.client.subscribe(this.config.rethink_prefix + '/+/+/set')

		this.client.subscribe(this.config.rethink_prefix + '/+/availability')
		this.client.publish(this.config.rethink_prefix + '/availability', Buffer.from('online'), { retain: true })

		this.emit('discovery')
	}

	disconnected() {
		console.log('HA mqtt connection lost')
	}

	received(topic: string, message: Buffer, packet) {
		try {
			if(topic === this.config.discovery_prefix + '/status' && message.toString('utf-8') === 'online') {
				console.log('HA online, starting discovery process')
				this.emit('discovery')
			}

			if(topic.startsWith(this.config.rethink_prefix + '/')) {
				const pathelements = topic.substring(this.config.rethink_prefix.length + 1).split('/')
				// rethink/+/+/set
				if(pathelements.length === 3 && pathelements[2] === 'set') {
					const [id, prop] = pathelements
					this.emit('setProperty', id, prop, message.toString('utf-8'))
				}

				// rethink/+/availability
				// only for retained deliveries. Packets delivered in real-time will not be caught by this
				if(pathelements.length === 2 && pathelements[1] === 'availability' && message.toString('utf-8') === 'online' && packet.retain) {
					// clear any retained availability topic, but only if we hadn't published a message on that topic yet
					if(!this.publishedAvailability.has(pathelements[0]))
						this.client.publish(topic, 'offline', { retain: true })
				}
			}

		} catch(err) {
			console.warn(`Error processing MQTT packet: ${err}`)
		}
	}

	publishConfig(id: string, haClass: string, config: Config) {
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

	publishProperty(id: string, property: string, value: string | number, options?: mqtt.IClientPublishOptions) {
		if(!options)
			options = {retain:true} // FIXME?

		if(typeof(value) === 'number')
			value = value.toString()

		const deviceTopic = `${this.config.rethink_prefix}/${id}`
		if(property === 'availability')
			this.publishedAvailability.add(id)

		this.client.publish(deviceTopic + '/' + property, value, options)
	}
}

export type DeviceInfo = {
	identifiers: string | string[];
	manufacturer?: string
	model?: string
	sw_version?: string
	name?: string
}

export type OriginInfo = {
	name: string,
	support_url?: string,
	sw_version?: string
}

export type AvailabilityInfo = {
	topic: string
}

export type ComponentInfo = {
	name?: string
	platform: string
	unique_id: string
}

export type DeviceDiscovery = {
	device: DeviceInfo,
	origin: OriginInfo,
	availability?: AvailabilityInfo[]
	components: Record<string, ComponentInfo>
}

export type ComponentDiscovery = {
	device: DeviceInfo,
	origin: OriginInfo,
	availability?: AvailabilityInfo[]
	name?: string
	unique_id: string
	object_id?: string
	optimistic?: boolean
}

export type Config = DeviceDiscovery | ComponentDiscovery