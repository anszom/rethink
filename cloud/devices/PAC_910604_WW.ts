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
 * Passive listener: never polls or queries; transmits only user-initiated
 * control writes.
 *
 * Controllable (each write reproduces the app's captured command frame):
 * the climate entity (power, cool/dry, target temperature, fan, both swing
 * axes); air purify, energy saving and smart care switches; a wind-mode
 * selector (off / coolpower / longpower, sharing the app's single off frame);
 * a human sense selector; sleep, turn-on and turn-off timers in minutes.
 * Auto-dry enable/countdown, filter used/rated/remaining life, power draw,
 * air quality and diagnostics stay state-only.
 */

// Owner-verified on the physical unit (each toggle driven on the remote/app and
// confirmed on the wire, on->off round trips; PM/humidity cross-checked with the
// ThinQ app): 0x1f7 power, 0x1f9 mode (cool/dry only), 0x1fd/0x1fe temperatures
// (/2), 0x205 vertical swing, 0x206 horizontal swing, 0x208 human sense,
// 0x20d eco, 0x20f air clean, 0x21a sleep timer (minutes, up to 420),
// 0x225 auto-dry countdown (minutes), 0x20e auto-dry enabled,
// 0x236 cool power, 0x209 long power,
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

// Vertical swing is a plain on/off on this unit, unlike the RAC angle modes
// which select a vane angle. Only 0 and 1 have ever been seen on the wire.
const SWING_V = Enum.of({
    off: 0,
    on: 1,
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
        // The field map is fixed for this exact model, so discovery does not
        // need to wait for a full frame containing power. This also lets a
        // reconnect that receives only delta frames populate Home Assistant.
        this.valuesReceived()
    }

    queryCaps() {
        // The exact-model field map is fixed; capabilities are not queried.
    }

    query() {
        // State arrives unprompted, so no values query is sent.
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

    /** Wind mode is derived from two tags: coolpower wins, then longpower. */
    private publishWindMode() {
        const mode = this.raw_clip_state[0x236] ? 'coolpower' : this.raw_clip_state[0x209] ? 'longpower' : 'off'
        this.HA.publishProperty(this.id, 'wind_mode-', mode)
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
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            // The app never sends a setpoint alone; it repeats the mode and fan
            // it believes are current in the same frame.
            write_attach: [0x1f9, 0x1fa],
        })
        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            // Turning on restores the mode, fan and setpoint in one frame, which
            // is what the app does. Turning off sends the power tag alone.
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
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
            read_xform: (raw) => {
                if (this.getPowerTLV() === 0) return 'off'
                return MODES.map(raw)
            },
            write_xform: (val) => {
                // 'off' is not a wire mode: HA sends it to mean power off.
                if (val === 'off') {
                    this.setProperty('climate-power', 'OFF')
                    return undefined
                }
                this.raw_clip_state[0x1f7] = 1 // a write while off is ignored
                return MODES.unmap(val)
            },
            write_attach: [0x1f7, 0x1fa, 0x1fe],
        })
        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => FAN_LEVELS.map(fanLevel(raw)),
            write_xform: (val) => {
                const level = FAN_LEVELS.unmap(val)
                if (level === undefined) return undefined
                this.raw_clip_state[0x1f7] = 1
                // The appliance expects the level duplicated across both bytes.
                return level * 0x0101
            },
            write_attach: [0x1f7, 0x1f9, 0x1fe],
        })

        // Both swing axes live on the climate entity, as they do for the RAC
        // units, so Home Assistant shows them as the AC's own swing controls
        // rather than as loose entities next to it.
        config['components']['climate']['swing_modes'] = SWING_V.options
        this.addField(config, {
            id: 0x205,
            name: 'swing_mode',
            comp: 'climate',
            read_xform: (raw) => SWING_V.map(raw) ?? 'off',
            write_xform: (val) => SWING_V.unmap(val),
        })

        // The horizontal field is two bits: the low byte is the right vane and
        // the high byte the left, so all four combinations are selectable. Each
        // was driven separately on the unit to confirm the encoding; 'both' was
        // never captured as a command, only as the resulting state.
        config['components']['climate']['swing_horizontal_modes'] = SWING_H.options
        this.addField(config, {
            id: 0x206,
            name: 'swing_horizontal_mode',
            comp: 'climate',
            // 'off' rather than a discard, so an unseen combination does not
            // leave Home Assistant on a stale reading.
            read_xform: (raw) => SWING_H.map(raw) ?? 'off',
            write_xform: (val) => SWING_H.unmap(val),
        })

        // Appliance-internal status stays under diagnostics; the environment
        // readings and the user-facing controls stay primary.
        const powerComp = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-power',
            name: 'Power',
            state_topic: '$this/power-',
            entity_category: 'diagnostic',
        }
        config['components']['power'] = powerComp

        // State-only binaries. Writes were never captured for these.
        const binaryFields = [{ id: 0x23f, name: 'smartguide', desc: 'Smart guide' }]
        for (const f of binaryFields) {
            const comp = {
                platform: 'binary_sensor',
                unique_id: '$deviceid-' + f.name,
                name: f.desc,
                entity_category: 'diagnostic',
            }
            config['components'][f.name] = comp
            this.addField(config, {
                id: f.id,
                name: '',
                comp: f.name,
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })
        }

        // Single-tag switches: each write below reproduces the exact frame the
        // LG app sent for that toggle, captured on the physical unit.
        const switchFields = [
            { id: 0x20d, name: 'eco', desc: 'Energy saving' },
            { id: 0x20f, name: 'airclean', desc: 'Air purify' },
            { id: 0x23e, name: 'smartcare', desc: 'Smart care' },
        ]
        for (const f of switchFields) {
            config['components'][f.name] = {
                platform: 'switch',
                unique_id: '$deviceid-' + f.name,
                name: f.desc,
            }
            this.addField(config, {
                id: f.id,
                name: '',
                comp: f.name,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
            })
        }

        // Wind mode is one selector in the app (off / coolpower / longpower),
        // and the wire agrees: a single shared off frame, coolpower as a
        // direct 0x236 tag, longpower as a climate bundle with fan forced to
        // max. There is no observed 0x236=0 or 0x209=0 write, so off goes
        // through the captured bundle (fan fixed to high) instead.
        const WIND_MODES = ['off', 'coolpower', 'longpower'] as const
        const windModeComp = {
            platform: 'select',
            unique_id: '$deviceid-wind_mode',
            name: 'Wind mode',
            options: [...WIND_MODES],
        }
        config['components']['wind_mode'] = windModeComp
        this.addField(config, {
            id: 0x236,
            name: '',
            comp: 'wind_mode',
            read_callback: () => {
                this.publishWindMode()
                return false
            },
            write_xform: (val) => {
                if (val === 'coolpower') return 1
                if (val === 'longpower') return -1
                return 0
            },
            write_callback: (val) => {
                // coolpower takes the default single-tag path.
                if (val === 1) return true
                // longpower (-1) and off (0) share the climate-bundle shape:
                // current mode/target with the fan forced (max for longpower,
                // high for off, both exactly as the app sent them).
                const mode = this.raw_clip_state[0x1f9]
                const target = this.raw_clip_state[0x1fe]
                if (mode === undefined || target === undefined) return false
                const fan = val === -1 ? 2313 : 1542
                this.raw_clip_state[0x1fa] = fan
                this.send(
                    [1, 1, 2, 1, 1],
                    [
                        { t: 0x1f9, v: mode },
                        { t: 0x1fa, v: fan },
                        { t: 0x1fe, v: target },
                    ],
                )
                return false
            },
        })
        this.addField(
            config,
            {
                id: 0x209,
                name: 'windlong',
                comp: 'wind_mode',
                readable: false,
                read_callback: () => {
                    this.publishWindMode()
                    return false
                },
            },
            false,
        )

        const humanSense = {
            platform: 'select',
            unique_id: '$deviceid-human_sense',
            name: 'Human sense',
            options: HUMAN_SENSE.options,
        }
        config['components']['human_sense'] = humanSense
        this.addField(config, {
            id: 0x208,
            name: '',
            comp: 'human_sense',
            read_xform: (raw) => HUMAN_SENSE.map(raw),
            write_xform: (val) => HUMAN_SENSE.unmap(val),
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

        // Countdown timers in minutes on the wire (0 = cancelled). Sleep maxes
        // out at the observed 420; the reservations go to 1440 for stop
        // (observed) and share the same bound for start.
        const sleepTimerComp = {
            platform: 'number',
            unique_id: '$deviceid-sleep_timer',
            name: 'Sleep timer',
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: 420,
            step: 10,
            mode: 'box',
        }
        config['components']['sleep_timer'] = sleepTimerComp
        this.addField(config, {
            id: 0x21a,
            name: '',
            comp: 'sleep_timer',
            read_xform: (raw) => raw,
            write_xform: (val) => Math.round(Number(val)),
        })

        const startTimerComp = {
            platform: 'number',
            unique_id: '$deviceid-start_timer',
            name: 'Turn-on timer',
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: 1440,
            step: 60,
            mode: 'box',
        }
        config['components']['start_timer'] = startTimerComp
        this.addField(config, {
            id: 0x21c,
            name: '',
            comp: 'start_timer',
            read_xform: (raw) => raw,
            write_xform: (val) => Math.round(Number(val)),
        })

        const stopTimerComp = {
            platform: 'number',
            unique_id: '$deviceid-stop_timer',
            name: 'Turn-off timer',
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: 1440,
            step: 60,
            mode: 'box',
        }
        config['components']['stop_timer'] = stopTimerComp
        this.addField(config, {
            id: 0x21b,
            name: '',
            comp: 'stop_timer',
            read_xform: (raw) => raw,
            write_xform: (val) => Math.round(Number(val)),
        })

        const autoDryComp = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-autodry',
            name: 'Auto dry',
            icon: 'mdi:hair-dryer',
            entity_category: 'diagnostic',
        }
        config['components']['autodry'] = autoDryComp
        this.addField(config, {
            id: 0x20e,
            name: '',
            comp: 'autodry',
            writable: false,
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
        })

        const dryRemainComp = {
            platform: 'sensor',
            unique_id: '$deviceid-dry_remain',
            name: 'Auto dry remaining',
            device_class: 'duration',
            unit_of_measurement: 'min',
            entity_category: 'diagnostic',
        }
        config['components']['dry_remain'] = dryRemainComp
        this.addField(config, {
            id: 0x225,
            name: '',
            comp: 'dry_remain',
            writable: false,
        })

        // Filter counters are sent directly in normal PAC state frames, unlike
        // RAC's private filter-management command: 0x355 is hours used and
        // 0x356 is the rated lifetime. Publish the raw counters, remaining
        // hours and the percentage shown by the app. Do not expose RAC's reset
        // button here: no PAC reset command has been captured, and writing zero
        // to a counter or reusing RAC's private command would be a guess.
        const filterDuration = {
            platform: 'sensor',
            icon: 'mdi:air-filter',
            device_class: 'duration',
            unit_of_measurement: 'h',
            entity_category: 'diagnostic',
        } as const
        config['components']['filter_used_time'] = {
            ...filterDuration,
            unique_id: '$deviceid-filter_used_time',
            name: 'Filter used time',
        }
        config['components']['filter_life_time'] = {
            ...filterDuration,
            unique_id: '$deviceid-filter_life_time',
            name: 'Filter life time',
        }
        config['components']['filter_remaining'] = {
            ...filterDuration,
            unique_id: '$deviceid-filter_remaining',
            name: 'Filter remaining',
        }
        // Virtual fields register each manually-published state topic without
        // claiming another wire tag in fields_by_id.
        for (const comp of ['filter_used_time', 'filter_life_time', 'filter_remaining']) {
            this.addField(config, { id: 0, name: '', comp, writable: false })
        }
        const filterUsedComp = {
            platform: 'sensor',
            unique_id: '$deviceid-filter_used',
            name: 'Filter used',
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
            entity_category: 'diagnostic',
        }
        config['components']['filter_used'] = filterUsedComp
        const publishFilterUsed = () => {
            const used = this.raw_clip_state[0x355]
            const max = this.raw_clip_state[0x356]
            if (used != null && max != null && max > 0) {
                const remaining = Math.max(0, max - used)
                const percent = Math.max(0, Math.min(100, Math.round((used / max) * 100)))
                this.HA.publishProperty(this.id, 'filter_used_time-', used)
                this.HA.publishProperty(this.id, 'filter_life_time-', max)
                this.HA.publishProperty(this.id, 'filter_remaining-', remaining)
                this.HA.publishProperty(this.id, 'filter_used-', percent)
            }
            return false
        }
        this.addField(config, {
            id: 0x355,
            name: '',
            comp: 'filter_used',
            writable: false,
            read_callback: publishFilterUsed,
        })
        this.addField(
            config,
            {
                id: 0x356,
                name: 'max',
                comp: 'filter_used',
                writable: false,
                read_callback: publishFilterUsed,
            },
            false,
        )

        // Instantaneous power draw. The tag reads exactly 0 whenever the unit is
        // off and moves with the fan level and compressor load while running,
        // which is what identifies it. It is published raw: the -60 correction
        // the RAC units apply does not hold here, where readings as low as 32 W
        // occur while running and would go negative.
        const powerDrawComp = {
            platform: 'sensor',
            unique_id: '$deviceid-power_draw',
            name: 'Power',
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        config['components']['power_draw'] = powerDrawComp
        this.addField(config, {
            id: 0x2b3,
            name: '',
            comp: 'power_draw',
            writable: false,
        })

        // Diagnostic error code reported by the appliance; 0 while healthy.
        const errorComp = {
            platform: 'sensor',
            unique_id: '$deviceid-error',
            name: 'Error code',
            icon: 'mdi:alert',
            entity_category: 'diagnostic',
        }
        config['components']['error'] = errorComp
        this.addField(config, {
            id: 0x221,
            name: '',
            comp: 'error',
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
