import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import WMVEM1825 from './WMVEM1825'

// LG MHES1738F over-the-range microwave. Status records, door events and hood commands match the
// MVEM1825, but the vent fan has five speeds instead of two.
export default class Device extends WMVEM1825 {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, 5)
    }
}
