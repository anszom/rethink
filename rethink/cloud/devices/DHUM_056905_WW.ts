import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/** TLV tags present in capability (0xA7/0x01) packets — store state but do not publish as entity values. */
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
        const config: DeviceDiscovery = allowExtendedType({
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
                } else {
                    this.setProperty('humidifier-power', 'ON')
                }
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

        // current humidity (observed on 0x1fd in device state packets, e.g. 0x30=48%)
        this.addField(config, {
            id: 0x1fd,
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

        this.addTimerField(config, 0x21b, 'off_timer', 'Sleep timer', 'mdi:bed-clock', 8)

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
            unit_of_measurement: 'min',
            min: 0,
            max: max,
            step: step,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * sends the remaining time (seconds); ceil to whole minutes for HA.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => {
                const val = Math.ceil(raw / 60 / step) * step
                return val > max ? 0 : val
            },
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

    /** Fan speed writes must include per-mode 0x2d7/0x2d8/0x2d9 triplets (see panel notify captures). */
    private buildFanSpeedTlvs(fan: 2 | 6): TLV.TLV[] {
        const modeFan = (mode: number, fanSpeed: number) => [
            { t: 0x2d7, v: mode },
            { t: 0x2d8, v: 0 },
            { t: 0x2d9, v: fanSpeed },
        ]
        const modes: [number, number][] =
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
                  ]
        const tlvs = [{ t: 0x1fa, v: fan }, ...modes.flatMap(([m, f]) => modeFan(m, f))]
        for (const { t, v } of tlvs) this.raw_clip_state[t] = v
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
        // 0x336 tracks humidity in live packets, not bucket level (was 45–50% during testing).
        if (k === 0x336) {
            this.raw_clip_state[k] = v
            return
        }
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

        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
    }
}
