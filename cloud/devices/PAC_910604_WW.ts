import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/**
 * LG floor-standing air conditioner PAC_910604_WW (deviceType 401).
 *
 * Same TLV envelope as the RAC_056905_WW wall units (0xA7 header), but the field
 * set is incompatible, so it gets its own handler instead of an alias:
 * fan levels replicate across both bytes (level x 0x0101), horizontal swing is a
 * two-bit field, and human-sense / power modes / air-quality sensors are new tags.
 *
 * Read-only: the handler never transmits. All discovery entries are state-only
 * and setProperty() on any of them is a tested no-op.
 */

// Owner-verified on the physical unit (each toggle driven on the remote/app and
// confirmed on the wire, on->off round trips; PM/humidity cross-checked with the
// ThinQ app): 0x1f7 power, 0x1f9 mode (cool/dry only), 0x1fd/0x1fe temperatures
// (/2), 0x205 vertical swing, 0x206 horizontal swing, 0x208 human sense,
// 0x20d eco, 0x20f air clean, 0x21a sleep timer (minutes, up to 420),
// 0x225 auto-dry countdown (minutes), 0x236 cool power, 0x209 long power,
// 0x23e smart care, 0x23f smart guide,
// 0x333/0x334/0x335 PM1.0/PM2.5/PM10, 0x336 humidity.
const MODES = Enum.of({
    cool: 0,
    dry: 1,
})

// Observed levels: 2 (low), 4 (medium), 6 (high), 8 (auto),
// 7 (coolpower only), 9 (longpower only).
const FAN_LEVELS = new Enum([
    ['auto', 8],
    ['low', 2],
    ['medium', 4],
    ['high', 6],
    ['turbo', 7],
    ['max', 9],
] as [string, number][])

// Bit-split field: low byte = right vane, high byte = left vane.
const SWING_H = Enum.of({
    off: 0,
    right: 1,
    left: 256,
    both: 257,
})

const HUMAN_SENSE = Enum.of({
    off: 0,
    direct: 1,
    indirect: 2,
})

/**
 * Fan values arrive as level x 0x0101 (both bytes equal: 0x0202, 0x0404 ...).
 * While eco is engaging the device emits one frame with 0xFF in one of the
 * bytes (0xFF04 or 0x04FF observed); the other byte still carries the level.
 */
function fanLevel(raw: number): number {
    const lo = raw & 0xff
    const hi = (raw >> 8) & 0xff
    return lo === 0xff ? hi : lo
}

export default class Device extends TLVDevice {
    meta: Metadata
    configDone = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
        // Stay fully passive: never poll the appliance, only listen.
        if (this.query_caps_timeout != undefined) {
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
        }
    }

    queryCaps() {
        // Read-only: no capability query is ever sent.
    }

    query() {
        // Read-only: no values query is ever sent.
    }

    start() {
        // Read-only: no periodic refresh timer.
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x1f7)
    }

    valuesReceived() {
        if (this.configDone) return
        this.configDone = true
        this.initConfig()
    }

    getPowerTLV() {
        return this.raw_clip_state[0x1f7]
    }

    getModeTLV() {
        return this.raw_clip_state[0x1f9]
    }

    initConfig() {
        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Stand Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    temperature_unit: 'C',
                    // Setpoints move in whole degrees (raw steps of 2).
                    temp_step: 1,
                    precision: 1,
                    current_humidity_topic: '$this/humidity-',
                    // 18C forced by coolpower is the observed floor; above the
                    // observed 26C ceiling the range is unverified.
                    min_temp: 18,
                    max_temp: 30,
                    modes: ['off', ...MODES.options],
                    fan_modes: FAN_LEVELS.options,
                } satisfies ClimateComponent,
            },
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            writable: false,
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                this.HA.publishProperty(this.id, 'power-', val)
                // Re-evaluate 'mode' so it flips between 'off' and the set mode.
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })
        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            writable: false,
            read_xform: (raw) => {
                if (this.getPowerTLV() === 0) return 'off'
                return MODES.map(raw)
            },
        })
        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            writable: false,
            read_xform: (raw) => FAN_LEVELS.map(fanLevel(raw)),
        })

        // Binary sensor fields
        const powerComp = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-power',
            name: 'Power',
            state_topic: '$this/power-',
        }
        config['components']['power'] = powerComp

        const binaryFields = [
            { id: 0x205, name: 'swing_v', desc: 'Vertical swing' },
            { id: 0x20d, name: 'eco', desc: 'Energy saving' },
            { id: 0x20f, name: 'airclean', desc: 'Air purify' },
            { id: 0x23f, name: 'smartguide', desc: 'Smart guide' },
            { id: 0x236, name: 'coolpower', desc: 'Cool power' },
            { id: 0x209, name: 'longpower', desc: 'Long power' },
            { id: 0x23e, name: 'smartcare', desc: 'Smart care' },
        ]
        for (const f of binaryFields) {
            config['components'][f.name] = {
                platform: 'binary_sensor',
                unique_id: '$deviceid-' + f.name,
                name: f.desc,
            }
            this.addField(config, {
                id: f.id,
                name: '',
                comp: f.name,
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })
        }

        // Enum sensor fields
        const swingH = {
            platform: 'sensor',
            unique_id: '$deviceid-swing_h',
            name: 'Horizontal swing',
            device_class: 'enum',
            options: SWING_H.options,
        }
        config['components']['swing_h'] = swingH
        this.addField(config, {
            id: 0x206,
            name: '',
            comp: 'swing_h',
            writable: false,
            read_xform: (raw) => SWING_H.map(raw),
        })

        const humanSense = {
            platform: 'sensor',
            unique_id: '$deviceid-human_sense',
            name: 'Human sense',
            device_class: 'enum',
            options: HUMAN_SENSE.options,
        }
        config['components']['human_sense'] = humanSense
        this.addField(config, {
            id: 0x208,
            name: '',
            comp: 'human_sense',
            writable: false,
            read_xform: (raw) => HUMAN_SENSE.map(raw),
        })

        // PM sensors
        const pmExtra = {
            unit_of_measurement: 'µg/m³',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        const pm1Comp = {
            platform: 'sensor',
            unique_id: '$deviceid-pm1',
            name: 'PM1.0',
            device_class: 'pm1',
            ...pmExtra,
        }
        config['components']['pm1'] = pm1Comp
        this.addField(config, {
            id: 0x333,
            name: '',
            comp: 'pm1',
            writable: false,
        })

        const pm25Comp = {
            platform: 'sensor',
            unique_id: '$deviceid-pm25',
            name: 'PM2.5',
            device_class: 'pm25',
            ...pmExtra,
        }
        config['components']['pm25'] = pm25Comp
        this.addField(config, {
            id: 0x334,
            name: '',
            comp: 'pm25',
            writable: false,
        })

        const pm10Comp = {
            platform: 'sensor',
            unique_id: '$deviceid-pm10',
            name: 'PM10',
            device_class: 'pm10',
            ...pmExtra,
        }
        config['components']['pm10'] = pm10Comp
        this.addField(config, {
            id: 0x335,
            name: '',
            comp: 'pm10',
            writable: false,
        })

        // Humidity sensor
        const humComp = {
            platform: 'sensor',
            unique_id: '$deviceid-humidity',
            name: 'Humidity',
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        config['components']['humidity'] = humComp
        this.addField(config, {
            id: 0x336,
            name: '',
            comp: 'humidity',
            writable: false,
        })

        // Countdown timers in minutes
        const sleepTimerComp = {
            platform: 'sensor',
            unique_id: '$deviceid-sleep_timer',
            name: 'Sleep timer',
            device_class: 'duration',
            unit_of_measurement: 'min',
        }
        config['components']['sleep_timer'] = sleepTimerComp
        this.addField(config, {
            id: 0x21a,
            name: '',
            comp: 'sleep_timer',
            writable: false,
        })

        const dryRemainComp = {
            platform: 'sensor',
            unique_id: '$deviceid-dry_remain',
            name: 'Auto dry remaining',
            device_class: 'duration',
            unit_of_measurement: 'min',
        }
        config['components']['dry_remain'] = dryRemainComp
        this.addField(config, {
            id: 0x225,
            name: '',
            comp: 'dry_remain',
            writable: false,
        })

        this.setConfig(config)

        // The first full frame arrived before fields were registered. Replay its
        // cached values once so HA receives initial state without polling the unit.
        for (const [id, value] of Object.entries(this.raw_clip_state)) {
            this.processKeyValue(Number(id), value)
        }
    }
}
