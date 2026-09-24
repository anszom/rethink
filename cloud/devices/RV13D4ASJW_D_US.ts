import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

type StartRequest = {
    course: string
    temp?: string
    dry_level?: string
    minutes?: number
    more_less_time?: number
    wrinkle_care?: boolean
    reduce_static?: boolean
    energy_saver?: boolean
}

// LG DLEX4000W electric dryer — matched on modelId "RV13D4ASJW_D_US" (ThinQ2, deviceType 202,
// modelJson "Victor2 Refresh Better (D) WiFi"). Same AABB frame family as RV13B6ES_D_US_WIFI / RV13B6BSD_D_US_WIFI:
// frames (buf = the AABB body, AA+len and checksum+BB already stripped) start with 0x30 and are discriminated by buf[1]:
//   0xEC        dial/status frame — two stacked records (29-byte old state, 28-byte current state), each
//               starting with a 0x1b marker; we read the current-state record (buf[32:]).
//   0xEB        single-record status frame (28-byte record at buf[3:]) — same field layout as 0xEC's
//               current-state record.
//
// Every offset and table below was re-derived on THIS appliance (2026-09-19) with rethink-capture --cloud:
// one variable at a time on the panel, each byte change paired with the LG cloud's own decoded washerDryer
// field in the same second. The record layout came out byte-for-byte identical to RV13B6ES_D_US_WIFI —
// including Wrinkle Care in rec[15] bit 0x10 (the offset that separates that model from RV13B6BSD) — and
// all twelve dial courses use the same codes, so this file is that handler under its own model id rather
// than an alias: an alias would silently inherit any future change to the relative, and the two are
// different appliances with different course/option sets (this one's Signal is a plain On/Off, and its steam
// courses carry Turbo Steam).
//
// rec[15] bit 0x40: set by the Drum Light hold (Wrinkle Care button, 3 s) and also observed while the panel
// was being operated, clearing on its own — the two were not separated on this appliance, so it is left
// undecoded rather than published as a light.
//
// Not decoded (declared entities intentionally omitted rather than published wrong): error codes (never
// observed) and a door sensor (opening the door produced no distinct byte; a mid-cycle door opening is the
// same generic Pause a button press gives).
const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 60 // 3B header + 29B record A (old) + 28B record B (current)
const RECORD_B_OFFSET = 32

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 31 // 3B header + 28B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request —
// the fridges, the EU washers and the US WashTower all use it; actuating commands are 0xF0E5,
// so this only ever reads. Confirmed on a live RV13B6ES: the dryer answered within a second
// with a 0xEB snapshot, then resumed normal 0xEC updates.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Offsets below are relative to the record's own 0x1b marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute]: the live countdown while running, or the estimated cycle time while
// Initial/Selecting. Confirmed against the cloud's remainTimeHour/Minute, including the hour rollover
// (Antibacterial reported 1h10m and decoded as 70 minutes).
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute]: a genuine separate initial-time estimate that stays fixed once a cycle is
// running while rec[2:4] counts down — confirmed against the cloud's initialTimeHour/Minute.
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
const COURSE_OFFSET = 6
const DRY_LEVEL_OFFSET = 8
const TEMP_OFFSET = 9
// rec[11]: the Signal (end-of-cycle beeper) setting. This one is NOT cloud-confirmed like everything else
// in this file — the LG cloud sends no signal field for this dryer at all (verified against a full
// allDeviceInfoUpdate snapshot). It was mapped from the wire alone: pressing Signal cycles the byte
// 0x00 -> 0x01 -> 0x04 -> 0x00 with nothing else in the record moving, and the three values were tied to
// the panel's own Off/Low/High indicator by reading the lit LED after each press.
const SIGNAL_OFFSET = 11
// rec[12]: the More/Less Time adjustment, a SIGNED byte holding the number of minutes added to or
// removed from the course's default time. Confirmed against the cloud's moreLessTime (which reports the
// same byte unsigned) across a Speed Dry trimmed from its 25-minute default down to 10:
// 0xfe/-2 -> 23 min, 0xf9/-7 -> 18, 0xf6/-10 -> 15, 0xf1/-15 -> 10. Every value matched 25 + offset.
const MORE_LESS_TIME_OFFSET = 12
// rec[15]: options bitfield, each bit isolated via a single-variable toggle against the cloud's enum.
// The 0x40 "base" bit is present while the panel is awake and clears on panel idle timeout and while
// actively drying — it is not part of any single option, so it is not exposed as its own entity.
const FLAGS_OFFSET = 15
const FLAG_CONTROL_LOCK = 0x01 // the panel calls it Control Lock (hold Damp Dry Signal); the cloud field is childLock
const FLAG_REDUCE_STATIC = 0x02
const FLAG_DAMP_DRY_SIGNAL = 0x08
// Confirmed across six clean on/off transitions, matching the cloud's wrinkleCare exactly, observed both
// with and without the 0x40 base bit present. This is the offset that differs from RV13B6BSD_D_US_WIFI.
const FLAG_WRINKLE_CARE = 0x10
// rec[16]: a separate options bitfield from rec[15].
const OPT2_OFFSET = 16
// Remote Start. RV13B6BSD_D_US_WIFI documents this as not findable in any device frame ("appears
// cloud-side only"); on this model it is rec[16] bit 0x01, isolated cleanly when the bit flipped in a
// frame that changed nothing else and the cloud reported remoteStart:"REMOTE_START_ON" 300ms later.
const OPT2_REMOTE_START = 0x01
const OPT2_ENERGY_SAVER = 0x02
const OPT2_TURBO_STEAM = 0x04
// rec[23]: literal count of "load items", matching the cloud's loadItem (LOADITEM_OFF/2/5 seen as
// 0x00/0x02/0x05). Not decoded by RV13B6BSD_D_US_WIFI.
const LOAD_ITEM_OFFSET = 23
// The load-item code is a step index; the number of items the panel actually displays for each step (Tom read
// them off the display): 1 -> 7, 2 -> 9, 3 -> 11, 4 -> 14, 5 -> 16, 6 -> 18. 0 = no load-item setting.
const LOAD_ITEMS: Record<number, number> = { 1: 7, 2: 9, 3: 11, 4: 14, 5: 16, 6: 18 }

const PHASE_OFF = 0x00

// Phase/status byte. Every code was observed directly on this appliance and cross-checked against the
// cloud's own state field in the same second (POWEROFF / INITIAL / PAUSE / DRYING / COOLING / END /
// WRINKLECARE). With Wrinkle Care selected a cycle runs Drying -> Cooling -> End (about 30 s) -> Wrinkle
// Care, the after-cycle tumble; End is brief in that case, so trigger on the transition, not on a dwell.
// While it runs the initial-time field counts elapsed minutes up and remaining time stays at 1. The tumble was
// still running after 114 minutes when it was powered off by hand (Wrinkle Care -> Off); how it ends when left
// alone has not been observed.
// Anything outside this table falls back to 'Running' rather than being reported wrongly.
const STATUS = Enum.of({
    Off: 0x00,
    Initial: 0x01,
    Pause: 0x03,
    Drying: 0x32,
    Cooling: 0x33,
    End: 0x04,
    'Wrinkle Care': 0x38,
})

// Course identifier -> name, derived from the capture by pairing rec[6] with the cloud's
// courseDryer27inchBase at matching timestamps. All 14 values below were observed on this appliance.
// 'Super Dry' is the Downloaded Cycle dial position, which reports whichever smart course is loaded
// into it (the cloud confirmed it as both courseDryer27inchBase and smartCourseDryer27inchBase).
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm. Press': 0x04, // printed with the period on the dial
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
    'Time Dry': 0x12,
    'Steam Fresh': 0x15,
    'Steam Sanitary': 0x16,
    'Super Dry': 0x1a,
})

// Dry level 1-5, confirmed by single-step toggling against the cloud's dryLevel enum. 0 (NO_DRYLEVEL)
// is used by courses that do not auto-sense dryness (Speed Dry, Air Dry, Steam Fresh, Time Dry) and
// is left undecoded below, so the entity reads unknown.
const DRY_LEVEL = Enum.of({
    Damp: 1,
    Less: 2,
    Normal: 3,
    More: 4,
    Very: 5,
})

// Temp 1-5, confirmed the same way against the cloud's temp enum. 0 (NO_TEMP) is used by courses with
// no heating element (Air Dry) and is left undecoded below, so the entity reads unknown.
const TEMP = Enum.of({
    'Ultra Low': 1,
    Low: 2,
    Medium: 3,
    'Mid High': 4,
    High: 5,
})

// Signal (beeper). This panel has a single On/Off Signal indicator (no Low/High step like RV13B6ES): the byte
// alternated 0x04 <-> 0x00 on each press with the panel's On/Off lamp following. Panel-confirmed, not
// cloud-confirmed — see SIGNAL_OFFSET.
const SIGNAL = Enum.of({
    Off: 0x00,
    On: 0x04,
})

// rec[10]: the Time Dry duration selector, 1..5 = 20..60 minutes in steps of 10 (the display's own column).
// Only meaningful on Time Dry (course 0x12); 0 otherwise. Cloud-confirmed against timeDry:"TIMEDRY_20".."TIMEDRY_60"
// while the Time Dry button was pressed through all five.
const TIME_DRY_OFFSET = 10
const TIME_DRY = Enum.of({
    '20 min': 1,
    '30 min': 2,
    '40 min': 3,
    '50 min': 4,
    '60 min': 5,
})
// rec[16] bit 0x80: Energy Saver's AUTOMATIC engagement (the model JSON's energySaverDefault). Present at
// rest and while Energy Saver switched itself on for Normal at the Normal dry level; it cleared — together
// with the 0x02 Energy Saver bit — the moment the option was turned off by hand on that course.
const OPT2_ENERGY_SAVER_AUTO = 0x80
// rec[17] bit 0x04: the panel's AI lamp. Per the manual it lights on Normal at the Normal dry level "except
// when the Energy Saver option is turned on"; since Energy Saver engages itself in exactly that state, the
// lamp is only ever seen after Energy Saver is switched off by hand — which is the single transition that
// set this bit (nothing else in the record moved, the cloud reports no field for it).
const OPT3_OFFSET = 17
const OPT3_AI = 0x04
// rec[20]: the previous phase, kept across a transition (Initial 0x01 -> Drying 0x32 -> Pause 0x03 -> Drying;
// Drying -> Off leaves 0x32 here). Matches the cloud's preState. rec[19] counts up while running (seconds or
// a fraction thereof; not pinned) and is left unpublished.
const PREV_PHASE_OFFSET = 20
const PHASE_PAUSED = 0x03

// rec[24] (echoed at rec[21] while the Downloaded position is selected): the SmartCourse code currently
// held in the Downloaded slot. Factory default 0x64 (Super Dry); the app's Denim download wrote 0x65. Same
// code the WMDownload command carries at body offset 11. Codes are NOT in the model JSON (it names the
// smart courses without numbering them) — each one is learned by capturing the app's download of it.
const DOWNLOAD_COURSE_OFFSET = 24
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
// All seventeen were captured 2026-09-19 by pushing each from the LG app in turn (the
// app hung once on Bedding / Curtains and re-sent it; the clean retry is the frame kept here). All 17 of the
// model JSON's smart courses are present, each the exact frame the app sent, cloud-confirmed by the slot
// read-back. The codes are not contiguous (0x64..0x73, then 0xca..0xd0), which is why none is inferred. Example (Denim: base course Khaki/Jean 0x0a, Medium 3, Normal dry 3):
//   f02503150a0000030000000001000a65000000030000000000
// It stores the cycle in the slot AND selects it (the record switched to course 0x0a with 0x65 in the slot
// without the dial moving); the panel's Downloaded position then runs it. Like every write it needs
// Remote Start armed. Every entry is a captured frame — a generated frame with a guessed code is exactly
// the kind of write this project refuses.
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
    'Rainy Days': 'f02503150d0000020000000001000d6e000000030000000000',
    // Time Dry 30 with +5 More Time at body[17] — the only download carrying a More/Less trim
    Socks: 'f0250315120000050000020001001271000000000005000000',
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

// Commands, all captured from the LG cloud in bridge mode while this dryer was driven from the app
// (2026-09-19) and checksum-verified against AABBDevice.send(). The 0xF024 action family is byte-identical
// to the washers' (pause 04, power off 01). The 0xF026 start packet layout — 22 bytes after the opcode:
//
//   f0 26 <course> 00 00 <temp> 00 00 <timeDry> <flags> <verb+opts> 00 <course> 00 x4 <dryLevel> 00 <moreLess> 00 x3
//     0 1     2     3  4    5    6  7     8        9        10       11    12            17        18   19
//
// Captured start on Normal:  f026 03 0000 04 0000 00 00 41 00 03 00000000 03 00 00 000000
// Captured resume from pause: identical except offset 10 = 0x01 — the 0x40 bit is "begin a new cycle";
// clearing it resumes. Energy Saver adds 0x02 (seen in the sibling family's captures; not exercised here
// because the run was started with Energy Saver off). The command is built from the appliance's own last
// reported record, so Home Assistant starts what is set on the machine, as the LG app does.
// ---- Remote course start (the "commit a blob" flow) ----
// The LG app lets you compose a cycle and commits it as ONE start packet; the packet is authoritative (the
// dryer runs what it carries, not what the dial shows). Three app starts were captured 2026-09-19 and pin
// every field the builder writes:
//   Normal, defaults:            f026 03 0000 04 0000 00 00 43 00 03 00000000 03 00 00 000000   (Energy Saver on by default -> verb 0x43)
//   Normal + Wrinkle Care:       f026 03 0000 04 0000 00 10 43 00 03 00000000 03 00 00 000000   (Wrinkle Care = flags 0x10, the rec[15] bit)
//   Time Dry 38 min, Medium:     f026 12 0000 03 0000 03 00 41 00 12 00000000 00 00 fe 000000   (duration 40 + More/Less -2)
//   Heavy Duty + Reduce Static:  f026 01 0000 05 0000 00 02 41 00 01 00000000 03 05 00 000000   (flags 0x02 AND load-item code 5 at offset 18)
// Per-course defaults come from the model JSON's Course table and match what the panel showed for every dial
// position captured. Damp Dry Signal (0x08) is NOT written: no captured start carries it (the app does not offer it
// remotely), so it stays at the course default.
const COURSE_DEFAULTS: Record<string, { temp: number; dryLevel: number; energySaver?: boolean; timeDry?: number }> = {
    'Heavy Duty': { temp: 5, dryLevel: 3 },
    Towels: { temp: 4, dryLevel: 3 },
    Normal: { temp: 4, dryLevel: 3, energySaver: true },
    Delicates: { temp: 2, dryLevel: 3 },
    'Perm. Press': { temp: 3, dryLevel: 3 },
    Bedding: { temp: 3, dryLevel: 3 },
    Antibacterial: { temp: 5, dryLevel: 5 },
    'Speed Dry': { temp: 5, dryLevel: 0 },
    'Air Dry': { temp: 0, dryLevel: 0 },
    'Steam Fresh': { temp: 4, dryLevel: 0 },
    'Steam Sanitary': { temp: 5, dryLevel: 0 },
    'Time Dry': { temp: 5, dryLevel: 0, timeDry: 3 },
}
const START_COURSES = Object.keys(COURSE_DEFAULTS)
// A smart course starts as its BASE course with the SmartCourse code at packet offset 11 — the same slot the
// download carries it in. Captured 2026-09-19: the app's start of the downloaded Denim was
//   f026 0a 0000 03 0000 00 00 41 00 0a 65 000000 03 00 dd 000000   (Khaki/Jean base, Medium, Normal dry, code 0x65, More/Less -35)
// Names are the LG app's own (its Manage Downloads list, screenshots 2026-09-19), so the HA select reads like the app.
// Base course, temp, dry level and Time Dry selector for each smart course are read off its captured download
// frame (body[0], body[3], body[15], body[6]) rather than typed twice.
function smartCourseDefaults(name: string):
    | {
          course: number
          temp: number
          dryLevel: number
          timeDry: number
          smart: number
          flags: number
          loadItem: number
          moreLess: number
      }
    | undefined {
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
const TIME_DRY_MINUTES: Record<number, number> = { 1: 20, 2: 30, 3: 40, 4: 50, 5: 60 }

const CMD_START = [0xf0, 0x26]
const CMD_PAUSE = [0xf0, 0x24, 0x04, 0x01, 0x00]
const CMD_POWER_OFF = [0xf0, 0x24, 0x01, 0x01, 0x00]
const START_OPTS_BASE = 0x01
const START_OPTS_NEW_CYCLE = 0x40
const START_OPTS_ENERGY_SAVER = 0x02
const FLAG_PANEL_ACTIVE = 0x40 // rec[15] 0x40 (drum light / panel activity): not a cycle setting, stripped from the command

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG DLEX4000W Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): unmapped phase codes emit 'Running'.
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
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
                        platform: 'select',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        command_topic: '$this/dry_level/set',
                        options: ['None', ...DRY_LEVEL.options],
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        // Reads the panel's setting; while PAUSED, picking a value sends the app's resume-apply packet with
                        // the dry level changed (same mechanism as Wrinkle Care). Not editable remotely otherwise.
                    },
                    temp: {
                        platform: 'select',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        command_topic: '$this/temp/set',
                        options: ['None', ...TEMP.options],
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        // Reads the panel's setting; while PAUSED, picking a value sends resume-apply with the temperature changed.
                    },
                    more_less_time: {
                        platform: 'number',
                        unique_id: '$deviceid-more_less_time',
                        state_topic: '$this/more_less_time',
                        command_topic: '$this/more_less_time/set',
                        min: -30,
                        max: 30,
                        step: 5,
                        name: 'More/Less time',
                        icon: 'mdi:plus-minus-variant',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        // Signed minutes against the course default (panel More Time / Less Time). While PAUSED, setting it
                        // sends resume-apply with the trim changed.
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
                        entity_category: 'diagnostic',
                    },
                    time_dry: {
                        platform: 'select',
                        unique_id: '$deviceid-time_dry',
                        state_topic: '$this/time_dry',
                        command_topic: '$this/time_dry/set',
                        options: ['None', ...TIME_DRY.options],
                        name: 'Time Dry duration',
                        icon: 'mdi:timer-sand',
                        // Time Dry only. While PAUSED on Time Dry, picking a duration sends resume-apply with the selector changed.
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
                    previous_status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-previous_status',
                        state_topic: '$this/previous_status',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start / Resume',
                        icon: 'mdi:play',
                        // Starts the cycle set at the panel (course, temp, dry level, Time Dry, options), or resumes
                        // a paused one. Needs Remote Start armed at the machine, as with the LG app; unarmed, the
                        // dryer ignores the command. Same packet either way — see CMD_START.
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    power_off: {
                        platform: 'select',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        state_topic: '$this/power_off',
                        options: ['unknown', 'Power Off'],
                        name: 'Power Off',
                        icon: 'mdi:power',
                        // A select, not a button: a deliberate two-step. Remote power-off drops the Wi-Fi module
                        // (observed: the dryer went silent until the panel's Power button brought it back), so a
                        // fat-finger strands the connection. It snaps back to 'unknown' after firing.
                    },
                    start_course: {
                        platform: 'select',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        state_topic: '$this/start_course',
                        options: ['unknown', ...START_COURSES, ...Object.keys(SPECIALTY_DOWNLOAD)],
                        name: 'Start course (defaults)',
                        icon: 'mdi:play-circle-outline',
                        // Starts the picked dial course at its model-JSON defaults, regardless of the dial. For a course
                        // with options, automations publish JSON to `$this/start_json/set` instead (see setProperty):
                        // {"course":"Time Dry","temp":"Medium","minutes":38,"wrinkle_care":true}. Needs Remote Start armed.
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded course',
                        icon: 'mdi:download-circle-outline',
                    },
                    specialty: {
                        platform: 'select',
                        unique_id: '$deviceid-specialty',
                        command_topic: '$this/specialty/set',
                        state_topic: '$this/specialty',
                        options: ['unknown', ...Object.keys(SPECIALTY_DOWNLOAD)],
                        name: 'Download specialty cycle',
                        icon: 'mdi:cloud-download-outline',
                        // WMDownload: stores the picked SmartCourse into the Downloaded slot and selects it; the panel's
                        // Downloaded position (or Start) then runs it. Snaps back to 'unknown' after firing; the loaded
                        // cycle is read back on `downloaded_course`.
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
                    control_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control Lock',
                        icon: 'mdi:lock',
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
                        name: 'TurboSteam', // one word on the panel
                        icon: 'mdi:kettle-steam',
                    },
                    wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        command_topic: '$this/wrinkle_care/set',
                        name: 'Wrinkle Care',
                        icon: 'mdi:iron-outline',
                        // A control, as in the LG app: while the dryer is PAUSED, switching it sends the app's resume-apply
                        // packet (the start packet with the new-cycle bit clear and the flag changed) and the cycle resumes
                        // with Wrinkle Care as set — captured 2026-09-19 22:24:47. At any other time the dryer accepts no
                        // remote edit, so the switch snaps back to the panel's actual state; use start_json's wrinkle_care
                        // to start a cycle with it on.
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

    private lastRecord: Buffer | null = null

    // The appliance is the interlock and the only one: Remote Start must be armed at the panel and cannot be
    // armed remotely; an unarmed start is simply ignored (the dryer beeps). Nothing here re-checks that.
    setProperty(prop: string, value: string) {
        if (prop === 'pause') {
            this.send(Buffer.from(CMD_PAUSE))
            return
        }
        if (prop === 'power_off') {
            if (value === 'Power Off') {
                this.send(Buffer.from(CMD_POWER_OFF))
                this.publishProperty('power_off', 'unknown') // re-arm the dropdown; never leave it looking armed
            }
            return
        }
        if (prop === 'wrinkle_care') {
            const rec = this.lastRecord
            if (!rec) return
            const on = value === 'ON'
            if (rec[PHASE_OFFSET] !== PHASE_PAUSED) {
                // not editable remotely unless paused: reflect the real state back so HA's switch does not lie
                this.publishProperty('wrinkle_care', (rec[FLAGS_OFFSET] & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
                return
            }
            const flags =
                (rec[FLAGS_OFFSET] & ~FLAG_PANEL_ACTIVE & ~FLAG_WRINKLE_CARE & 0xff) | (on ? FLAG_WRINKLE_CARE : 0)
            this.send(
                this.startPacketFromRecord(
                    rec,
                    flags,
                    START_OPTS_BASE | ((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0 ? START_OPTS_ENERGY_SAVER : 0),
                ),
            )
            return
        }
        if (prop === 'dry_level' || prop === 'temp' || prop === 'time_dry' || prop === 'more_less_time') {
            const rec = this.lastRecord
            if (!rec) return
            if (rec[PHASE_OFFSET] !== PHASE_PAUSED) {
                // not editable remotely unless paused: reflect the real state back so the control does not lie
                this.publishProperty('dry_level', DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
                this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
                this.publishProperty(
                    'time_dry',
                    rec[COURSE_OFFSET] === 0x12 ? TIME_DRY.map(rec[TIME_DRY_OFFSET]) : 'None',
                )
                this.publishProperty('more_less_time', rec.readInt8(MORE_LESS_TIME_OFFSET))
                return
            }
            const edit = Buffer.from(rec)
            if (prop === 'dry_level') {
                const v = DRY_LEVEL.unmap(value)
                if (v === undefined) return
                edit[DRY_LEVEL_OFFSET] = v
            } else if (prop === 'temp') {
                const v = TEMP.unmap(value)
                if (v === undefined) return
                edit[TEMP_OFFSET] = v
            } else if (prop === 'time_dry') {
                const v = TIME_DRY.unmap(value)
                if (v === undefined || rec[COURSE_OFFSET] !== 0x12) return
                edit[TIME_DRY_OFFSET] = v
            } else {
                const m = Math.round(Number(value))
                if (!Number.isFinite(m)) return
                edit.writeInt8(Math.max(-30, Math.min(30, m)), MORE_LESS_TIME_OFFSET)
            }
            this.send(
                this.startPacketFromRecord(
                    edit,
                    edit[FLAGS_OFFSET] & ~FLAG_PANEL_ACTIVE & 0xff,
                    START_OPTS_BASE | ((edit[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0 ? START_OPTS_ENERGY_SAVER : 0),
                ),
            )
            return
        }
        if (prop === 'specialty') {
            const dl = SPECIALTY_DOWNLOAD[value]
            if (dl !== undefined) {
                this.send(Buffer.from(dl, 'hex'))
                this.publishProperty('specialty', 'unknown')
            }
            return
        }
        if (prop === 'start_course' || prop === 'start_json') {
            const req = prop === 'start_course' ? { course: value } : this.parseStartJson(value)
            if (!req) return
            const pkt = this.buildCourseStart(req)
            if (pkt) this.send(pkt)
            if (prop === 'start_course') this.publishProperty('start_course', 'unknown')
            return
        }
        if (prop !== 'start') return
        const rec = this.lastRecord
        if (!rec) return
        // Start and resume are the same packet; only the 0x40 bit at offset 10 separates them.
        const opts =
            START_OPTS_BASE |
            (rec[PHASE_OFFSET] === PHASE_PAUSED ? 0 : START_OPTS_NEW_CYCLE) |
            ((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0 ? START_OPTS_ENERGY_SAVER : 0)
        this.send(this.startPacketFromRecord(rec, rec[FLAGS_OFFSET] & ~FLAG_PANEL_ACTIVE & 0xff, opts))
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
            rec[COURSE_OFFSET] === 0x12 ? rec[TIME_DRY_OFFSET] : 0,
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

    private parseStartJson(value: string): StartRequest | null {
        try {
            const j = JSON.parse(value)
            return typeof j === 'object' && j && typeof j.course === 'string' ? (j as StartRequest) : null
        } catch {
            return null
        }
    }

    // Build a start packet for a course composed remotely, exactly the way the LG app commits one: the course's
    // defaults, then the caller's overrides. Fields: temp (name from TEMP), dry_level (name from DRY_LEVEL),
    // minutes (Time Dry only: 20..60 in steps of 10 picks the duration selector, the remainder becomes the
    // More/Less trim, e.g. 38 -> 40 with -2), more_less_time (minutes, signed), wrinkle_care, energy_saver.
    // Returns null for an unknown course or an unmappable value rather than sending a guess.
    private buildCourseStart(req: StartRequest): Buffer | null {
        const smart = smartCourseDefaults(req.course)
        const def = smart
            ? { temp: smart.temp, dryLevel: smart.dryLevel, timeDry: smart.timeDry || undefined, energySaver: false }
            : COURSE_DEFAULTS[req.course]
        const course = smart ? smart.course : COURSE.unmap(req.course)
        if (!def || course === undefined) return null
        const temp = req.temp !== undefined ? TEMP.unmap(req.temp) : def.temp
        const dryLevel = req.dry_level !== undefined ? DRY_LEVEL.unmap(req.dry_level) : def.dryLevel
        if (temp === undefined || dryLevel === undefined) return null
        let timeDry = def.timeDry ?? 0
        let moreLess = Math.round(req.more_less_time ?? smart?.moreLess ?? 0)
        if (req.minutes !== undefined) {
            if (course !== 0x12) return null // minutes only mean something on Time Dry
            const m = Math.round(req.minutes)
            // nearest selector step, remainder as the trim — the app's own encoding (38 -> selector 40, trim -2)
            const sel = Math.min(5, Math.max(1, Math.round(m / 10) - 1))
            timeDry = sel
            moreLess = m - TIME_DRY_MINUTES[sel]
        }
        const flags =
            (smart?.flags ?? 0) |
            (req.wrinkle_care ? FLAG_WRINKLE_CARE : 0) |
            (req.reduce_static ? FLAG_REDUCE_STATIC : 0)
        const loadItem = req.reduce_static ? 5 : (smart?.loadItem ?? 0) // Reduce Static engages load-item code 5 on the panel and in the app's start
        const energySaver = req.energy_saver ?? def.energySaver ?? false
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
        if (buf[0] !== 0x30 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0x31 (serial), 0xE2 (idle snapshot) and 0xD8/0x72 (heartbeats) are not decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== 0x1b) return // the current-state record should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(phase) ?? 'Running')
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('dry_level', DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('load_item', LOAD_ITEMS[rec[LOAD_ITEM_OFFSET]] ?? 0)
        this.publishProperty('signal', SIGNAL.map(rec[SIGNAL_OFFSET]))
        // signed: negative trims the course default, positive extends it
        this.publishProperty('more_less_time', isOff ? 0 : rec.readInt8(MORE_LESS_TIME_OFFSET))

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('control_lock', (flags & FLAG_CONTROL_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('reduce_static', (flags & FLAG_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (flags & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_steam', (opt2 & OPT2_TURBO_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('energy_saver_auto', (opt2 & OPT2_ENERGY_SAVER_AUTO) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('ai', (rec[OPT3_OFFSET] & OPT3_AI) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('time_dry', rec[COURSE_OFFSET] === 0x12 ? TIME_DRY.map(rec[TIME_DRY_OFFSET]) : 'None')
        this.publishProperty('previous_status', STATUS.map(rec[PREV_PHASE_OFFSET]))
        this.publishProperty('downloaded_course', SMARTCOURSE.map(rec[DOWNLOAD_COURSE_OFFSET]))
        this.lastRecord = Buffer.from(rec)
        // not yet located (declared entities intentionally omitted rather than published wrong): error
        // codes and a door sensor. Opening the door mid-cycle produces the same generic Pause phase a
        // button press would, with no distinguishing byte found.
    }
}
