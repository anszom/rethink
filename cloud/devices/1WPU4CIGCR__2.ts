import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type ComponentInfo, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'
import HADevice from './base'
import AABBDevice from './aabb_device'

/*
 * LG PuriCare Water Purifier (ATOM-U, ThinQ model 1WPU4CIGCR__2, deviceType 103).
 *
 * An AA..BB appliance. Its modelJSON declares no legacy control, but LG's capability API
 * (convert/control) does drive it, and it converts a capability command into the appliance's
 * own protocol — so the command frame below was captured from LG's cloud, each answered
 * CL-0000:
 *
 *   aa <len> f0 17 | <26-byte record, 0xff = leave this field alone> | ck bb
 *
 * The record is the same 26-byte layout the appliance reports, so the read map doubles as the
 * write map. The four-field sterilization reservation is read-only: a time-only write moves the
 * appliance's weekly day anchor, and LG's schema offers no way to preserve it.
 *
 * This driver is stateless: it publishes what each frame reports and lets Home Assistant hold
 * the history. Dispense volumes arrive as per-report deltas, which it sums into a monotonic
 * counter (reset to zero on restart) published as `total_increasing`, the same shape HA's
 * statistics engine already handles for energy meters.
 */

const HEADER_LEN = 2
const TRAILER_LEN = 0
const CLASS_TAG = 0x12
const RECORD_LEN = 26

/** The usage report is a fixed 14-byte body: `12 1f 00` then six big-endian dispense counters. */
const USAGE_BODY_LEN = 14

const OFF = {
    monStatus: 0,
    cockState: 1,
    waterSelection: 2,
    waterAmountMode: 3,
    tempUnit: 4,
    amountUnit: 5,
    hotWaterTemp: 6,
    notUseNotice: 8,
    defaultWaterSet: 10,
    defaultWaterAmountMode: 11,
    buttonSoundOnOff: 12,
    sterilizeInitMonth: 15,
    sterilizeInitDay: 16,
    sterilizeInitHour: 17,
    sterilizeInitMin: 18,
    autoCareOnOff: 20,
    monDataRefresh: 22,
    highSterilizeState: 23,
    filterFlushingState: 24,
    appVersion: 25,
} as const

/** `IGNORE` — LG's own sentinel for "this unit does not report the field", and, in a
 *  command frame, for "leave this field alone". */
const IGNORE = 0xff

/** Command frame opcode: `aa <len> f0 17 <record> <ck> bb`. See the header note. */
const SET_STATE = [0xf0, 0x17]

/** Volumes the appliance accepts as the default dispense, in mL (LG's own enum). */
const DEFAULT_AMOUNTS: [string, number][] = [
    ['120 mL', 1],
    ['250 mL', 2],
    ['500 mL', 3],
]

// Every enum below is modelJSON `MonitoringValue.<field>.valueMapping`, with English labels
// taken from this model's ko-KR language pack (@WP_* keys). Where LG left the label blank or
// reused another field's key, the mapping's own `_comment` is used instead.

/** wpState.monStatus */
const MON_STATUS: Record<number, string> = { 0: 'Fault', 1: 'Not operating', 2: 'Normal' }

/** wpState.cockState. COCK_MANUAL_ON is the manual-dispense hold. */
const COCK_STATE: Record<number, string> = { 0: 'Standby', 1: 'UVnano Sterilizing', 2: 'Manual dispensing' }

/** wpState.waterSelection — which tap was used last. */
const WATER_SELECTION: Record<number, string> = {
    1: 'Hot water',
    2: 'Purified',
    3: 'Cold water',
    4: 'Sterilized water',
}

/** wpState.waterAmountMode / defaultWaterAmountMode, in the unit wpState.amountUnit reports.
 *  Code 4 (Continuous) exists only for the live selection, not for the default. */
const WATER_AMOUNT: Record<number, string> = { 1: '120', 2: '250', 3: '500', 4: 'Continuous' }

/** wpState.hotWaterTemp — a code, not a temperature. `hotWaterTemp_C` maps it. */
const HOT_WATER_TEMP: Record<number, number> = { 1: 40, 2: 75, 3: 85 }

/** wpState.defaultWaterSet */
const DEFAULT_WATER: Record<number, string> = { 1: 'Last used', 2: 'Purified', 3: 'Cold water' }

/** wpState.highSterilizeState */
const STERILIZE_STATE: Record<number, string> = {
    0: 'Standby',
    1: 'Water line sterilizing',
    2: 'Water line sterilizing',
    3: 'Water line sterilizing',
    4: 'Outlet sterilizing',
    5: 'Cancelling sterilize',
}

/** wpState.filterFlushingState */
const FILTER_FLUSH: Record<number, string> = { 0: 'Off', 1: 'Filter replacement' }

/** wpState.tempUnit / amountUnit — settings the panel owns; diagnostic only. */
const TEMP_UNIT: Record<number, string> = { 0: '°F', 1: '°C' }
const AMOUNT_UNIT: Record<number, string> = { 0: 'oz', 1: 'mL' }

const enumOf = (table: Record<number, string>, raw: number) => table[raw] ?? `Code ${raw}`
const pad2 = (n: number) => String(n).padStart(2, '0')

type UsageTotals = { total: number; normal: number; cold: number; hot: number; sterilization: number }

export default class Device extends AABBDevice {
    private readonly legacyPlatformCleanup: DeviceDiscovery
    // Running dispense counters, summed from the per-report deltas. Reset to zero on restart;
    // published as total_increasing so Home Assistant accumulates and handles the reset itself.
    private readonly usage: UsageTotals = { total: 0, normal: 0, cold: 0, hot: 0, sterilization: 0 }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const sensor = (id: string, name: string, extra: object = {}) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            name,
            ...extra,
        })
        const volume = (id: string, name: string) =>
            sensor(id, name, {
                device_class: 'volume',
                unit_of_measurement: 'L',
                state_class: 'total_increasing',
                suggested_display_precision: 1,
            })

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Water Purifier' }),
            components: {
                status: sensor('status', 'State', { icon: 'mdi:water-check' }),
                water_selection: sensor('water_selection', 'Last dispense', { icon: 'mdi:water' }),
                water_amount: sensor('water_amount', 'Dispense volume', { icon: 'mdi:cup-water' }),
                hot_water_temp: sensor('hot_water_temp', 'Hot water temp', {
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    suggested_display_precision: 0,
                    // 0xff (IGNORE) publishes nothing, so the entity must tolerate a gap.
                    value_template: "{{ value if value | is_number else 'None' }}",
                }),
                cock_state: sensor('cock_state', 'Outlet state', { icon: 'mdi:shield-sun-outline' }),
                sterilize_state: sensor('sterilize_state', 'Sterilize state', { icon: 'mdi:shield-sun' }),
                filter_flushing: sensor('filter_flushing', 'Filter cleaning', { icon: 'mdi:air-filter' }),
                sterilize_reserved_at: sensor('sterilize_reserved_at', 'Sterilize schedule', {
                    icon: 'mdi:calendar-clock',
                }),
                sterilize_time: sensor('sterilize_time', 'Sterilize schedule time', {
                    icon: 'mdi:clock-outline',
                    entity_category: 'diagnostic',
                }),
                app_version: sensor('app_version', 'App version', { icon: 'mdi:tag', entity_category: 'diagnostic' }),
                data_refresh: sensor('data_refresh', 'Data refresh interval', {
                    icon: 'mdi:timer-outline',
                    entity_category: 'diagnostic',
                }),
                water_usage_today: volume('water_usage_today', 'Water dispensed'),
                water_usage_normal: volume('water_usage_normal', 'Purified dispensed'),
                water_usage_cold: volume('water_usage_cold', 'Cold water dispensed'),
                water_usage_hot: volume('water_usage_hot', 'Hot water dispensed'),
                water_usage_sterilization: volume('water_usage_sterilization', 'Rinse water dispensed'),
            },
        })

        // Home Assistant keys a device-discovery component by both component id and platform.
        // Removing the former platform first prevents the old sensor/binary_sensor registry
        // entries from surviving beside their select/switch replacements. Keep this cleanup
        // payload so every discovery replay (including a simultaneous HA/add-on restart) sends
        // the tombstones before the replacement config.
        this.legacyPlatformCleanup = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Water Purifier' }),
            components: {
                default_water: { platform: 'sensor' } as ComponentInfo,
                default_water_amount: { platform: 'sensor' } as ComponentInfo,
                auto_care: { platform: 'binary_sensor' } as ComponentInfo,
                not_use_notice: { platform: 'binary_sensor' } as ComponentInfo,
                sterilize_time: { platform: 'text' } as ComponentInfo,
            },
        })

        this.setConfig(config)
    }

    publishConfig() {
        if (this.legacyPlatformCleanup) this.HA.publishConfig(this.id, this.legacyPlatformCleanup)
        super.publishConfig()
    }

    // AABBDevice strips the leading AA/length and trailing CRC/BB, so byte 0 here is the class
    // tag and the record offsets need no whole-frame adjustment.
    processAABB(buf: Buffer) {
        if (buf[0] !== CLASS_TAG) return
        if (this.processUsage(buf)) return

        const payload = buf.length - HEADER_LEN - TRAILER_LEN
        if (payload <= 0 || payload % RECORD_LEN !== 0) return

        // The trailing record is the current state; a leading one, when present, is the previous.
        const record = buf.length - TRAILER_LEN - RECORD_LEN
        const at = (o: number) => buf[record + o]

        this.publishProperty('status', enumOf(MON_STATUS, at(OFF.monStatus)))
        this.publishProperty('cock_state', enumOf(COCK_STATE, at(OFF.cockState)))
        this.publishProperty('water_selection', enumOf(WATER_SELECTION, at(OFF.waterSelection)))
        this.publishProperty('sterilize_state', enumOf(STERILIZE_STATE, at(OFF.highSterilizeState)))
        this.publishProperty('filter_flushing', enumOf(FILTER_FLUSH, at(OFF.filterFlushingState)))
        this.publishProperty('default_water', enumOf(DEFAULT_WATER, at(OFF.defaultWaterSet)))
        this.publishProperty('temp_unit', enumOf(TEMP_UNIT, at(OFF.tempUnit)))
        this.publishProperty('amount_unit', enumOf(AMOUNT_UNIT, at(OFF.amountUnit)))

        // Volumes read in whatever unit wpState.amountUnit reports, so the unit travels with the value.
        const unit = AMOUNT_UNIT[at(OFF.amountUnit)] ?? 'mL'
        const amount = WATER_AMOUNT[at(OFF.waterAmountMode)]
        this.publishProperty(
            'water_amount',
            amount ? (amount === 'Continuous' ? amount : `${amount} ${unit}`) : 'Unknown',
        )
        // The DEFAULT volume is a select, so its state has to be one of the option strings —
        // and LG's setter enum for it is mL-only, unlike the live reading above.
        const dflt = DEFAULT_AMOUNTS.find(([, code]) => code === at(OFF.defaultWaterAmountMode))
        this.publishProperty('default_water_amount', dflt ? dflt[0] : 'Unknown')

        // hotWaterTemp is a 1/2/3 code, and 0xff means this unit is not reporting one.
        const hot = HOT_WATER_TEMP[at(OFF.hotWaterTemp)]
        this.publishProperty('hot_water_temp', hot ?? '')

        // Empty retained payload removes a previously retained state. Only the model's
        // documented 0/1 codes may become OFF/ON; IGNORE and future codes stay unknown.
        const binaryState = (raw: number) => (raw === 0 ? 'OFF' : raw === 1 ? 'ON' : '')
        this.publishProperty('button_sound', binaryState(at(OFF.buttonSoundOnOff)))
        this.publishProperty('auto_care', binaryState(at(OFF.autoCareOnOff)))
        this.publishProperty('not_use_notice', binaryState(at(OFF.notUseNotice)))

        // Four raw reservation bytes (month, day, hour, minute); 0xff in any field means "not set".
        const [month, day, hour, minute] = [
            OFF.sterilizeInitMonth,
            OFF.sterilizeInitDay,
            OFF.sterilizeInitHour,
            OFF.sterilizeInitMin,
        ].map(at)
        const set = ![month, day, hour, minute].includes(IGNORE)
        this.publishProperty('sterilize_reserved_at', set ? `${month}.${day} ${pad2(hour)}:${pad2(minute)}` : 'Not set')
        this.publishProperty('sterilize_time', set ? `${pad2(hour)}:${pad2(minute)}` : '')

        this.publishProperty('app_version', at(OFF.appVersion))
        this.publishProperty('data_refresh', at(OFF.monDataRefresh))
    }

    // The usage report: `12 1f 00` then six big-endian dispense counters (deltas since the last
    // report). Returns true when it consumed the frame so the state decode is skipped.
    private processUsage(buf: Buffer): boolean {
        if (buf.length !== USAGE_BODY_LEN || buf[1] !== 0x1f || buf[2] !== 0x00) return false

        const normal = buf[3]
        const hot = buf.readUInt16BE(4)
        const cold = buf.readUInt16BE(6)
        const sterilization = buf.readUInt16BE(12)
        const total = normal + hot + cold + buf.readUInt16BE(8) + buf.readUInt16BE(10) + sterilization
        if (total === 0) return true

        this.usage.total += total
        this.usage.normal += normal
        this.usage.cold += cold
        this.usage.hot += hot
        this.usage.sterilization += sterilization
        this.publishProperty('water_usage_today', this.usage.total)
        this.publishProperty('water_usage_normal', this.usage.normal)
        this.publishProperty('water_usage_cold', this.usage.cold)
        this.publishProperty('water_usage_hot', this.usage.hot)
        this.publishProperty('water_usage_sterilization', this.usage.sterilization)
        return true
    }

    private setField(offset: number, value: number) {
        const record = Buffer.alloc(RECORD_LEN, IGNORE)
        record[offset] = value
        this.send(Buffer.concat([Buffer.from(SET_STATE), record]))
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'default_water': {
                const code = Object.entries(DEFAULT_WATER).find(([, label]) => label === mqttValue)?.[0]
                if (code === undefined) return log('status', this.id, `Unknown default dispense ${mqttValue}`)
                return this.setField(OFF.defaultWaterSet, Number(code))
            }
            case 'default_water_amount': {
                const hit = DEFAULT_AMOUNTS.find(([label]) => label === mqttValue)
                if (!hit) return log('status', this.id, `Unknown default dispense volume ${mqttValue}`)
                return this.setField(OFF.defaultWaterAmountMode, hit[1])
            }
            case 'auto_care':
                if (mqttValue !== 'ON' && mqttValue !== 'OFF')
                    return log('status', this.id, `Invalid auto-care value ${mqttValue}`)
                return this.setField(OFF.autoCareOnOff, mqttValue === 'ON' ? 1 : 0)
            case 'not_use_notice':
                if (mqttValue !== 'ON' && mqttValue !== 'OFF')
                    return log('status', this.id, `Invalid disuse-alert value ${mqttValue}`)
                return this.setField(OFF.notUseNotice, mqttValue === 'ON' ? 1 : 0)
            default:
                log('status', this.id, `Item does not support writing ${prop}`)
        }
    }
}
