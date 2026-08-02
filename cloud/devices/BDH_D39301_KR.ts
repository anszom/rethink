import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import WashTowerDevice, { DRYER_MODEL } from './washtower_common'

/** LG WashTower upper dryer, ThinQ deviceType 222. */
export default class BDH_D39301_KR extends WashTowerDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, DRYER_MODEL)
    }
}
