import ACDevice, { type SwingAxis, SWING_SWEEP_ON_OFF } from './ac_common'

/**
 * LG Portable Air Conditioner Model LP1022FVSM
 * ThinQ model POT_056905_WW
 *
 * A portable unit speaking the same DualCool TLV scheme as the wall units, so the protocol
 * handling comes from ac_common. What is below is what this unit reports differently.
 *
 * Its capability response covers most of what the old standalone handler used to hardcode:
 * 0x2c1 = 7 (modes cool/dry/fan_only), 0x2c2 = 0x54 (fan wire values 2/4/6) and 0x2e1 / 0x2e2 =
 * 32 / 60 (16 - 30 C) all agree with the tables that were written out by hand here.
 */
export default class Device extends ACDevice {
    readonly haDeviceName = 'LG Portable AC'

    /* This unit sends its TLV frames with the header byte 6 of 0xa7 */
    isHeaderByte6(byte: number): boolean {
        return byte === 0x87 || byte === 0xa7
    }

    /* Cooling only - no heat, and 0x2c1 = 7 agrees */
    readonly modeTable = ['cool', 'dry', 'fan_only']
    readonly modeToWire = { cool: 0, dry: 1, fan_only: 2 }
    readonly haModes = ['off', 'cool', 'dry', 'fan_only']

    /* Three fan steps, no auto - 0x2c2 = 0x54 sets exactly bits 2, 4 and 6 */
    readonly fanTable = [undefined, undefined, 'low', undefined, 'medium', undefined, 'high']
    readonly fanToWire = { low: 2, medium: 4, high: 6 }
    readonly haFanModes = ['low', 'medium', 'high']

    /* The panel steps in whole degrees */
    readonly tempStep = 1

    /* Setting a mode while off is what the app uses to turn the unit on */
    readonly powerOnWithModeWrite = true

    /*
     * One vane, driven on / off on a positional tag. 0x2cd = 16 leaves all four jet and
     * positional-swing bits clear, so the bitmap does not describe this swing and the default
     * derivation would drop the control entirely.
     *
     * The tag is kept at 0x322, which is what this handler has always written. Note that the
     * captured values response carries 0x321, not 0x322, so the state is never read back - see
     * the note in the model's test. Which of the two the unit actually acts on needs checking
     * against hardware before this is changed.
     */
    swingAxes(): SwingAxis[] {
        return [{ tag: 0x322, name: 'swing_mode', levels: SWING_SWEEP_ON_OFF, attach: [0x1f9, 0x1fa] }]
    }
}
