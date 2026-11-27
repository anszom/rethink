import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WD722RH water purifier, matched on modelId "1WPD6CMIDR__3" (thinq2 deviceType 103).
//
// Two frame families arrive, both in the long AABB envelope:
//
//   - config: a 0xEC envelope carrying two 126-byte records (previous, current), handled by
//     processEnvelopedStatus. Locks, feature toggles, display and sound settings, ice and
//     hot-water state live here.
//   - state: a longer frame with dispense amounts and the last dispensed water type. Its byte 10
//     counts a variable-length region starting at byte 12; once that region is removed every
//     state frame is STATE_LEN bytes long, whatever its size on the wire.
//
// Settings are written with a 145-byte sparse payload: an F0 17 header, then the config record
// layout with 0xFF in every byte that is left unchanged. The appliance echoes the write back in
// the next config record.
//
// Ice maker, dispensing and sterilisation stay read-only: their states are decoded, but the
// commands that change them have not been captured.

const CLASS_BYTE = 0x12
const CONFIG_RECORD_LEN = 126

const STATE_VARLEN_OFFSET = 10
const STATE_VAR_START = 12
const STATE_LEN = 330

/** Offsets into a normalised state frame. */
const STATE = {
    // The outlet of the last pour. It only changes when a dispense starts, not when the selection
    // on the panel changes.
    lastWaterType: 22,
    // 16-bit big-endian, like the other 16-bit fields in this frame
    normalAmount: 42,
    coldAmount: 44,
    hotAmount: 46,
} as const

/** Offsets into a config record. A write sets the same field at offset + WRITE_HEADER.length. */
const CONFIG = {
    cockState: 1,
    hotWaterTemp: 6,
    defaultWaterSet: 10,
    defaultWaterAmountMode: 11,
    buttonSound: 12,
    voiceGuidance: 13,
    voiceVolume: 14,
    sterilizeState: 23,
    hotWaterLock: 26,
    dndMode: 83,
    dndStartHour: 84,
    dndEndHour: 86,
    defaultHotWaterTemp: 90,
    iceMaker: 110,
    iceLock: 111,
    iceLever: 112,
    displayBrightness: 113,
    timeFormat: 114,
    childLock: 115,
    iceAmount: 116,
    coldWater: 117,
    productSound: 118,
    iceFirstMode: 119,
    clockOnStandbyScreen: 120,
    alwaysOnDisplay: 121,
    displayDimmingMin: 122,
    displayOffMin: 123,
    leverDispensingType: 124,
    dndIceMode: 125,
} as const

type ConfigField = keyof typeof CONFIG

const WRITE_HEADER = [0xf0, 0x17]
const WRITE_LEN = 145

/** LG's "no reading" value, used by the enums and by the hot water temperature. */
const NO_READING = 255

/** A dispense amount slot reads this while the outlet prepares (e.g. hot water heating up). */
const PREPARING = 2

const WATER_TYPE = Enum.of({
    'Hot water': 1,
    'Filtered water': 2,
    'Cold water': 3,
    'Sterilizing water': 4,
    Ice: 5,
})

const DEFAULT_WATER_TYPE = Enum.of({
    'Last used': 1,
    'Filtered water': 2,
    'Cold water': 3,
})

const DEFAULT_WATER_AMOUNT = Enum.of({
    '120ml': 1,
    '250ml': 2,
    '500ml': 3,
    '1000ml': 4,
    'Last used': 5,
})

const LEVER_DISPENSING_TYPE = Enum.of({
    'Press and hold': 0,
    Click: 1,
})

const DEFAULT_HOT_WATER_TEMP = Enum.of({
    '40 °C': 1,
    '70 °C': 2,
    '90 °C': 3,
})

// The wire carries the percentage itself. 0% is not offered on the panel.
const PERCENT_OPTIONS = Enum.of({
    '20%': 20,
    '40%': 40,
    '60%': 60,
    '80%': 80,
    '100%': 100,
})

const TIME_FORMAT = Enum.of({
    '12-hour': 0,
    '24-hour': 1,
})

// Display mode is two mutually exclusive config bytes; the code is (always-on << 1) | clock.
// Both bytes set has not been seen, so it reads as always-on and is never written.
const DISPLAY_MODE = new Enum<string>([
    ['Always on', [2, 3]],
    ['Clock on standby screen', 1],
    ['Off', 0],
])

const ICE_STATUS = Enum.of({
    Waiting: 0,
    'Drying (ice disabled)': 1,
    'Drying (ice enabled)': 2,
    Making: 3,
    Full: 4,
    Enough: 5,
})

const STERILIZE_STATE = Enum.of({
    Off: 0,
    'Auto (type A)': 1,
    'Auto (type B)': 2,
    'Manual (type A)': 3,
    Flush: 4,
    Cancelled: 5,
})

const OUTLET_STATE = Enum.of({
    Off: 0,
    On: 1,
    Manual: 2,
})

const DISPENSE_STATE = ['Idle', 'Preparing', 'Dispensing']

// Plain on/off settings and the config field each one is stored in.
const SWITCHES: Record<string, ConfigField> = {
    ice_lock: 'iceLock',
    ice_lever: 'iceLever',
    ice_first_mode: 'iceFirstMode',
    cold_water_enabled: 'coldWater',
    product_sound: 'productSound',
    button_sound: 'buttonSound',
    voice_guidance: 'voiceGuidance',
    dnd_mode: 'dndMode',
    dnd_ice_mode: 'dndIceMode',
}

// Writable enumerations and the config field each one is stored in.
const SELECTS: Record<string, [ConfigField, Enum<string>]> = {
    display_brightness: ['displayBrightness', PERCENT_OPTIONS],
    voice_volume: ['voiceVolume', PERCENT_OPTIONS],
    time_format: ['timeFormat', TIME_FORMAT],
    default_water_type: ['defaultWaterSet', DEFAULT_WATER_TYPE],
    default_water_amount: ['defaultWaterAmountMode', DEFAULT_WATER_AMOUNT],
    lever_dispensing_type: ['leverDispensingType', LEVER_DISPENSING_TYPE],
    default_hot_water_temp: ['defaultHotWaterTemp', DEFAULT_HOT_WATER_TEMP],
}

// Writable numbers, with the range accepted by the panel.
const NUMBERS: Record<string, [ConfigField, number, number]> = {
    dnd_start_hour: ['dndStartHour', 0, 23],
    dnd_end_hour: ['dndEndHour', 0, 23],
    display_dimming_min: ['displayDimmingMin', 1, 30],
    display_off_min: ['displayOffMin', 1, 30],
}

const component = (platform: string, id: string, name: string, extra: Record<string, unknown> = {}) => ({
    platform,
    unique_id: `$deviceid-${id}`,
    state_topic: `$this/${id}`,
    name,
    ...extra,
})

const sensor = (id: string, name: string, extra: Record<string, unknown> = {}) => component('sensor', id, name, extra)

const enumSensor = (id: string, name: string, options: string[], extra: Record<string, unknown> = {}) =>
    sensor(id, name, { device_class: 'enum', options, ...extra })

const binarySensor = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    component('binary_sensor', id, name, extra)

const writable = (platform: string, id: string, name: string, extra: Record<string, unknown> = {}) =>
    component(platform, id, name, { command_topic: `$this/${id}/set`, entity_category: 'config', ...extra })

const amount = (id: string, name: string, icon: string) =>
    // Each pour reports its own volume and then returns to 0, so this is not a running total.
    sensor(id, name, { unit_of_measurement: 'mL', icon })

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Water Purifier' }),
                components: {
                    last_water_type: enumSensor('last_water_type', 'Last dispensed water', WATER_TYPE.options, {
                        icon: 'mdi:water',
                    }),
                    dispense_state: enumSensor('dispense_state', 'Dispense state', DISPENSE_STATE, {
                        icon: 'mdi:cup-water',
                    }),
                    hot_water_amount: amount('hot_water_amount', 'Hot water poured', 'mdi:kettle-steam'),
                    cold_water_amount: amount('cold_water_amount', 'Cold water poured', 'mdi:snowflake'),
                    normal_water_amount: amount('normal_water_amount', 'Filtered water poured', 'mdi:water'),
                    hot_water_temp: sensor('hot_water_temp', 'Hot water temperature', {
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        state_class: 'measurement',
                    }),
                    ice_status: enumSensor('ice_status', 'Ice status', ICE_STATUS.options, {
                        icon: 'mdi:snowflake-variant',
                    }),
                    cock_state: enumSensor('cock_state', 'Outlet state', OUTLET_STATE.options, {
                        icon: 'mdi:water-outline',
                        entity_category: 'diagnostic',
                    }),
                    sterilize_state: enumSensor('sterilize_state', 'Sterilization', STERILIZE_STATE.options, {
                        icon: 'mdi:shimmer',
                        entity_category: 'diagnostic',
                    }),
                    child_lock: binarySensor('child_lock', 'Child lock', {
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    }),
                    ice_maker: binarySensor('ice_maker', 'Ice maker', {
                        icon: 'mdi:snowflake-variant',
                        entity_category: 'diagnostic',
                    }),
                    hot_water_lock: writable('switch', 'hot_water_lock', 'Hot water lock', { icon: 'mdi:lock' }),
                    ice_lock: writable('switch', 'ice_lock', 'Ice lock', { icon: 'mdi:lock' }),
                    ice_lever: writable('switch', 'ice_lever', 'Ice-only lever', { icon: 'mdi:toggle-switch' }),
                    ice_first_mode: writable('switch', 'ice_first_mode', 'Ice-first mode', {
                        icon: 'mdi:snowflake-alert',
                    }),
                    cold_water_enabled: writable('switch', 'cold_water_enabled', 'Cold water enabled', {
                        icon: 'mdi:snowflake',
                    }),
                    dnd_mode: writable('switch', 'dnd_mode', 'Do not disturb', { icon: 'mdi:volume-off' }),
                    dnd_ice_mode: writable('switch', 'dnd_ice_mode', 'Ice making during do not disturb', {
                        icon: 'mdi:snowflake-alert',
                    }),
                    // The panel shows local time, but the wire carries the hour in UTC.
                    dnd_start_hour: writable('number', 'dnd_start_hour', 'Do not disturb start hour (UTC)', {
                        min: 0,
                        max: 23,
                        step: 1,
                        icon: 'mdi:clock-start',
                    }),
                    dnd_end_hour: writable('number', 'dnd_end_hour', 'Do not disturb end hour (UTC)', {
                        min: 0,
                        max: 23,
                        step: 1,
                        icon: 'mdi:clock-end',
                    }),
                    display_brightness: writable('select', 'display_brightness', 'Display brightness', {
                        options: PERCENT_OPTIONS.options,
                        icon: 'mdi:brightness-6',
                    }),
                    time_format: writable('select', 'time_format', 'Time format', {
                        options: TIME_FORMAT.options,
                        icon: 'mdi:clock-outline',
                    }),
                    display_mode: writable('select', 'display_mode', 'Display mode', {
                        options: DISPLAY_MODE.options,
                        icon: 'mdi:monitor',
                    }),
                    display_dimming_min: writable('number', 'display_dimming_min', 'Display dimming timeout', {
                        min: 1,
                        max: 30,
                        step: 1,
                        unit_of_measurement: 'min',
                        icon: 'mdi:brightness-4',
                    }),
                    display_off_min: writable('number', 'display_off_min', 'Display off timeout', {
                        min: 1,
                        max: 30,
                        step: 1,
                        unit_of_measurement: 'min',
                        icon: 'mdi:monitor-off',
                    }),
                    product_sound: writable('switch', 'product_sound', 'Product sound', { icon: 'mdi:volume-high' }),
                    voice_volume: writable('select', 'voice_volume', 'Voice volume', {
                        options: PERCENT_OPTIONS.options,
                        icon: 'mdi:volume-medium',
                    }),
                    button_sound: writable('switch', 'button_sound', 'Button sound', { icon: 'mdi:volume-medium' }),
                    voice_guidance: writable('switch', 'voice_guidance', 'Voice guidance', {
                        icon: 'mdi:account-voice',
                    }),
                    default_water_type: writable('select', 'default_water_type', 'Default water type', {
                        options: DEFAULT_WATER_TYPE.options,
                        icon: 'mdi:cup-water',
                    }),
                    default_water_amount: writable('select', 'default_water_amount', 'Default water amount', {
                        options: DEFAULT_WATER_AMOUNT.options,
                        icon: 'mdi:cup',
                    }),
                    lever_dispensing_type: writable('select', 'lever_dispensing_type', 'Lever dispensing type', {
                        options: LEVER_DISPENSING_TYPE.options,
                        icon: 'mdi:gesture-tap-button',
                    }),
                    default_hot_water_temp: writable(
                        'select',
                        'default_hot_water_temp',
                        'Default hot water temperature',
                        {
                            options: DEFAULT_HOT_WATER_TEMP.options,
                            icon: 'mdi:thermometer',
                        },
                    ),
                },
            }),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'hot_water_lock') {
            // inverted on the wire: 0 is locked
            if (mqttValue === 'ON' || mqttValue === 'OFF') this.write({ hotWaterLock: mqttValue === 'ON' ? 0 : 1 })
        } else if (prop in SWITCHES) {
            if (mqttValue === 'ON' || mqttValue === 'OFF') this.write({ [SWITCHES[prop]]: mqttValue === 'ON' ? 1 : 0 })
        } else if (prop in SELECTS) {
            const [field, values] = SELECTS[prop]
            const code = values.unmap(mqttValue)
            if (code !== undefined) this.write({ [field]: code })
        } else if (prop in NUMBERS) {
            const [field, min, max] = NUMBERS[prop]
            const value = Number(mqttValue)
            if (Number.isInteger(value) && value >= min && value <= max) this.write({ [field]: value })
        } else if (prop === 'display_mode') {
            const code = DISPLAY_MODE.unmap(mqttValue)
            if (code !== undefined) this.write({ clockOnStandbyScreen: code & 1, alwaysOnDisplay: code >> 1 })
        }
    }

    private write(fields: Partial<Record<ConfigField, number>>) {
        const payload = Buffer.alloc(WRITE_LEN, 0xff)
        payload.set(WRITE_HEADER)
        for (const [field, value] of Object.entries(fields))
            payload[WRITE_HEADER.length + CONFIG[field as ConfigField]] = value
        this.send(payload)
    }

    processAABB(buf: Buffer) {
        if (this.processEnvelopedStatus(buf, CLASS_BYTE, CONFIG_RECORD_LEN, this.processConfig)) return

        const state = this.normaliseState(buf)
        if (state) this.processState(state)
    }

    /** Remove the variable-length region of a state frame; undefined for anything else. */
    private normaliseState(buf: Buffer): Buffer | undefined {
        if (buf.length <= STATE_VAR_START) return undefined

        const varLen = buf[STATE_VARLEN_OFFSET]
        if (STATE_VAR_START + varLen > buf.length) return undefined

        const state = Buffer.concat([buf.subarray(0, STATE_VAR_START), buf.subarray(STATE_VAR_START + varLen)])
        return state.length === STATE_LEN ? state : undefined
    }

    private processState(buf: Buffer) {
        this.publishEnum('last_water_type', WATER_TYPE, buf[STATE.lastWaterType])

        const amounts = [STATE.hotAmount, STATE.coldAmount, STATE.normalAmount].map((o) => buf.readUInt16BE(o))
        // An outlet that is still preparing has not poured anything yet.
        const preparing = amounts.includes(PREPARING)
        const [hot, cold, normal] = amounts.map((a) => (a === PREPARING ? 0 : a))
        const dispensing = hot > 0 || cold > 0 || normal > 0

        this.publishProperty('dispense_state', dispensing ? 'Dispensing' : preparing ? 'Preparing' : 'Idle')
        this.publishProperty('hot_water_amount', hot)
        this.publishProperty('cold_water_amount', cold)
        this.publishProperty('normal_water_amount', normal)
    }

    private processConfig(rec: Buffer) {
        this.publishEnum('cock_state', OUTLET_STATE, rec[CONFIG.cockState])
        this.publishEnum('ice_status', ICE_STATUS, rec[CONFIG.iceAmount])
        this.publishEnum('sterilize_state', STERILIZE_STATE, rec[CONFIG.sterilizeState])

        this.publishFlag('hot_water_lock', rec[CONFIG.hotWaterLock] === 0)
        this.publishFlag('child_lock', rec[CONFIG.childLock] === 1)
        this.publishFlag('ice_maker', rec[CONFIG.iceMaker] === 1)
        for (const [prop, field] of Object.entries(SWITCHES)) this.publishFlag(prop, rec[CONFIG[field]] === 1)

        for (const [prop, [field, values]] of Object.entries(SELECTS))
            this.publishEnum(prop, values, rec[CONFIG[field]])

        for (const [prop, [field]] of Object.entries(NUMBERS)) {
            const value = rec[CONFIG[field]]
            if (value !== NO_READING) this.publishProperty(prop, value)
        }

        const displayMode =
            (rec[CONFIG.alwaysOnDisplay] === 1 ? 2 : 0) | (rec[CONFIG.clockOnStandbyScreen] === 1 ? 1 : 0)
        this.publishEnum('display_mode', DISPLAY_MODE, displayMode)

        // Only valid while hot water is being poured; this is not the configured temperature.
        const temp = rec[CONFIG.hotWaterTemp]
        this.publishProperty('hot_water_temp', temp === NO_READING ? undefined : temp)
    }

    /** An unknown code leaves the previous value in place. */
    private publishEnum(prop: string, values: Enum<string>, code: number) {
        const label = values.map(code)
        if (label !== undefined) this.publishProperty(prop, label)
    }

    private publishFlag(prop: string, on: boolean) {
        this.publishProperty(prop, on ? 'ON' : 'OFF')
    }
}
