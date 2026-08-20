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

/** Entering these modes resets fan speed to low (high remains user-selectable). */
const SILENT_MODES = new Set([2, 19])

const HA_MODES = ['Smart', 'Jet', 'Silent', 'Spot', 'Laundry'] as const

const CLIP_TO_HA_MODE: Record<number, string> = {
    0: 'Smart',
    1: 'Jet',
    2: 'Silent',
    4: 'Spot',
    5: 'Laundry',
    17: 'Smart',
    18: 'Jet',
    19: 'Silent',
    20: 'Spot',
    21: 'Laundry',
}

const HA_TO_CLIP_MODE: Record<string, number> = {
    Smart: 17,
    Jet: 18,
    Silent: 19,
    Spot: 20,
    Laundry: 21,
}

/**
 * Per-mode fan capability table resent with every fan-speed write.
 *
 * The panel/device does not treat fan speed as a single global value alone: a write of
 * 0x1fa must be accompanied by a repeating 3-tuple capability declaration:
 *   0x2d7 = operating-mode id
 *   0x2d8 = 0 (always observed)
 *   0x2d9 = fan speed that mode should run at (2 = low, 6 = high)
 *
 * Most modes accept the requested fan speed. Laundry is fixed at high — that is a
 * property of the mode, not a special-case in the write path. Mode 22 appears in the
 * on-wire table on observed units but is not exposed in the ThinQ app / HA modes list.
 *
 * This is a capability declaration, not device state: it must not be stored in
 * raw_clip_state (those tags are not globally unique — they repeat once per mode row).
 */
type ModeFanCap = {
    mode: number
    /** When set, 0x2d9 is always this value; otherwise it follows the requested fan. */
    fixedFan?: 2 | 6
}

const MODE_FAN_CAPS: readonly ModeFanCap[] = [
    { mode: 17 }, // Smart
    { mode: 18 }, // Jet
    { mode: 20 }, // Spot
    { mode: 21, fixedFan: 6 }, // Laundry — high fan only
    { mode: 22 }, // present on-wire; not exposed in app
]

function normalizeHaMode(val: string): string {
    return val.charAt(0).toUpperCase() + val.slice(1).toLowerCase()
}

/**
 * LG Dehumidifier DHUM_056905_WW (e.g. models using 056905 platform, deviceType 403)
 */
export default class Device extends TLVDevice {
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
                    modes: [...HA_MODES],
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
                    options: ['low', 'high'],
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
            read_xform: (raw) => CLIP_TO_HA_MODE[raw] ?? `mode${raw}`,
            read_callback: () => {
                const mode = this.raw_clip_state[0x1f9]
                if (
                    mode != null &&
                    SILENT_MODES.has(mode) &&
                    (this.modeClipPrev == null || !SILENT_MODES.has(this.modeClipPrev))
                ) {
                    this.publishFanSpeedState('low')
                }
                if (mode != null) this.modeClipPrev = mode
                return true
            },
            write_xform: (val) => {
                if (val === 'off' || val === undefined) {
                    this.setProperty('humidifier-power', 'OFF')
                    return undefined
                }

                // Power on via attached 0x1f7
                this.raw_clip_state[0x1f7] = 1

                const mode = normalizeHaMode(val)
                const clip = HA_TO_CLIP_MODE[mode] ?? Number(val)
                if (mode === 'Silent' && (this.modeClipPrev == null || !SILENT_MODES.has(this.modeClipPrev))) {
                    this.raw_clip_state[0x1fa] = 2
                    this.publishFanSpeedState('low')
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
                const modes2ha: Record<number, string> = { 2: 'low', 6: 'high' }
                return modes2ha[raw] ?? raw.toString()
            },
            read_callback: (val) => {
                this.publishFanSpeedState(typeof val === 'string' ? val : String(val))
                return false
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { low: 2, high: 6 }
                return modes2clip[val] ?? Number(val)
            },
            write_callback: (val) => {
                if (val !== 2 && val !== 6) return false
                this.sendFanSpeedTlvs(val)
                return false
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
        if (v === 6) return 'high'
        if (v === 2) return 'low'
        return v != null ? String(v) : 'low'
    }

    private publishFanSpeedState(override?: string) {
        const state = override ?? this.fanSpeedFromClip()
        this.HA.publishProperty(this.id, 'fan_speed-', state)
    }

    /**
     * Build the fan-speed write payload: requested speed (0x1fa) plus MODE_FAN_CAPS rows.
     * Equivalent expanded form for fan=2:
     *   0x1fa=2,
     *   modeFan(17, 2), modeFan(18, 2), modeFan(20, 2),
     *   modeFan(21, 6), // Laundry always high
     *   modeFan(22, 2)
     */
    private buildFanSpeedTlvs(fan: 2 | 6): TLV.TLV[] {
        const modeFanRow = (mode: number, fanSpeed: number): TLV.TLV[] => [
            { t: 0x2d7, v: mode },
            { t: 0x2d8, v: 0 },
            { t: 0x2d9, v: fanSpeed },
        ]

        const tlvs: TLV.TLV[] = [{ t: 0x1fa, v: fan }]
        for (const { mode, fixedFan } of MODE_FAN_CAPS) {
            tlvs.push(...modeFanRow(mode, fixedFan ?? fan))
        }

        // Only the actual fan setpoint is device state; mode rows are a capability declaration.
        this.raw_clip_state[0x1fa] = fan
        return tlvs
    }

    private sendFanSpeedTlvs(fan: 2 | 6) {
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
