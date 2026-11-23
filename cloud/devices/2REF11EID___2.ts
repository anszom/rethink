import HADevice from './base'
import T1Device from './t1_device'
import type { Device as Thinq1Device } from '../thinq1/device'
import type { ComponentInfo, Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { MON_START } from '../thinq1/rti'
import { STATUS_FIELDS, unpackStatus, type Status, type TemperatureUnit } from './fridge_common'

// LG LFXC22526S, ThinQ1. Layout and controls: modelJSON version 2.3,
// contentsId WW21063007020405374276. Live frame at 34 F / -2 F:
// 020d0a01020205000000ffffffff00 (door closed; byte 7 becomes 1 when open).
const FRIDGE_F: Record<number, number> = Object.fromEntries(
    [46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33].map((value, index) => [index + 1, value]),
)
const FREEZER_F: Record<number, number> = Object.fromEntries(
    [8, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -6].map((value, index) => [index + 1, value]),
)
const FRIDGE_C: Record<number, number> = { 1: 8, 3: 7, 5: 6, 7: 5, 9: 4, 10: 3, 12: 2, 14: 1 }
const FREEZER_C: Record<number, number> = { 1: -13, 2: -14, 3: -15, 5: -16, 7: -17, 9: -18, 11: -19, 12: -20, 13: -21 }
const ICE_PLUS = Enum.of({ OFF: 1, ON: 2 })
const ON_OFF = Enum.of({ OFF: 0, ON: 1 })
const AIR_MODE = Enum.of({ Auto: 2, Power: 3 })
const AIR_STATUS = Enum.of({ Auto: 2, Power: 3, Replace: 4 })
const SAVING_MODE = Enum.of({ Off: 0, 'Delay defrost': 2, 'Demand response': 3 })
const DISPLAY_LOCK = Enum.of({ Unlocked: 1, Locked: 2 })
const POLL_MS = 3000
// Allow brief gaps in monitoring replies without flickering HA availability.
const STATUS_TIMEOUT_MS = 90000
// Full-state commands must still use a recent snapshot; pending writes expire
// independently so an old request cannot be replayed after telemetry recovers.
const CONTROL_MAX_AGE_MS = 12000
const COMMAND_TIMEOUT_MS = 12000
type EnumControl = { field: keyof Status; values: Enum<string>; reported?: Enum<string> }
const ENUM_CONTROLS = {
    ice_plus: { field: 'expressFreeze', values: ICE_PLUS },
    fresh_air_filter_mode: { field: 'freshAirFilter', values: AIR_MODE, reported: AIR_STATUS },
    smart_saving_mode: { field: 'smartSaving', values: SAVING_MODE },
    sabbath_mode: { field: 'sabbathMode', values: ON_OFF },
} satisfies Record<string, EnumControl>
type EnumProperty = keyof typeof ENUM_CONTROLS
type ControlField = 'fridgeSetpoint' | 'freezerSetpoint' | (typeof ENUM_CONTROLS)[EnumProperty]['field']

function isEnumProperty(prop: string): prop is EnumProperty {
    return Object.prototype.hasOwnProperty.call(ENUM_CONTROLS, prop)
}

function controlValue(prop: EnumProperty, status: Status) {
    const { field, values } = ENUM_CONTROLS[prop]
    return values.map(status[field])
}

type ExtraConfig = {
    platform: 'switch' | 'select' | 'sensor' | 'binary_sensor'
    name: string
    icon?: string
    options?: string[]
    device_class?: 'enum' | 'problem'
    entity_category?: 'diagnostic'
    unit_of_measurement?: string
    suggested_display_precision?: number
}

// Optional entities are discovered only after the appliance reports a defined
// value. 255 does not mean off, unlocked, or an empty filter counter.
const EXTRA_CONFIG = {
    ice_plus: { platform: 'switch', name: 'Ice Plus', icon: 'mdi:snowflake' },
    fresh_air_filter_mode: {
        platform: 'select',
        name: 'Fresh air filter mode',
        options: AIR_MODE.options,
        icon: 'mdi:air-filter',
    },
    fresh_air_filter_status: {
        platform: 'sensor',
        name: 'Fresh air filter status',
        device_class: 'enum',
        options: AIR_STATUS.options,
        entity_category: 'diagnostic',
    },
    fresh_air_filter_replace: {
        platform: 'binary_sensor',
        name: 'Fresh air filter replacement needed',
        device_class: 'problem',
        entity_category: 'diagnostic',
    },
    water_filter_used_months: {
        platform: 'sensor',
        name: 'Water filter age',
        unit_of_measurement: 'months',
        suggested_display_precision: 0,
        entity_category: 'diagnostic',
    },
    water_filter_remaining_months: {
        platform: 'sensor',
        name: 'Water filter remaining',
        unit_of_measurement: 'months',
        suggested_display_precision: 0,
        entity_category: 'diagnostic',
    },
    water_filter_replace: {
        platform: 'binary_sensor',
        name: 'Water filter replacement needed',
        device_class: 'problem',
        entity_category: 'diagnostic',
    },
    smart_saving_mode: {
        platform: 'select',
        name: 'Smart saving mode',
        options: SAVING_MODE.options,
        icon: 'mdi:leaf',
    },
    smart_saving_active: { platform: 'binary_sensor', name: 'Smart saving active', icon: 'mdi:leaf' },
    sabbath_mode: { platform: 'switch', name: 'Sabbath mode' },
    temperature_unit: {
        platform: 'sensor',
        name: 'Temperature unit',
        device_class: 'enum',
        options: ['°F', '°C'],
        entity_category: 'diagnostic',
    },
    display_lock: {
        platform: 'sensor',
        name: 'Display lock',
        device_class: 'enum',
        options: DISPLAY_LOCK.options,
        entity_category: 'diagnostic',
    },
} satisfies Record<string, ExtraConfig>
type ExtraKey = keyof typeof EXTRA_CONFIG
const EXTRA_KEYS = Object.keys(EXTRA_CONFIG) as ExtraKey[]

function table(unit: TemperatureUnit, fridge: boolean): Record<number, number> {
    if (unit === 'C') return fridge ? FRIDGE_C : FREEZER_C
    return fridge ? FRIDGE_F : FREEZER_F
}

function extraValues(status: Status): Record<ExtraKey, string | number | undefined> {
    const air = AIR_STATUS.map(status.freshAirFilter)
    const months = status.waterFilter <= 6 ? status.waterFilter : undefined
    return {
        ice_plus: controlValue('ice_plus', status),
        fresh_air_filter_mode: controlValue('fresh_air_filter_mode', status),
        fresh_air_filter_status: air,
        fresh_air_filter_replace: air === undefined ? undefined : status.freshAirFilter === 4 ? 'ON' : 'OFF',
        water_filter_used_months: months,
        // LG explicitly defines remaining months as 6 minus the reported age.
        water_filter_remaining_months: months === undefined ? undefined : 6 - months,
        water_filter_replace: months === undefined ? undefined : months === 6 ? 'ON' : 'OFF',
        smart_saving_mode: controlValue('smart_saving_mode', status),
        smart_saving_active: ON_OFF.map(status.smartSavingRun),
        sabbath_mode: controlValue('sabbath_mode', status),
        temperature_unit: status.tempUnit === 0 ? '°F' : status.tempUnit === 1 ? '°C' : undefined,
        display_lock: DISPLAY_LOCK.map(status.displayLock),
    }
}

export default class Device extends T1Device {
    private unit?: TemperatureUnit
    private status?: Buffer
    private statusAt?: number
    private firmware?: string
    private supported = new Set<ExtraKey>()
    private pollTimer?: ReturnType<typeof setInterval>
    private staleTimer?: ReturnType<typeof setTimeout>
    private pending = new Map<ControlField, { code: number; expires: number }>()

    constructor(
        HA: Connection,
        thinq: Thinq1Device,
        readonly meta: Metadata,
    ) {
        super(HA, thinq, meta)
        this.stream.on('packet', (body) => {
            if (body.Cmd !== 'DevInfo' || body.Format !== 'B64' || typeof body.Data !== 'string') return
            const firmware = Buffer.from(body.Data, 'base64')
                .toString('utf8')
                .match(/(?:^|,)FwVer=([^,\r\n]+)/)?.[1]
            if (firmware && this.firmware !== firmware) {
                this.firmware = firmware
                if (this.unit) this.configure(this.unit)
            }
        })
    }

    start() {
        if (this.pollTimer) return
        super.start()
        // A fresh Mon/Start is needed for each snapshot on this fridge.
        this.pollTimer = setInterval(() => this.thinq.sendRaw(MON_START), POLL_MS)
        this.pollTimer.unref?.()
    }

    drop() {
        clearInterval(this.pollTimer)
        this.pollTimer = undefined
        this.invalidateStatus()
        super.drop()
    }

    private invalidateStatus() {
        clearTimeout(this.staleTimer)
        this.status = undefined
        this.statusAt = undefined
        this.pending.clear()
        this.publishProperty('availability', 'offline')
    }

    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', this.status ? 'online' : 'offline')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    private configure(unit: TemperatureUnit) {
        const temperature = (fridge: boolean) => {
            const key = fridge ? 'fridge_setpoint' : 'freezer_setpoint'
            const values = Object.values(table(unit, fridge))
            return {
                platform: 'number',
                device_class: 'temperature',
                unique_id: `$deviceid-${key}`,
                state_topic: `$this/${key}`,
                command_topic: `$this/${key}/set`,
                name: fridge ? 'Fridge target temperature' : 'Freezer target temperature',
                unit_of_measurement: unit === 'F' ? '°F' : '°C',
                min: Math.min(...values),
                max: Math.max(...values),
                step: 1,
                optimistic: false,
            }
        }
        const components: Record<string, ComponentInfo> = allowExtendedType({
            fridge_setpoint: temperature(true),
            freezer_setpoint: temperature(false),
            door: {
                platform: 'binary_sensor',
                device_class: 'door',
                unique_id: '$deviceid-door',
                state_topic: '$this/door',
                name: 'Door',
            },
        })
        for (const key of this.supported) {
            const field = EXTRA_CONFIG[key]
            const writable = field.platform === 'switch' || field.platform === 'select'
            components[key] = allowExtendedType({
                ...field,
                unique_id: `$deviceid-${key}`,
                state_topic: `$this/${key}`,
                ...(writable ? { command_topic: `$this/${key}/set`, optimistic: false } : {}),
                // Unknown optional values must not leave an available stale state.
                availability: [
                    { topic: '$this/availability' },
                    { topic: '$rethink/availability' },
                    { topic: `$this/${key}/availability` },
                ],
                availability_mode: 'all',
            })
        }
        this.setConfig({
            ...HADevice.config(this.meta, {
                name: 'LG Refrigerator',
                model: 'LFXC22526S',
                ...(this.firmware ? { sw_version: this.firmware } : {}),
            }),
            components,
        })
    }

    onStatus(buf: Buffer) {
        if (buf.length < 15) {
            this.invalidateStatus()
            this.log('Unexpected status length', buf.length)
            return
        }
        const status = unpackStatus(buf)
        const unit = status.tempUnit === 0 ? 'F' : status.tempUnit === 1 ? 'C' : undefined
        if (!unit) {
            this.invalidateStatus()
            this.publishProperty('fridge_setpoint', undefined)
            this.publishProperty('freezer_setpoint', undefined)
            return
        }
        const values = extraValues(status)
        let configure = this.unit !== unit
        if (configure) this.pending.clear()
        this.unit = unit
        for (const key of EXTRA_KEYS) {
            if (values[key] !== undefined && !this.supported.has(key)) {
                this.supported.add(key)
                configure = true
            }
        }
        this.status =
            status.anyDoorOpen === 0 || status.anyDoorOpen === 1 ? Buffer.from(buf.subarray(0, 15)) : undefined
        this.statusAt = this.status ? Date.now() : undefined
        if (configure) this.configure(unit)
        this.publishProperty('fridge_setpoint', table(unit, true)[status.fridgeSetpoint])
        this.publishProperty('freezer_setpoint', table(unit, false)[status.freezerSetpoint])
        this.publishProperty('door', status.anyDoorOpen === 0 ? 'OFF' : status.anyDoorOpen === 1 ? 'ON' : undefined)
        for (const key of this.supported) {
            this.publishProperty(key, values[key])
            this.publishProperty(`${key}/availability`, values[key] === undefined ? 'offline' : 'online')
        }
        for (const [field, pending] of this.pending) {
            if (status[field] === pending.code || Date.now() >= pending.expires || !this.knownControl(field, status))
                this.pending.delete(field)
        }
        this.publishProperty('availability', this.status ? 'online' : 'offline')
        clearTimeout(this.staleTimer)
        this.staleTimer = setTimeout(() => this.invalidateStatus(), STATUS_TIMEOUT_MS)
        this.staleTimer.unref?.()
    }

    private knownControl(field: ControlField, status: Status): boolean {
        if (field === 'fridgeSetpoint')
            return this.unit !== undefined && table(this.unit, true)[status.fridgeSetpoint] !== undefined
        if (field === 'freezerSetpoint')
            return this.unit !== undefined && table(this.unit, false)[status.freezerSetpoint] !== undefined
        const control: EnumControl | undefined = Object.values(ENUM_CONTROLS).find((entry) => entry.field === field)
        return control !== undefined && (control.reported ?? control.values).map(status[field]) !== undefined
    }

    setProperty(prop: string, mqttValue: string) {
        if (!this.status || this.statusAt === undefined || !this.unit) return
        if (Date.now() - this.statusAt >= CONTROL_MAX_AGE_MS) {
            this.log('Ignoring command: status snapshot is stale', prop)
            return
        }
        const status = unpackStatus(this.status)
        if (!this.knownControl('fridgeSetpoint', status) || !this.knownControl('freezerSetpoint', status)) return

        let field: ControlField, code: number | undefined
        if (prop === 'fridge_setpoint' || prop === 'freezer_setpoint') {
            const fridge = prop === 'fridge_setpoint'
            field = fridge ? 'fridgeSetpoint' : 'freezerSetpoint'
            const value = Number(mqttValue)
            if (!mqttValue.trim() || !Number.isInteger(value)) return
            const raw = Object.entries(table(this.unit, fridge)).find(([, v]) => v === value)?.[0]
            code = raw === undefined ? undefined : Number(raw)
        } else if (isEnumProperty(prop)) {
            const control = ENUM_CONTROLS[prop]
            field = control.field
            code = control.values.unmap(mqttValue)
        } else return
        if (code === undefined || !this.knownControl(field, status)) {
            this.log('Unsupported control value', prop, mqttValue)
            return
        }
        // LG's SetControl template: fields 1..14 with fixed IGNORE slots 8..12.
        // Water-filter age, door state and temperature unit are preserved, not
        // offered as controls merely because they occur in this template.
        const data = Buffer.from(this.status.subarray(1, 15))
        data.fill(0xff, 8, 13)
        this.pending.set(field, { code, expires: Date.now() + COMMAND_TIMEOUT_MS })
        for (const [field, pending] of this.pending) {
            if (Date.now() < pending.expires && this.knownControl(field, status))
                data[STATUS_FIELDS.indexOf(field) - 1] = pending.code
            else this.pending.delete(field)
        }
        this.sendCommand({ CmdOpt: 'Set', Value: 'ControlData', Format: 'B64', Data: data.toString('base64') })
    }
}
