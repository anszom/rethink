import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import WMVEL2137 from './WMVEL2137'

// LG over-the-range microwave/hood, matched on modelId "WMVEF1337F" (thinq2 deviceType 302,
// RTK_RTL8720cm modem, clip_ble_v2.9.242, protocolVer 4.9, softVer 20240722).
//
// It speaks WMVEL2137's protocol, verified live against a real unit with rethink and no LG cloud:
//   - the same F0 ED status query, answered with a 41 EB record;
//   - the same F0 43 22 04 vent/lamp command, acknowledged with AA084100430063BB exactly as the
//     MVEL2033F does, each followed by a 41 EC report of the new state;
//   - the same field offsets, including the 0x53 marker at rec[35] and the vent/lamp nibbles at
//     rec[36]: vent speeds 1-4 (asking for 5 gave 3) and lamp levels 1-2 (asking for 3 gave 1).
//
// The one difference is the record length: 53 bytes instead of 46. The 7 trailing bytes were zero in
// every frame captured. A manual cook (Microwave, full power, paused and cancelled) decoded correctly
// at WMVEL2137's offsets: state, cook mode, power level, cook time and remaining time. The kitchen
// timer, the Done state and the sensor/auto menus have not been captured on this model.
//
// It also opens each connection with a 41 0A content-sync envelope that it repeats every 5 s until
// acknowledged, so this handler acks like the cloud does.
const RECORD_LEN = 53

export default class Device extends WMVEL2137 {
    protected readonly recordLen = RECORD_LEN

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, true)
    }
}
