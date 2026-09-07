import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/**
 * LG PuriCare air purifier AIR_910604_WW (deviceType 402).
 *
 * The tag-name baseline, filter semantics and the write quirks below were
 * cross-checked against the earlier exact-model work in sosohage2/rethink-korea
 * commits c3cf559 and 387be48. That work's correction not to publish the
 * appliance's internal temperature (0x1fd) and humidity (0x336) as room
 * measurements is retained: neither tracks the room.
 *
 * Every writable field here was driven from the app and the resulting command
 * frame captured, so the values written are the ones LG itself sends:
 *
 *   0x1f7  power                 0/1
 *   0x1f9  operating mode        13 clean booster, 14 single, 15 dual, 16 auto
 *   0x1fa  main fan speed        2 low, 4 medium, 6 high, 7 turbo, 8 auto
 *   0x326  clean booster fan     same levels
 *   0x327  circulation rotation  0/1
 *   0x24e  clean indicator       0/1
 *   0x360  air sterilization     0/1
 *   0x21a  sleep timer           minutes, counts down
 *
 * Two appliance quirks, both observed rather than worked around:
 *
 * 1. A write that arrives while the unit is off is acknowledged and then
 *    ignored. Sending the power tag alongside does work and starts the unit
 *    directly in the requested state, so mode and fan writes force power on and
 *    attach it.
 * 2. While the operating mode is auto the appliance drives the fan itself and a
 *    bare fan write is ignored. Nothing is done about this - silently changing
 *    the user's mode to make a fan request stick would be worse.
 *
 * Setting the sleep timer also switches the clean indicator off; the appliance
 * reports both tags in one frame. That is its own behaviour, not something done
 * here.
 */
const MODES = new Enum([
    ['clean_booster', 13],
    ['single_clean', 14],
    ['dual_clean', 15],
    ['auto', 16],
] as [string, number][])

const FAN_SPEEDS = new Enum([
    ['low', 2],
    ['medium', 4],
    ['high', 6],
    ['turbo', 7],
    ['auto', 8],
] as [string, number][])

const TAG_POWER = 0x1f7
const TAG_MODE = 0x1f9
const TAG_FAN = 0x1fa
const TAG_BOOSTER_FAN = 0x326
const TAG_ROTATION = 0x327
const TAG_INDICATOR = 0x24e
const TAG_STERILIZE = 0x360
const TAG_SLEEP_TIMER = 0x21a

export default class Device extends TLVDevice {
    meta: Metadata
    configDone = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
        // The field map is fixed for this exact model and the appliance reports
        // its state unprompted, so nothing needs to be asked for. Writes still
        // go out normally; this only suppresses polling.
        if (this.query_caps_timeout != undefined) {
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
        }
        // Publish discovery immediately so a connection that only sees delta
        // frames is still usable.
        this.valuesReceived()
    }

    queryCaps() {
        // Capabilities are not queried; the exact-model field map is fixed.
    }

    query() {
        // State arrives unprompted, so no values query is sent.
    }

    start() {
        // No periodic refresh timer.
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === TAG_POWER)
    }

    valuesReceived() {
        if (this.configDone) return
        this.configDone = true
        this.initConfig()
    }

    initConfig() {
        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG PuriCare Air Purifier' }),
            components: {
                fan: {
                    platform: 'fan',
                    unique_id: '$deviceid-fan',
                    name: null,
                    icon: 'mdi:air-purifier',
                    preset_modes: FAN_SPEEDS.options,
                },
                mode: {
                    platform: 'select',
                    unique_id: '$deviceid-mode',
                    name: 'Mode',
                    icon: 'mdi:tune-variant',
                    options: MODES.options,
                },
                clean_booster_fan_speed: {
                    platform: 'select',
                    unique_id: '$deviceid-clean_booster_fan_speed',
                    name: 'Clean booster fan speed',
                    icon: 'mdi:fan',
                    options: FAN_SPEEDS.options,
                },
                sleep_timer: {
                    platform: 'number',
                    unique_id: '$deviceid-sleep_timer',
                    name: 'Sleep timer',
                    icon: 'mdi:sleep',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    min: 0,
                    max: 720,
                    step: 10,
                    mode: 'box',
                },
                pm1: {
                    platform: 'sensor',
                    unique_id: '$deviceid-pm1',
                    name: 'PM1.0',
                    device_class: 'pm1',
                    unit_of_measurement: 'µg/m³',
                    state_class: 'measurement',
                    suggested_display_precision: 0,
                },
                pm25: {
                    platform: 'sensor',
                    unique_id: '$deviceid-pm25',
                    name: 'PM2.5',
                    device_class: 'pm25',
                    unit_of_measurement: 'µg/m³',
                    state_class: 'measurement',
                    suggested_display_precision: 0,
                },
                pm10: {
                    platform: 'sensor',
                    unique_id: '$deviceid-pm10',
                    name: 'PM10',
                    device_class: 'pm10',
                    unit_of_measurement: 'µg/m³',
                    state_class: 'measurement',
                    suggested_display_precision: 0,
                },
                air_quality: {
                    platform: 'sensor',
                    unique_id: '$deviceid-air_quality',
                    name: 'Air quality index',
                    icon: 'mdi:weather-hazy',
                    state_class: 'measurement',
                },
                odor: {
                    platform: 'sensor',
                    unique_id: '$deviceid-odor',
                    name: 'Odor index',
                    icon: 'mdi:scent',
                    state_class: 'measurement',
                },
                error: {
                    platform: 'sensor',
                    unique_id: '$deviceid-error',
                    name: 'Error code',
                    icon: 'mdi:alert',
                    entity_category: 'diagnostic',
                },
                filter_life: {
                    platform: 'sensor',
                    unique_id: '$deviceid-filter_life',
                    name: 'Filter life',
                    icon: 'mdi:air-filter',
                    unit_of_measurement: '%',
                    state_class: 'measurement',
                },
                top_filter_life: {
                    platform: 'sensor',
                    unique_id: '$deviceid-top_filter_life',
                    name: 'Top filter life',
                    icon: 'mdi:air-filter',
                    unit_of_measurement: '%',
                    state_class: 'measurement',
                },
            },
        })

        // Power is the fan entity's own on/off. Turning on restores the last
        // mode and fan speed in the same frame, matching what the app sends.
        this.addField(config, {
            id: TAG_POWER,
            name: '',
            comp: 'fan',
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            write_attach: (raw) => (raw ? [TAG_MODE, TAG_FAN] : []),
        })

        // Main fan speed drives the fan entity's preset slot.
        this.addField(config, {
            id: TAG_FAN,
            name: 'preset_mode',
            comp: 'fan',
            read_xform: (raw) => FAN_SPEEDS.map(raw) ?? 'None',
            write_xform: (val) => {
                this.raw_clip_state[TAG_POWER] = 1 // quirk 1
                return FAN_SPEEDS.unmap(val)
            },
            write_attach: [TAG_POWER, TAG_MODE],
        })

        // Operating mode gets its own select: the fan platform's single preset
        // slot is already taken by the speed.
        this.addField(config, {
            id: TAG_MODE,
            name: '',
            comp: 'mode',
            read_xform: (raw) => MODES.map(raw) ?? 'None',
            write_xform: (val) => {
                this.raw_clip_state[TAG_POWER] = 1 // quirk 1
                return MODES.unmap(val)
            },
            write_attach: [TAG_POWER, TAG_FAN],
        })

        // The clean booster's circulation fan is reported and driven separately
        // from the main fan speed.
        this.addField(config, {
            id: TAG_BOOSTER_FAN,
            name: '',
            comp: 'clean_booster_fan_speed',
            read_xform: (raw) => FAN_SPEEDS.map(raw) ?? 'None',
            write_xform: (val) => {
                this.raw_clip_state[TAG_POWER] = 1 // quirk 1
                return FAN_SPEEDS.unmap(val)
            },
            write_attach: [TAG_POWER],
        })

        this.addSwitch(
            config,
            'circulation_rotation',
            TAG_ROTATION,
            'Circulation fan rotation',
            'mdi:rotate-3d-variant',
        )
        this.addSwitch(config, 'clean_indicator', TAG_INDICATOR, 'Clean indicator', 'mdi:lightbulb')
        this.addSwitch(config, 'air_sanitization', TAG_STERILIZE, 'Air sanitization', 'mdi:shield-sun')

        // Reported in minutes and counting down, so the entity shows the live
        // remaining time rather than what was requested.
        // The explicit write_xform is required: TLVDevice.setProperty leaves the
        // value undefined when a field has none, and then drops the write.
        this.addField(config, {
            id: TAG_SLEEP_TIMER,
            name: '',
            comp: 'sleep_timer',
            write_xform: (val) => Number(val),
        })

        const readonly = (id: number, comp: string) => this.addField(config, { id, name: '', comp, writable: false })

        readonly(0x333, 'pm1')
        readonly(0x334, 'pm25')
        readonly(0x335, 'pm10')
        readonly(0x240, 'air_quality')
        readonly(0x241, 'odor')
        readonly(0x221, 'error')

        // LG calls 0x355/0x363 "useTime", but physical-app comparison proved
        // they are hours remaining. Publish remaining / maximum as a percent.
        this.addFilterLife(config, 'filter_life', 0x355, 0x356)
        this.addFilterLife(config, 'top_filter_life', 0x363, 0x364)

        this.setConfig(config)

        // The first full frame arrived before fields were registered.
        for (const [id, value] of Object.entries(this.raw_clip_state)) {
            this.processKeyValue(Number(id), value)
        }
    }

    private addSwitch(config: DeviceDiscovery, comp: string, id: number, name: string, icon: string) {
        config.components[comp] = allowExtendedType({
            platform: 'switch',
            unique_id: `$deviceid-${comp}`,
            name,
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

    private addFilterLife(config: DeviceDiscovery, comp: string, remainTag: number, maxTag: number) {
        const recompute = () => {
            const remain = this.raw_clip_state[remainTag]
            const max = this.raw_clip_state[maxTag]
            if (remain != null && max != null && max > 0) {
                const percent = Math.max(0, Math.min(100, Math.round((remain / max) * 100)))
                this.HA.publishProperty(this.id, `${comp}-`, percent)
            }
            return false
        }

        this.addField(config, { id: remainTag, name: '', comp, writable: false, read_callback: recompute })
        this.addField(config, { id: maxTag, name: 'max', comp, writable: false, read_callback: recompute }, false)
    }
}
