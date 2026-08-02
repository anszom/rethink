import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import WashTowerDevice, { WASHER_MODEL } from './washtower_common'

/** LG WashTower lower washer, ThinQ deviceType 221. */
export default class FAKPK21021 extends WashTowerDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, WASHER_MODEL)
    }
}
