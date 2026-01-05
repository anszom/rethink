import { TLV } from '../util/tlv.js'
import { ClipDeployMessage } from '../util/clip.js'
import RAC_056905_WW from './devices/RAC_056905_WW.js'
import WIN_056905_WW from './devices/WIN_056905_WW.js'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4.js'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2.js'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK.js'
import { Device, type DeviceManager } from './devmgr.js'
import { type Connection } from './homeassistant.js'
import HADevice from './devices/base.js'

const deviceTypes = {
	RAC_056905_WW,
	WIN_056905_WW,
	["2REF11EIDA__4"]: Dev_2REF11EIDA__4,
	["2RES1VE61NFA2"]: Dev_2RES1VE61NFA2,
	["Y_V8_Y___W.B32QEUK"]: Y_V8_Y___W_B32QEUK
}

type DeviceWithExtra = Device & {
	ha?: HADevice
}

class Bridge {
	clipDevices = new Map<string, DeviceWithExtra>()
	constructor(readonly devmgr: DeviceManager, readonly HA: Connection) {
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

	newDevice(_clipdev: Device, provisionMsg: ClipDeployMessage) {
		const clipdev = _clipdev as DeviceWithExtra
		const devclass = deviceTypes[provisionMsg.kind]
		if(!devclass) {
			console.warn(`Device type ${provisionMsg.kind} unknown`)
			return
		}

		const hadevice = new devclass(this.HA, clipdev, provisionMsg) as HADevice
		clipdev.ha = hadevice
		this.clipDevices.set(clipdev.id, clipdev)

		clipdev.on('close', this.dropDevice.bind(this,clipdev))
		clipdev.on('data', (data: Buffer) => hadevice.processData(data))

		// hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
		hadevice.query()
	}

	dropDevice(clipdev) {
		if(clipdev.ha) {
			clipdev.ha.drop()
		}
	}
}

export default Bridge
