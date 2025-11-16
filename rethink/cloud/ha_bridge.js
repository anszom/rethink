const deviceTypes = {}
deviceTypes['RAC_056905_WW'] = require('./devices/RAC_056905_WW.js')
deviceTypes["WIN_056905_WW"] = require("./devices/WIN_056905_WW.js");
deviceTypes["2RES1VE61NFA2"] = require("./devices/2RES1VE61NFA2.js");

class Bridge {
	constructor(devmgr, HA) {
		this.devmgr = devmgr
		this.HA = HA
		this.clipDevices = new Map()

		devmgr.on('newDevice', this.newDevice.bind(this))
		HA.on('discovery', () => {
			this.clipDevices.forEach((clipdev, id) => {
				if(clipdev.ha)
					clipdev.ha.publishConfig()
			})
		})
		HA.on('setProperty', (id, prop, value) => {
			const clipdev = this.clipDevices.get(id)
			if(clipdev && clipdev.ha) {
				clipdev.ha.setProperty(prop, value)
			}
		})
	}

	newDevice(clipdev, provisionMsg) {
		const devclass = deviceTypes[provisionMsg.kind]
		if(!devclass) {
			console.warn(`Device type ${provisionMsg.kind} unknown`)
			return
		}

		const hadevice = new devclass(this.HA, clipdev, provisionMsg)
		clipdev.ha = hadevice
		this.clipDevices.set(clipdev.id, clipdev)

		clipdev.on('close', this.dropDevice.bind(this,clipdev))
		clipdev.on('data', (tlv) => hadevice.processTLV(tlv))

		hadevice.publishConfig()
		hadevice.query()
	}

	dropDevice(clipdev) {
		if(clipdev.ha) {
			clipdev.ha.drop()
		}
	}
}

module.exports = Bridge
