import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG F3M2CYK__ front-load washer (marketing model F3M2CYU2B), deviceType 201.
//
// AABB frames, class byte 0x20. The status record is 43 bytes with NO leading 0x18 marker —
// byte offsets below are absolute. Every offset was reverse-engineered live on a real unit
// (2026-10-29), cross-referenced against the modelJson MonitoringValue enums and the per-course
// defaults in the modelJson Course section. Option flags are packed as single bits and were each
// isolated with a one-variable physical toggle (turbo, pre wash, cold wash, steam, fresh care,
// remote start, delay wash) while the user operated the machine.
//
//   [3]  soil        (0=no soil, 1=light, 2=light-normal, 3=normal, 4=normal-heavy, 5=heavy)
//   [4]  temp        (13=TapCold, 14=Cold, 15=EcoWarm, 16=Warm, 17=WarmRinse, 18=Hot, 19=ExtraHot)
//   [5]  rinse       (14=Normal, 15=Plus, 16=Plus2, 17=Plus3)
//   [6]  spin        (12=DrainOnly, 13=Low, 14=Medium, 15=High, 16=ExtraHigh)
//   [7]  course      (wire code, non-sequential — see COURSE)
//   [14] reserveTimeMinute  [15] reserveTimeHour — Delay Wash time as TOTAL minutes (16-bit LE):
//        "1:00" reads 60 (0x3C), "2:00" reads 120 (0x78). Not an hour/minute split.
//   [16] remainTimeMinute   [17] remainTimeHour     (live countdown while running)
//   [18] initialTimeMinute  [19] initialTimeHour    (total cycle time)
//   [23] state       (11 = Running, 12 = Rinsing, ...) — see STATE
//   [24] preState    (previous state, not published)
//   [32] ezCSDetergentSetVal  (0=Off, 1=Less, 2=Normal, 3=More)
//   [33] ezCSSoftenerSetVal   (0=Off, 1=Less, 2=Normal, 3=More)
//   [36] options bitfield 1: 0x04 = cold wash, 0x20 = turbo wash, 0x40 = pre wash
//   [37] options bitfield 2: 0x10 = steam
//   [38] options bitfield 3: 0x40 = fresh care
//   [39] options bitfield 4: 0x10 = remote start
//   [41] options bitfield 5: 0x80 = delay wash (active)
//   [42] door       (1 = closed/latched, 0 = open/unlatched) — see DOOR note below
//
// DOOR: [42] tracks the door latch, not physical position. 1 = closed AND locked (latched for a
// cycle / ready for remote start). 0 = unlatched, which can mean either genuinely open or
// shut-but-unlocked. Confirmed live: user reported "cerrada y bloqueada" while the byte read 0x01.

const STATUS_LENGTH = 43

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request;
// the trailing 18041314 is this model's record parameter (captured live as the exact bytes the
// cloud sends the F3M2CYK__). Without it the washer sends nothing after a container restart —
// it only volunteers a frame when something changes, so a driver that never asks stays blank.
const STATUS_REQUEST = 'F0ED112101000000180413140000'

const SOIL_OFFSET = 3
const TEMP_OFFSET = 4
const RINSE_OFFSET = 5
const SPIN_OFFSET = 6
const COURSE_OFFSET = 7
const RESERVE_MIN_OFFSET = 14
const RESERVE_HOUR_OFFSET = 15
const TIME_MIN_OFFSET = 16
const TIME_HOUR_OFFSET = 17
const INITIAL_MIN_OFFSET = 18
const INITIAL_HOUR_OFFSET = 19
const STATE_OFFSET = 23
const DETERGENT_OFFSET = 32
const SOFTENER_OFFSET = 33
const DRY_LEVEL_OFFSET = 8
const SMART_COURSE_OFFSET = 25
const FLAGS1_OFFSET = 36 // cold wash / turbo wash / pre wash
const FLAGS2_OFFSET = 37 // steam / rinse-spin
const FLAGS3_OFFSET = 38 // fresh care
const FLAGS4_OFFSET = 39 // remote start
const FLAGS5_OFFSET = 41 // delay wash
const DOOR_OFFSET = 42
const DOOR_CLOSED = 0x01 // 1 = closed/latched, 0 = open/unlatched

const FLAG_COLD_WASH = 0x04
const FLAG_TURBO_WASH = 0x20
const FLAG_PRE_WASH = 0x40
const FLAG_STEAM = 0x10
const FLAG_RINSE_SPIN = 0x20
const FLAG_FRESH_CARE = 0x40
const FLAG_REMOTE_START = 0x10
const FLAG_DELAY = 0x80

// From modelJson MonitoringValue.state (index = wire byte value).
const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Paused: 2,
    Detecting: 3,
    'Add Drain': 5,
    'Detergent Amount': 6,
    Reserved: 7,
    'Pre-wash': 9,
    Running: 11,
    Rinsing: 12,
    'Rinse Hold': 13,
    Spinning: 14,
    Drying: 15,
    End: 16,
    Refreshing: 21,
    Error: 23,
    Standby: [27, 28, 29], // FROZEN_PREVENT_INITIAL/PAUSE/RUNNING
    'Smart Diagnosis': 34,
    'Detergent Drawer Open': 35,
})

// From modelJson MonitoringValue.temp (index = wire byte value).
const TEMP = Enum.of({
    'No temp': 0,
    'Tap Cold': 13,
    Cold: 14,
    'Eco Warm': 15,
    Warm: 16,
    'Warm Rinse': 17,
    Hot: 18,
    'Extra Hot': 19,
})

// From modelJson MonitoringValue.soilWash (index = wire byte value).
const SOIL = Enum.of({
    'No soil': 0,
    Light: 1,
    'Light Normal': 2,
    Normal: 3,
    'Normal Heavy': 4,
    Heavy: 5,
})

// From modelJson MonitoringValue.spin (index = wire byte value).
const SPIN = Enum.of({
    'No spin': 0,
    'Drain only': 12,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
})

// From modelJson MonitoringValue.rinse (index = wire byte value).
const RINSE = Enum.of({
    Normal: 14,
    Plus: 15,
    'Plus 2': 16,
    'Plus 3': 17,
})

// Course code = byte 7. Reverse-engineered from live dial turns (2026-10-29). The wire
// code is NOT the modelJson imgIndex — it's a separate, non-sequential value. Ambiguous:
// 13 vs 79 are BulkyLarge / Sports Wear (same soil/temp/spin defaults), named best-guess.
const COURSE = Enum.of({
    'Allergy Care': 5,
    Bulky: 13,
    Delicates: 22,
    'Heavy Duty': 35,
    Normal: 46,
    'Perm Press': 48,
    'Rinse+Spin': 55,
    Sanitary: 60,
    'Speed Wash': 74,
    'Sports Wear': 79,
    Towels: 84,
    'Tub Clean': 85,
    White: 90,
    Download: 255,
})

// ezCSDetergentSetVal / ezCSSoftenerSetVal (index = wire byte value).
const DISPENSE = Enum.of({
    Off: 0,
    Less: 1,
    Normal: 2,
    More: 3,
})

// From modelJson MonitoringValue.dryLevel (index = wire byte value).
const DRY_LEVEL = Enum.of({
    None: 0,
    Wind: 5,
    Turbo: 6,
    '30 min': 11,
    '60 min': 12,
    '90 min': 13,
    '120 min': 14,
    '150 min': 15,
})

// A downloadable "Smart Course" programme (modelJson `SmartCourse`). The Download dial slot
// (course 0xFF) is programmed by an F0E5 command carrying a [value][code] pair per field; each entry
// below is that full field set, reverse-engineered from live app downloads (2026-10-29/30) and
// verified to reproduce the captured frames byte-for-byte (AABB checksum included).
interface DownloadCourse {
    id: number // SmartCourse wire ID (read back as status [25])
    base: number // base dial course (status [22])
    soil: number
    spin: number
    temp: number
    detergent: number
    softener: number
    rinse: number
    turbo: number
    steam: number
    coldWash: number
    freshCare: number
    rinseSpin?: number // 0/1 — Rinse+Spin option (status [37] 0x20)
    dryLevel?: number // 0 none, 5 wind, 6 turbo, 11-15 = 30-150 min (status [8])
    preWash?: number // 0/1 — pre-wash (status [36] 0x40)
}

// Wire field order for the F0E5 payload. The washer parses by code, so order is incidental — except
// for Collars & Cuffs, which the app sends reordered and is replayed verbatim (see setProperty).
const DOWNLOAD_FIELD_ORDER = [
    0x0a, 0x0c, 0x1e, 0x21, 0x1f, 0x27, 0x28, 0x3d, 0x20, 0x22, 0x10, 0x35, 0x3e, 0x38, 0x34, 0x44, 0x7f, 0x00,
]

const DOWNLOAD_COURSES: Record<string, DownloadCourse> = {
    'Small Load': {
        id: 0x69,
        base: 0x44,
        soil: 3,
        spin: 15,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    Beachwear: {
        id: 0x73,
        base: 0x16,
        soil: 1,
        spin: 14,
        temp: 14,
        detergent: 0,
        softener: 0,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'New Clothes': {
        id: 0x74,
        base: 0x2e,
        soil: 1,
        spin: 13,
        temp: 14,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    Blanket: {
        id: 0x7c,
        base: 0x0d,
        soil: 3,
        spin: 14,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 0,
        steam: 1,
        coldWash: 0,
        freshCare: 0,
    },
    'Color Care': {
        id: 0x6f,
        base: 0x2e,
        soil: 3,
        spin: 14,
        temp: 14,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    Denim: {
        id: 0x70,
        base: 0x2e,
        soil: 3,
        spin: 14,
        temp: 14,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    Swimwear: {
        id: 0x67,
        base: 0x16,
        soil: 1,
        spin: 13,
        temp: 14,
        detergent: 0,
        softener: 0,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Rainy Day': {
        id: 0x6d,
        base: 0x2e,
        soil: 3,
        spin: 16,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Gym Clothes': {
        id: 0x6e,
        base: 0x4f,
        soil: 1,
        spin: 14,
        temp: 16,
        detergent: 0,
        softener: 0,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Sweat Stains': {
        id: 0x65,
        base: 0x2e,
        soil: 1,
        spin: 15,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Single Garments': {
        id: 0x6b,
        base: 0x4a,
        soil: 1,
        spin: 15,
        temp: 18,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    Overnight: {
        id: 0x6a,
        base: 0x2e,
        soil: 3,
        spin: 13,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 1,
    },
    EcoWash: {
        id: 0x78,
        base: 0x2e,
        soil: 3,
        spin: 15,
        temp: 14,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 1,
        steam: 0,
        coldWash: 1,
        freshCare: 0,
    },
    'Delicate Dresses': {
        id: 0x79,
        base: 0x16,
        soil: 1,
        spin: 13,
        temp: 14,
        detergent: 0,
        softener: 0,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Half Load Wash': {
        id: 0x76,
        base: 0x2e,
        soil: 3,
        spin: 15,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 14,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Juice & Food Stains': {
        id: 0x7e,
        base: 0x23,
        soil: 5,
        spin: 15,
        temp: 18,
        detergent: 2,
        softener: 2,
        rinse: 15,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Collars & Cuffs': {
        id: 0x7d,
        base: 0x23,
        soil: 3,
        spin: 14,
        temp: 18,
        detergent: 2,
        softener: 2,
        rinse: 15,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
        rinseSpin: 1,
    },
    'Full Load Wash': {
        id: 0x71,
        base: 0x2e,
        soil: 5,
        spin: 15,
        temp: 16,
        detergent: 2,
        softener: 2,
        rinse: 15,
        turbo: 1,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
    'Handwash/Wool': {
        id: 0xdd,
        base: 0x22,
        soil: 3,
        spin: 13,
        temp: 16,
        detergent: 0,
        softener: 0,
        rinse: 14,
        turbo: 0,
        steam: 0,
        coldWash: 0,
        freshCare: 0,
    },
}

// SmartCourse id -> label, for reading the currently-downloaded programme back into the select.
const SMART_COURSE = new Enum(
    Object.entries(DOWNLOAD_COURSES).map(([name, course]) => [name, course.id] as [string, number]),
)

// Collars & Cuffs is the one programme the app sends reordered (0x35 before 0x20) and with
// rinseSpin=1 despite its modelJson default of OFF; replay its exact payload verbatim.
const COLLARS_AND_CUFFS_INNER = Buffer.from(
    'F0E5000201FF120B7D0AFF0C231E03210E1F12270228023D003501200F220010003E003800340044007F0000',
    'hex',
)

// Build the F0E5 inner payload (header + [value][code] pairs). AABBDevice.frame() adds the AA..BB
// framing and checksum when it is handed to send().
function buildDownloadInner(course: DownloadCourse): Buffer {
    const vals: Record<number, number> = {
        0x0a: course.id,
        0x0c: 0xff,
        0x1e: course.base,
        0x21: course.soil,
        0x1f: course.spin,
        0x27: course.temp,
        0x28: course.detergent,
        0x3d: course.softener,
        0x20: course.rinseSpin ?? 0,
        0x22: course.rinse,
        0x10: course.dryLevel ?? 0,
        0x35: 0, // smartCare_onOff — download-only, always 0
        0x3e: course.turbo,
        0x38: course.steam,
        0x34: course.coldWash,
        0x44: course.preWash ?? 0,
        0x7f: course.freshCare,
    }
    const inner: number[] = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, 0x12, 0x0b]
    for (const code of DOWNLOAD_FIELD_ORDER) inner.push(vals[code] ?? 0, code)
    return Buffer.from(inner)
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATE.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSE.options,
                    },
                    downloaded_course: {
                        platform: 'select',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        command_topic: '$this/downloaded_course/set',
                        name: 'Downloaded course',
                        icon: 'mdi:cloud-download-outline',
                        options: SMART_COURSE.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash time',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil',
                        icon: 'mdi:water-opacity',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:rotate-3d-variant',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water',
                        device_class: 'enum',
                        options: RINSE.options,
                    },
                    detergent: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent',
                        state_topic: '$this/detergent',
                        name: 'Detergent level',
                        icon: 'mdi:cup-water',
                        device_class: 'enum',
                        options: DISPENSE.options,
                    },
                    softener: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener',
                        state_topic: '$this/softener',
                        name: 'Softener level',
                        icon: 'mdi:flower',
                        device_class: 'enum',
                        options: DISPENSE.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: DRY_LEVEL.options,
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'Turbo wash',
                        icon: 'mdi:lightning-bolt',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre wash',
                        icon: 'mdi:water-sync',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'Fresh care',
                        icon: 'mdi:weather-windy',
                    },
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse + Spin',
                        icon: 'mdi:water-sync',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:remote',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door', // payload ON = open, OFF = closed
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x20, STATUS_LENGTH, this.processStatus)
        // 0xBD (full status dump) and 0x72/0x7F (heartbeats) are not decoded.
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    private processStatus(status: Buffer) {
        const state = status[STATE_OFFSET]
        const isOff = state === 0

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('course', COURSE.map(status[COURSE_OFFSET]))
        this.publishProperty('downloaded_course', SMART_COURSE.map(status[SMART_COURSE_OFFSET]))

        // Zeroed on Off so a stale countdown never shows while the machine is idle.
        this.publishProperty('remaining_time', isOff ? 0 : status[TIME_HOUR_OFFSET] * 60 + status[TIME_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : status[INITIAL_HOUR_OFFSET] * 60 + status[INITIAL_MIN_OFFSET])
        // Delay Wash time is stored as TOTAL minutes (16-bit LE). Zero when no delay is set.
        this.publishProperty('reserve_time', status[RESERVE_HOUR_OFFSET] * 256 + status[RESERVE_MIN_OFFSET])

        this.publishProperty('temp', TEMP.map(status[TEMP_OFFSET]))
        this.publishProperty('soil', SOIL.map(status[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(status[SPIN_OFFSET]))
        this.publishProperty('rinse', RINSE.map(status[RINSE_OFFSET]))

        this.publishProperty('detergent', DISPENSE.map(status[DETERGENT_OFFSET]))
        this.publishProperty('softener', DISPENSE.map(status[SOFTENER_OFFSET]))
        this.publishProperty('dry_level', DRY_LEVEL.map(status[DRY_LEVEL_OFFSET]))

        const flags1 = status[FLAGS1_OFFSET]
        this.publishProperty('cold_wash', (flags1 & FLAG_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', (flags1 & FLAG_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (flags1 & FLAG_PRE_WASH) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('steam', (status[FLAGS2_OFFSET] & FLAG_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', (status[FLAGS2_OFFSET] & FLAG_RINSE_SPIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (status[FLAGS3_OFFSET] & FLAG_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (status[FLAGS4_OFFSET] & FLAG_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('delay_wash', (status[FLAGS5_OFFSET] & FLAG_DELAY) !== 0 ? 'ON' : 'OFF')

        // [42] = 1 means closed/latched (see DOOR note in the header). device_class 'door'
        // is ON = open, so we invert: latched -> OFF (closed), unlatched -> ON (open).
        this.publishProperty('door', status[DOOR_OFFSET] === DOOR_CLOSED ? 'OFF' : 'ON')
    }

    setProperty(prop: string, value: string) {
        if (prop !== 'downloaded_course') return
        const course = DOWNLOAD_COURSES[value]
        if (!course) return
        // Collars & Cuffs is replayed verbatim: the app sends it in a non-standard field order.
        this.send(value === 'Collars & Cuffs' ? COLLARS_AND_CUFFS_INNER : buildDownloadInner(course))
    }
}
