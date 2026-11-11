import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import WMVEM1825 from './WMVEM1825'

// The appliance sends its door-open event only while idle. Opening the door during a cook sends a
// pause event instead, with this payload byte set; a pause from the Stop key leaves it clear. The
// door-closed event always follows, so the door state recovers. Opening the door after a cook has
// finished is not reported at all: it clears Done exactly like the Stop key does.
const PAUSE_EVENT = Buffer.from('41b20007', 'hex')
const PAUSE_DOOR_OPEN_OFFSET = 5 + 23

// LG MHES1738F over-the-range microwave. Status records, door events and hood commands match the
// MVEM1825, but the vent fan has five speeds instead of two.
export default class Device extends WMVEM1825 {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, 5)
    }

    processAABB(buf: Buffer) {
        if (buf.length === 5 + buf[4] && buf.subarray(0, 4).equals(PAUSE_EVENT) && buf[PAUSE_DOOR_OPEN_OFFSET] === 1) {
            this.publishProperty('door', 'ON')
            return
        }
        super.processAABB(buf)
    }
}
