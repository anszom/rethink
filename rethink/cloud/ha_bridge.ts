import { TLV } from '../util/tlv.js'
import { ClipDeployMessage } from '../util/types.js'
import RAC_056905_WW from './devices/RAC_056905_WW.js'
import WIN_056905_WW from "./devices/WIN_056905_WW.js"
import { type DeviceManager } from './devmgr.js'
import type HA_connection from './ha_connection.js'

const deviceTypes = { RAC_056905_WW, WIN_056905_WW }

class Bridge {
	clipDevices = new Map()
	constructor(readonly devmgr: DeviceManager, readonly HA: HA_connection) {
		devmgr.on('newDevice', this.newDevice.bind(this))
		HA.on('discovery', () => {
			this.clipDevices.forEach((clipdev, id) => {
				if(clipdev.ha)
					clipdev.ha.publishConfig()
			})
		})
		HA.on('setProperty', (id: string, prop: string, value: string) => {
			const clipdev = this.clipDevices.get(id)
			if(clipdev && clipdev.ha) {
				clipdev.ha.setProperty(prop, value)
			}
		})
	}

	newDevice(clipdev, provisionMsg: ClipDeployMessage) {
		const devclass = deviceTypes[provisionMsg.kind]
		if(!devclass) {
			console.warn(`Device type ${provisionMsg.kind} unknown`)
			return
		}

		const hadevice = new devclass(this.HA, clipdev, provisionMsg)
		clipdev.ha = hadevice
		this.clipDevices.set(clipdev.id, clipdev)

		clipdev.on('close', this.dropDevice.bind(this,clipdev))
		clipdev.on('data', (tlv: TLV[]) => hadevice.processTLV(tlv))

		hadevice.publishConfig()
		hadevice.query()
	}

	dropDevice(clipdev) {
		if(clipdev.ha) {
			clipdev.ha.drop()
		}
	}
}

export default Bridge
