import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { STATES, DRY_LEVELS, TEMPERATURES, ERRORS } from './dryer_common'

// LG DLEX4000W electric dryer — matched on modelId "RV13D4ASJW_D_US" (ThinQ2, deviceType 202,
// modelJson "Victor2 Refresh Better (D) WiFi"). Same AABB frame family as RV13B6ES_D_US_WIFI / RV13B6BSD_D_US_WIFI:
// frames (buf = the AABB body, AA+len and checksum+BB already stripped) start with 0x30 and are discriminated by buf[1]:
//   0xEC        dial/status frame — two stacked records (29-byte old state, 28-byte current state), each
//               starting with a 0x1b marker; we read the current-state record.
//   0xEB        single-record status frame (28-byte record) — same field layout as 0xEC's current-state record.
//
// Every offset and table below was derived on this appliance with rethink-capture --cloud: one variable at a
// time on the panel, each byte change paired with the LG cloud's own decoded washerDryer field in the same
// second. The record layout came out byte-for-byte identical to RV13B6ES_D_US_WIFI — including Wrinkle Care in
// rec[15] bit 0x10 (the offset that separates that model from RV13B6BSD) — and the dial courses use the same
// codes, so this file is that handler under its own model id rather than an alias: the two are different
// appliances with different course/option sets (this one's Signal is a plain On/Off, its steam courses carry
// Turbo Steam, and it takes remote commands).
//
// rec[15] bit 0x40 is the drum light: on at power-on and for four minutes after, on at End and while a
// cycle is paused, off while the drum tumbles; the Drum Light hold (Wrinkle Care button, 3 s) sets it too.
//
// Not decoded (declared entities intentionally omitted rather than published wrong): a door sensor (opening
// the door produced no distinct byte; a mid-cycle door opening is the same generic Pause a button press gives).

// One status block is a leading byte + the 28B record; 0xEB carries one block, 0xEC two (old, current).
const STATUS_LENGTH = 29

// Status query, sent on every connect. 0xF0ED is the "report your state" request the other AABB handlers
// send; it only reads. Confirmed on this dryer: after a reconnect it answers with one 0xEB snapshot within
// two seconds, then resumes normal 0xEC updates.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Offsets below are relative to the record's own 0x1b marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute]: the live countdown while running, or the estimated cycle time while
// Initial/Selecting. Confirmed against the cloud's remainTimeHour/Minute, including the hour rollover
// (Antibacterial reported 1h10m and decoded as 70 minutes).
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute]: a separate initial-time estimate — confirmed against the cloud's
// initialTimeHour/Minute. Fixed on a timed cycle. On a sensor-dry cycle the dryer rewrites it whenever it
// re-estimates (observed 55 -> 48 when remaining dropped 53 -> 46) and from then on reports it alternating
// between two adjacent minutes (48/49) every half minute; published as sent.
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
const COURSE_OFFSET = 6
// rec[7]: error code. Never observed non-zero on this appliance; the offset is the one the RV13B6 siblings
// (same record layout) located by injecting it into a bridged simulated appliance and reading the cloud's
// error field.
const ERROR_OFFSET = 7
const DRY_LEVEL_OFFSET = 8
const TEMP_OFFSET = 9
// rec[10]: the Time Dry duration selector, 1..5 = 20..60 minutes in steps of 10 (the display's own column).
// Only meaningful on Time Dry (course 0x12); 0 otherwise. Cloud-confirmed against timeDry:"TIMEDRY_20".."TIMEDRY_60"
// while the Time Dry button was pressed through all five.
const TIME_DRY_OFFSET = 10
const TIME_DRY_MINUTES: Record<number, number> = { 1: 20, 2: 30, 3: 40, 4: 50, 5: 60 }
// rec[11]: the Signal (end-of-cycle beeper) setting. NOT cloud-confirmed like everything else in this file —
// the LG cloud sends no signal field for this family. Panel-confirmed: the byte alternated 0x04 <-> 0x00 on
// each press with the panel's On/Off lamp following.
const SIGNAL_OFFSET = 11
// rec[12]: the More/Less Time adjustment, a SIGNED byte holding the number of minutes added to or
// removed from the course's default time. Confirmed against the cloud's moreLessTime (which reports the
// same byte unsigned) across a Speed Dry trimmed from its 25-minute default down to 10:
// 0xfe/-2 -> 23 min, 0xf9/-7 -> 18, 0xf6/-10 -> 15, 0xf1/-15 -> 10. Every value matched 25 + offset.
const MORE_LESS_TIME_OFFSET = 12
// rec[15]: options bitfield, each bit isolated via a single-variable toggle against the cloud's enum.
// The 0x40 bit is the drum light (see the header) — a lamp, not a cycle option.
const FLAGS_OFFSET = 15
const FLAG_CHILD_LOCK = 0x01 // the panel calls it Control Lock (hold Damp Dry Signal); the cloud field is childLock
const FLAG_REDUCE_STATIC = 0x02
const FLAG_DAMP_DRY_SIGNAL = 0x08
// Confirmed across six clean on/off transitions, matching the cloud's wrinkleCare exactly, observed both
// with and without the 0x40 drum-light bit present. This is the offset that differs from RV13B6BSD_D_US_WIFI.
const FLAG_WRINKLE_CARE = 0x10
const FLAG_DRUM_LIGHT = 0x40 // not a cycle setting, stripped from every command built off the record
// rec[16]: a separate options bitfield from rec[15].
const OPT2_OFFSET = 16
// Remote Start. RV13B6BSD_D_US_WIFI documents this as not findable in any device frame; on this model it
// is rec[16] bit 0x01, isolated cleanly when the bit flipped in a frame that changed nothing else and the
// cloud reported remoteStart:"REMOTE_START_ON" 300ms later.
const OPT2_REMOTE_START = 0x01
const OPT2_ENERGY_SAVER = 0x02
// Turbo Steam is a button and a lamp. The bit is the button's option (four presses on Heavy Duty, four
// flips). The lamp is also lit on the two steam courses, which set no bit for it anywhere in the record, so
// the entity is published as the lamp shows: option bit, or a steam course.
const OPT2_TURBO_STEAM = 0x04
// rec[16] bit 0x80: Energy Saver's AUTOMATIC engagement (the model JSON's energySaverDefault). Present at
// rest and while Energy Saver switched itself on for Normal at the Normal dry level; it cleared — together
// with the 0x02 Energy Saver bit — the moment the option was turned off by hand on that course.
const OPT2_ENERGY_SAVER_AUTO = 0x80
// rec[17] bit 0x04: the panel's AI lamp. Per the manual it lights on Normal at the Normal dry level "except
// when the Energy Saver option is turned on"; since Energy Saver engages itself in exactly that state, the
// lamp is only ever seen after Energy Saver is switched off by hand — which is the single transition that
// set this bit (nothing else in the record moved; the cloud reports no field for it).
const OPT3_OFFSET = 17
const OPT3_AI = 0x04
// rec[23]: the load-item step code, matching the cloud's loadItem (LOADITEM_OFF/2/5 seen as 0x00/0x02/0x05).
// The panel displays an item count for each step (1 -> 7, 2 -> 9, 3 -> 11, 4 -> 14, 5 -> 16, 6 -> 18); the
// code is published as-is, like the siblings do.
const LOAD_ITEM_OFFSET = 23
// rec[24] (echoed at rec[21] while the Downloaded position is selected): the SmartCourse code currently
// held in the Downloaded slot. Factory default 0x64 (Super Dry). Same code the WMDownload command carries
// at body offset 11. Codes are NOT in the model JSON (it names the smart courses without numbering them) —
// each one is learned by capturing the app's download of it.
const DOWNLOAD_COURSE_OFFSET = 24

const PHASE_OFF = 0x00
const PHASE_PAUSED = 0x03
const COURSE_TIME_DRY = 0x12

// Course identifier -> name, derived from the capture by pairing rec[6] with the cloud's
// courseDryer27inchBase at matching timestamps. 'Super Dry' is the Downloaded Cycle dial position, which
// reports whichever smart course is loaded into it (the cloud confirmed it as both courseDryer27inchBase
// and smartCourseDryer27inchBase).
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    // Base courses that are NOT dial positions: each appears in the record after the app downloads the smart
    // course built on it (cloud courseDryer27inchBase names in the comments).
    'Ultra Delicate': 0x06, // ULTRA_DELICATES
    'Small Load': 0x09, // SMALLLOAD
    'Khaki/Jean': 0x0a, // KHAKIJEAN (Denim)
    Sportswear: 0x0b, // SPORTWEAR (Gym Clothes)
    Kidswear: 0x0c, // KIDWEAR (Kids Clothes)
    'Low Temp Dry': 0x0d, // LOWTEMPDRY (Rainy Day, Overnight Dry)
    'Jumbo Dry': 0x0e, // JUMBODRY (Blankets)
    'Rack Dry': 0x13, // RACKDRY
    Antibacterial: 0x08,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': COURSE_TIME_DRY,
    'Steam Fresh': 0x15,
    'Steam Sanitary': 0x16,
    'Super Dry': 0x1a,
})
// The steam courses light the Turbo Steam lamp on their own (see OPT2_TURBO_STEAM).
const STEAM_COURSES: number[] = [0x15, 0x16]

// Signal (beeper). This panel has a single On/Off Signal indicator (no Low/High step like RV13B6ES).
// Panel-confirmed, not cloud-confirmed — see SIGNAL_OFFSET.
const SIGNAL = Enum.of({
    Off: 0x00,
    On: 0x04,
})

// Names are the LG app's own (its Manage Downloads list), so the HA selects read like the app.
const SMARTCOURSE = Enum.of({
    'Super Dry': 0x64,
    Denim: 0x65,
    "Kids' Clothes": 0x66,
    'Small Load': 0x67,
    'Ultra Delicate': 0x68,
    'Gym Clothes': 0x6b,
    Blankets: 0x6c,
    'Blanket Refresh': 0x6d,
    'Rainy Days': 0x6e,
    Socks: 0x71,
    'Overnight Dry': 0x72,
    'Bedding / Curtains': 0x73,
    'Wrinkle Prevention': 0xca,
    'Static Reduce': 0xcc,
    'Half Load Dry': 0xcd,
    'Full Load Dry': 0xce,
    'Rack Dry': 0xd0,
})

// ---- SmartCourse download (the "Specialty cycle" flow) ----
// WMDownload = opcode f0 25, then 03 15 (0x15 = 21 = the model JSON's courseDownloadDataLength), then a
// 21-byte body in the START packet's layout with the SmartCourse code inserted at body offset 11, right after
// the second copy of the base course:
//
//   f0 25 03 15  <course> 00 00 <temp> 00 00 <timeDry> <flags> 01 00 <course> <smart> 00 00 00 <dryLevel> <loadItem> <moreLess> 00 00 00 00
//               body: 0     1  2    3     4  5     6        7     8  9    10       11    12 13 14    15        16        17     18 19 20
//
// Every entry is the exact frame the LG app sent for that download, cloud-confirmed by the slot read-back; all
// 17 of the model JSON's smart courses are here. The codes are not contiguous (0x64..0x73, then 0xca..0xd0),
// which is why none is inferred. Example (Denim: base course Khaki/Jean 0x0a, Medium 3, Normal dry 3):
//   f02503150a0000030000000001000a65000000030000000000
// It stores the cycle in the slot AND selects it (the record switched to course 0x0a with 0x65 in the slot
// without the dial moving); the panel's Downloaded position then runs it. Like every write it needs
// Remote Start armed.
const SPECIALTY_DOWNLOAD: Record<string, string> = {
    'Super Dry': 'f02503151a0000050000000001001a64000000050000000000',
    Denim: 'f02503150a0000030000000001000a65000000030000000000',
    "Kids' Clothes": 'f02503150c0000050000000001000c66000000030000000000',
    'Small Load': 'f0250315090000050000000001000967000000030000000000',
    'Ultra Delicate': 'f0250315060000010000000001000668000000030000000000',
    'Gym Clothes': 'f02503150b0000050000000001000b6b000000030000000000',
    Blankets: 'f02503150e0000030000000001000e6c000000050000000000',
    // Time Dry base (0x12) with the duration at body[6] and no dry level
    'Blanket Refresh': 'f025031512000001000001000100126d000000000000000000',
    // Time Dry 30 with +5 More Time at body[17] — the only download carrying a More/Less trim
    Socks: 'f0250315120000050000020001001271000000000005000000',
    'Rainy Days': 'f02503150d0000020000000001000d6e000000030000000000',
    // Wrinkle Care ON rides in the flags byte at body[7] (0x10, the same bit as rec[15])
    'Overnight Dry': 'f02503150d0000020000001001000d72000000030000000000',
    'Bedding / Curtains': 'f0250315070000030000000001000773000000050000000000',
    'Wrinkle Prevention': 'f02503150300000300000010010003ca000000030000000000',
    // Reduce Static ON in the flags byte (0x02) AND a load-item count of 5 at body[16] — the only download to carry one
    'Static Reduce': 'f02503150300000300000002010003cc000000030500000000',
    'Half Load Dry': 'f02503150300000300000000010003cd000000040000000000',
    'Full Load Dry': 'f02503150100000500000000010001ce000000050000000000',
    // Rack Dry: base course 0x13 (not a dial position), no heat (temp 0) and no sensing (dry level 0) — the drum does not tumble
    'Rack Dry': 'f02503151300000000000000010013d0000000000000000000',
}

// ---- Commands ----
// All captured from the LG cloud in bridge mode while this dryer was driven from the app, and checksum-verified
// against AABBDevice.send(). The 0xF024 action family is byte-identical to the washers' (pause 04, power off 01).
// The 0xF026 start packet layout — 22 bytes after the opcode:
//
//   f0 26 <course> 00 00 <temp> 00 00 <timeDry> <flags> <verb+opts> 00 <course> <smart> 00 00 00 <dryLevel> <loadItem> <moreLess> 00 00 00
//     0 1     2     3  4    5    6  7     8        9        10       11    12      13    14 15 16    17        18        19     20 21 22
//
// Start and resume are the same packet; the 0x40 bit at offset 10 is "begin a new cycle" and clearing it
// resumes a paused one. The app starts captured, which pin every field the builder writes:
//   Normal, defaults:            f026 03 0000 04 0000 00 00 43 00 03 00000000 03 00 00 000000   (Energy Saver on by default -> verb 0x43)
//   Normal + Wrinkle Care:       f026 03 0000 04 0000 00 10 43 00 03 00000000 03 00 00 000000   (Wrinkle Care = flags 0x10, the rec[15] bit)
//   Time Dry 38 min, Medium:     f026 12 0000 03 0000 03 00 41 00 12 00000000 00 00 fe 000000   (duration 40 + More/Less -2)
//   Heavy Duty + Reduce Static:  f026 01 0000 05 0000 00 02 41 00 01 00000000 03 05 00 000000   (flags 0x02 AND load-item code 5 at offset 18)
//   Downloaded Denim:            f026 0a 0000 03 0000 00 00 41 00 0a 65 000000 03 00 dd 000000   (base Khaki/Jean, code 0x65 at offset 12, More/Less -35)
// Damp Dry Signal (0x08) is NOT written: no captured start carries it (the app does not offer it remotely), so
// it stays at the course default.
const CMD_START = [0xf0, 0x26]
const CMD_PAUSE = [0xf0, 0x24, 0x04, 0x01, 0x00]
const CMD_POWER_OFF = [0xf0, 0x24, 0x01, 0x01, 0x00]
const START_OPTS_BASE = 0x01
const START_OPTS_NEW_CYCLE = 0x40
const START_OPTS_ENERGY_SAVER = 0x02

// Per-course defaults for a remote start, from the model JSON's Course table; they match what the panel showed
// for every dial position captured.
const COURSE_DEFAULTS: Record<string, { temp: number; dryLevel: number; energySaver?: boolean; timeDry?: number }> = {
    'Heavy Duty': { temp: 5, dryLevel: 3 },
    Towels: { temp: 4, dryLevel: 3 },
    Normal: { temp: 4, dryLevel: 3, energySaver: true },
    Delicates: { temp: 2, dryLevel: 3 },
    'Perm Press': { temp: 3, dryLevel: 3 },
    Bedding: { temp: 3, dryLevel: 3 },
    Antibacterial: { temp: 5, dryLevel: 5 },
    'Speed Dry': { temp: 5, dryLevel: 0 },
    'Air Dry': { temp: 0, dryLevel: 0 },
    'Steam Fresh': { temp: 4, dryLevel: 0 },
    'Steam Sanitary': { temp: 5, dryLevel: 0 },
    'Time Dry': { temp: 5, dryLevel: 0, timeDry: 3 },
}
// A smart course starts as its BASE course with the SmartCourse code at packet offset 12 — the same slot the
// download carries it in. Base course, temp, dry level, Time Dry selector, flags, load item and trim for each
// smart course are read off its captured download frame rather than typed twice.
function smartCourseDefaults(name: string) {
    const dl = SPECIALTY_DOWNLOAD[name]
    if (!dl) return undefined
    const b = Buffer.from(dl.slice(8), 'hex') // after f0 25 03 15
    return {
        course: b[0],
        temp: b[3],
        timeDry: b[6],
        flags: b[7],
        smart: b[11],
        dryLevel: b[15],
        loadItem: b[16],
        moreLess: b.readInt8(17),
    }
}
const TARGET_COURSES = [...Object.keys(COURSE_DEFAULTS), ...Object.keys(SPECIALTY_DOWNLOAD)]
// Staged temp / dry level / Energy Saver can be left at the course's own default.
const COURSE_DEFAULT = 'Course default'
const ENERGY_SAVER = Enum.of({ [COURSE_DEFAULT]: 0, On: 1, Off: 2 })
// The panel steps More/Less in 5-minute increments; the app's own starts go past the panel's +/-30 (the captured
// Denim start carries -35), so the staged range is the byte's practical span rather than the panel's.
const MORE_LESS_MIN = -60
const MORE_LESS_MAX = 60

export default class Device extends AABBDevice {
    // The last status record, for commands built off what the panel has set.
    private lastRecord: Buffer | null = null

    // Staged remote-start options, assembled into one start packet by start_course.
    private targetCourse = 'Normal'
    private targetTemp?: number
    private targetDryLevel?: number
    private targetTimeDryMinutes?: number
    private targetMoreLessTime?: number
    private targetWrinkleCare = false
    private targetReduceStatic = false
    private targetEnergySaver = COURSE_DEFAULT

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    // Remote power-off drops the Wi-Fi module until the panel's Power button brings it back; there
                    // is no remote power-on, as on the other dryers that expose this.
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: 'PRESS',
                        name: 'Power off',
                        icon: 'mdi:power-off',
                        availability: [
                            {
                                topic: '$this/power',
                                payload_available: 'ON',
                                payload_not_available: 'OFF',
                            },
                        ],
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.options,
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.options,
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
                    // Which SmartCourse is loaded in the Downloaded slot (rec[24]); pairs with the `specialty` select
                    // (writes the slot). The panel's Downloaded position runs it.
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded course',
                        icon: 'mdi:download-circle-outline',
                        device_class: 'enum',
                        options: SMARTCOURSE.options,
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
                        name: 'Initial time estimate',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMPERATURES.options,
                    },
                    time_dry_setting: {
                        platform: 'sensor',
                        unique_id: '$deviceid-time_dry_setting',
                        state_topic: '$this/time_dry_setting',
                        name: 'Time Dry setting',
                        icon: 'mdi:timer-cog-outline',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    more_less_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-more_less_time',
                        state_topic: '$this/more_less_time',
                        name: 'More/Less time',
                        icon: 'mdi:plus-minus-variant',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    load_item: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_item',
                        state_topic: '$this/load_item',
                        name: 'Load items',
                        icon: 'mdi:tshirt-crew-outline',
                        state_class: 'measurement',
                    },
                    signal: {
                        platform: 'sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell-outline',
                        device_class: 'enum',
                        options: SIGNAL.options,
                        entity_category: 'diagnostic',
                    },
                    ai: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-ai',
                        state_topic: '$this/ai',
                        name: 'AI sensing',
                        icon: 'mdi:brain',
                        entity_category: 'diagnostic',
                    },
                    energy_saver_auto: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver_auto',
                        state_topic: '$this/energy_saver_auto',
                        name: 'Energy Saver automatic',
                        icon: 'mdi:leaf',
                        entity_category: 'diagnostic',
                    },
                    reduce_static: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-reduce_static',
                        state_topic: '$this/reduce_static',
                        name: 'Reduce static',
                        icon: 'mdi:flash-off-outline',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        device_class: 'light',
                        entity_category: 'diagnostic',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    turbo_steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_steam',
                        state_topic: '$this/turbo_steam',
                        name: 'Turbo Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    // A control, as in the LG app: while the dryer is PAUSED, switching it sends the app's resume-apply
                    // packet (the start packet with the new-cycle bit clear and the flag changed) and the cycle resumes
                    // with Wrinkle Care as set. At any other time the dryer accepts no remote edit, so the switch snaps
                    // back to the panel's actual state; target_wrinkle_care starts a cycle with it on.
                    wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        command_topic: '$this/wrinkle_care/set',
                        name: 'Wrinkle Care',
                        icon: 'mdi:iron-outline',
                    },
                    // Starts the cycle set at the panel (course, temp, dry level, Time Dry, options), or resumes a paused
                    // one. Needs Remote Start armed at the machine, as with the LG app; unarmed, the dryer ignores the
                    // command.
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: 'PRESS',
                        name: 'Start / Resume',
                        icon: 'mdi:play',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: 'PRESS',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    // WMDownload: stores the picked SmartCourse into the Downloaded slot and selects it; the panel's
                    // Downloaded position (or Start) then runs it. Snaps back to 'unknown' after firing; the loaded
                    // cycle is read back on `downloaded_course`.
                    specialty: {
                        platform: 'select',
                        unique_id: '$deviceid-specialty',
                        command_topic: '$this/specialty/set',
                        state_topic: '$this/specialty',
                        options: ['unknown', ...Object.keys(SPECIALTY_DOWNLOAD)],
                        name: 'Download specialty cycle',
                        icon: 'mdi:cloud-download-outline',
                    },
                    // ---- Staged remote start: the target_* values are assembled into one start packet by start_course,
                    // the way the LG app commits a composed cycle. Dial courses start at their defaults; a smart course
                    // starts as its base course with its code, straight from the captured download. ----
                    target_course: {
                        platform: 'select',
                        unique_id: '$deviceid-target_course',
                        state_topic: '$this/target_course',
                        command_topic: '$this/target_course/set',
                        options: TARGET_COURSES,
                        name: 'Target course',
                        icon: 'mdi:tumble-dryer',
                    },
                    target_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-target_temp',
                        state_topic: '$this/target_temp',
                        command_topic: '$this/target_temp/set',
                        options: [COURSE_DEFAULT, ...TEMPERATURES.options.filter((o) => TEMPERATURES.unmap(o) !== 0)],
                        name: 'Target temperature',
                        icon: 'mdi:thermometer',
                    },
                    target_dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-target_dry_level',
                        state_topic: '$this/target_dry_level',
                        command_topic: '$this/target_dry_level/set',
                        options: [COURSE_DEFAULT, ...DRY_LEVELS.options.filter((o) => DRY_LEVELS.unmap(o) !== 0)],
                        name: 'Target dry level',
                        icon: 'mdi:water-percent',
                    },
                    // Time Dry only: the nearest selector step (20..60) becomes the duration and the remainder the
                    // More/Less trim, the app's own encoding (38 -> 40 with -2).
                    target_time_dry: {
                        platform: 'number',
                        unique_id: '$deviceid-target_time_dry',
                        state_topic: '$this/target_time_dry',
                        command_topic: '$this/target_time_dry/set',
                        min: 20,
                        max: 60,
                        step: 1,
                        name: 'Target Time Dry',
                        icon: 'mdi:timer-cog-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    target_more_less_time: {
                        platform: 'number',
                        unique_id: '$deviceid-target_more_less_time',
                        state_topic: '$this/target_more_less_time',
                        command_topic: '$this/target_more_less_time/set',
                        min: MORE_LESS_MIN,
                        max: MORE_LESS_MAX,
                        step: 5,
                        name: 'Target More/Less time',
                        icon: 'mdi:plus-minus-variant',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    target_wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-target_wrinkle_care',
                        state_topic: '$this/target_wrinkle_care',
                        command_topic: '$this/target_wrinkle_care/set',
                        name: 'Target Wrinkle Care',
                        icon: 'mdi:iron-outline',
                    },
                    // Reduce Static engages load-item code 5 on the panel and in the app's start.
                    target_reduce_static: {
                        platform: 'switch',
                        unique_id: '$deviceid-target_reduce_static',
                        state_topic: '$this/target_reduce_static',
                        command_topic: '$this/target_reduce_static/set',
                        name: 'Target Reduce Static',
                        icon: 'mdi:flash-off-outline',
                    },
                    target_energy_saver: {
                        platform: 'select',
                        unique_id: '$deviceid-target_energy_saver',
                        state_topic: '$this/target_energy_saver',
                        command_topic: '$this/target_energy_saver/set',
                        options: ENERGY_SAVER.options,
                        name: 'Target Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    // Sends the start packet built from the staged target_* values, regardless of the dial. Needs Remote
                    // Start armed.
                    start_course: {
                        platform: 'button',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        payload_press: 'PRESS',
                        name: 'Start course',
                        icon: 'mdi:play-circle-outline',
                    },
                },
            }),
        )
    }

    // These dryers only volunteer a status frame when something changes, so a driver that never
    // asks stays blank until the next physical interaction — and every reconnect (container
    // restart, appliance reboot) discards the last known state, leaving Home Assistant pinned at
    // "Off"/unknown indefinitely. Asking once per connect is what makes the entities survive a
    // restart.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    // The appliance is the interlock and the only one: Remote Start must be armed at the panel and cannot be
    // armed remotely; an unarmed start is simply ignored (the dryer beeps). Nothing here re-checks that.
    setProperty(prop: string, value: string) {
        if (prop === 'pause') {
            if (value === 'PRESS') this.send(Buffer.from(CMD_PAUSE))
        } else if (prop === 'power_off') {
            if (value === 'PRESS') this.send(Buffer.from(CMD_POWER_OFF))
        } else if (prop === 'start') {
            const rec = this.lastRecord
            if (value !== 'PRESS' || !rec) return
            // Start and resume are the same packet; only the 0x40 bit at offset 10 separates them.
            const opts =
                START_OPTS_BASE |
                (rec[PHASE_OFFSET] === PHASE_PAUSED ? 0 : START_OPTS_NEW_CYCLE) |
                ((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0 ? START_OPTS_ENERGY_SAVER : 0)
            this.send(this.startPacketFromRecord(rec, rec[FLAGS_OFFSET] & ~FLAG_DRUM_LIGHT & 0xff, opts))
        } else if (prop === 'wrinkle_care') {
            const rec = this.lastRecord
            if (!rec) return
            if (rec[PHASE_OFFSET] !== PHASE_PAUSED) {
                // not editable remotely unless paused: reflect the real state back so HA's switch does not lie
                this.publishProperty('wrinkle_care', (rec[FLAGS_OFFSET] & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
                return
            }
            const flags =
                (rec[FLAGS_OFFSET] & ~FLAG_DRUM_LIGHT & ~FLAG_WRINKLE_CARE & 0xff) |
                (value === 'ON' ? FLAG_WRINKLE_CARE : 0)
            this.send(
                this.startPacketFromRecord(
                    rec,
                    flags,
                    START_OPTS_BASE | ((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0 ? START_OPTS_ENERGY_SAVER : 0),
                ),
            )
        } else if (prop === 'specialty') {
            const dl = SPECIALTY_DOWNLOAD[value]
            if (dl === undefined) return
            this.send(Buffer.from(dl, 'hex'))
            this.publishProperty('specialty', 'unknown')
        } else if (prop === 'target_course') {
            if (!TARGET_COURSES.includes(value)) return
            this.targetCourse = value
            this.publishProperty(prop, value)
        } else if (prop === 'target_temp') {
            const code = value === COURSE_DEFAULT ? undefined : TEMPERATURES.unmap(value)
            if (value !== COURSE_DEFAULT && !code) return
            this.targetTemp = code
            this.publishProperty(prop, value)
        } else if (prop === 'target_dry_level') {
            const code = value === COURSE_DEFAULT ? undefined : DRY_LEVELS.unmap(value)
            if (value !== COURSE_DEFAULT && !code) return
            this.targetDryLevel = code
            this.publishProperty(prop, value)
        } else if (prop === 'target_time_dry') {
            const minutes = Device.parseMinutes(value, 20, 60)
            if (minutes === undefined) return
            this.targetTimeDryMinutes = minutes
            this.publishProperty(prop, minutes)
        } else if (prop === 'target_more_less_time') {
            const minutes = Device.parseMinutes(value, MORE_LESS_MIN, MORE_LESS_MAX)
            if (minutes === undefined) return
            this.targetMoreLessTime = minutes
            this.publishProperty(prop, minutes)
        } else if (prop === 'target_wrinkle_care' || prop === 'target_reduce_static') {
            if (value !== 'ON' && value !== 'OFF') return
            if (prop === 'target_wrinkle_care') this.targetWrinkleCare = value === 'ON'
            else this.targetReduceStatic = value === 'ON'
            this.publishProperty(prop, value)
        } else if (prop === 'target_energy_saver') {
            if (ENERGY_SAVER.unmap(value) === undefined) return
            this.targetEnergySaver = value
            this.publishProperty(prop, value)
        } else if (prop === 'start_course') {
            if (value !== 'PRESS') return
            const pkt = this.buildCourseStart()
            if (pkt) this.send(pkt)
        }
    }

    private static parseMinutes(value: string, min: number, max: number) {
        const m = Math.round(Number(value))
        return Number.isFinite(m) && m >= min && m <= max ? m : undefined
    }

    // The start/resume packet built from the appliance's own record: what the panel has set, with the given
    // flags byte and verb/options byte. The app sends exactly this shape for a start and for a resume-apply.
    private startPacketFromRecord(rec: Buffer, flags: number, opts: number): Buffer {
        return Buffer.from([
            ...CMD_START,
            rec[COURSE_OFFSET],
            0,
            0,
            rec[TEMP_OFFSET],
            0,
            0,
            rec[COURSE_OFFSET] === COURSE_TIME_DRY ? rec[TIME_DRY_OFFSET] : 0,
            flags,
            opts,
            0,
            rec[COURSE_OFFSET],
            0,
            0,
            0,
            0,
            rec[DRY_LEVEL_OFFSET],
            rec[LOAD_ITEM_OFFSET], // the app carries the current load-item code here (captured with Reduce Static on)
            rec[MORE_LESS_TIME_OFFSET],
            0,
            0,
            0,
        ])
    }

    // The start packet for the staged target_* values, exactly the way the LG app commits a composed cycle: the
    // course's defaults, then the overrides. Returns null rather than sending a guess when the staged values do
    // not fit the course (a Time Dry duration on any other course).
    private buildCourseStart(): Buffer | null {
        const smart = smartCourseDefaults(this.targetCourse)
        const def = smart
            ? { temp: smart.temp, dryLevel: smart.dryLevel, timeDry: smart.timeDry || undefined, energySaver: false }
            : COURSE_DEFAULTS[this.targetCourse]
        const course = smart ? smart.course : COURSE.unmap(this.targetCourse)
        if (!def || course === undefined) return null
        const temp = this.targetTemp ?? def.temp
        const dryLevel = this.targetDryLevel ?? def.dryLevel
        let timeDry = def.timeDry ?? 0
        let moreLess = this.targetMoreLessTime ?? smart?.moreLess ?? 0
        if (this.targetTimeDryMinutes !== undefined) {
            if (course !== COURSE_TIME_DRY) return null
            // nearest selector step, remainder as the trim — the app's own encoding (38 -> selector 40, trim -2)
            const sel = Math.min(5, Math.max(1, Math.round(this.targetTimeDryMinutes / 10) - 1))
            timeDry = sel
            moreLess = this.targetTimeDryMinutes - TIME_DRY_MINUTES[sel]
        }
        const flags =
            (smart?.flags ?? 0) |
            (this.targetWrinkleCare ? FLAG_WRINKLE_CARE : 0) |
            (this.targetReduceStatic ? FLAG_REDUCE_STATIC : 0)
        const loadItem = this.targetReduceStatic ? 5 : (smart?.loadItem ?? 0)
        // "Course default" is the model JSON's default, which is what the app sends: its captured Normal start
        // carries Energy Saver on although the record it was issued against had Energy Saver switched off by
        // hand (rec[16] 0x02 and 0x80 both clear). A panel that keeps Energy Saver off for Normal therefore
        // differs from a "Course default" remote start; stage target_energy_saver Off to match it.
        const energySaver =
            this.targetEnergySaver === COURSE_DEFAULT ? (def.energySaver ?? false) : this.targetEnergySaver === 'On'
        const opts = START_OPTS_BASE | START_OPTS_NEW_CYCLE | (energySaver ? START_OPTS_ENERGY_SAVER : 0)
        return Buffer.from([
            ...CMD_START,
            course,
            0,
            0,
            temp,
            0,
            0,
            timeDry,
            flags,
            opts,
            0,
            course,
            smart?.smart ?? 0,
            0,
            0,
            0,
            dryLevel,
            loadItem,
            moreLess & 0xff,
            0,
            0,
            0,
        ])
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x30, STATUS_LENGTH, this.processStatus)
        // 0x31 (serial), 0xE2 (idle snapshot) and 0xD8/0x72 (heartbeats) are not decoded.
    }

    private processStatus(status: Buffer) {
        const rec = status.subarray(1)
        if (rec[0] !== 0x1b) return // the current-state record should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATES.map(phase))
        const error = rec[ERROR_OFFSET]
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('downloaded_course', SMARTCOURSE.map(rec[DOWNLOAD_COURSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('dry_level', DRY_LEVELS.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('temp', TEMPERATURES.map(rec[TEMP_OFFSET]))
        this.publishProperty(
            'time_dry_setting',
            rec[COURSE_OFFSET] === COURSE_TIME_DRY ? (TIME_DRY_MINUTES[rec[TIME_DRY_OFFSET]] ?? 0) : 0,
        )
        this.publishProperty('load_item', rec[LOAD_ITEM_OFFSET])
        this.publishProperty('signal', SIGNAL.map(rec[SIGNAL_OFFSET]))
        // signed: negative trims the course default, positive extends it
        this.publishProperty('more_less_time', isOff ? 0 : rec.readInt8(MORE_LESS_TIME_OFFSET))

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('reduce_static', (flags & FLAG_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (flags & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (flags & FLAG_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        const turboSteam = (opt2 & OPT2_TURBO_STEAM) !== 0 || STEAM_COURSES.includes(rec[COURSE_OFFSET])
        this.publishProperty('turbo_steam', turboSteam ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('energy_saver_auto', (opt2 & OPT2_ENERGY_SAVER_AUTO) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('ai', (rec[OPT3_OFFSET] & OPT3_AI) !== 0 ? 'ON' : 'OFF')
        this.lastRecord = Buffer.from(rec)
    }
}
