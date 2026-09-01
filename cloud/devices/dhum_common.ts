import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection, type HumidifierComponent } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/**
 * TLV tags present in capability (0xA7/0x01) packets — store during the caps query phase
 * but do not publish as entity values. After caps are received, 0x336 is handled as
 * current humidity via its field definition.
 */
const CAPS_ONLY_TAGS = new Set([0x2d5, 0x2d6, 0x336, 0x2e5, 0x2e6, 0x2da])

/** Observed on bucket-empty notify when the tank is reinstalled (0x2b1=256, 0x2b2=0). */
const BUCKET_EMPTIED_EVENT = 256

export type DhumEnumTable = readonly (readonly [clipValue: number, label: string])[]

export type DhumFeatures = {
    ionizer?: boolean
    uvNano?: boolean
    bucketLight?: boolean
    bucketFull?: boolean
    offTimer?: boolean
}

type ExpandedEnumTable = {
    toHa: Readonly<Record<number, string>>
    toClip: Readonly<Record<string, number>>
    options: readonly string[]
    clipValues: ReadonlySet<number>
}

export type DhumProfile = {
    modes: ExpandedEnumTable
    fans: ExpandedEnumTable
    silentModes: ReadonlySet<number>
    lowFanClip: number
    /** Initial response carries both capability rows and live state. */
    combinedInitialResponse?: boolean
    features: DhumFeatures
}

export type DhumProfileDefinition = {
    modes: DhumEnumTable
    fans: DhumEnumTable
    silentModes?: readonly number[]
    lowFanClip: number
    combinedInitialResponse?: boolean
    features?: DhumFeatures
}

function expandEnumTable(table: DhumEnumTable): ExpandedEnumTable {
    const toHa: Record<number, string> = {}
    const toClip: Record<string, number> = {}
    const options: string[] = []

    for (const [clipValue, label] of table) {
        toHa[clipValue] = label
        toClip[label.toLowerCase()] = clipValue
        if (!options.includes(label)) options.push(label)
    }

    return {
        toHa,
        toClip,
        options,
        clipValues: new Set(table.map(([clipValue]) => clipValue)),
    }
}

/** Build every derived lookup from the two model-specific wire tables. */
export function defineDhumProfile(definition: DhumProfileDefinition): DhumProfile {
    return {
        modes: expandEnumTable(definition.modes),
        fans: expandEnumTable(definition.fans),
        silentModes: new Set(definition.silentModes),
        lowFanClip: definition.lowFanClip,
        combinedInitialResponse: definition.combinedInitialResponse,
        features: definition.features ?? {},
    }
}

export default class Device extends TLVDevice {
    static profile: DhumProfile

    profile(): DhumProfile {
        return (this.constructor as typeof Device).profile
    }

    powerStatePrev?: boolean
    modePrev?: string
    modeClipPrev?: number
    initialValuesReceived = false
    /** Last bucket-full state published to HA (retained). */
    bucketFullHaState?: boolean

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const config: DeviceDiscovery & { components: { humidifier: HumidifierComponent } } = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dehumidifier' }),
            components: {
                humidifier: {
                    platform: 'humidifier',
                    unique_id: '$deviceid-humidifier',
                    name: null,
                    device_class: 'dehumidifier',
                    modes: [...this.profile().modes.options],
                    min_humidity: 30,
                    max_humidity: 70,
                } satisfies HumidifierComponent,
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
                    options: [...this.profile().fans.options],
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
        const features = this.profile().features
        if (!features.ionizer) delete config.components.ionizer
        if (!features.uvNano) delete config.components.uv_nano
        if (!features.bucketLight) delete config.components.bucket_light
        if (!features.bucketFull) delete config.components.bucket_full

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
            read_xform: (raw) => this.profile().modes.toHa[raw] ?? 'unknown',
            read_callback: () => {
                const mode = this.raw_clip_state[0x1f9]
                if (
                    mode != null &&
                    this.profile().silentModes.has(mode) &&
                    (this.modeClipPrev == null || !this.profile().silentModes.has(this.modeClipPrev))
                ) {
                    this.publishFanSpeedState(this.fanSpeedFromClip(this.profile().lowFanClip))
                }
                if (mode != null) this.modeClipPrev = mode
                return true
            },
            write_xform: (val) => {
                if (val === 'off' || val === undefined) {
                    this.setProperty('humidifier-power', 'OFF')
                    return undefined
                }

                const clip = this.profile().modes.toClip[val.toLowerCase()]
                if (clip === undefined) return undefined

                // Power on via attached 0x1f7
                this.raw_clip_state[0x1f7] = 1
                if (
                    this.profile().silentModes.has(clip) &&
                    (this.modeClipPrev == null || !this.profile().silentModes.has(this.modeClipPrev))
                ) {
                    this.raw_clip_state[0x1fa] = this.profile().lowFanClip
                    this.publishFanSpeedState(this.fanSpeedFromClip(this.profile().lowFanClip))
                }
                this.modeClipPrev = clip
                return clip
            },
            write_attach: [0x1f7],
        })

        this.addField(config, {
            id: 0x1fa,
            name: '',
            comp: 'fan_speed',
            read_xform: (raw) => this.profile().fans.toHa[raw] ?? 'unknown',
            read_callback: (val) => {
                this.publishFanSpeedState(typeof val === 'string' ? val : String(val))
                return false
            },
            write_xform: (val) => this.profile().fans.toClip[val.toLowerCase()],
            write_callback: (val) => {
                if (!this.profile().fans.clipValues.has(val)) return false
                return this.sendFanSpeedTlvs(val)
            },
        })

        // current humidity: ThinQ maps 0x336 → airState.humidity.current (live packets).
        // 0x1fd is a different property on this platform family (temperature on RAC/WIN).
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

        if (features.ionizer) {
            // ionizer on/off (0x360 on live notify packets: 0=OFF, 1=ON)
            this.addField(config, {
                id: 0x360,
                name: '',
                comp: 'ionizer',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
                write_attach: [0x1f7, 0x1f9],
            })
        }

        if (features.uvNano) {
            // UVnano (0x2a2 on live notify packets: 0=OFF, 1=ON)
            this.addField(config, {
                id: 0x2a2,
                name: '',
                comp: 'uv_nano',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
                write_attach: [0x1f7, 0x1f9],
            })
        }

        if (features.bucketLight) {
            // bucket light (0x21e on live notify packets: 0=OFF, 1=ON)
            this.addField(config, {
                id: 0x21e,
                name: '',
                comp: 'bucket_light',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
            })
        }

        if (features.offTimer) this.addTimerField(config, 0x21b, 'off_timer', 'Sleep timer', 'mdi:bed-clock', 9)

        // Wire bare state_topic/command_topic (expected by humidifier platform) to our 'power' property
        const hum = (config.components as any).humidifier
        hum.state_topic = '$this/humidifier-power'
        hum.command_topic = '$this/humidifier-power/set'

        this.setConfig(config)
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
         * HA unit is hours; TLV is minutes (hours×60), same as RAC timers on 0x21b.
         * Countdown notifies also report remaining time in minutes.
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
        return this.profile().fans.toHa[v] ?? 'unknown'
    }

    private publishFanSpeedState(override?: string) {
        const state = override ?? this.fanSpeedFromClip()
        this.HA.publishProperty(this.id, 'fan_speed-', state)
    }

    /** Return true to let TLVDevice send a plain 0x1fa write. */
    protected sendFanSpeedTlvs(_fan: number): boolean {
        return true
    }

    private publishBucketFullState(full: boolean) {
        if (!this.profile().features.bucketFull) return
        if (this.bucketFullHaState === full) return
        this.bucketFullHaState = full
        this.HA.publishProperty(this.id, 'bucket_full-', full ? 'ON' : 'OFF', { retain: true })
    }

    processKeyValue(k: number, v: number) {
        if (
            this.query_caps_timeout !== undefined &&
            CAPS_ONLY_TAGS.has(k) &&
            !(k === 0x336 && this.profile().combinedInitialResponse)
        ) {
            this.raw_clip_state[k] = v
            return
        }
        // Mode-fan capability rows (0x2d7/0x2d8/0x2d9) repeat once per mode — not global state.
        if (k === 0x2d7 || k === 0x2d8 || k === 0x2d9) return
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
                t === 0x21b ||
                t === 0x21e ||
                t === 0x2b2 ||
                t === 0x253 ||
                t === 0x2a2 ||
                t === 0x336 ||
                t === 0x360,
        )
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
    }
}
