import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG water purifier, modelId 1WPD6CMIDR__3 (deviceType 103, "wpState" in the LG cloud).
//
// Passive by default: state is decoded without polling. Writes are exposed for every
// setting whose exact TX frame was captured from the ThinQ app: ice lock, ice-only lever,
// ice-first mode, hot water lock, cold water enable, display brightness, time format,
// display mode (always-on / waiting-screen clock / off), display dimming and off timers,
// product sound, voice volume, button sound, voice guidance, default water type, default
// water amount preset and lever dispensing type. Dispensing, sterilisation, ice maker and
// any other unverified command remain state-only.
//
// Every settable field lives in a 145-byte sparse config payload (0xF0 0x17 header
// followed by 0xFF filler). The appliance echoes the write into the 270-byte config
// frame at CONFIG_LEN in two records; the value only reaches its final resting place in
// the settled (second) record, whose offset is always the write offset + 137 — confirmed
// across all twelve captured settings, not assumed from a single one.
//
// Field offsets below were derived by replaying real captures alongside the decoded
// `wpState` values LG's cloud published for the same instants, keeping only offsets that
// agreed on every observation. See rethink-mapping/analysis/wp/FINDINGS.md.
//
// Two AA..BB frame families arrive. AABBDevice strips the envelope and passes
// raw.subarray(2, len-2), so every offset here is (raw offset - 2).
//
//   raw 336/337 — state:  dispense amounts, on-screen water selection
//   raw 270     — config: locks, feature toggles, ice, hot-water temperature
//
// State frames are not fixed-width: raw index 12 counts a variable region that begins at
// raw index 14. Both observed sizes collapse to 334 bytes once it is removed, and skipping
// that step shifts every later field by one byte on 337-byte frames.

/** Raw index of the variable-region length byte, in handler coordinates. */
const VARLEN_OFF = 10
/** Handler-coordinate start of the variable region. */
const VAR_START = 12
/** Length every state frame reaches after the variable region is removed. */
const STATE_NORMALISED_LEN = 330
/** Handler-coordinate length of a config frame. */
const CONFIG_LEN = 266

/** Offsets into a normalised state frame. */
const STATE = {
    /** Which outlet the last pour came from. It only advances when a dispense starts, so
     *  it is a record of the last pour rather than whatever screen the panel is showing —
     *  cycling the on-screen selection alone leaves the whole frame byte-identical. */
    lastWaterType: 22,
    normalAmount: 43,
    coldAmount: 45,
    hotAmount: 47,
} as const

// The config frame repeats every field in two 127-byte records; the second one settles a
// frame later than the first, so the later copy is the one that is safe to publish.
/** Offsets into a config frame. */
const CONFIG = {
    defaultWaterSet: 149,
    defaultWaterAmountMode: 150,
    cockState: 140,
    hotWaterTemp: 145,
    sterilizeState: 162,
    hotWaterLock: 165,
    buttonSoundOnOff: 151,
    voiceOnOff: 152,
    voiceVolume: 153,
    iceMaker: 249,
    iceLock: 250,
    iceLever: 251,
    productSoundOnOff: 257,
    deviceLock: 254,
    iceAmount: 255,
    coldWaterOnOff: 256,
    iceFirstMode: 258,
    alwaysOnDisplayOnOff: 259,
    clockOnOffInWaitingScreen: 260,
    displayDimmingMin: 261,
    displayOffMin: 262,
    leverDispensingType: 263,
    displayBrightness: 252,
    timeFormat: 253,
} as const

/** MonitoringValue.defaultWaterSet. */
const DEFAULT_WATER_SET: Record<number, string> = {
    1: 'RECENT_WATER',
    2: 'NORMAL_WATER',
    3: 'COLD_WATER',
}

/** MonitoringValue.defaultWaterAmountMode: which preset slot the lever dispenses. */
const DEFAULT_WATER_AMOUNT_MODE: Record<number, string> = {
    1: 'PRESET_120ML',
    2: 'PRESET_250ML',
    3: 'PRESET_500ML',
    4: 'PRESET_1000ML',
    5: 'LAST_USED',
}

/** MonitoringValue.leverDispensingType. */
const LEVER_DISPENSING_TYPE: Record<number, string> = {
    0: 'PRESSING',
    1: 'CLICK',
}

/** Display brightness presets exposed on the panel; the wire carries the literal percent. */
const DISPLAY_BRIGHTNESS_OPTIONS = ['20', '40', '60', '80', '100']

/** MonitoringValue.voiceVolume; the wire carries the literal percent, 0 is not offered on the panel. */
const VOICE_VOLUME_OPTIONS = ['20', '40', '60', '80', '100']

/** MonitoringValue.waterSelection. 5 is not in the model JSON but is what this unit
 *  records after an ice pour. */
const WATER_TYPE: Record<number, string> = {
    1: 'HOT_WATER',
    2: 'NORMAL_WATER',
    3: 'COLD_WATER',
    4: 'STERILIZATION_WATER',
    5: 'ICE',
}

/** MonitoringValue.iceAmount. */
const ICE_AMOUNT: Record<number, string> = {
    0: 'WAITING',
    1: 'DRYING_ICEDISABLE',
    2: 'DRYING_ICEENABLE',
    3: 'MAKING',
    4: 'FULL',
    5: 'ICE_ENOUGH',
}

/** MonitoringValue.highSterilizeState. */
const STERILIZE_STATE: Record<number, string> = {
    0: 'OFF',
    1: 'AUTO_DWP_A_TYPE',
    2: 'AUTO_DWP_B_TYPE',
    3: 'MANUAL_DWP_A_TYPE',
    4: 'FLUSH',
    5: 'CARE_CANCEL',
}

/** MonitoringValue.cockState. */
const COCK_STATE: Record<number, string> = { 0: 'OFF', 1: 'ON', 2: 'COCK_MANUAL_ON' }

/** Reported by dispense_state; PREPARING covers the pre-pour heating stage. */
const DISPENSE_STATES = ['IDLE', 'PREPARING', 'DISPENSING']

/** LG's "no reading" sentinel, shared by every MonitoringValue enum and by hotWaterTemp. */
const IGNORE = 255

/** Hot water reports this in its amount slot while it heats, before any water is poured. */
const PREPARING = 2

const enumSensor = (id: string, name: string, table: Record<number, string>, extra: Record<string, unknown> = {}) =>
    sensor(id, name, { device_class: 'enum', options: Object.values(table), ...extra })

const sensor = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    platform: 'sensor',
    unique_id: `$deviceid-${id}`,
    state_topic: `$this/${id}`,
    name,
    ...extra,
})

const binarySensor = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    platform: 'binary_sensor',
    unique_id: `$deviceid-${id}`,
    state_topic: `$this/${id}`,
    name,
    ...extra,
})

const controlSwitch = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    platform: 'switch',
    unique_id: `$deviceid-${id}`,
    state_topic: `$this/${id}`,
    command_topic: `$this/${id}/set`,
    name,
    ...extra,
})

const controlSelect = (id: string, name: string, options: string[], extra: Record<string, unknown> = {}) => ({
    platform: 'select',
    unique_id: `$deviceid-${id}`,
    state_topic: `$this/${id}`,
    command_topic: `$this/${id}/set`,
    options,
    name,
    ...extra,
})

const controlNumber = (
    id: string,
    name: string,
    range: { min: number; max: number; step?: number },
    extra: Record<string, unknown> = {},
) => ({
    platform: 'number',
    unique_id: `$deviceid-${id}`,
    state_topic: `$this/${id}`,
    command_topic: `$this/${id}/set`,
    min: range.min,
    max: range.max,
    step: range.step ?? 1,
    name,
    ...extra,
})

/** Enum table lookup, throwing away an unrecognised HA value instead of writing garbage. */
function reverseLookup(table: Record<number, string>, label: string): number | undefined {
    const entry = Object.entries(table).find(([, v]) => v === label)
    return entry ? Number(entry[0]) : undefined
}

/** Build the exact 145-byte inner payload used by the purifier's sparse config writes. */
function configCommandRaw(valueOffset: number, value: number): Buffer {
    const inner = Buffer.alloc(145, 0xff)
    inner[0] = 0xf0
    inner[1] = 0x17
    inner[valueOffset] = value
    return inner
}

/** Build a two-byte sparse config write, e.g. the mutually-exclusive display mode pair. */
function configCommandPair(offsetA: number, valueA: number, offsetB: number, valueB: number): Buffer {
    const inner = Buffer.alloc(145, 0xff)
    inner[0] = 0xf0
    inner[1] = 0x17
    inner[offsetA] = valueA
    inner[offsetB] = valueB
    return inner
}

const configCommand = (valueOffset: number, enabled: boolean) => configCommandRaw(valueOffset, enabled ? 1 : 0)

const millilitres = (id: string, name: string, icon: string) =>
    sensor(id, name, {
        unit_of_measurement: 'mL',
        icon,
        // Each dispense reports its own volume and then returns to 0, so this is a
        // momentary reading rather than a running total.
    })

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Water Purifier' }),
                components: {
                    last_water_type: enumSensor('last_water_type', 'Last dispensed water', WATER_TYPE, {
                        icon: 'mdi:water',
                    }),
                    dispense_state: sensor('dispense_state', 'Dispense state', {
                        icon: 'mdi:cup-water',
                        device_class: 'enum',
                        options: DISPENSE_STATES,
                    }),
                    dispensing: binarySensor('dispensing', 'Dispensing', { icon: 'mdi:water-pump' }),
                    hot_water_amount: millilitres('hot_water_amount', 'Hot water poured', 'mdi:kettle-steam'),
                    cold_water_amount: millilitres('cold_water_amount', 'Cold water poured', 'mdi:snowflake'),
                    normal_water_amount: millilitres('normal_water_amount', 'Filtered water poured', 'mdi:water'),
                    hot_water_temp: sensor('hot_water_temp', 'Hot water temperature', {
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        state_class: 'measurement',
                    }),
                    ice_status: enumSensor('ice_status', 'Ice status', ICE_AMOUNT, {
                        icon: 'mdi:snowflake-variant',
                    }),
                    cock_state: enumSensor('cock_state', 'Outlet state', COCK_STATE, {
                        icon: 'mdi:water-outline',
                        entity_category: 'diagnostic',
                    }),
                    sterilize_state: enumSensor('sterilize_state', 'Sterilisation mode', STERILIZE_STATE, {
                        icon: 'mdi:shimmer',
                        entity_category: 'diagnostic',
                    }),
                    sterilizing: binarySensor('sterilizing', 'Sterilising', { icon: 'mdi:shimmer' }),
                    hot_water_lock: controlSwitch('hot_water_lock', 'Hot water lock', { icon: 'mdi:lock' }),
                    ice_lock: controlSwitch('ice_lock', 'Ice lock', { icon: 'mdi:lock' }),
                    ice_lever: controlSwitch('ice_lever', 'Ice-only lever', {
                        icon: 'mdi:toggle-switch',
                    }),
                    ice_first_mode: controlSwitch('ice_first_mode', 'Ice-first mode', {
                        icon: 'mdi:snowflake-alert',
                    }),
                    child_lock: binarySensor('child_lock', 'Child lock', { icon: 'mdi:lock' }),
                    cold_water_enabled: controlSwitch('cold_water_enabled', 'Cold water enabled', {
                        icon: 'mdi:snowflake',
                        entity_category: 'diagnostic',
                    }),
                    ice_maker: binarySensor('ice_maker', 'Ice maker', {
                        icon: 'mdi:snowflake-variant',
                        entity_category: 'diagnostic',
                    }),
                    display_brightness: controlSelect(
                        'display_brightness',
                        'Display brightness',
                        DISPLAY_BRIGHTNESS_OPTIONS,
                        { icon: 'mdi:brightness-6', entity_category: 'config' },
                    ),
                    time_format: controlSelect('time_format', 'Time format', ['12', '24'], {
                        icon: 'mdi:clock-outline',
                        entity_category: 'config',
                    }),
                    display_mode: controlSelect(
                        'display_mode',
                        'Display mode',
                        ['ALWAYS_ON', 'WAITING_SCREEN_CLOCK', 'OFF'],
                        { icon: 'mdi:monitor', entity_category: 'config' },
                    ),
                    display_dimming_min: controlNumber(
                        'display_dimming_min',
                        'Display dimming timeout',
                        { min: 1, max: 30 },
                        { unit_of_measurement: 'min', icon: 'mdi:brightness-4', entity_category: 'config' },
                    ),
                    display_off_min: controlNumber(
                        'display_off_min',
                        'Display off timeout',
                        { min: 1, max: 30 },
                        { unit_of_measurement: 'min', icon: 'mdi:monitor-off', entity_category: 'config' },
                    ),
                    product_sound: controlSwitch('product_sound', 'Product sound', {
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                    }),
                    voice_volume: controlSelect('voice_volume', 'Voice volume', VOICE_VOLUME_OPTIONS, {
                        icon: 'mdi:volume-medium',
                        entity_category: 'config',
                    }),
                    button_sound: controlSwitch('button_sound', 'Button sound', {
                        icon: 'mdi:volume-medium',
                        entity_category: 'config',
                    }),
                    voice_guidance: controlSwitch('voice_guidance', 'Voice guidance', {
                        icon: 'mdi:account-voice',
                        entity_category: 'config',
                    }),
                    default_water_type: controlSelect(
                        'default_water_type',
                        'Default water type',
                        Object.values(DEFAULT_WATER_SET),
                        { icon: 'mdi:cup-water', entity_category: 'config' },
                    ),
                    default_water_amount: controlSelect(
                        'default_water_amount',
                        'Default water amount',
                        Object.values(DEFAULT_WATER_AMOUNT_MODE),
                        { icon: 'mdi:cup', entity_category: 'config' },
                    ),
                    lever_dispensing_type: controlSelect(
                        'lever_dispensing_type',
                        'Lever dispensing type',
                        Object.values(LEVER_DISPENSING_TYPE),
                        { icon: 'mdi:gesture-tap-button', entity_category: 'config' },
                    ),
                },
            }),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'ice_lock':
            case 'ice_lever':
            case 'ice_first_mode':
            case 'hot_water_lock':
            case 'cold_water_enabled':
            case 'product_sound':
            case 'button_sound':
            case 'voice_guidance':
                return this.setBooleanProperty(prop, mqttValue)
            case 'display_brightness':
                return this.setBrightness(mqttValue)
            case 'time_format':
                return this.setTimeFormat(mqttValue)
            case 'display_mode':
                return this.setDisplayMode(mqttValue)
            case 'display_dimming_min':
                return this.setTimeoutMinutes(CONFIG.displayDimmingMin - 137, mqttValue)
            case 'display_off_min':
                return this.setTimeoutMinutes(CONFIG.displayOffMin - 137, mqttValue)
            case 'voice_volume':
                return this.setVolume(mqttValue)
            case 'default_water_type':
                return this.setEnumProperty(CONFIG.defaultWaterSet - 137, DEFAULT_WATER_SET, mqttValue)
            case 'default_water_amount':
                return this.setEnumProperty(CONFIG.defaultWaterAmountMode - 137, DEFAULT_WATER_AMOUNT_MODE, mqttValue)
            case 'lever_dispensing_type':
                return this.setEnumProperty(CONFIG.leverDispensingType - 137, LEVER_DISPENSING_TYPE, mqttValue)
        }
    }

    /** Boolean toggles that only need a captured ON/OFF offset. */
    private setBooleanProperty(prop: string, mqttValue: string) {
        if (mqttValue !== 'ON' && mqttValue !== 'OFF') return
        const enabled = mqttValue === 'ON'
        const offsets: Record<string, number> = {
            ice_lock: 113,
            ice_lever: 114,
            ice_first_mode: 121,
            hot_water_lock: 28,
            cold_water_enabled: 119,
            product_sound: 120,
            button_sound: 14,
            voice_guidance: 15,
        }
        const offset = offsets[prop]
        // hotWaterLock's wire polarity is inverted relative to every other flag here: the
        // captured LOCK frame writes 0 and UNLOCK writes 1.
        const raw = prop === 'hot_water_lock' ? (enabled ? 0 : 1) : enabled ? 1 : 0
        if (offset !== undefined) this.send(configCommandRaw(offset, raw))
    }

    /** Display brightness: the wire carries the literal percent, captured at 20/40/60/80/100. */
    private setBrightness(mqttValue: string) {
        const value = Number(mqttValue)
        if (!DISPLAY_BRIGHTNESS_OPTIONS.includes(mqttValue)) return
        this.send(configCommandRaw(115, value))
    }

    /** Voice volume: same percent-literal wire encoding as brightness, captured at 20/60. */
    private setVolume(mqttValue: string) {
        if (!VOICE_VOLUME_OPTIONS.includes(mqttValue)) return
        this.send(configCommandRaw(16, Number(mqttValue)))
    }

    private setTimeFormat(mqttValue: string) {
        if (mqttValue !== '12' && mqttValue !== '24') return
        this.send(configCommandRaw(116, mqttValue === '24' ? 1 : 0))
    }

    /**
     * Display mode is a mutually-exclusive pair of bytes captured together: always-on
     * writes (0,1), waiting-screen-clock writes (1,0), off writes (0,0). No frame with
     * both bytes set to 1 was ever observed, so it is not offered as an option.
     */
    private setDisplayMode(mqttValue: string) {
        const pairs: Record<string, [number, number]> = {
            ALWAYS_ON: [0, 1],
            WAITING_SCREEN_CLOCK: [1, 0],
            OFF: [0, 0],
        }
        const pair = pairs[mqttValue]
        if (pair) this.send(configCommandPair(122, pair[0], 123, pair[1]))
    }

    /** Shared 1-30 minute range check for the two display timeout numbers. */
    private setTimeoutMinutes(offset: number, mqttValue: string) {
        const minutes = Number(mqttValue)
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) return
        this.send(configCommandRaw(offset, minutes))
    }

    /** Generic enum-table write, silently dropping any value HA should never send. */
    private setEnumProperty(offset: number, table: Record<number, string>, mqttValue: string) {
        const code = reverseLookup(table, mqttValue)
        if (code !== undefined) this.send(configCommandRaw(offset, code))
    }

    processAABB(buf: Buffer) {
        if (buf.length === CONFIG_LEN) return this.processConfig(buf)

        const state = this.normaliseState(buf)
        if (state) this.processState(state)
    }

    /**
     * Remove the variable-length region so a state frame reaches its fixed layout.
     * Returns undefined for anything that is not a state frame, including a frame whose
     * declared region would run past the end of the buffer.
     */
    private normaliseState(buf: Buffer): Buffer | undefined {
        if (buf.length <= VAR_START) return undefined

        const varLen = buf[VARLEN_OFF]
        if (VAR_START + varLen > buf.length) return undefined

        const normalised = Buffer.concat([buf.subarray(0, VAR_START), buf.subarray(VAR_START + varLen)])
        return normalised.length === STATE_NORMALISED_LEN ? normalised : undefined
    }

    private processState(buf: Buffer) {
        this.publishEnum('last_water_type', WATER_TYPE, buf[STATE.lastWaterType])

        const hot = buf[STATE.hotAmount]
        const cold = buf[STATE.coldAmount]
        const normal = buf[STATE.normalAmount]

        // Hot water announces itself before it pours: the amount slot reads 2 while the
        // outlet heats, then switches to the volume actually being dispensed. Reporting
        // that stage as "2 mL poured" would be wrong, so it is surfaced as PREPARING.
        const preparing = hot === PREPARING || cold === PREPARING || normal === PREPARING
        const amounts = [hot, cold, normal].map((a) => (a === PREPARING ? 0 : a))
        const dispensing = amounts.some((a) => a > 0)

        this.publishProperty('dispense_state', dispensing ? 'DISPENSING' : preparing ? 'PREPARING' : 'IDLE')
        this.publishProperty('dispensing', dispensing ? 'ON' : 'OFF')
        this.publishProperty('hot_water_amount', amounts[0])
        this.publishProperty('cold_water_amount', amounts[1])
        this.publishProperty('normal_water_amount', amounts[2])
    }

    private processConfig(buf: Buffer) {
        this.publishEnum('cock_state', COCK_STATE, buf[CONFIG.cockState])
        this.publishEnum('ice_status', ICE_AMOUNT, buf[CONFIG.iceAmount])

        const sterilize = buf[CONFIG.sterilizeState]
        this.publishEnum('sterilize_state', STERILIZE_STATE, sterilize)
        if (STERILIZE_STATE[sterilize] !== undefined) {
            this.publishProperty('sterilizing', sterilize === 0 ? 'OFF' : 'ON')
        }

        // hotWaterLock reads 1 for UNLOCK, so it is inverted relative to the other flags.
        this.publishFlag('hot_water_lock', buf[CONFIG.hotWaterLock] === 0)
        this.publishFlag('ice_lock', buf[CONFIG.iceLock] === 1)
        this.publishFlag('ice_lever', buf[CONFIG.iceLever] === 1)
        this.publishFlag('child_lock', buf[CONFIG.deviceLock] === 1)
        this.publishFlag('cold_water_enabled', buf[CONFIG.coldWaterOnOff] === 1)
        this.publishFlag('ice_maker', buf[CONFIG.iceMaker] === 1)
        this.publishFlag('ice_first_mode', buf[CONFIG.iceFirstMode] === 1)
        this.publishFlag('product_sound', buf[CONFIG.productSoundOnOff] === 1)
        this.publishFlag('button_sound', buf[CONFIG.buttonSoundOnOff] === 1)
        this.publishFlag('voice_guidance', buf[CONFIG.voiceOnOff] === 1)

        const brightness = buf[CONFIG.displayBrightness]
        if (brightness !== IGNORE) this.publishProperty('display_brightness', String(brightness))

        const volume = buf[CONFIG.voiceVolume]
        if (volume !== IGNORE) this.publishProperty('voice_volume', String(volume))

        this.publishProperty('time_format', buf[CONFIG.timeFormat] === 1 ? '24' : '12')

        const alwaysOn = buf[CONFIG.alwaysOnDisplayOnOff] === 1
        const waitingClock = buf[CONFIG.clockOnOffInWaitingScreen] === 1
        // The two bytes are mutually exclusive on the captures seen so far; alwaysOn wins
        // if both were somehow set, since that is the more visible state to be wrong about.
        this.publishProperty('display_mode', alwaysOn ? 'ALWAYS_ON' : waitingClock ? 'WAITING_SCREEN_CLOCK' : 'OFF')

        const dimmingMin = buf[CONFIG.displayDimmingMin]
        if (dimmingMin !== IGNORE) this.publishProperty('display_dimming_min', dimmingMin)

        const offMin = buf[CONFIG.displayOffMin]
        if (offMin !== IGNORE) this.publishProperty('display_off_min', offMin)

        this.publishEnum('default_water_type', DEFAULT_WATER_SET, buf[CONFIG.defaultWaterSet])
        this.publishEnum('default_water_amount', DEFAULT_WATER_AMOUNT_MODE, buf[CONFIG.defaultWaterAmountMode])
        this.publishEnum('lever_dispensing_type', LEVER_DISPENSING_TYPE, buf[CONFIG.leverDispensingType])

        const temp = buf[CONFIG.hotWaterTemp]
        // Live only during a hot pour, reverting to the sentinel once it ends: this is the
        // temperature of the water being served, not the configured setpoint (which the
        // appliance never puts on the wire). Clear it so a stale reading cannot linger.
        this.publishProperty('hot_water_temp', temp === IGNORE ? 'unknown' : temp)
    }

    /** Publish a decoded enum, leaving the previous value in place for an unlisted code. */
    private publishEnum(prop: string, table: Record<number, string>, code: number) {
        const label = table[code]
        if (label !== undefined) this.publishProperty(prop, label)
    }

    private publishFlag(prop: string, on: boolean) {
        this.publishProperty(prop, on ? 'ON' : 'OFF')
    }
}
