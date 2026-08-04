import ACDevice, { type WireLevels } from './ac_common'

/*
 * LG DualCool residential air conditioners (deviceType 401), the model this handler was
 * developed against being RAC_056905_WW. The protocol handling lives in ac_common; below are
 * the properties of these units: the 0x1f9 / 0x1fa scales, the setpoint range, how their power
 * reading has to be corrected, and the fact that they carry a basic-filter counter.
 */
export default class Device extends ACDevice {
    /* TODO: get allowed op modes from 0x2c1 */
    readonly modeLevels: WireLevels = [
        ['cool', 0],
        ['dry', 1],
        ['fan_only', 2],
        ['heat', 4],
        ['auto', 6],
    ]

    /* TODO: get from 0x2c2 */
    readonly fanLevels: WireLevels = [
        ['auto', 8],
        ['very low', 2],
        ['low', 3],
        ['medium', 4],
        ['high', 5],
        ['very high', 6],
    ]

    /* Air purify and energy saving do not read back reliably here */
    readonly modeDependentSwitchOptimistic = true

    /* TODO: some devices report the temp ranges via tags 0x2e1 - 0x2ec */
    temperatureRange() {
        return { min: 18, max: 30 }
    }

    /* Basic filter management, unless the unit reports the unsupported mFilter one */
    filterStyle() {
        return !(this.raw_clip_state[0x2f1] & 1 || this.raw_clip_state[0x2f1] & 0x200)
            ? ('priv' as const)
            : ('none' as const)
    }

    /* This value is reported as zero by multi-split units */
    hasPowerSensor() {
        return !!this.raw_clip_state[0x2b3]
    }

    /*
     * The measurements reported by AC appear to be Watts, but they are not accurate in several aspects:
     * - the value is biased by +50
     * - idle consumption (around 4W) and the 4-way valve is not included
     * - fan modes' consumption appears to be approximated
     *
     * The formula below is expected to be within +/-10% of the actual power consumption. The discrepancy may
     * be highest in fan-only modes.
     */
    powerReadXform(raw: number) {
        return Math.max(5, raw - 60)
    }
}
