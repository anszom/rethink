import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/*
 * LG PuriCare air-purifying humidifier, ThinQ model HUM_056905_WW, deviceType 404.
 *
 * WHERE THE WIRE MAP COMES FROM
 * -----------------------------
 * Unlike the dehumidifier and the air conditioners, none of this was guessed from packet
 * diffs. This model's own modelJSON labels every state field with its clip tag —
 * "targetHumidity_state_tlv_595", "windStrength_state_tlv_506", and so on for all 38 fields
 * — so LG publishes the exact mapping. Each id below is that label, and each enum is that
 * field's `value_mapping` with English labels for LG's ko-KR language-pack entries.
 *
 * Nine of them were then confirmed on the wire, by driving the appliance from LG's cloud
 * (through the bridge) and watching what rethink relayed:
 *
 *   0x1f7 power        0/1                     0x1f9 opMode   Air Clean=5 Humidify+Clean=12 Humidify=24
 *   0x1fa windStrength Low=2 Mid=4 High=6 Turbo=7      0x253 target humidity, percent
 *   0x109 Night mode     0x1e4 Sleep mode  0x1e6 Auto operation
 *
 * The rest are LG's own declarations, published because the appliance reports them: every
 * id here appeared in the device's answer to a values query (0x1f5=2), so nothing below is
 * an entity for a field this unit does not have.
 *
 * 0x1fd is half-degrees, like the AC family: wire 55 = 27.5 degC, matching what the cloud
 * read from the same appliance at the same moment. 0x336 (humidity) is one-for-one.
 */

/** Half-degree tags — the AC family's convention, and this model shares it. */
const HALF_DEGREE = 2

/** 0x20e reports 252, not 1, for "on" — LG's own value_mapping says so. */
const AUTO_DRY_ON = 252

const OP_MODES = [
    ['Air Clean', 5],
    ['Humidify+Clean', 12],
    ['Humidify', 24],
] as const

const FAN_LEVELS = [
    ['Auto', 8],
    ['Low', 2],
    ['Mid', 4],
    ['High', 6],
    ['Turbo', 7],
] as const

const HYGIENE_DRY = [
    ['Off', 0],
    ['Gentle', 1],
    ['Quiet', 2],
    ['Quick', 3],
    ['Focus', 4],
    ['Default', 5],
] as const

const STANDBY_STERILIZE = [
    ['Rapid', 0],
    ['Normal', 1],
    ['Silent', 2],
    ['Power', 3],
] as const

const DISPLAY_BRIGHTNESS = [
    ['Off', 0],
    ['1Level', 8],
    ['2Level', 9],
    ['3Level', 10],
] as const

const SENSOR_MON = [
    ['While running only', 0],
    ['Always', 1],
] as const

/** 0x1e3, LG's humidifier.productStatus. */
const PRODUCT_STATUS: Record<number, string> = {
    0: 'Normal',
    1: 'No tank',
    2: 'Low water',
    3: 'Sterilizing',
    4: 'Drying',
    5: 'Boiling',
    6: 'Boiling (low)',
}

/** 0x3e0, LG's mood-light palette. Only the colours this model names are offered. */
const MOOD_COLORS: [string, number][] = [
    ['Blue', 1],
    ['Green', 2],
    ['Red', 3],
    ['Purple', 4],
    ['Yellow', 6],
    ['Pink', 7],
    ['Pure White', 8],
    ['Aquarium', 9],
    ['Candlelight', 10],
    ['Sunlight', 11],
    ['Rose', 12],
    ['Mint', 13],
    ['Lime', 14],
    ['Very Peri', 15],
    ['Warm White', 16],
    ['Cool White', 17],
    ['Sapphire', 18],
    ['Rainbow', 19],
]

type Levels = readonly (readonly [string, number])[]

export default class Device extends TLVDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Humidifying Air Purifier' }),
            components: {
                humidifier: {
                    platform: 'humidifier',
                    unique_id: '$deviceid-humidifier',
                    name: null,
                    device_class: 'humidifier',
                    modes: OP_MODES.map(([label]) => label),
                    // LG's own value_validation for airState.humidity.desired.
                    min_humidity: 0,
                    max_humidity: 100,
                },
            },
        })

        // Power (0x1f7). The humidifier platform's bare state/command topics are wired to it below.
        this.addField(
            config,
            {
                id: 0x1f7,
                name: 'power',
                comp: 'humidifier',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
            },
            false,
        )

        // Operating mode (0x1f9) — the humidifier entity's `mode`.
        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'humidifier',
            read_xform: (raw) => OP_MODES.find(([, wire]) => wire === raw)?.[0] ?? `mode${raw}`,
            write_xform: (val) => {
                const hit = OP_MODES.find(([label]) => label === val)
                if (!hit) return undefined
                // Selecting a mode while off is how the LG app turns it on.
                this.raw_clip_state[0x1f7] = 1
                return hit[1]
            },
            write_attach: [0x1f7],
        })

        // Target humidity (0x253) — the humidifier entity's target.
        this.addField(config, {
            id: 0x253,
            name: 'target_humidity',
            comp: 'humidifier',
            write_xform: (val) => Math.round(Number(val) / 5) * 5,
        })

        // Current humidity (0x336) — read-only, its own sensor as well as the humidifier attribute.
        this.addSensor(config, 0x336, 'current_humidity', 'Current humidity', {
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
        })
        ;(config.components as any).humidifier.current_humidity_topic = '$this/current_humidity-'

        this.addSelect(config, 0x1fa, 'fan_speed', 'Fan speed', 'mdi:fan', FAN_LEVELS)
        this.addSelect(config, 0x1e9, 'hygiene_dry', 'Sanitary dry', 'mdi:hair-dryer', HYGIENE_DRY)
        this.addSelect(config, 0x164, 'standby_sterilize', 'Standby sterilize', 'mdi:shimmer', STANDBY_STERILIZE)
        this.addSelect(config, 0x21f, 'display', 'Screen brightness', 'mdi:brightness-6', DISPLAY_BRIGHTNESS)
        this.addSelect(config, 0x337, 'sensor_mon', 'Air quality sensor', 'mdi:motion-sensor', SENSOR_MON)
        this.addSelect(config, 0x3e0, 'mood_color', 'Mood light color', 'mdi:palette', MOOD_COLORS)

        this.addSwitch(config, 0x109, 'night_mode', 'Night mode', 'mdi:weather-night')
        this.addSwitch(config, 0x1e4, 'sleep_mode', 'Sleep mode', 'mdi:power-sleep')
        this.addSwitch(config, 0x1e6, 'auto_strength', 'Auto operation', 'mdi:autorenew')
        this.addSwitch(config, 0x1e7, 'humidify', 'Humidify', 'mdi:water')
        this.addSwitch(config, 0x117, 'over_prevention', 'Over-humidification prevention', 'mdi:water-alert')
        this.addSwitch(config, 0x161, 'anti_glare', 'Anti-glare', 'mdi:eye-off')
        this.addSwitch(config, 0x1b8, 'mood_light', 'Mood light', 'mdi:lightbulb-on')
        this.addSwitch(config, 0x3a0, 'bell_sound', 'Notification sound', 'mdi:bell')
        this.addSwitch(config, 0x20e, 'auto_dry', 'Auto dry', 'mdi:fan-auto', AUTO_DRY_ON)

        this.addNumber(config, 0x21e, 'watertank_light', 'Tank light brightness', 'mdi:lightbulb', 0, 200, 1)
        this.addNumber(config, 0x21b, 'off_timer', 'Off timer (min)', 'mdi:timer-off', 0, 720, 10)
        this.addNumber(config, 0x35a, 'start_time', 'Scheduled on time(HHMM)', 'mdi:clock-start', 0, 2400, 10)
        this.addNumber(config, 0x35b, 'stop_time', 'Scheduled off time(HHMM)', 'mdi:clock-end', 0, 2400, 10)

        this.addSensor(config, 0x1fd, 'temperature', 'Current temperature', {
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            read_xform: (raw: number) => raw / HALF_DEGREE,
        })
        this.addSensor(config, 0x333, 'pm1', 'PM1.0', {
            device_class: 'pm1',
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addSensor(config, 0x334, 'pm25', 'PM2.5', {
            device_class: 'pm25',
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addSensor(config, 0x335, 'pm10', 'PM10', {
            device_class: 'pm10',
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
        })
        this.addSensor(config, 0x240, 'air_quality', 'Overall air quality', {
            icon: 'mdi:air-filter',
            state_class: 'measurement',
        })
        this.addSensor(config, 0x1ee, 'watertank_remain', 'Tank level', {
            icon: 'mdi:cup-water',
            unit_of_measurement: '%',
            state_class: 'measurement',
        })
        this.addSensor(config, 0x2ad, 'watertank_time', 'Tank time remaining', {
            icon: 'mdi:timer-sand',
            unit_of_measurement: 'min',
        })
        this.addSensor(config, 0x1ed, 'water_filter', 'Water filter level', {
            icon: 'mdi:filter',
            unit_of_measurement: '%',
            state_class: 'measurement',
        })
        this.addSensor(config, 0x355, 'filter_used', 'Filter usage hours', {
            icon: 'mdi:filter-outline',
            entity_category: 'diagnostic',
        })
        this.addSensor(config, 0x356, 'filter_max', 'Filter replacement cycle', {
            icon: 'mdi:filter-cog',
            entity_category: 'diagnostic',
        })
        this.addSensor(config, 0x225, 'auto_dry_remain', 'Auto dry remaining', {
            icon: 'mdi:timer-sand',
            unit_of_measurement: 'min',
        })
        this.addSensor(config, 0x1e3, 'status', 'Operating state', {
            icon: 'mdi:information-outline',
            read_xform: (raw: number) => PRODUCT_STATUS[raw] ?? `State${raw}`,
        })
        this.addSensor(config, 0x221, 'error', 'Error code', {
            icon: 'mdi:alert-circle-outline',
            entity_category: 'diagnostic',
        })

        /*
         * Low water as its own alert. Only productStatus 2 (WATER_LACK) raises it: 1 (BUCKET_OFF)
         * is what the appliance reports whenever the tank is simply not seated, which it is not
         * while it runs as a plain air purifier, and an alarm for that would cry wolf. That state
         * stays visible on the Operating statesensor.
         */
        ;(config.components as any).water_lack = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-water_lack',
            name: 'Low water',
            device_class: 'problem',
            icon: 'mdi:water-off',
            payload_on: 'ON',
            payload_off: 'OFF',
            state_topic: '$this/water_lack-',
        }

        const hum = (config.components as any).humidifier
        hum.state_topic = '$this/humidifier-power'
        hum.command_topic = '$this/humidifier-power/set'

        this.setConfig(config)
    }

    /** A select whose options are English labels and whose wire values are LG's enum codes. */
    private addSelect(config: DeviceDiscovery, id: number, comp: string, desc: string, icon: string, levels: Levels) {
        config['components'][comp] = {
            platform: 'select',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            icon,
            options: levels.map(([label]) => label),
        } as any
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => levels.find(([, wire]) => wire === raw)?.[0],
            write_xform: (val) => levels.find(([label]) => label === val)?.[1],
        })
    }

    private addSwitch(config: DeviceDiscovery, id: number, comp: string, desc: string, icon: string, onValue = 1) {
        config['components'][comp] = {
            platform: 'switch',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            icon,
        } as any
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => (raw === onValue ? 'ON' : 'OFF'),
            write_xform: (val) => (val === 'ON' ? onValue : 0),
        })
    }

    private addNumber(
        config: DeviceDiscovery,
        id: number,
        comp: string,
        desc: string,
        icon: string,
        min: number,
        max: number,
        step: number,
    ) {
        config['components'][comp] = {
            platform: 'number',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            icon,
            min,
            max,
            step,
            mode: 'box',
        } as any
        this.addField(config, { id, name: '', comp, write_xform: (val) => Math.round(Number(val)) })
    }

    private addSensor(
        config: DeviceDiscovery,
        id: number,
        comp: string,
        desc: string,
        opts: Record<string, unknown> & { read_xform?: (raw: number) => string | number },
    ) {
        const { read_xform, ...attrs } = opts
        config['components'][comp] = {
            platform: 'sensor',
            unique_id: `$deviceid-${comp}`,
            name: desc,
            ...attrs,
        } as any
        this.addField(config, { id, name: '', comp, writable: false, read_xform })
    }

    processKeyValue(k: number, v: number) {
        if (k === 0x1e3) this.HA.publishProperty(this.id, 'water_lack-', v === 2 ? 'ON' : 'OFF')
        super.processKeyValue(k, v)
    }

    /* 0x3e8 is reported only in the answer to a capabilities query (0x1f5=1) on this model. */
    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x3e8)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x1f7 || t === 0x1f9 || t === 0x1fa)
    }
}
