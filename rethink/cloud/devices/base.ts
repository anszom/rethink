import { TLV } from "../../util/tlv.js";
import { ClipDeployMessage } from "../../util/clip.js"
import { Device as ClipDevice } from "../devmgr.js"
import type { Connection, Config, DeviceDiscovery, ComponentDiscovery } from '../homeassistant.js'

export default class HADevice {
	readonly id: string
	config: Config|undefined

	static defaultConfig(provisionMsg: ClipDeployMessage, deviceInfo?: object) {
		return {
			availability: [ { topic: '$this/availability' }, { topic: '$rethink/availability' } ],
			device: {
				identifiers: '$deviceid',
				manufacturer: 'LG',
				model: provisionMsg.data?.appInfo?.modelName,
				sw_version: provisionMsg.data?.appInfo?.softVer,
				... (deviceInfo || {})
			},
			origin: {
				name: 'rethink',
				support_url: 'https://github.com/anszom/rethink'
			}
		}
	}

	static componentConfig(provisionMsg: ClipDeployMessage, deviceInfo?: object): ComponentDiscovery {
		return {
			...this.defaultConfig(provisionMsg, deviceInfo),
			name: (deviceInfo as any)?.name,
			unique_id: '$deviceid',
			object_id: '$deviceid',
			optimistic: false,
		}
	}

	static deviceConfig(provisionMsg: ClipDeployMessage, deviceInfo?: object): DeviceDiscovery {
		return {
			...this.defaultConfig(provisionMsg, deviceInfo),
			components: {}
		}
	}

	constructor(readonly HA: Connection, readonly ha_class, readonly clip: ClipDevice) {
		this.id = clip.id
	}

	setConfig(config: Config) {
		this.config = config
		this.publishConfig()
	}

	drop() {
		this.HA.publishProperty(this.id, 'availability', 'offline', {retain: false})
	}

	// clip-side
	query() {
		throw new Error("To be overriden");
	}

	processData(data: Buffer) {
		throw new Error("To be overriden");
	}
	
	// HA-side
	publishConfig() {
		if(this.config) {
			this.HA.publishConfig(this.id, this.ha_class, this.config)
			this.HA.publishProperty(this.id, 'availability', 'online', {retain: false})
		}
	}

	setProperty(prop: string, mqttValue: string) {
		throw new Error("To be overriden");
	}
}
