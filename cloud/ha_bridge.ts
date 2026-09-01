import POT_056905_WW from './devices/POT_056905_WW'
import WTDN3 from './devices/WTDN3'
import RAC_056905_WW from './devices/RAC_056905_WW'
import WIN_056905_WW from './devices/WIN_056905_WW'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4'
import Dev_2REF11EBIVPC4 from './devices/2REF11EBIVPC4'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2'
import Dev_2REB1GLVB1__2 from './devices/2REB1GLVB1__2'
import Dev_2RES1VE600FWC from './devices/2RES1VE600FWC'
import Dev_STUDIO_HOOD from './devices/STUDIO_HOOD'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK'
import F_V8_Y___W_B_2QEUK from './devices/F_V8_Y___W.B_2QEUK'
import Y_V8_F___W_B_2QEUK from './devices/Y_V8_F___W.B_2QEUK'
import F_V__F___W_B_1QEUK from './devices/F_V__F___W.B_1QEUK'
import F_VB_F___W_B_2QEUK from './devices/F_VB_F___W.B_2QEUK'
import VCDWL2QEUK from './devices/VCDWL2QEUK'
import T1789EFH_F from './devices/T1789EFH_F'
import RV13U6AM8W_D_US_WIFI from './devices/RV13U6AM8W_D_US_WIFI'
import F3L2CYU__ from './devices/F3L2CYU__'
import F3L7CYK5W_US_WIFI from './devices/F3L7CYK5W_US_WIFI'
import RV13B6BSD_D_US_WIFI from './devices/RV13B6BSD_D_US_WIFI'
import RV13B6ES_D_US_WIFI from './devices/RV13B6ES_D_US_WIFI'
import WTL_FXU_BDV_NA_01 from './devices/WTL_FXU_BDV_NA_01'
import DHUM_056905_WW from './devices/DHUM_056905_WW'
import DHUM_231006_WW from './devices/DHUM_231006_WW'
import ST_B_E4H01Y_APL from './devices/ST_B_E4H01Y_APL'
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
    POT_056905_WW,
    RAC_056905_WW,
    ['RAC_0B0001_WW']: RAC_056905_WW, // a different European variant (deviceType 401, RTK_RTL8720cm), same TLV handler
    WIN_056905_WW,
    ['2REF11EIDA__4']: Dev_2REF11EIDA__4,
    ['2REF11EBIVPC4']: Dev_2REF11EBIVPC4,
    ['2RES1VE61NFA2']: Dev_2RES1VE61NFA2,
    ['2REB1GLVB1__2']: Dev_2REB1GLVB1__2,
    ['2RES1VE600FWC']: Dev_2RES1VE600FWC,
    ['STUDIO_HOOD']: Dev_STUDIO_HOOD,
    ['Y_V8_Y___W.B32QEUK']: Y_V8_Y___W_B32QEUK,
    ['F_V7_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['F_V8_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
    ['Y_V8_F___W.B_2QEUK']: Y_V8_F___W_B_2QEUK,
    ['F_V__Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['VCDWL2QEUK']: VCDWL2QEUK, // LG F4X7511TWS front-load washer (matched on modelId VCDWL2QEUK)
    ['F_V__F___W.B_1QEUK']: F_V__F___W_B_1QEUK,
    // FV1413H2BA front-load washer SoftAP model F_VA_F___W.B__QEUK (deviceType 201)
    ['F_VA_F___W.B__QEUK']: F_V__F___W_B_1QEUK,
    ['F_VB_F___W.B_2QEUK']: F_VB_F___W_B_2QEUK, // LG CV74J7S2QA washer/dryer combo
    ['T1789EFH_F']: T1789EFH_F, // LG WT7300CW top-loading washer
    ['RV13U6AM8W_D_US_WIFI']: RV13U6AM8W_D_US_WIFI, // LG DLE7300WE dryer
    ['F3L2CYU__']: F3L2CYU__, // LG front-load washer
    ['F3L7CYK5W_US_WIFI']: F3L7CYK5W_US_WIFI, // LG front-load washer, same record layout as F3L2CYU__ but
    // a different course table and two extra option bits, so it needs its own handler rather than an alias
    ['RV13B6BSD_D_US_WIFI']: RV13B6BSD_D_US_WIFI, // LG electric dryer
    ['RV13B6ES_D_US_WIFI']: RV13B6ES_D_US_WIFI, // LG electric dryer, same frame layout as RV13B6BSD but
    // Wrinkle Care sits in a different bitfield, so it needs its own handler rather than an alias
    WTL_FXU_BDV_NA_01, // LG WashTower
    DHUM_056905_WW,
    DHUM_231006_WW, // same TLV map as the 056905, different mode and fan enums
    ST_B_E4H01Y_APL,
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
