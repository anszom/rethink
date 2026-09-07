import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG water purifier, modelId 1WPD6CMIDR__3 (deviceType 103, "wpState" in the LG cloud).
//
// Passive by default: state is decoded without polling. Writes are exposed only for
// ice lock, ice-only lever and ice-first mode, whose exact ON/OFF frames were captured.
// Dispensing, sterilisation and unverified feature commands remain state-only.
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
    cockState: 140,
    hotWaterTemp: 145,
    sterilizeState: 162,
    hotWaterLock: 165,
    iceMaker: 249,
    iceLock: 250,
    iceLever: 251,
    deviceLock: 254,
    iceAmount: 255,
    coldWaterOnOff: 256,
    iceFirstMode: 258,
} as const

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

/** Build the exact 145-byte inner payload used by the purifier's sparse config writes. */
function configCommand(valueOffset: number, enabled: boolean): Buffer {
    const inner = Buffer.alloc(145, 0xff)
    inner[0] = 0xf0
    inner[1] = 0x17
    inner[valueOffset] = enabled ? 1 : 0
    return inner
}

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
                    hot_water_lock: binarySensor('hot_water_lock', 'Hot water lock', { icon: 'mdi:lock' }),
                    ice_lock: controlSwitch('ice_lock', 'Ice lock', { icon: 'mdi:lock' }),
                    ice_lever: controlSwitch('ice_lever', 'Ice-only lever', {
                        icon: 'mdi:toggle-switch',
                    }),
                    ice_first_mode: controlSwitch('ice_first_mode', 'Ice-first mode', {
                        icon: 'mdi:snowflake-alert',
                    }),
                    child_lock: binarySensor('child_lock', 'Child lock', { icon: 'mdi:lock' }),
                    cold_water_enabled: binarySensor('cold_water_enabled', 'Cold water enabled', {
                        icon: 'mdi:snowflake',
                        entity_category: 'diagnostic',
                    }),
                    ice_maker: binarySensor('ice_maker', 'Ice maker', {
                        icon: 'mdi:snowflake-variant',
                        entity_category: 'diagnostic',
                    }),
                },
            }),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (mqttValue !== 'ON' && mqttValue !== 'OFF') return
        const enabled = mqttValue === 'ON'
        if (prop === 'ice_lock') this.send(configCommand(113, enabled))
        if (prop === 'ice_lever') this.send(configCommand(114, enabled))
        if (prop === 'ice_first_mode') this.send(configCommand(121, enabled))
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
