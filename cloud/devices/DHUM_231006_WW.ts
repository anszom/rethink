import DhumDevice, { defineDhumProfile } from './dhum_common'
import type * as TLV from '@/util/tlv'

/**
 * LG Dehumidifier DHUM_231006_WW (deviceType 403, BEKEN_BK7234, protocolVer 7).
 *
 * A captured values packet reports modes 19/20/85/86 and fan-memory rows using
 * 2/7/8. Captured cloud writes additionally confirm fan 6. LG's model metadata
 * defines code 4 as the remaining medium fan level.
 */
export default class Device extends DhumDevice {
    static profile = defineDhumProfile({
        modes: [
            [86, 'Smart Plus'],
            [19, 'Silent'],
            [20, 'Intensive'],
            [85, 'Quick'],
        ],
        fans: [
            [8, 'auto'],
            [2, 'low'],
            [4, 'medium'],
            [6, 'high'],
            [7, 'turbo'],
        ],
        lowFanClip: 2,
        combinedInitialResponse: true,
        features: {
            ionizer: true,
            uvNano: true,
            bucketLight: true,
            offTimer: true,
        },
    })

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /*
         * Unlike 056905, this model's captured initial response has no 0x2da
         * marker. It combines current values with the repeated 0x2d7/0x2d8/
         * 0x2d9 mode/fan capability rows, so recognize that observed shape.
         */
        const tags = new Set(tlvArray.map(({ t }) => t))
        return (
            (tags.has(0x1f7) &&
                tags.has(0x1f9) &&
                tags.has(0x1fa) &&
                tags.has(0x2d7) &&
                tags.has(0x2d8) &&
                tags.has(0x2d9)) ||
            super.isCapsResponse(tlvArray)
        )
    }
}
