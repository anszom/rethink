import WTDN3 from './devices/WTDN3'
import RAC_056905_WW from './devices/RAC_056905_WW'
import WIN_056905_WW from './devices/WIN_056905_WW'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2'
import Dev_2REB1GLVB1__2 from './devices/2REB1GLVB1__2'
import Dev_2RES1VE600FWC from './devices/2RES1VE600FWC'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK'
import F_V8_Y___W_B_2QEUK from './devices/F_V8_Y___W.B_2QEUK'
import { Device as T1Device } from './thinq1/device'
import { Device as T2Device } from './thinq2/device'
import { type Connection } from './homeassistant'
import HADevice from './devices/base'
import { type Metadata } from './thinq'
import { AnyDevice } from './devmgr'

type T1Factory = new (HA: Connection, thinq: T1Device, metadata: Metadata) => HADevice
type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t1deviceTypes: Record<string, T1Factory> = {
    WTDN3,
}

const t2deviceTypes: Record<string, T2Factory> = {
    RAC_056905_WW,
    WIN_056905_WW,
    ['2REF11EIDA__4']: Dev_2REF11EIDA__4,
    ['2RES1VE61NFA2']: Dev_2RES1VE61NFA2,
    ['2REB1GLVB1__2']: Dev_2REB1GLVB1__2,
    ['2RES1VE600FWC']: Dev_2RES1VE600FWC,
    ['Y_V8_Y___W.B32QEUK']: Y_V8_Y___W_B32QEUK,
    ['F_V8_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
    ['F_V__Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
}

class Bridge {
    haDevices = new Map<string, HADevice>()
    constructor(readonly HA: Connection) {
        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => ha.publishConfig())
        })
        HA.on('setProperty', (id: string, prop: string, value: string) => {
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })
    }

    newDevice(thinqdev: AnyDevice) {
        const meta = thinqdev.meta
        const oldDevice = this.haDevices.get(thinqdev.id)
        if (oldDevice) oldDevice.drop()

        let hadevice: HADevice | undefined

        if (thinqdev.platform === 'thinq1') {
            const devclass = t1deviceTypes[meta.modelId]
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        } else if (thinqdev.platform === 'thinq2') {
            const devclass = t2deviceTypes[meta.modelId]
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        }

        if (!hadevice) {
            console.warn(`${thinqdev.platform} device type ${meta.modelId} unknown`)
            return
        }

        this.haDevices.set(thinqdev.id, hadevice)
        thinqdev.on('close', () => this.dropDevice(hadevice))

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start()
    }

    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) === ha) {
            this.haDevices.delete(ha.id)
            ha.drop()
        }
    }
}

export default Bridge
