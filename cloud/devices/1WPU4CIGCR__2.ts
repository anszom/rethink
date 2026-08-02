import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type ComponentInfo, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import type {
    PurifierDailyUsage,
    PurifierHistoryState,
    PurifierHistoryStore,
    PurifierUsage,
} from '@/bridge/purifier-history-store'

/*
 * LG PuriCare Water Purifier (ATOM-U STS T20 Cold/Hot/Purified/Steril), ThinQ model 1WPU4CIGCR__2, deviceType 103.
 *
 * THE COMMAND FRAME, AND WHY IT LOOKED LIKE THERE WASN'T ONE
 * ----------------------------------------------------------
 * The first pass here concluded this appliance could not be controlled at all: its
 * modelJSON says `Config.supportControl: false`, its `ControlWifi` block is
 * `{"basicCtrl": {"command": "Set", "data": {}}}` — an empty command set — and LG's
 * cloud answers 9006 to a control request. Every one of those observations is about
 * LG's LEGACY control path, which LG has since retired. The capability API that
 * replaced it (`dataops/v1/s2p/backend/convert/control`) does control this unit, and
 * its `convert/capabilitySchema` lists the setters plainly:
 *
 *   dispenserDefaultWater      setDispenserDefaultWaterType / …AmountMode
 *   waterPurifierNotUseNotice  setNotUseNotice
 *   waterPurifierSterilize     setAutoCareState / setSterilizeReservation
 *
 * That matters here because LG's server converts a capability command into the
 * appliance's own protocol and sends it down — and rethink relays it. So the
 * cloud→appliance command frame can be MADE to exist without touching the appliance,
 * which is how every frame below was captured (2026-07-28), each one answered CL-0000:
 *
 *   aa 20 f0 17 | <26-byte record, 0xff = leave this field alone> | ck bb
 *
 * The record is the SAME 26-byte layout the appliance reports, so the read map below
 * doubles as the write map. The captured commands landed on the offsets the read probes
 * had predicted:
 *
 *   setDispenserDefaultWaterAmountMode 120/250/500 -> record[11]  1/2/3
 *   setDispenserDefaultWaterType coldWater         -> record[10]  3
 *   setNotUseNotice on                             -> record[8]   1
 *   setAutoCareState off                           -> record[20]  0
 *   setSterilizeReservation raw 21:45 (06:45 KST) -> record[17]=21 record[18]=45
 *
 * The reservation command is intentionally not exposed as a write. A live round-trip on
 * 2026-07-29 proved that the appliance replaces its month/day anchor when it receives the
 * time-only frame, moving the weekly sterilization to another weekday. LG's capability
 * schema accepts only `sterilizeStartTime`, so there is no verified way to preserve that
 * weekday. The time remains visible from the appliance's four-field schedule report.
 *
 * `f0 17` as the set-state opcode is not specific to this model — the fridge drivers in
 * this repo build the same `F0 17 FF FF …` frame with 0xff for untouched fields.
 *
 * Not everything this model declares actually takes: `setButtonSoundState` answers
 * CL-0003 on this unit, so Button sound stays a read-only sensor rather than a switch that
 * silently does nothing.
 *
 * WHERE THE BYTE OFFSETS COME FROM
 * --------------------------------
 * modelJSON gives the field names and every enum code (`MonitoringValue.*.valueMapping`),
 * but no offsets: this is an AA..BB appliance, so the layout lives in the Wi-Fi module and
 * in LG's server. It was recovered on 2026-07-28 by making LG's cloud decode frames we
 * chose — rethink relays what the appliance sends, and the management API can inject a
 * frame as if the appliance had sent it (tools/lg-oracle.mjs).
 *
 * The probe that settled it re-injected the appliance's own captured state frame with
 * EXACTLY ONE byte changed, then read LG's snapshot back. That is sharper than a ramp:
 * a ramp names numeric fields but leaves every enum at IGNORE, because byte[i]=i is not a
 * valid code for a 0..2 enum. Three passes were run (fill 3, fill 0, fill 1/2) so each
 * field was seen moving at least twice — once when its own probe set it, once when the
 * next probe reverted it.
 *
 * Base frame (real, captured 2026-07-28):
 *   aa3a12ec02 0102010101ffff00ff010101ffff071c121eff01ff030000010200
 *              02010101ffff00ff010101ffff071c121eff01ff03000001 ccbb
 *
 * THIS FRAME CARRIES THE STATE TWICE, AND LG READS THE LAST COPY.
 * Bytes 4..29 and 30..55 are two 26-byte records with the same field order (the halves are
 * byte-identical in a quiet frame, which is why this is easy to miss). Probing the FIRST
 * record never moved a field to the probe value — every field came back holding the second
 * record's value instead — so the decoder reads the trailing record. The same
 * old-record/new-record shape appears on the AA..BB washers in this repo.
 *
 * Confirmed layout, as offsets into the record (and, in brackets, absolute offsets into the
 * 58-byte frame, which is how the probes recorded them):
 *
 *    0 monStatus      [30]    1 cockState            [31]    2 waterSelection    [32]
 *    3 waterAmountMode[33]    4 tempUnit             [34]    5 amountUnit        [35]
 *    6 hotWaterTemp   [36]    7 voiceMode            [37]    8 notUseNotice      [38]
 *    9 autoElevation  [39]   10 defaultWaterSet      [40]   11 defaultWaterAmountMode [41]
 *   12 buttonSoundOnOff[42]  13 voiceOnOff           [43]   14 voiceVolume       [44]
 *   15 sterilizeInitMonth[45] 16 sterilizeInitDay    [46]   17 sterilizeInitHour [47]
 *   18 sterilizeInitMin[48]  19 cleanMode            [49]   20 autoCareOnOff     [50]
 *   21 energySavingMode[51]  22 monDataRefresh       [52]   23 highSterilizeState[53]
 *   24 filterFlushingState[54] 25 appVersion         [55]
 *
 * 26 bytes, 26 fields, one-for-one with the 26 `wpState.*` keys LG publishes for this unit.
 *
 * THE RECORD COUNT VARIES, SO IT IS COUNTED RATHER THAN ASSUMED.
 * The appliance also sends a 32-byte single-record form, `aa 20 12 eb …`, and that is the one
 * it sends most of the time — seen live at 2026-07-28 09:46, its 26 payload bytes equal to the
 * 58-byte frame's SECOND record exactly (they differ only in the record's own index byte, 01
 * on the leading record and 00 on the trailing one). A decoder keyed on "58 bytes, tag 0xec"
 * therefore ignores the appliance's usual frame and leaves every entity unknown — which is
 * what the first live rebuild showed. So the payload is measured instead: header 4 bytes,
 * trailer 2, and whatever is between must be a whole number of 26-byte records; the last one
 * is the current state. That accepts both forms and rejects the two heartbeats
 * (`aa0912af0d…`, `aa0a12e24a…`), whose payloads are 3 and 4 bytes.
 *
 * WHAT THIS UNIT DOES NOT HAVE
 * ----------------------------
 * voiceMode, voiceOnOff, voiceVolume, cleanMode, energySavingMode and autoElevation read
 * 0xff = IGNORE in every captured frame, and the model's Config agrees: supportSoundSetting
 * false, supportCleanMode false, supportEnergySaving false. No entity is published for them
 * — the same rule the dehumidifier learned (an entity for a field the appliance never
 * reports is a permanently-unknown entity).
 */

/** `aa <len> 12 <tag> …<records>… <ck> bb` — 4 header bytes, 2 trailer bytes. */
const HEADER_LEN = 4
const TRAILER_LEN = 2
/** buf[2] on every frame this appliance sends, state and heartbeat alike. */
const CLASS_TAG = 0x12
/** One state record. The frame holds one or two of them; the last is current. */
const RECORD_LEN = 26
const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TIMEOUT_MS = 0x7fffffff
const HISTORY_RETRY_MS = 5 * 1000
const HISTORY_PROPERTIES = [
    'water_usage_today',
    'water_usage_normal',
    'water_usage_cold',
    'water_usage_hot',
    'water_usage_sterilization',
    'sterilize_pipe_last_at',
    'sterilize_outlet_last_at',
    'sterilize_previous_month_count',
] as const

type Timer = ReturnType<typeof setTimeout>
type SterilizationActive = PurifierHistoryState['sterilization']['active']
type UsageDelta = Omit<PurifierUsage, 'day'>
type PendingUsage = { day: string; delta: UsageDelta }
type Clock = {
    now: () => number
    setTimeout: (callback: () => void, delay: number) => Timer
    clearTimeout: (timer: Timer | undefined) => void
}

const systemClock: Clock = {
    now: Date.now,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const kstParts = (time: number) => {
    const date = new Date(time + KST_OFFSET_MS)
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
    }
}
const kstDay = (time: number) => {
    const p = kstParts(time)
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`
}
const kstMonth = (time: number) => {
    const p = kstParts(time)
    return `${p.year}-${pad2(p.month)}`
}
const previousKstMonth = (time: number) => {
    const p = kstParts(time)
    return kstMonth(Date.UTC(p.year, p.month - 2, 15) - KST_OFFSET_MS)
}
const previousKstMonthStart = (time: number) => {
    const p = kstParts(time)
    return Date.UTC(p.year, p.month - 2, 1) - KST_OFFSET_MS
}
const nextKstMidnight = (time: number) => {
    const shifted = new Date(time + KST_OFFSET_MS)
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - KST_OFFSET_MS
}
const formatClock = (hour: number, minute: number) => {
    const period = hour < 12 ? 'AM' : 'PM'
    return `${hour % 12 || 12}:${pad2(minute)} ${period}`
}
const formatKst = (time: number | undefined) => {
    // This bridge can only attest to completions it observed. An absent timestamp does not
    // prove the appliance has never completed a cycle before collection began.
    if (time == null) return 'Not yet observed'
    const p = kstParts(time)
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const scheduleAnchor = (parts: number[], time: number) => {
    if (parts.some((part) => part === IGNORE)) return undefined
    const [month, day, hour, minute] = parts
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return undefined

    // The record omits the year. A weekly "next run" is close to now, so the nearest valid
    // occurrence across the current year boundary is the unambiguous one.
    const currentYear = new Date(time).getUTCFullYear()
    const candidates = [currentYear - 1, currentYear, currentYear + 1]
        .map((year) => {
            const instant = Date.UTC(year, month - 1, day, hour, minute)
            const date = new Date(instant)
            return date.getUTCFullYear() === year &&
                date.getUTCMonth() === month - 1 &&
                date.getUTCDate() === day &&
                date.getUTCHours() === hour &&
                date.getUTCMinutes() === minute
                ? instant
                : undefined
        })
        .filter((instant): instant is number => instant !== undefined)
    if (!candidates.length) return undefined

    return candidates.reduce((closest, candidate) =>
        Math.abs(candidate - time) < Math.abs(closest - time) ? candidate : closest,
    )
}
const scheduleInKst = (anchor: number, time: number) => {
    let instant = anchor
    if (instant < time) instant += Math.ceil((time - instant) / WEEK_MS) * WEEK_MS
    return { ...kstParts(instant), instant }
}
type SterilizationSchedule = ReturnType<typeof scheduleInKst> | undefined
const formatSterilizationSchedule = (local: SterilizationSchedule) => {
    if (!local) return 'Not set'
    return `${local.month}.${local.day} ${formatClock(local.hour, local.minute)}`
}
const formatWeeklySchedule = (local: SterilizationSchedule) => {
    if (!local) return 'Not set'
    const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)).getUTCDay()
    return `Weekly ${WEEKDAYS[weekday]} ${formatClock(local.hour, local.minute)}`
}
const isValidAABBFrame = (buf: Buffer) => {
    if (buf.length < 4 || buf.length > 0xff || buf[0] !== 0xaa || buf[1] !== buf.length || buf[buf.length - 1] !== 0xbb)
        return false
    let sum = 0
    for (let i = 0; i < buf.length - TRAILER_LEN; i++) sum += buf[i]
    return buf[buf.length - 2] === ((sum & 0xff) ^ 0x55)
}
const emptyUsage = (day: string): PurifierUsage => ({
    day,
    normal: 0,
    hot: 0,
    cold: 0,
    soda: 0,
    mineral: 0,
    sterilization: 0,
})
const copyHistory = (state: PurifierHistoryState): PurifierHistoryState => ({
    ...state,
    usage: { ...state.usage },
    schedule: state.schedule
        ? {
              parts: [
                  state.schedule.parts[0],
                  state.schedule.parts[1],
                  state.schedule.parts[2],
                  state.schedule.parts[3],
              ],
              instant: state.schedule.instant,
          }
        : undefined,
    sterilization: {
        ...state.sterilization,
        active: state.sterilization.active ? { ...state.sterilization.active } : undefined,
        countsByMonth: { ...state.sterilization.countsByMonth },
    },
})

/** Offsets WITHIN a record. Add the record's start to get the absolute offset. */
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

export default class Device extends AABBDevice {
    private readonly legacyPlatformCleanup: DeviceDiscovery
    private historyStore: PurifierHistoryStore | undefined
    private history: PurifierHistoryState | undefined
    private historyUnavailable = false
    private midnightTimer: Timer | undefined
    private historyRetryTimer: Timer | undefined
    private sterilizationScheduleTimer: Timer | undefined
    private sterilizationScheduleParts: number[] | undefined
    private sterilizationScheduleKey: string | undefined
    private sterilizationScheduleAnchor: number | undefined
    private sterilizationScheduleObserved = false
    private historyPublishCache: Record<string, string | number> = {}
    private pendingUsage: PendingUsage | undefined
    private pendingSterilization: { active: SterilizationActive } | undefined
    private observedSterilizationKind: NonNullable<SterilizationActive>['kind'] | undefined
    private readonly clock: Clock

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata, clock: Partial<Clock> = {}) {
        super(HA, thinq)
        this.clock = { ...systemClock, ...clock }

        const sensor = (id: string, name: string, extra: object = {}) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            name,
            ...extra,
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
                sterilize_reserved_at: sensor('sterilize_reserved_at', 'Sterilize schedule time', {
                    icon: 'mdi:calendar-clock',
                }),
                sterilize_weekly_schedule: sensor('sterilize_weekly_schedule', 'Weekly sterilize schedule', {
                    icon: 'mdi:calendar-week',
                }),
                sterilize_time: sensor('sterilize_time', 'Sterilize schedule time', {
                    icon: 'mdi:clock-outline',
                }),
                default_water: {
                    platform: 'select',
                    unique_id: '$deviceid-default_water',
                    state_topic: '$this/default_water',
                    command_topic: '$this/default_water/set',
                    name: 'Default dispense',
                    icon: 'mdi:water-outline',
                    options: Object.values(DEFAULT_WATER),
                },
                default_water_amount: {
                    platform: 'select',
                    unique_id: '$deviceid-default_water_amount',
                    state_topic: '$this/default_water_amount',
                    command_topic: '$this/default_water_amount/set',
                    name: 'Default dispense volume',
                    icon: 'mdi:cup-outline',
                    options: DEFAULT_AMOUNTS.map(([label]) => label),
                },
                button_sound: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-button-sound',
                    state_topic: '$this/button_sound',
                    name: 'Button sound',
                    icon: 'mdi:volume-high',
                    payload_on: 'ON',
                    payload_off: 'OFF',
                },
                auto_care: {
                    platform: 'switch',
                    unique_id: '$deviceid-auto-care',
                    state_topic: '$this/auto_care',
                    command_topic: '$this/auto_care/set',
                    name: 'High-temp sterilize schedule',
                    icon: 'mdi:shield-check',
                    payload_on: 'ON',
                    payload_off: 'OFF',
                },
                not_use_notice: {
                    platform: 'switch',
                    unique_id: '$deviceid-not-use-notice',
                    state_topic: '$this/not_use_notice',
                    command_topic: '$this/not_use_notice/set',
                    name: 'Disuse alert',
                    icon: 'mdi:bell-outline',
                    payload_on: 'ON',
                    payload_off: 'OFF',
                },
                temp_unit: sensor('temp_unit', 'Temperature unit', {
                    icon: 'mdi:thermometer',
                    entity_category: 'diagnostic',
                }),
                amount_unit: sensor('amount_unit', 'Volume unit', {
                    icon: 'mdi:beaker',
                    entity_category: 'diagnostic',
                }),
                app_version: sensor('app_version', 'App version', { icon: 'mdi:tag', entity_category: 'diagnostic' }),
                data_refresh: sensor('data_refresh', 'Data refresh interval', {
                    icon: 'mdi:timer-outline',
                    entity_category: 'diagnostic',
                }),
                water_usage_today: sensor('water_usage_today', 'Today usage', {
                    device_class: 'volume',
                    unit_of_measurement: 'L',
                    state_class: 'measurement',
                    suggested_display_precision: 1,
                }),
                water_usage_normal: sensor('water_usage_normal', 'Today purified', {
                    device_class: 'volume',
                    unit_of_measurement: 'L',
                    state_class: 'measurement',
                    suggested_display_precision: 1,
                }),
                water_usage_cold: sensor('water_usage_cold', 'Today cold water', {
                    device_class: 'volume',
                    unit_of_measurement: 'L',
                    state_class: 'measurement',
                    suggested_display_precision: 1,
                }),
                water_usage_hot: sensor('water_usage_hot', 'Today hot water', {
                    device_class: 'volume',
                    unit_of_measurement: 'L',
                    state_class: 'measurement',
                    suggested_display_precision: 1,
                }),
                water_usage_sterilization: sensor('water_usage_sterilization', 'Today rinse water', {
                    device_class: 'volume',
                    unit_of_measurement: 'L',
                    state_class: 'measurement',
                    suggested_display_precision: 1,
                }),
                sterilize_pipe_last_at: sensor('sterilize_pipe_last_at', 'Last water-line sterilize', {
                    icon: 'mdi:pipe',
                }),
                sterilize_outlet_last_at: sensor('sterilize_outlet_last_at', 'Last outlet sterilize', {
                    icon: 'mdi:water-pump',
                }),
                sterilize_previous_month_count: sensor(
                    'sterilize_previous_month_count',
                    'Last month high-temp sterilize count',
                    {
                        icon: 'mdi:calendar-check',
                        unit_of_measurement: 'x',
                        // Keep the descriptive MQTT payload ("Before collection"), while exposing a native
                        // unknown state instead of making the unit-bearing sensor unavailable.
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                ),
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

    setPurifierHistoryStore(store: PurifierHistoryStore) {
        this.historyStore = store
    }

    applyPurifierUsageBaseline(day: string, baseline: PurifierDailyUsage) {
        if (!this.history || this.historyUnavailable || day !== kstDay(this.clock.now())) return false

        const next = copyHistory(this.history)
        if (next.usage.day !== day) next.usage = emptyUsage(day)

        const pendingUsage = this.pendingUsage
        const localUsage = { ...next.usage }
        if (pendingUsage?.day === day) {
            for (const key of Object.keys(pendingUsage.delta) as (keyof UsageDelta)[])
                localUsage[key] += pendingUsage.delta[key]
        }
        for (const key of Object.keys(baseline) as (keyof PurifierDailyUsage)[])
            next.usage[key] = Math.max(localUsage[key], baseline[key])
        next.usageComplete = true

        // The live driver is the sole owner of both its memory snapshot and JSON file.
        // Suppress saveHistory's normal pending-delta fold because it is already included
        // in localUsage above; restore it if the atomic save fails.
        this.pendingUsage = undefined
        if (!this.saveHistory(next)) {
            this.pendingUsage = pendingUsage
            return false
        }
        this.history = next
        this.publishHistory()
        return true
    }

    start() {
        super.start()
        if (!this.historyStore || this.historyUnavailable) return

        try {
            const now = this.clock.now()
            let state = this.historyStore.load(this.id)
            if (!state) {
                state = {
                    version: 1,
                    collectedSince: now,
                    usageComplete: false,
                    usage: emptyUsage(kstDay(now)),
                    sterilization: { countsByMonth: {} },
                }
                this.historyStore.save(this.id, state)
            }
            this.history = state
            if (this.rollover(now)) this.publishHistory()
            this.scheduleMidnight()
        } catch (error) {
            this.enterHistoryUnavailable('Cannot load purifier history', error)
        }
    }

    drop() {
        this.clock.clearTimeout(this.midnightTimer)
        this.midnightTimer = undefined
        this.clock.clearTimeout(this.historyRetryTimer)
        this.historyRetryTimer = undefined
        this.clock.clearTimeout(this.sterilizationScheduleTimer)
        this.sterilizationScheduleTimer = undefined
        this.sterilizationScheduleParts = undefined
        this.sterilizationScheduleKey = undefined
        this.sterilizationScheduleAnchor = undefined
        this.sterilizationScheduleObserved = false
        super.drop()
    }

    /*
     * The base class strips the AA/length prefix before handing the body on, but every offset
     * above is stated against the WHOLE frame — that is how the probes recorded them, and
     * keeping the two in the same coordinate system is what makes the map checkable. So the
     * frame is taken here, unstripped.
     */
    processData(buf: Buffer) {
        if (!isValidAABBFrame(buf)) return
        if (this.processUsage(buf)) {
            if (this.historyRetryTimer) this.publishHistory()
            return
        }
        if (buf[2] !== CLASS_TAG) return
        const payload = buf.length - HEADER_LEN - TRAILER_LEN
        if (payload <= 0 || payload % RECORD_LEN !== 0) return

        // A valid appliance state frame is also an opportunity to drain a failed HA history publish.
        if (this.historyRetryTimer) this.publishHistory()

        // The trailing record is the current state; a leading one, when present, is the previous.
        const record = buf.length - TRAILER_LEN - RECORD_LEN
        const at = (o: number) => buf[record + o]
        this.processSterilization(at(OFF.highSterilizeState))

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

        // The sterilisation reservation is four UTC bytes (month, day, hour, minute). ThinQ renders
        // that moment in KST; 0xff in any field means "not set".
        const parts = [OFF.sterilizeInitMonth, OFF.sterilizeInitDay, OFF.sterilizeInitHour, OFF.sterilizeInitMin].map(
            at,
        )
        this.publishSterilizationSchedule(parts)

        this.publishProperty('app_version', at(OFF.appVersion))
        this.publishProperty('data_refresh', at(OFF.monDataRefresh))
    }

    private publishSterilizationSchedule(parts: number[]) {
        this.sterilizationScheduleParts = [...parts]
        this.clock.clearTimeout(this.sterilizationScheduleTimer)
        this.sterilizationScheduleTimer = undefined

        const now = this.clock.now()
        const key = parts.join(',')
        const firstObservation = !this.sterilizationScheduleObserved
        this.sterilizationScheduleObserved = true
        if (key !== this.sterilizationScheduleKey) {
            this.sterilizationScheduleKey = key
            const stored = firstObservation ? this.history?.schedule : undefined
            this.sterilizationScheduleAnchor =
                stored?.parts.join(',') === key ? stored.instant : scheduleAnchor(parts, now)
        }
        this.persistSterilizationSchedule(parts, this.sterilizationScheduleAnchor)
        const schedule =
            this.sterilizationScheduleAnchor === undefined
                ? undefined
                : scheduleInKst(this.sterilizationScheduleAnchor, now)
        this.publishProperty('sterilize_reserved_at', formatSterilizationSchedule(schedule))
        this.publishProperty('sterilize_weekly_schedule', formatWeeklySchedule(schedule))

        // Read-only clock view of the four-field reservation. ThinQ displays the UTC record in
        // KST; writing its time would also replace the appliance-owned weekly day anchor.
        this.publishProperty('sterilize_time', schedule ? `${pad2(schedule.hour)}:${pad2(schedule.minute)}` : '')
        if (!schedule) return

        // The appliance may retain the original weekly anchor after that occurrence passes.
        // Advance Home Assistant at the boundary even when no new state frame arrives.
        this.sterilizationScheduleTimer = this.clock.setTimeout(
            () => {
                this.sterilizationScheduleTimer = undefined
                if (this.sterilizationScheduleParts) this.publishSterilizationSchedule(this.sterilizationScheduleParts)
            },
            Math.min(MAX_TIMEOUT_MS, Math.max(1, schedule.instant - now + 1)),
        )
        this.unref(this.sterilizationScheduleTimer)
    }

    private persistSterilizationSchedule(parts: number[], anchor: number | undefined) {
        if (!this.history || this.historyUnavailable) return
        if (anchor === undefined) {
            if (!this.history.schedule) return
            const next = copyHistory(this.history)
            delete next.schedule
            if (this.saveHistory(next)) this.history = next
            return
        }
        if (this.history.schedule?.instant === anchor && this.history.schedule.parts.join(',') === parts.join(','))
            return

        const next = copyHistory(this.history)
        next.schedule = {
            parts: [parts[0]!, parts[1]!, parts[2]!, parts[3]!],
            instant: anchor,
        }
        if (this.saveHistory(next)) this.history = next
    }

    private processUsage(buf: Buffer) {
        if (
            buf.length !== 18 ||
            buf[0] !== 0xaa ||
            buf[1] !== 0x12 ||
            buf[2] !== CLASS_TAG ||
            buf[3] !== 0x1f ||
            buf[4] !== 0x00 ||
            buf[17] !== 0xbb
        )
            return false

        const delta = {
            normal: buf[5],
            hot: buf.readUInt16BE(6),
            cold: buf.readUInt16BE(8),
            soda: buf.readUInt16BE(10),
            mineral: buf.readUInt16BE(12),
            sterilization: buf.readUInt16BE(14),
        }
        if (!Object.values(delta).some(Boolean)) return true
        const now = this.clock.now()
        if (!this.history || this.historyUnavailable) return true

        const previousDay = this.history.usage.day
        const next = copyHistory(this.history)
        const day = kstDay(now)
        if (next.usage.day !== day) {
            next.usage = emptyUsage(day)
            next.usageComplete = true
        }
        for (const key of Object.keys(delta) as (keyof typeof delta)[]) next.usage[key] += delta[key]
        if (this.saveHistory(next)) {
            this.history = next
            this.publishHistory()
            if (day !== previousDay) this.scheduleMidnight()
        } else {
            this.retainUsage(day, delta)
        }
        return true
    }

    private retainUsage(day: string, delta: UsageDelta) {
        if (this.pendingUsage?.day !== day) {
            this.pendingUsage = { day, delta: { ...delta } }
            return
        }
        for (const key of Object.keys(delta) as (keyof UsageDelta)[]) this.pendingUsage.delta[key] += delta[key]
    }

    private processSterilization(phase: number) {
        if (!this.history || this.historyUnavailable) return
        const now = this.clock.now()
        if (!this.prepareHistoryAt(now)) return

        if (this.pendingSterilization && !this.updateSterilization(this.pendingSterilization.active)) return

        const current = this.history!.sterilization.active
        const kind = phase >= 1 && phase <= 3 ? 'pipe' : phase === 4 ? 'outlet' : undefined
        if (phase === 5) {
            this.observedSterilizationKind = undefined
            if (current) this.updateSterilization(undefined)
            return
        }
        if (kind) {
            this.observedSterilizationKind = kind
            if (current?.kind === kind) return
            this.updateSterilization({ kind, startedAt: now })
            return
        }
        if (phase !== 0 || !current) return
        if (this.observedSterilizationKind !== current.kind) {
            // A persisted active marker only says the previous process saw a start. If the
            // first state after restart is idle, completion happened while we were offline
            // (or the marker is stale), so clear it without inventing a completion timestamp.
            this.observedSterilizationKind = undefined
            this.updateSterilization(undefined)
            return
        }

        const next = copyHistory(this.history!)
        next.sterilization.active = undefined
        if (current.kind === 'pipe') next.sterilization.lastPipeAt = now
        else next.sterilization.lastOutletAt = now
        const month = kstMonth(now)
        next.sterilization.countsByMonth[month] = (next.sterilization.countsByMonth[month] ?? 0) + 1
        if (this.saveHistory(next)) {
            this.history = next
            this.observedSterilizationKind = undefined
            this.publishHistory()
        }
    }

    private updateSterilization(active: SterilizationActive) {
        const next = copyHistory(this.history!)
        next.sterilization.active = active
        if (this.saveHistory(next)) {
            this.history = next
            this.publishHistory()
            return true
        }
        this.pendingSterilization = { active }
        return false
    }

    private prepareHistoryAt(now: number) {
        if (!this.history || this.historyUnavailable) return false
        const previousDay = this.history.usage.day
        const rolled = this.rollover(now, true)
        if (rolled && this.history?.usage.day !== previousDay) this.scheduleMidnight()
        return rolled
    }

    private rollover(now: number, completeNewDay = false) {
        if (!this.history || this.historyUnavailable) return false
        const day = kstDay(now)
        if (this.history.usage.day === day) return true
        const next = copyHistory(this.history)
        next.usage = emptyUsage(day)
        next.usageComplete = completeNewDay
        if (!this.saveHistory(next)) return false
        this.history = next
        this.publishHistory()
        return true
    }

    private saveHistory(next: PurifierHistoryState) {
        try {
            if (this.pendingUsage?.day === next.usage.day) {
                for (const key of Object.keys(this.pendingUsage.delta) as (keyof UsageDelta)[])
                    next.usage[key] += this.pendingUsage.delta[key]
            }
            if (this.pendingSterilization) next.sterilization.active = this.pendingSterilization.active
            const now = this.clock.now()
            const retainedMonths = new Set([kstMonth(now), previousKstMonth(now)])
            next.sterilization.countsByMonth = Object.fromEntries(
                Object.entries(next.sterilization.countsByMonth).filter(([month]) => retainedMonths.has(month)),
            )
            this.historyStore!.save(this.id, next)
            this.pendingUsage = undefined
            this.pendingSterilization = undefined
            return true
        } catch (error) {
            console.warn('Cannot save purifier history', error)
            return false
        }
    }

    private historySnapshot() {
        const state = this.history!
        const usage = state.usage
        const total = usage.normal + usage.hot + usage.cold + usage.soda + usage.mineral + usage.sterilization
        const now = this.clock.now()
        const previous = previousKstMonth(now)
        const collected = state.collectedSince <= previousKstMonthStart(now)
        const usageValue = (value: number) => (state.usageComplete ? value / 1000 : '')
        return {
            water_usage_today: usageValue(total),
            water_usage_normal: usageValue(usage.normal),
            water_usage_cold: usageValue(usage.cold),
            water_usage_hot: usageValue(usage.hot),
            water_usage_sterilization: usageValue(usage.sterilization),
            sterilize_pipe_last_at: formatKst(state.sterilization.lastPipeAt),
            sterilize_outlet_last_at: formatKst(state.sterilization.lastOutletAt),
            sterilize_previous_month_count: collected
                ? (state.sterilization.countsByMonth[previous] ?? 0)
                : 'Before collection',
        }
    }

    private publishHistory() {
        if (!this.history || this.historyUnavailable) return
        let failed = false
        for (const [property, value] of Object.entries(this.historySnapshot())) {
            if (this.historyPublishCache[property] === value) continue
            try {
                this.HA.publishProperty(this.id, property, value)
                this.historyPublishCache[property] = value
            } catch (error) {
                failed = true
                console.warn(`Purifier history '${property}' Publish failed`, error)
            }
        }
        if (failed) this.scheduleHistoryRetry()
        else {
            this.clock.clearTimeout(this.historyRetryTimer)
            this.historyRetryTimer = undefined
        }
    }

    private scheduleHistoryRetry() {
        if (this.historyRetryTimer || this.historyUnavailable) return
        this.historyRetryTimer = this.clock.setTimeout(() => {
            this.historyRetryTimer = undefined
            this.publishHistory()
        }, HISTORY_RETRY_MS)
        this.unref(this.historyRetryTimer)
    }

    private scheduleMidnight() {
        if (!this.history || this.historyUnavailable) return
        this.clock.clearTimeout(this.midnightTimer)
        const now = this.clock.now()
        this.midnightTimer = this.clock.setTimeout(
            () => {
                this.midnightTimer = undefined
                if (this.rollover(this.clock.now(), true)) this.publishHistory()
                this.scheduleMidnight()
            },
            Math.max(0, nextKstMidnight(now) - now),
        )
        this.unref(this.midnightTimer)
    }

    private unref(timer: Timer) {
        ;(timer as unknown as { unref?: () => void }).unref?.()
    }

    private enterHistoryUnavailable(message: string, error: unknown) {
        console.warn(message, error)
        this.historyUnavailable = true
        this.history = undefined
        this.pendingUsage = undefined
        this.pendingSterilization = undefined
        this.clock.clearTimeout(this.midnightTimer)
        this.midnightTimer = undefined
        this.clock.clearTimeout(this.historyRetryTimer)
        this.historyRetryTimer = undefined
        for (const property of HISTORY_PROPERTIES) {
            try {
                // Empty retained MQTT payloads remove the old retained state instead of presenting
                // stale history as current while persistence is unavailable.
                this.HA.publishProperty(this.id, property, '')
            } catch (clearError) {
                console.warn(`Purifier history '${property}' Init failed`, clearError)
            }
        }
    }

    /**
     * Build and send a set-state frame: `aa <len> f0 17 <26-byte record> <ck> bb`, with every
     * field this command is not changing left at 0xff.
     *
     * The base class's `send` supplies the AA/length prefix and the checksum, so what goes in
     * is `f0 17` plus the record — which reproduces the captured frames byte for byte.
     */
    private setField(offset: number, value: number) {
        const record = Buffer.alloc(RECORD_LEN, IGNORE)
        record[offset] = value
        this.send(Buffer.concat([Buffer.from(SET_STATE), record]))
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'default_water': {
                const code = Object.entries(DEFAULT_WATER).find(([, label]) => label === mqttValue)?.[0]
                if (code === undefined) return console.warn(`Water Purifier: Unknown default dispense '${mqttValue}'`)
                return this.setField(OFF.defaultWaterSet, Number(code))
            }
            case 'default_water_amount': {
                const hit = DEFAULT_AMOUNTS.find(([label]) => label === mqttValue)
                if (!hit) return console.warn(`Water Purifier: Unknown default dispense volume '${mqttValue}'`)
                return this.setField(OFF.defaultWaterAmountMode, hit[1])
            }
            case 'auto_care':
                if (mqttValue !== 'ON' && mqttValue !== 'OFF')
                    return console.warn(`Water Purifier: Invalid high-temp sterilize schedule value '${mqttValue}'`)
                return this.setField(OFF.autoCareOnOff, mqttValue === 'ON' ? 1 : 0)
            case 'not_use_notice':
                if (mqttValue !== 'ON' && mqttValue !== 'OFF')
                    return console.warn(`Water Purifier: Invalid disuse-alert value '${mqttValue}'`)
                return this.setField(OFF.notUseNotice, mqttValue === 'ON' ? 1 : 0)
            default:
                console.warn(`Water Purifier: Item does not support writing ${prop}`)
        }
    }
}
