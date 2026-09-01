import DhumDevice, { defineDhumProfile } from './dhum_common'
import * as TLV from '@/util/tlv'

/** LG Dehumidifier DHUM_056905_WW (deviceType 403). */
export default class Device extends DhumDevice {
    static profile = defineDhumProfile({
        modes: [
            [0, 'Smart'],
            [1, 'Jet'],
            [2, 'Silent'],
            [4, 'Spot'],
            [5, 'Laundry'],
            [17, 'Smart'],
            [18, 'Jet'],
            [19, 'Silent'],
            [20, 'Spot'],
            [21, 'Laundry'],
        ],
        fans: [
            [2, 'low'],
            [6, 'high'],
        ],
        silentModes: [2, 19],
        lowFanClip: 2,
        features: {
            ionizer: true,
            uvNano: true,
            bucketLight: true,
            bucketFull: true,
            offTimer: true,
        },
    })

    /**
     * This model writes its fan setpoint together with the captured per-mode table.
     * Laundry is fixed high; mode 22 is present on-wire but is not exposed in HA.
     */
    protected sendFanSpeedTlvs(fan: number): boolean {
        const row = (mode: number, fanSpeed: number): TLV.TLV[] => [
            { t: 0x2d7, v: mode },
            { t: 0x2d8, v: 0 },
            { t: 0x2d9, v: fanSpeed },
        ]
        const tlvs: TLV.TLV[] = [
            { t: 0x1fa, v: fan },
            ...row(17, fan),
            ...row(18, fan),
            ...row(20, fan),
            ...row(21, 6),
            ...row(22, fan),
        ]

        this.raw_clip_state[0x1fa] = fan
        this.send([1, 1, 2, 1, 1], tlvs)
        return false
    }
}
