import RAC from './RAC_056905_WW'
import { type DeviceDiscovery } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'

// LG ceiling-cassette IDU, ThinQ model CST_570004_WW, deviceType 401 (RTK_RTL8720cm),
// typically installed as several IDUs on one multi-split ODU.
//
// The control/telemetry protocol is the same DualCool AC TLV scheme as RAC_056905_WW
// (standard tags 0x1f7 power, 0x1f9 mode, 0x1fa fan, 0x1fd current temp, 0x1fe target
// temp, 0x2b3 instantaneous power, ...), so we reuse the RAC handler and only patch the
// CST-specific differences:
//
// 1. Wire header: CST emits its async/query TLV frames with UART header byte6 = 0xa7
//    instead of 0x87. The base tlv_device framing check only accepts 0x87, so processData
//    normalizes 0xa7 -> 0x87 before delegating. (POT_056905_WW has the same quirk.)
//
// 2. Feature gating: RAC gates air-clean/energy-saving/auto-dry on the capability bitmap
//    tag 0x2cc, and the filter sensors on 0x2f1. CST never sends 0x2cc (though it does
//    report the value tags 0x20d/0x20e) and reports 0x2f1&1 (="no filter") even though its
//    filter priv-command returns real data. This handler synthesizes the missing 0x2cc bits
//    from the present value tags and always probes for the filter.
//
// 3. Extra sensors CST exposes but RAC has no field for / gates out:
//    - Humidity: tag 0x336, raw/10 = %RH.
//    - Power: RAC only creates the Power (W) sensor when tag 0x2b3 is non-zero at config
//      time. On a multi-split the IDU is often idle at init, so this handler always creates
//      it. setConfig injects both into the finished config.
export default class Device extends RAC {
    processData(buf: Buffer) {
        if (buf[6] === 0xa7) {
            const b = Buffer.from(buf)
            b[6] = 0x87
            super.processData(b)
            return
        }
        super.processData(buf)
    }

    // The tags driving CST's capability differences arrive only in the caps reply, which a
    // caps retry can re-deliver. Each override is therefore applied at the exact point RAC reads
    // the tag, so a duplicate caps reply cannot undo it:
    //   - filter (RAC reads 0x2f1 in valuesReceived): CST always has a filter, so probe
    //     unconditionally rather than gating on 0x2f1;
    //   - jet / positional swing / energy-save (RAC reads 0x2cd/0x2cc in initMakeSetConfig):
    //     rewrite those tags in an initMakeSetConfig override, right before super reads them.

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true
        // ask the modem to report all TLV changes (empty blacklist) — same as RAC
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined
            this.initProbeForFilter()
        }, 500)
    }

    initMakeSetConfig() {
        // RAC reads the feature bitmap from 0x2cc. CST omits 0x2cc but reports the same bitmap
        // under 0x2cb (adjacent tag; low bits match RAC's 0x2cc layout — bit0 air-purify,
        // bit1 energy-save, bit2 auto-dry). Map 0x2cb into 0x2cc so RAC reads the real caps,
        // masking bit2: CST exposes auto-dry as a duration select (0x20e), added in setConfig,
        // not RAC's binary sensor.
        if (this.raw_clip_state[0x2cc] == null && this.raw_clip_state[0x2cb] != null) {
            this.raw_clip_state[0x2cc] = this.raw_clip_state[0x2cb] & ~0x4
        }
        // Suppress jet and RAC's positional swing. CST's 0x2cd is not RAC's jet/swing bitmap
        // (its value has many unrelated bits set), and the unit has no jet and no heat hardware,
        // so clear the bits RAC reads as jet-cool/heat (1|2) and swing-V/H (4|8). Swing comes
        // from the on/off value tags 0x205/0x206 instead, wired up in setConfig.
        this.raw_clip_state[0x2cd] &= ~(1 | 2 | 4 | 8)
        super.initMakeSetConfig()
    }

    setConfig(config: DeviceDiscovery) {
        // Render Energy saving as a plain toggle. RAC marks it optimistic, which makes HA show
        // it as two assumed-state buttons instead of a switch. Drop optimistic; RAC's read/write
        // logic and its power/mode hooks are left untouched.
        if (config.components['energysave']) {
            delete (config.components['energysave'] as { optimistic?: boolean }).optimistic
        }

        // Fan speed: CST uses a different 0x1fa scale than RAC's DualCool wall units:
        //   1=very low, 2=low, 4=medium, 6=high, 7=power, 8=auto
        // Re-register the field and replace the advertised fan_modes list with the app's 6 options.
        const fanR: Record<number, string> = { 1: 'very low', 2: 'low', 4: 'medium', 6: 'high', 7: 'power', 8: 'auto' }
        const fanW: Record<string, number> = { 'very low': 1, low: 2, medium: 4, high: 6, power: 7, auto: 8 }
        ;(config.components['climate'] as { fan_modes?: string[] }).fan_modes = [
            'auto',
            'very low',
            'low',
            'medium',
            'high',
            'power',
        ]
        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => fanR[raw],
            write_xform: (val) => fanW[val],
            write_attach: [0x1f9, 0x1fe],
        })

        // HVAC mode: CST's 0x1f9 wire values differ from RAC's. CST advertises modes {0,1,2,3}
        // in caps 0x2c1 and reports 0x1f9=3 live for auto, whereas RAC uses auto=6 (and 4=heat).
        // So on CST: cool=0, dry=1, fan_only=2, auto=3 (no heat). RAC's table reads wire 3 as
        // undefined and writes auto as the unsupported wire 6, so re-register the field with
        // CST's table. Mode-change hooks and power-off handling are kept identical to RAC.
        const modeR: (string | undefined)[] = ['cool', 'dry', 'fan_only', 'auto']
        const modeW: Record<string, number> = { cool: 0, dry: 1, fan_only: 2, auto: 3 }
        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => (this.getPowerTLV() === 0 ? 'off' : modeR[raw]),
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                if (val === 'off') {
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return modeW[val]
            },
            write_attach: [0x1fa, 0x1fe],
        })

        // Swing: CST exposes plain on/off vertical and horizontal swing on 0x205 / 0x206.
        // RAC's positional 0x321/0x322 swing is suppressed in initMakeSetConfig, so wire these
        // up as the climate swing attributes.
        const climate = config.components['climate'] as {
            modes?: string[]
            swing_modes?: string[]
            swing_horizontal_modes?: string[]
            min_temp?: number
            max_temp?: number
        }
        // Temperature range from caps. RAC hardcodes 18–30 °C with a TODO to read tags
        // 0x2e1–0x2ec; CST advertises the cooling range in 0x2e1 (min) / 0x2e2 (max), raw/2 = °C
        // (32/60 -> 16/30), so read it instead of inheriting RAC's hardcoded minimum.
        if (this.raw_clip_state[0x2e1] != null) climate.min_temp = this.raw_clip_state[0x2e1] / 2
        if (this.raw_clip_state[0x2e2] != null) climate.max_temp = this.raw_clip_state[0x2e2] / 2
        // CST is cooling-only (no heat hardware) — restrict the HVAC mode list so HA doesn't
        // offer 'heat'. Supported per the official app: cool / dry / fan_only / auto (+ off).
        climate.modes = ['off', 'cool', 'dry', 'fan_only', 'auto']
        climate.swing_modes = ['on', 'off']
        this.addField(config, {
            id: 0x205,
            name: 'swing_mode',
            comp: 'climate',
            read_xform: (raw) => (raw ? 'on' : 'off'),
            write_xform: (val) => (val === 'on' ? 1 : 0),
        })
        climate.swing_horizontal_modes = ['on', 'off']
        this.addField(config, {
            id: 0x206,
            name: 'swing_horizontal_mode',
            comp: 'climate',
            read_xform: (raw) => (raw ? 'on' : 'off'),
            write_xform: (val) => (val === 'on' ? 1 : 0),
        })

        // Auto-dry duration setting (0x20e): writable select (255 = smart).
        this.addValueSelect(config, 'autodry_setting', 0x20e, 'Auto dry', 'mdi:hair-dryer', [
            ['off', 0],
            ['10 min', 1],
            ['30 min', 2],
            ['60 min', 3],
            ['smart', 255],
        ])

        // Auto-dry remaining (0x225): minutes left in the auto-dry cycle (0 when not drying).
        // Independent of the 0x20e setting — 0x225 only changes while drying runs.
        if (this.raw_clip_state[0x225] != null && !config.components['autodryremain']) {
            config.components['autodryremain'] = allowExtendedType({
                platform: 'sensor',
                unique_id: '$deviceid-autodryremain',
                name: 'Auto dry remaining',
                icon: 'mdi:hair-dryer-outline',
                device_class: 'duration',
                unit_of_measurement: 'min',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            })
            this.addField(config, { id: 0x225, name: '', comp: 'autodryremain', writable: false })
        }

        // Display brightness (0x21f, RAC's "display light"): raw 100/150/200.
        this.addValueSelect(config, 'display', 0x21f, 'Display', 'mdi:brightness-6', [
            ['off', 100],
            ['50%', 150],
            ['100%', 200],
        ])

        // Wind mode (comfort airflow): five mutually-exclusive one-hot flags —
        // 0x3d6=manner, 0x3d7=long power, 0x291=study, 0x290=auto temp, all-0=off.
        // Expose as a single select. Only effective in cool mode. Reads derive the mode from
        // whichever flag is set (via a read hook on each); the write is handled in setProperty.
        if (this.raw_clip_state[0x3d6] != null && !config.components['wind_mode']) {
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

        // Comfort energy saving (0x23f): on/off switch (only effective in cool mode). Distinct
        // from plain energy saving (0x20d, exposed by RAC as "energysave").
        if (this.raw_clip_state[0x23f] != null && !config.components['comfort_saving']) {
            config.components['comfort_saving'] = allowExtendedType({
                platform: 'switch',
                unique_id: '$deviceid-comfort_saving',
                name: 'Comfort energy saving',
                icon: 'mdi:leaf',
                entity_category: 'config',
            })
            this.addField(config, {
                id: 0x23f,
                name: '',
                comp: 'comfort_saving',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
            })
        }

        // Humidity (0x336, raw/10 = %RH) — CST reports it but RAC has no field for it.
        if (this.raw_clip_state[0x336] != null && !config.components['humidity']) {
            config.components['humidity'] = allowExtendedType({
                platform: 'sensor',
                unique_id: '$deviceid-humidity',
                name: 'Humidity',
                device_class: 'humidity',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
            })
            this.addField(config, {
                id: 0x336,
                name: '',
                comp: 'humidity',
                writable: false,
                read_xform: (raw) => Math.round(raw / 10),
            })
        }

        // Power (W) — RAC only adds this when 0x2b3 is non-zero at config time; always
        // expose it on CST (multi-split IDUs are usually idle when the handler initializes).
        if (!config.components['energy_current']) {
            config.components['energy_current'] = allowExtendedType({
                platform: 'sensor',
                unique_id: '$deviceid-energy_current',
                name: 'Power',
                device_class: 'power',
                unit_of_measurement: 'W',
                state_class: 'measurement',
                suggested_display_precision: 0,
            })
            // Report 0x2b3 as-is (watts). CST's 0x2b3 is already a clean value (0 when off), so
            // RAC's max(5, raw-60) bias/floor is not applied. It tracks the IDU's compressor
            // share and excludes the indoor fan's own draw, so fan-only reads ~0.
            this.addField(config, {
                id: 0x2b3,
                name: '',
                comp: 'energy_current',
                writable: false,
            })
        }

        super.setConfig(config)
    }

    // Register a writable HA select whose options map one-to-one to wire values. The
    // [label, wire] list is the single source of truth — the option list and both the read and
    // write transforms are derived from it, so they can't drift out of sync.
    addValueSelect(
        config: DeviceDiscovery,
        comp: string,
        id: number,
        name: string,
        icon: string,
        levels: ReadonlyArray<readonly [string, number]>,
    ) {
        if (this.raw_clip_state[id] == null || config.components[comp]) return
        const toLabel = new Map(levels.map(([label, raw]) => [raw, label]))
        const toRaw = new Map(levels.map(([label, raw]) => [label, raw]))
        config.components[comp] = allowExtendedType({
            platform: 'select',
            unique_id: `$deviceid-${comp}`,
            name,
            icon,
            entity_category: 'config',
            options: levels.map(([label]) => label),
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => toLabel.get(raw),
            write_xform: (val) => toRaw.get(val),
        })
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

    // RAC probes for the filter once and, if no reply comes within 5 s, builds the config
    // without filter entities. On a multi-split the probe can race with the caps/values/masking
    // traffic, so retry it a few times before falling back. A reply clears
    // filterInitialQueryTimeout (in RAC.processFilterData), stopping the retries and proceeding
    // to config.
    filterProbeAttempts = 0
    initProbeForFilter() {
        this.filterProbeAttempts++
        this.sendFilterQuery()
        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined
            if (this.filterProbeAttempts < 5) {
                this.initProbeForFilter()
            } else {
                this.initMakeSetConfig()
            }
        }, 4 * 1000)
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
