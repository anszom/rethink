import ACDevice, { type SwingAxis, SWING_SWEEP_ON_OFF } from './ac_common'

/**
 * LG Air Conditioner Model LW1823HRSM
 * ThinQ model WIN_056905_WW
 *
 * A window unit on the same DualCool TLV scheme, so the protocol handling comes from ac_common.
 *
 * NB: no capability or state capture from this model exists in the tree, so unlike the other
 * handlers the tables below could not be checked against a recording, and neither could the
 * capability bitmaps that now decide which optional entities appear. They are carried over
 * unchanged from the standalone handler this replaces. Note also that other hardware is known to
 * report the same ThinQ model id with a different feature set, which is the case the
 * capability-driven approach here is meant to cover but which nothing has yet confirmed it does.
 */
export default class Device extends ACDevice {
    /*
     * 0x1f9 = 8 was decoded as neither heat nor cool by the standalone handler, which carried a
     * commented-out guess of 'eco'; it is left unmapped until something confirms it. The handler
     * also had a dry -> 8 entry in the write direction only, which could never round-trip and is
     * dropped with it.
     */
    readonly modeTable = ['cool', undefined, 'fan_only', undefined, 'heat']
    readonly modeToWire = { cool: 0, fan_only: 2, heat: 4 }
    readonly haModes = ['off', 'cool', 'fan_only', 'heat']

    readonly fanTable = [undefined, undefined, 'low', undefined, undefined, undefined, 'high']
    readonly fanToWire = { low: 2, high: 6 }
    readonly haFanModes = ['low', 'high']

    /*
     * The standalone handler tried to force the power state alongside every mode write, but
     * addressed the field as 'power' where it is registered as 'climate-power', so the call only
     * ever logged a warning and the unit was never powered on by selecting a mode. Stating the
     * intent properly is what powerOnWithModeWrite does.
     */
    readonly powerOnWithModeWrite = true

    /* The old handler hardcoded 16 - 30 C; ac_common reads 0x2e1 / 0x2e2 when the unit sends them */
    temperatureRange() {
        return super.temperatureRange() ?? { min: 16, max: 30 }
    }

    /* One vane, on/off on the horizontal positional tag, as the standalone handler had it */
    swingAxes(): SwingAxis[] {
        return [{ tag: 0x322, name: 'swing_mode', levels: SWING_SWEEP_ON_OFF, attach: [0x1f9, 0x1fa] }]
    }
}
