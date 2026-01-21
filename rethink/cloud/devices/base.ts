import { TLV } from "../../util/tlv.js";
import { type Metadata } from "../thinq.js"
import type { Connection, Config, DeviceDiscovery, ComponentDiscovery } from '../homeassistant.js'

export default class HADevice {
	config: Config|undefined

	static defaultConfig(meta: Metadata, deviceInfo?: object) {
		return {
			availability: [ { topic: '$this/availability' }, { topic: '$rethink/availability' } ],
			availability_mode: 'all',
			device: {
				identifiers: '$deviceid',
				manufacturer: 'LG',
				model: meta.modelName,
				sw_version: meta.swVersion,
				... (deviceInfo || {})
			},
			origin: {
				name: 'rethink',
				support_url: 'https://github.com/anszom/rethink'
			}
		}
	}

	static componentConfig(meta: Metadata, deviceInfo?: object): ComponentDiscovery {
		return {
			...this.defaultConfig(meta, deviceInfo),
			name: (deviceInfo as any)?.name,
			unique_id: '$deviceid',
			object_id: '$deviceid',
			optimistic: false,
		}
	}

	static deviceConfig(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
		return {
			...this.defaultConfig(meta, deviceInfo),
			components: {}
		}
	}

	constructor(readonly HA: Connection, readonly ha_class, readonly id: string) {
	}

	setConfig(config: Config) {
		this.config = config
		this.publishConfig()
	}

	drop() {
		this.HA.publishProperty(this.id, 'availability', 'offline')
	}

	start() {}

	// HA-side
	publishConfig() {
		if(this.config) {
			this.HA.publishProperty(this.id, 'availability', 'online')
			this.HA.publishConfig(this.id, this.ha_class, this.config)
		}
	}

	setProperty(prop: string, mqttValue: string) {
		throw new Error("To be overriden");
	}
}
