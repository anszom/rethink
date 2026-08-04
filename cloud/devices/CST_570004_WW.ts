import ACDevice, { SWING_AXES_ON_OFF, type WireLevels } from './ac_common'
import { type DeviceDiscovery } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'

/*
 * LG ceiling-cassette IDU, ThinQ model CST_570004_WW, deviceType 401 (RTK_RTL8720cm),
 * typically installed as several IDUs on one multi-split ODU.
 *
 * It speaks the same DualCool AC TLV scheme as the residential units, so the protocol handling
 * comes from ac_common; what is below are the ways in which a cassette differs from a wall unit,
 * plus the few entities that no other model has been seen to have.
 */
export default class Device extends ACDevice {
    /* CST emits its async/query TLV frames with UART header byte 6 = 0xa7 instead of 0x87. */
    isHeaderByte6(byte: number): boolean {
        return byte === 0x87 || byte === 0xa7
    }

    /*
     * Operation modes: CST advertises modes {0,1,2,3} in caps 0x2c1 and reports 0x1f9=3 live for
     * auto, whereas the wall units use auto=6 (and 4=heat). A cassette on a cooling-only outdoor
     * unit has no heat hardware at all, so restrict the mode list HA offers as well.
     */
    readonly modeLevels: WireLevels = [
        ['cool', 0],
        ['dry', 1],
        ['fan_only', 2],
        ['auto', 3],
    ]

    /* Fan speed: a different 0x1fa scale, and six steps instead of the wall units' five. */
    readonly fanLevels: WireLevels = [
        ['auto', 8],
        ['very low', 1],
        ['low', 2],
        ['medium', 4],
        ['high', 6],
        ['power', 7],
    ]

    /*
     * Not narrowed by the 0x2c2 bitmap. This unit reports 469 - wire values 0, 2, 4, 6, 7 and 8 -
     * which agrees with the list above on five of six but offers 0 where this says 1. The list is
     * what was derived by driving the appliance, so it wins over an unexplained disagreement about
     * the slowest step; letting the bitmap narrow it would silently drop "very low". Worth settling
     * by writing 0 and seeing whether the panel shows the same step as 1 does.
     */
    fanCaps() {
        return undefined
    }

    /*
     * Setting the mode alone is ignored while the unit is powered off - verified on hardware, the
     * official app turns the unit on by sending 0x1f7=1 together with the mode.
     */
    readonly powerOnWithModeWrite = true

    /* The feature bitmap is reported under 0x2cb; 0x2cc is not sent at all. */
    featureCaps() {
        return this.raw_clip_state[0x2cb]
    }

    /*
     * 0x2cd is not the jet/positional-swing bitmap here - its value has many unrelated bits set,
     * while the unit has neither jet nor positional swing.
     */
    jetSwingCaps() {
        return 0
    }

    /*
     * Which variant of the shared features this unit has. The vanes are driven as plain on/off on
     * 0x205 / 0x206 rather than by position, which 0x2cd does not describe either way.
     */
    swingAxes() {
        return SWING_AXES_ON_OFF
    }
    autoDryStyle() {
        return 'select' as const
    }
    /*
     * The basic-filter priv-command returns an unpopulated counter here (used=0, life=720) that
     * does not match the app, so read the filter from the value tags instead.
     */
    filterStyle() {
        return 'valueTags' as const
    }

    /* Entities that so far only this model has been seen to report. */
    addModelFields(config: DeviceDiscovery) {
        // Display brightness (0x21f, the wall units' "display light"): raw 100/150/200. Those
        // report it inconsistently, here the three levels match what the unit's panel shows.
        this.addValueSelect(config, 'display', 0x21f, 'Display', 'mdi:brightness-6', [
            ['off', 100],
            ['50%', 150],
            ['100%', 200],
        ])

        // Comfort energy saving (0x23f): only effective in cool mode, and distinct from the plain
        // energy saving of 0x20d that ac_common exposes as "energysave".
        if (this.raw_clip_state[0x23f] != null) {
            this.addConfigSwitchField(config, 0x23f, 'comfort_saving', 'Comfort energy saving', 'mdi:leaf')
        }

        // Humidity (0x336, raw/10 = %RH). A room measurement, not a diagnostic.
        this.addOptionalSensorField(
            config,
            0x336,
            'humidity',
            'Humidity',
            undefined,
            {
                device_class: 'humidity',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
                entity_category: undefined,
            },
            (raw) => Math.round(raw / 10),
        )

        this.addWindModeSelect(config)
    }

    /*
     * Wind mode (comfort airflow): five mutually-exclusive one-hot flags -
     * 0x3d6=manner, 0x3d7=long power, 0x291=study, 0x290=auto temp, all-0=off.
     * Expose as a single select. Only effective in cool mode. Reads derive the mode from
     * whichever flag is set (via a read hook on each); the write is handled in setProperty.
     */
    addWindModeSelect(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x3d6] == null || config.components['wind_mode']) return

        config.components['wind_mode'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-wind_mode',
            name: 'Wind mode',
            icon: 'mdi:weather-windy',
            entity_category: 'config',
            options: ['off', 'manner', 'long power', 'study', 'auto temp'],
            state_topic: '$this/wind_mode',
            command_topic: '$this/wind_mode/set',
        })
        for (const id of Device.WIND_FLAGS) {
            this.addField(
                config,
                {
                    id,
                    name: `flag_${id.toString(16)}`,
                    comp: 'wind_mode',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        this.HA.publishProperty(this.id, 'wind_mode', this.windModeFromState())
                        return false
                    },
                },
                false,
            )
        }
    }

    // Wind-mode one-hot flags: 0x290 auto temp, 0x291 study, 0x3d5 release, 0x3d6 manner,
    // 0x3d7 long power. Exactly one is 1 at a time; "off" is all flags 0.
    static readonly WIND_FLAGS = [0x290, 0x291, 0x3d5, 0x3d6, 0x3d7]
    static readonly WIND_TO_FLAG: Record<string, number | undefined> = {
        manner: 0x3d6,
        'long power': 0x3d7,
        study: 0x291,
        'auto temp': 0x290,
        off: undefined,
    }

    windModeFromState(): string {
        if (this.raw_clip_state[0x3d6]) return 'manner'
        if (this.raw_clip_state[0x3d7]) return 'long power'
        if (this.raw_clip_state[0x291]) return 'study'
        if (this.raw_clip_state[0x290]) return 'auto temp'
        return 'off'
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'wind_mode') {
            const on = Device.WIND_TO_FLAG[mqttValue]
            // select one flag exclusively: chosen=1, everything else (incl. 0x3d5 release)=0
            const tlv = Device.WIND_FLAGS.map((id) => ({ t: id, v: id === on ? 1 : 0 }))
            for (const { t, v } of tlv) this.raw_clip_state[t] = v
            this.send([1, 1, 2, 1, 1], tlv)
            return
        }
        super.setProperty(prop, mqttValue)
    }
}
