import RAC_056905_WW from './RAC_056905_WW'
import { Enum } from '@/util/enum'

const FAN_MODES = Enum.of({
    low: 2,
    medium: 4,
    high: 6,
})

/**
 * LG ducted air conditioner using the PWFMDD200 / LCW-005 Wi-Fi module.
 * ThinQ model DUCT_626301_WW.
 */
export default class Device extends RAC_056905_WW {
    protected getFanModes() {
        return FAN_MODES
    }

    protected modeWritePowersOn(): boolean {
        return true
    }
}
