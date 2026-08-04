import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type ComponentInfo, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/** TLV tags present in capability (0xA7/0x01) packets — store state but do not publish as entity values. */
const CAPS_ONLY_TAGS = new Set([0x2d5, 0x2d6, 0x336, 0x2e5, 0x2e6, 0x2da])

/** Switches only some units on this platform have, by the tag that proves it. */
const OPTIONAL_COMPONENTS: Record<number, string> = {
    0x2a2: 'uv_nano',
    0x360: 'ionizer',
    // Declared by LG's modelJSON for the platform, so held back the same way: the declaration is
    // per-platform, not per-unit, and an appliance that never reports the tag has no such control.
    0x17c: 'ban_disturb_sleep',
    0x185: 'watertank_light_brightness',
    0x186: 'watertank_state',
    0x189: 'swing',
    0x18f: 'fan_when_full',
    0x1fd: 'temperature',
    0x20e: 'auto_dry',
    0x21f: 'display',
    0x221: 'error',
    0x225: 'auto_dry_remain',
    0x337: 'sensor_mon',
    0x357: 'safe_op_remain',
    0x392: 'discharge_clean',
    0x3a0: 'bell_sound',
    0x3b9: 'melody',
    0x3e0: 'mood_color',
}

/** Observed on bucket-empty notify when the tank is reinstalled (0x2b1=256, 0x2b2=0). */
const BUCKET_EMPTIED_EVENT = 256

/** Entering these modes resets fan speed to low (high remains user-selectable). */
const SILENT_MODES = new Set([2, 19])

const HA_MODES = ['Smart', 'Jet', 'Silent', 'Intensive', 'Laundry'] as const

const CLIP_TO_HA_MODE: Record<number, string> = {
    0: 'Smart',
    1: 'Jet',
    2: 'Silent',
    4: 'Intensive',
    5: 'Laundry',
    17: 'Smart',
    18: 'Jet',
    19: 'Silent',
    20: 'Intensive',
    21: 'Laundry',
}

const HA_TO_CLIP_MODE: Record<string, number> = {
    Smart: 17,
    Jet: 18,
    Silent: 19,
    Intensive: 20,
    Laundry: 21,
}

/**
 * Mode tables live on the class, not in module scope, so a sibling model on the
 * same platform can reuse this whole implementation and override just the enum.
 * Reads go through `this.modes()`, which resolves against the *actual* class —
 * subclass statics included. Necessary because these codes are model-specific:
 * DHUM_231006_WW shares 19/20 with this model but uses 85/86 where this one
 * uses 17/21.
 */
export type ModeTables = {
    haModes: readonly string[]
    clipToHa: Record<number, string>
    haToClip: Record<string, number>
    silent: ReadonlySet<number>
    /** Fan-speed labels shown in HA, and their clip codes. */
    fanOptions: readonly string[]
    fanToHa: Record<number, string>
    fanToClip: Record<string, number>
    /** Label + code used when a silent mode forces the fan down. */
    lowFan: string
    lowFanClip: number
    /** Clip codes this model actually accepts for a fan write. */
    fanClipValues: ReadonlySet<number>
    /**
     * Per-mode fan-memory triplets to emit alongside 0x1fa, as [mode, fan].
     * The 056905 panel writes the whole table on every fan change; models with
     * no captured evidence of that should return an empty list and send 0x1fa
     * alone rather than guess at mode codes they may not have.
     */
    fanPerMode: (fan: number) => [number, number][]
}

function normalizeHaMode(val: string): string {
    return val.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

/**
 * LG Dehumidifier DHUM_056905_WW (e.g. models using 056905 platform, deviceType 403)
 */
export default class Device extends TLVDevice {
    /** Override in a subclass for a model whose mode codes differ. */
    static modeTables: ModeTables = {
        haModes: HA_MODES,
        clipToHa: CLIP_TO_HA_MODE,
        haToClip: HA_TO_CLIP_MODE,
        silent: SILENT_MODES,
        fanOptions: ['Low', 'High'],
        fanToHa: { 2: 'Low', 6: 'High' },
        fanToClip: { Low: 2, High: 6 },
        lowFan: 'Low',
        lowFanClip: 2,
        fanClipValues: new Set([2, 6]),
        fanPerMode: (fan) =>
            fan === 2
                ? [
                      [17, 2],
                      [18, 2],
                      [20, 2],
                      [21, 6],
                      [22, 2],
                  ]
                : [
                      [17, 6],
                      [18, 6],
                      [20, 6],
                      [21, 6],
                      [22, 6],
                  ],
    }

    /** Resolves against the real class, so subclass overrides win. */
    modes(): ModeTables {
        return (this.constructor as typeof Device).modeTables
    }

    powerStatePrev?: boolean
    modePrev?: string
    modeClipPrev?: number
    initialValuesReceived = false
    /** Last bucket-full state published to HA (retained). */
    bucketFullHaState?: boolean

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dehumidifier' }),
            components: {
                humidifier: {
                    platform: 'humidifier',
                    unique_id: '$deviceid-humidifier',
                    name: null,
                    device_class: 'dehumidifier',
                    modes: [...this.modes().haModes],
                    min_humidity: 30,
                    max_humidity: 70,
                },
                ionizer: {
                    platform: 'switch',
                    unique_id: '$deviceid-ionizer',
                    name: 'Ionizer',
                    icon: 'mdi:air-filter',
                },
                uv_nano: {
                    platform: 'switch',
                    unique_id: '$deviceid-uv_nano',
                    name: 'UVnano',
                    icon: 'mdi:lightbulb',
                },
                bucket_light: {
                    platform: 'switch',
                    unique_id: '$deviceid-bucket_light',
                    name: 'Bucket Light',
                    icon: 'mdi:lightbulb-on',
                },
                // MQTT humidifier platform has no fan_mode support; use a select entity instead.
                fan_speed: {
                    platform: 'select',
                    unique_id: '$deviceid-fan_speed',
                    name: 'Fan speed',
                    icon: 'mdi:fan',
                    options: [...this.modes().fanOptions],
                },
                current_humidity: {
                    platform: 'sensor',
                    unique_id: '$deviceid-current_humidity',
                    name: 'Current humidity',
                    device_class: 'humidity',
                    unit_of_measurement: '%',
                    state_class: 'measurement',
                    state_topic: '$this/humidifier-current_humidity',
                },
                bucket_full: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-bucket_full',
                    name: 'Bucket full',
                    icon: 'mdi:water-alert',
                    device_class: 'problem',
                    payload_on: 'ON',
                    payload_off: 'OFF',
                    state_topic: '$this/bucket_full-',
                },
            },
        })

        // power (0x1f7) - registered as humidifier-power; we wire bare state/command below
        this.addField(
            config,
            {
                id: 0x1f7,
                name: 'power',
                comp: 'humidifier',
                write_xform: (val) => (val === 'ON' ? 1 : 0),
                write_attach: (raw) => (raw ? [0x1f9] : []),
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                read_callback: (val) => {
                    const powerState = val === 'ON'
                    if (this.powerStatePrev !== powerState) {
                        // future hooks
                    }
                    this.powerStatePrev = powerState
                    return true // allow the power state publish
                },
            },
            false,
        )

        // mode / op mode
        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'humidifier',
            read_xform: (raw) => this.modes().clipToHa[raw] ?? `mode${raw}`,
            read_callback: () => {
                const mode = this.raw_clip_state[0x1f9]
                if (
                    mode != null &&
                    this.modes().silent.has(mode) &&
                    (this.modeClipPrev == null || !this.modes().silent.has(this.modeClipPrev))
                ) {
                    this.publishFanSpeedState(this.modes().lowFan)
                }
                if (mode != null) this.modeClipPrev = mode
                return true
            },
            write_xform: (val) => {
                if (val === 'off' || val === undefined) {
                    this.setProperty('humidifier-power', 'OFF')
                    return undefined
                } else {
                    this.setProperty('humidifier-power', 'ON')
                }
                const mode = normalizeHaMode(val)
                const clip = this.modes().haToClip[mode] ?? Number(val)
                if (
                    typeof clip === 'number' &&
                    this.modes().silent.has(clip) &&
                    (this.modeClipPrev == null || !this.modes().silent.has(this.modeClipPrev))
                ) {
                    this.raw_clip_state[0x1fa] = this.modes().lowFanClip
                    this.publishFanSpeedState(this.modes().lowFan)
                }
                if (typeof clip === 'number') this.modeClipPrev = clip
                return clip
            },
            write_attach: [0x1f7],
        })

        this.addField(config, {
            id: 0x1fa,
            name: '',
            comp: 'fan_speed',
            read_xform: (raw) => {
                return this.modes().fanToHa[raw] ?? raw.toString()
            },
            read_callback: (val) => {
                this.publishFanSpeedState(typeof val === 'string' ? val : String(val))
                return false
            },
            write_xform: (val) => {
                return this.modes().fanToClip[val] ?? Number(val)
            },
            write_callback: (val) => {
                if (typeof val !== 'number' || !this.modes().fanClipValues.has(val)) return false
                this.sendFanSpeedTlvs(val)
                return false
            },
        })

        /*
         * Current humidity is 0x336, in whole %RH.
         *
         * It used to be read off 0x1fd, which published a room humidity of 238 %
         * for a live DHUM_056905_WW. 0x1fd is the current *temperature* tag on
         * this whole TLV family — ac_common calls it TAG_TEMP_CURRENT, and
         * WIN/POT/RAC_056905_WW all read it as one. Checked against the LG
         * cloud's own decode of the same appliance while bridged, 2026-07-28:
         *
         *   0x336 = 55        airState.humidity.current = 55
         *   0x1fd = 238       airState.tempState.current = -18   (int8 of 238)
         *
         * so the cloud reads the two tags exactly the other way round from what
         * this driver did. 0x1fd is left unpublished rather than exposed as a
         * temperature: this unit reports -18/-20 degC indoors and LG's cloud
         * shows that same nonsense, so the sensor is not worth an entity until
         * a model on this platform is seen reporting a plausible one.
         *
         * The reading that produced the old mapping — 48 on 0x1fd, taken for
         * 48 % — is a room temperature under whichever scale this platform uses,
         * not a humidity.
         */
        this.addField(config, {
            id: 0x336,
            name: 'current_humidity',
            comp: 'humidifier',
            state_topic: 'topic',
            writable: false,
        })

        // target humidity setpoint (0x253 on live A7/0x04 notify packets, e.g. v=35)
        this.addField(config, {
            id: 0x253,
            name: 'target_humidity',
            comp: 'humidifier',
            read_xform: (raw) => raw,
            read_callback: (val) => {
                const n = typeof val === 'number' ? val : Number(val)
                return n >= 30 && n <= 70
            },
            write_xform: (valStr) => {
                let val = Number(valStr)
                if (val < 30) val = 30
                if (val > 70) val = 70
                val = Math.round(val)
                this.raw_clip_state[0x1f7] = 1
                return val
            },
            write_attach: [0x1f7, 0x1f9],
        })

        // ionizer on/off (0x360 on live notify packets: 0=OFF, 1=ON)
        this.addField(config, {
            id: 0x360,
            name: '',
            comp: 'ionizer',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            write_attach: [0x1f7, 0x1f9],
        })

        // UVnano (0x2a2 on live notify packets: 0=OFF, 1=ON)
        this.addField(config, {
            id: 0x2a2,
            name: '',
            comp: 'uv_nano',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            write_attach: [0x1f7, 0x1f9],
        })

        // bucket light (0x21e on live notify packets: 0=OFF, 1=ON)
        this.addField(config, {
            id: 0x21e,
            name: '',
            comp: 'bucket_light',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
        })

        this.addTimerField(config, 0x21b, 'off_timer', 'Sleep timer', 'mdi:bed-clock', 9)

        // Wire bare state_topic/command_topic (expected by humidifier platform) to our 'power' property
        const hum = (config.components as any).humidifier
        hum.state_topic = '$this/humidifier-power'
        hum.command_topic = '$this/humidifier-power/set'

        this.addLGDeclaredFields(config)

        this.holdOptionalComponents(config)
        this.setConfig(config)
    }

    /*
     * Not every unit on this platform has every extra. Hold those switches back
     * until the appliance itself has reported their tag, so a unit without the
     * hardware does not get a control that does nothing.
     *
     * Measured on a DHUM_056905_WW, 2026-07-28: 0x2a2 was never reported at all
     * and a write to it drew no reply, while 0x360 reports 0 but ignores every
     * write — tried in Silent, Smart, Jet and Laundry, with the LG cloud's
     * airState.miscFuncState.extraOp never moving off 0. LG's own control list
     * for this model (basicCtrl, reservationCtrl, remoteMon, diagData,
     * energyStateCtrl) offers neither. Upstream PR #64 was written against a
     * unit that has them, so they stay for appliances that report them.
     */
    private heldComponents: Record<number, { name: string; component: ComponentInfo }> = {}

    private holdOptionalComponents(config: DeviceDiscovery) {
        for (const [tag, name] of Object.entries(OPTIONAL_COMPONENTS)) {
            const component = config.components[name]
            if (!component) continue
            this.heldComponents[Number(tag)] = { name, component }
            delete config.components[name]
        }
    }

    /** Publish a held switch the moment its tag arrives. */
    private releaseOptionalComponent(tag: number) {
        const held = this.heldComponents[tag]
        if (!held || !this.config) return
        delete this.heldComponents[tag]
        this.config.components[held.name] = held.component
        this.publishConfig()
    }

    /*
     * A component carrying nothing but its `platform` is how device discovery
     * says "this entity is gone"; omitting it only stops Home Assistant
     * creating a new one. Both are needed: the omission keeps a fresh install
     * clean, and the removal clears the entity an earlier version of this
     * driver already created.
     *
     * It has to be exactly that, not an empty object. `platform` is required by
     * DEVICE_DISCOVERY_SCHEMA, and Home Assistant rejects the *whole device
     * payload* without it — "required key not provided @
     * data['components'][...]['platform']" — so one malformed removal silently
     * freezes discovery for every entity on the appliance. Home Assistant then
     * pops `platform` and treats the now-empty config as the removal
     * (`mqtt/discovery.py`, `_parse_device_payload`).
     */
    private dropUnreportedComponents() {
        let changed = false
        for (const [tag, held] of Object.entries(this.heldComponents)) {
            if (this.raw_clip_state[Number(tag)] !== undefined) continue
            if (!this.config) continue
            this.config.components[held.name] = { platform: held.component.platform } as ComponentInfo
            changed = true
        }
        // The entries stay held rather than being forgotten: an appliance that
        // reports the tag later still gets its switch, and releasing it
        // overwrites the removal with the real component.
        if (changed) this.publishConfig()
    }

    /*
     * The rest of what this platform declares.
     *
     * PR #64 covered the controls its author could reach from the appliance's panel. LG's own
     * modelJSON for both dehumidifiers here labels every state field with its clip tag —
     * `waterTankFull_state_tlv_390`, `swing_state_tlv_393`, `melody_state_tlv_953` and so on —
     * and the two models declare an identical set, so these belong on the shared base class.
     *
     * They go through the same hold-back path as the ionizer and UVnano switches: a unit that
     * never reports the tag does not get the entity. That matters here, because this list is
     * LG's declaration for the platform rather than a per-unit capability read.
     *
     * Two are inverted against every other flag on the appliance — LG's own value_mapping has
     * 0 = ON for both the display and the buzzer — so they are written as explicit tables rather
     * than truthiness, which is exactly the sort of thing that later reads as a bug.
     *
     * 0x1fd finally gets an entity. It was left unpublished when the humidity mix-up was fixed,
     * because the only unit measured then (DHUM_056905_WW) reported -18 degC indoors and LG's
     * cloud agreed with that nonsense. DHUM_231006_WW settles the scale: it reported 0x1fd = 58
     * while the cloud read 29.0 degC off the same appliance at the same moment, i.e. half-degrees,
     * the same convention ac_common uses for TAG_TEMP_CURRENT. The older unit's sensor is simply
     * broken, in the driver and in LG's cloud alike.
     */
    private addLGDeclaredFields(config: DeviceDiscovery) {
        this.addLevelSelect(config, 0x189, 'swing', 'Airflow direction', 'mdi:arrow-oscillating', [
            ['Level 1', 0],
            ['Level 2', 1],
            ['Level 3', 2],
            ['Up-down swing', 3],
        ])
        this.addLevelSelect(config, 0x20e, 'auto_dry', 'Auto dry', 'mdi:hair-dryer', [
            ['Off', 0],
            ['Level 1', 1],
            ['Level 2', 2],
            ['Level 3', 3],
            ['Level 4', 4],
            ['Smart dry', 253],
        ])
        this.addLevelSelect(config, 0x21f, 'display', 'Display', 'mdi:brightness-6', [
            ['On', 0],
            ['Off', 1],
        ])
        this.addLevelSelect(config, 0x3a0, 'bell_sound', 'Notification sound', 'mdi:bell', [
            ['On', 0],
            ['Off', 1],
        ])
        this.addLevelSelect(config, 0x337, 'sensor_mon', 'Air quality sensor', 'mdi:motion-sensor', [
            ['While running only', 0],
            ['Always', 1],
        ])
        this.addLevelSelect(config, 0x3b9, 'melody', 'Melody', 'mdi:music-note', [
            ['Default melody', 0],
            ['Vivaldi Winter', 1],
            ['Jingle Bells (chorus)', 2],
            ['We Wish You a Merry Christmas', 3],
            ['Beethoven Pastoral', 4],
            ['Vivaldi Spring', 5],
            ['Dvorak Humoresque', 6],
            ["Elgar Salut d'Amour", 7],
            ['Vivaldi Autumn', 8],
            ['Tchaikovsky Sugar Plum Fairy', 9],
            ['Radetzky March', 10],
            ['Jingle Bells (intro)', 11],
        ])
        this.addLevelSelect(config, 0x3e0, 'mood_color', 'Mood light color', 'mdi:palette', [
            ['Pure White', 0],
            ['Very Peri', 1],
            ['Lime', 2],
            ['Salmon Pink', 3],
            ['Lavender', 4],
            ['Santorini', 5],
            ['Sunlight', 6],
            ['Rose', 7],
        ])

        this.addFlagSwitch(config, 0x17c, 'ban_disturb_sleep', 'Do not disturb while sleeping', 'mdi:sleep')
        this.addFlagSwitch(config, 0x18f, 'fan_when_full', 'Fan when tank full', 'mdi:fan-alert')
        this.addFlagSwitch(config, 0x392, 'discharge_clean', 'Vent clean', 'mdi:air-purifier')

        this.addReadSensor(config, 0x1fd, 'temperature', 'Current temperature', 'mdi:thermometer', (raw) => raw / 2, {
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
        })
        this.addReadSensor(
            config,
            0x186,
            'watertank_state',
            'Tank state',
            'mdi:cup-water',
            (raw) => ({ 0: 'Normal', 1: 'Full (stopped)', 2: 'Full (fan)' })[raw] ?? `State${raw}`,
        )
        this.addReadSensor(config, 0x221, 'error', 'Error code', 'mdi:alert-circle-outline', (raw) =>
            raw === 0 ? 'Normal' : `E${String(raw).padStart(2, '0')}`,
        )
        this.addReadSensor(config, 0x225, 'auto_dry_remain', 'Auto dry remaining', 'mdi:timer-sand', (raw) => raw)
        this.addReadSensor(
            config,
            0x357,
            'safe_op_remain',
            'Safe operation remaining',
            'mdi:shield-clock',
            (raw) => raw,
        )

        config['components']['watertank_light_brightness'] = allowExtendedType({
            platform: 'number',
            unique_id: '$deviceid-watertank_light_brightness',
            name: 'Tank light brightness',
            icon: 'mdi:lightbulb-on-outline',
            min: 0,
            max: 4000,
            step: 1,
            mode: 'box',
        })
        this.addField(config, {
            id: 0x185,
            name: '',
            comp: 'watertank_light_brightness',
            write_xform: (val) => Math.round(Number(val)),
        })
    }

    private addLevelSelect(
        config: DeviceDiscovery,
        id: number,
        comp: string,
        desc: string,
        icon: string,
        levels: readonly (readonly [string, number])[],
    ) {
        config['components'][comp] = allowExtendedType({
            platform: 'select',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            icon,
            options: levels.map(([label]) => label),
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => levels.find(([, wire]) => wire === raw)?.[0],
            write_xform: (val) => levels.find(([label]) => label === val)?.[1],
        })
    }

    private addFlagSwitch(config: DeviceDiscovery, id: number, comp: string, desc: string, icon: string) {
        config['components'][comp] = allowExtendedType({
            platform: 'switch',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            icon,
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
        })
    }

    private addReadSensor(
        config: DeviceDiscovery,
        id: number,
        comp: string,
        desc: string,
        icon: string,
        read_xform: (raw: number) => string | number,
        extra: Record<string, unknown> = {},
    ) {
        config['components'][comp] = allowExtendedType({
            platform: 'sensor',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            icon,
            ...extra,
        })
        this.addField(config, { id, name: '', comp, writable: false, read_xform })
    }

    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, max: number) {
        const step = 1
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: step,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Setpoint is hours×60 (minutes) in tlv, same as RAC timers on 0x21b.
         * While counting down, notifies send remaining time in seconds.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => Math.ceil(raw / 60 / step) * step,
            write_xform: (val) => Math.round(Number(val) * 60),
        })
    }

    private fanSpeedFromClip(raw?: number): string {
        const v = raw ?? this.raw_clip_state[0x1fa]
        // Through the mode table rather than a hard-coded pair: DHUM_231006_WW has five speeds,
        // and both models' labels are the appliance's own.
        return this.modes().fanToHa[v] ?? (v != null ? String(v) : this.modes().lowFan)
    }

    private publishFanSpeedState(override?: string) {
        const state = override ?? this.fanSpeedFromClip()
        this.HA.publishProperty(this.id, 'fan_speed-', state)
    }

    /** Fan speed writes carry per-mode 0x2d7/0x2d8/0x2d9 triplets (see panel notify captures). */
    private buildFanSpeedTlvs(fan: number): TLV.TLV[] {
        const modeFan = (mode: number, fanSpeed: number) => [
            { t: 0x2d7, v: mode },
            { t: 0x2d8, v: 0 },
            { t: 0x2d9, v: fanSpeed },
        ]
        const modes = this.modes().fanPerMode(fan)
        const tlvs = [{ t: 0x1fa, v: fan }, ...modes.flatMap(([m, f]) => modeFan(m, f))]
        for (const { t, v } of tlvs) this.raw_clip_state[t] = v
        return tlvs
    }

    private sendFanSpeedTlvs(fan: number) {
        this.send([1, 1, 2, 1, 1], this.buildFanSpeedTlvs(fan))
    }

    private publishBucketFullState(full: boolean) {
        if (this.bucketFullHaState === full) return
        this.bucketFullHaState = full
        this.HA.publishProperty(this.id, 'bucket_full-', full ? 'ON' : 'OFF', { retain: true })
    }

    processKeyValue(k: number, v: number) {
        if (this.query_caps_timeout !== undefined && CAPS_ONLY_TAGS.has(k)) {
            this.raw_clip_state[k] = v
            return
        }
        // The tag arriving is the appliance saying it has the feature; publish
        // the switch before the value that follows.
        if (k in this.heldComponents) this.releaseOptionalComponent(k)
        if (k === 0x2b1) {
            this.raw_clip_state[k] = v
            if (v === BUCKET_EMPTIED_EVENT) this.publishBucketFullState(false)
            return
        }
        if (k === 0x2b2) {
            this.raw_clip_state[k] = v
            this.publishBucketFullState(v !== 0)
            return
        }
        super.processKeyValue(k, v)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(
            ({ t }) =>
                t === 0x1f7 ||
                t === 0x1f9 ||
                t === 0x1fa ||
                t === 0x1fd ||
                t === 0x21b ||
                t === 0x21e ||
                t === 0x2b2 ||
                t === 0x253 ||
                t === 0x2a2 ||
                t === 0x360,
        )
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // The values response is the appliance's full inventory. Anything still
        // held back after it is something this unit does not have.
        this.dropUnreportedComponents()

        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
    }
}
