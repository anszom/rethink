import * as mqtt from 'mqtt'
import EventEmitter from 'node:events'
import { HAConfig } from '../util/clip.js'

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

	constructor(readonly config: HAConfig) {
		super()

		// mqtt module has builtin reconnection support
		this.client = mqtt.connect(this.config.mqtt_url, {
			will: {
				topic: config.rethink_prefix + '/availability',
				payload: Buffer.from('offline'),
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

	received(topic: string, message: Buffer) {
		try {
			if(topic === this.config.discovery_prefix + '/status' && message.toString('utf-8') === 'online') {
				console.log('HA online, starting discovery process')
				this.emit('discovery')
			}

			if(topic.startsWith(this.config.rethink_prefix + '/')) {
				const pathelements = topic.substring(this.config.rethink_prefix.length + 1).split('/')
				if(pathelements.length === 3 && pathelements[2] === 'set') {
					const [id, prop] = pathelements
					this.emit('setProperty', id, prop, message.toString('utf-8'))
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