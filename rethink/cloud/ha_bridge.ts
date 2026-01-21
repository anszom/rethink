import WTDN3 from './devices/WTDN3.js'
import RAC_056905_WW from './devices/RAC_056905_WW.js'
import WIN_056905_WW from './devices/WIN_056905_WW.js'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4.js'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2.js'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK.js'
import { Device as T1Device } from './thinq1/devmgr.js'
import { Device as T2Device } from './thinq2/devmgr.js'
import { type Connection } from './homeassistant.js'
import HADevice from './devices/base.js'
import { type Metadata } from './thinq.js'

type T1Factory = new (HA: Connection, thinq: T1Device, metadata: Metadata) => HADevice
type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t1deviceTypes: Record<string, T1Factory> = {
	WTDN3,
}

const t2deviceTypes: Record<string, T2Factory> = {
	RAC_056905_WW,
	WIN_056905_WW,
	["2REF11EIDA__4"]: Dev_2REF11EIDA__4,
	["2RES1VE61NFA2"]: Dev_2RES1VE61NFA2,
	["Y_V8_Y___W.B32QEUK"]: Y_V8_Y___W_B32QEUK
}

class Bridge {
	haDevices = new Map<string, HADevice>()
	constructor(readonly HA: Connection) {
		HA.on('discovery', () => {
			this.haDevices.forEach((ha) => ha.publishConfig())
		})
		HA.on('setProperty', (id: string, prop: string, value: string) => {
			const ha = this.haDevices.get(id)
			if(ha)
				ha.setProperty(prop, value)
		})
	}

	newT1Device(thinqdev: T1Device, meta: Metadata) {
		const devclass = t1deviceTypes[meta.modelId]
		if(!devclass) {
			console.warn(`Thinq1 device type ${meta.modelId} unknown`)
			return
		}

		const oldDevice = this.haDevices.get(thinqdev.id)
		if(oldDevice)
			oldDevice.drop()

		const hadevice = new devclass(this.HA, thinqdev, meta)
		this.haDevices.set(thinqdev.id, hadevice)

		thinqdev.on('close', () => this.dropDevice(hadevice))

		// hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
		hadevice.start()
	}

	newT2Device(thinqdev: T2Device, meta: Metadata) {
		const devclass = t2deviceTypes[meta.modelId]
		if(!devclass) {
			console.warn(`Thinq2 device type ${meta.modelId} unknown`)
			return
		}

		const oldDevice = this.haDevices.get(thinqdev.id)
		if(oldDevice)
			oldDevice.drop()

		const hadevice = new devclass(this.HA, thinqdev, meta)
		this.haDevices.set(thinqdev.id, hadevice)

		thinqdev.on('close', () => this.dropDevice(hadevice))

		// hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
		hadevice.start()
	}

	dropDevice(ha: HADevice) {
		if(this.haDevices.get(ha.id) === ha)
			this.haDevices.delete(ha.id)

		ha.drop()
	}
}

export default Bridge
