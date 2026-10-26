import { tombstone, type ComponentInfo, type Tombstone } from '../homeassistant'
import Y_V8_Y___W_B32QEUK from './Y_V8_Y___W.B32QEUK'

// A complete Cotton cycle on an F2WR709S2W confirmed the inherited telemetry and core
// controls. Pause worked only while Remote Start was armed, and every resume command was
// rejected. The C9 packet observed on physical resume travels in the opposite direction,
// so neither conditional control is exposed.
export default class Device extends Y_V8_Y___W_B32QEUK {
    protected components(): Record<string, ComponentInfo | Tombstone> {
        return {
            ...super.components(),
            start: tombstone('button'),
            pause: tombstone('button'),
            set_delay_end: tombstone('number'),
            set_steam: tombstone('switch'),
            set_prewash: tombstone('switch'),
            set_turbowash: tombstone('switch'),
            set_crease_care: tombstone('switch'),
            set_steam_softener: tombstone('switch'),
            set_medic_rinse: tombstone('switch'),
        }
    }
}
