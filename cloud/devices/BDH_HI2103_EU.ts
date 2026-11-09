import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { STATES_UP, ERRORS_UP } from './dryer_common'

// LG heat-pump dryer, matched on modelId "BDH_HI2103_EU" (thinq2 deviceType 202), sold as RH18U8AVCW.
//
// The wire format is the one BDH_D30007_US.ts documents: long 0xFF-escaped AABB framing, class byte
// 0x30, an envelope carrying 0xEC (two stacked 42-byte records, previous then current) or 0xEB (one
// record). Most fields sit at the same record offsets too. It is a separate handler rather than an
// alias because the tables and the set of fields differ: the course catalogue is the EU one (Wool, no
// Delicates or Silent Dry), the dry level and drying mode are labelled differently on the panel, the
// downloaded-cycle byte is never 0, and this model reports a door lock where the US one does not.
//
// Every offset and table entry below was confirmed live, against real wire traffic captured with
// rethink bridged to the LG cloud, each byte change matched against the cloud's decoded washerDryer
// state in the same second while the dryer was driven at the panel and from the ThinQ app.

const CLASS_BYTE = 0x30
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 42

// LG's "report your state" request, 0xF0ED; actuating commands are 0xF0E5, so this only ever reads.
const STATUS_REQUEST = 'F0ED112101000000180411120000'

// Commands, as the ThinQ app sends them through the cloud: F0E5 000201FF, a pair count, then that many
// (setting id, value) pairs. Each id below was mapped by changing that one setting in the app and
// seeing it alone change, both in the dryer's next status record and in the cloud's state. The dryer
// acks with 3000E500, then echoes the pairs with a status byte each: 00 for a setting it changed, 10 or
// 11 for one already at that value, and 17 for all of them when it refuses the command as a whole. The app's commands always carry every setting; ids 0x70 and 0x7f take
// 2-byte values, which is what makes its 8-, 9- and 11-pair commands parse without a byte left over.
// 0x0b is the downloaded cycle's id (as in rec[23]) and 0x0c the course it is built on.
//
// Commands are built the way the app builds them, so that each has a form the dryer has accepted:
//   start, nothing changed:   0a <course>, 03 01
//   start, settings changed:  0a, 1f, 1e, 34, 3f, 0f, 70, 7f, 03 01 - unchanged ones at the course's
//                             modelJSON default, as the app sends them
//   resume, nothing changed:  03 03
//   resume, settings changed: 1f, 1e, 34, 3f, 0f, 70, 7f, 03 03 - unchanged ones as the dryer reports
//   download a cycle:         0b <id>, 0a ff, 0c <base>, 1f, 1e, 34, 3f, 0f, 70, 7f - stores and selects
//                             it without starting; captured for all eight
//   start a downloaded cycle: 0a ff, 0b <id>, 0c <base>, 1f, 1e, 34, 3f, 0f, 70, 7f, 03 01 - starts the
//                             cycle already stored: with any other id the dryer refuses it (17 for
//                             every pair). Captured from the app for Silent, and sent by rethink for
//                             the other seven, each right after downloading it, the dryer running it.
// The settings forms reproduce, byte for byte, the six the app sent while each id was being mapped.
const COMMAND_PREFIX = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff]
const SETTING_POWER = 0x02 // 1 on, 0 off
const SETTING_RUN = 0x03 // 1 start, 2 pause, 3 resume
const SETTING_COURSE = 0x0a // a course code, as reported in rec[5]
const SETTING_DOWNLOAD = 0x0b // a downloaded cycle's id, as reported in rec[23]
const SETTING_DOWNLOAD_BASE = 0x0c // the course a downloaded cycle is built on
const COURSE_DOWNLOAD = 0xff // the Download position, in rec[5] and as 0x0a
const SETTING_WRINKLE_CARE = 0x0f // 0/1, cloud wrinkleCare
const SETTING_DRY_LEVEL = 0x1e // the rec[1] codes, cloud dryLevel
const SETTING_DRYING_MODE = 0x1f // the rec[2] codes, cloud ecoHybrid
const SETTING_DAMP_DRY_SIGNAL = 0x34 // 0/1, cloud dampDryBeep
const SETTING_STEAM = 0x3f // always 0; the modelJSON lists a steam option for every course, hidden
const SETTING_TIMER = 0x70 // minutes, 2 bytes: Timed Dry's length, 100 giving a 100-minute run
const SETTING_DELAY = 0x7f // minutes, 2 bytes: 180 put the dryer in RESERVED, cloud reserveTimeMinute 180
const TWO_BYTE_SETTINGS = new Set([SETTING_TIMER, SETTING_DELAY])
const POWER_ON = 1
const POWER_OFF = 0
const RUN_START = 1
const RUN_PAUSE = 2
const RUN_RESUME = 3

// The modelJSON's ranges: timeSetting 30-180 minutes, reserveTimeHour 3-19 hours.
const TIMER_MIN = 30
const TIMER_MAX = 180
const DELAY_MIN_HOURS = 3
const DELAY_MAX_HOURS = 19

function command(...pairs: [number, number][]): Buffer {
    const body = pairs.flatMap(([id, value]) =>
        TWO_BYTE_SETTINGS.has(id) ? [id, value >> 8, value & 0xff] : [id, value],
    )
    return Buffer.from([...COMMAND_PREFIX, pairs.length, ...body])
}

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

// Offsets are relative to the start of the 42-byte record.
const DRY_LEVEL_OFFSET = 1
const DRYING_MODE_OFFSET = 2
const COURSE_OFFSET = 5
// Big-endian minute counts, matching the cloud's remainTimeMinute and initialTimeMinute. The initial
// time is set by the drying timer (Timed Dry, Cool Air) and by a cycle starting, where a sensing cycle
// revises it once Detecting ends (Eco: 100 to 65). Selecting a cycle at the panel leaves it as it was,
// 0 after power-on, and the cloud's initialTimeMinute stays the same with it.
// rec[7:9], big-endian minutes: the delay set before a delayed start, the cloud's reserveTimeMinute.
const DELAY_OFFSET = 7
const REMAIN_TIME_OFFSET = 9
const INITIAL_TIME_OFFSET = 11
const STATE_OFFSET = 13
// rec[15]: the error code, the modelJSON's error index. Confirmed by starting with the door open: the
// byte went 0 to 16 as the state went to ERROR, the cloud reporting error ERROR_DOOR in the same frame,
// and back to 0 (ERROR_NO) once the error was cleared at the panel.
const ERROR_OFFSET = 15
// Big-endian Wh used by the running cycle, the cloud's courseSpendPower, on every minute of a run. It
// survives power-off, as on the US model.
const SPENT_POWER_OFFSET = 17
const BUZZER_OFFSET = 19
// rec[24]: options bitfield. Each bit toggled at the panel with the cloud naming it in the same frame.
const OPT1_OFFSET = 24
const OPT1_WRINKLE_CARE = 0x08 // wrinkleCare, the panel's Anti-crease
const OPT1_DRUM_LIGHT = 0x20 // drumLight; the appliance also lights the drum on pause and power-off
const OPT1_DAMP_DRY_SIGNAL = 0x40 // dampDryBeep; switching it on also turns the buzzer back on
// rec[26]: a second options bitfield.
const OPT2_OFFSET = 26
// Door lock, the cloud's doorLock: set while a cycle runs (audibly, a click a few seconds after start
// and resume), cleared a few seconds after a pause or power-off. Absent from the US model.
const OPT2_DOOR_LOCK = 0x01
// detectLoad: follows the selected cycle, on for the sensing ones (Eco, Small Load, ...) and off for
// the timed and refresh ones, rather than being a setting of its own.
const OPT2_DETECT_LOAD = 0x04
// Child lock, the cloud's childLock: toggled at the panel four times, the bit alone moving each time with
// the cloud reporting CHILDLOCK_ON or CHILDLOCK_OFF in the same frame. It survives power-off.
const OPT2_CHILD_LOCK = 0x10
// remoteStart: switchable at the panel, and switched on by the appliance itself whenever a cycle
// starts or resumes, as on the US model.
const OPT2_REMOTE_START = 0x40

const STATE_POWEROFF = 0

// State codes are this model's modelJSON state indices, which are the newer dryers' shared STATES_UP.
// Seen live against the cloud's state: 0 POWEROFF, 1 INITIAL, 3 PAUSE, 5 ERROR, 7 DRYING, 8 COOLING,
// 10 RESERVED, 14 DETECTING, 18 BEDDINGBRUSHING, 19 DRY_REFRESHING, 20 ALLERGYCARE and 21
// CONDENSERCARE.
const STATE = STATES_UP

// Error codes, rec[15]: the newer dryers' shared ERRORS_UP. This model's modelJSON numbers its errors
// the same way, except dE2, which it lists at 42 where ERRORS_UP has 43; nothing has been seen to settle
// which is right, so 42 reports None. Door open (16) and Filter missing (18) are confirmed live, each
// triggered on purpose with the cloud naming it.
const ERRORS = ERRORS_UP

// Course codes, rec[5]. The modelJSON names the courses but carries no index for them, so every code
// came from selecting the cycle and reading the byte against the cloud's course. All seventeen of the
// modelJSON's courses are here: the fourteen dial positions plus the Drum Clean button and the drying
// timer, which steps through Timed Dry and, at its shortest, Cool Air. Names are the panel's; the
// cloud identifier follows each as a comment, since several disagree (Eco is NORMAL, Baby Care is
// BABYWEAR, Small Load is QUICKDRY).
const COURSE = Enum.of({
    Eco: 7, // NORMAL
    'AI Dry': 44, // AI_COURSE
    Towels: 2, // TOWELS
    'Easy Care': 5, // EASYCARE
    'Anti-Allergy': 16, // ALLERGYCARE
    'Baby Care': 23, // BABYWEAR
    'Small Load': 9, // QUICKDRY
    'Outdoor Refresh': 22, // WATERREPELLENT
    'Refresh Jacket': 20, // PADDINGREFRESH
    Sportswear: 8, // SPORTWEAR
    Wool: 11, // WOOL
    'Refresh Bedding': 15, // BEDDINGBRUSH
    'Down Blanket': 4, // BEDDING
    'Drum Clean': 19, // TUBCLEAN
    'Timed Dry': 21, // TIMEDRY
    'Cool Air': 13, // COOLAIR
    'Condenser Care': 18, // CONDENSERCARE
    // The dial's Download position: the appliance runs the cycle last pushed from the app, and which
    // one is in rec[23].
    'Downloaded cycle': 255, // DOWNLOAD
})

// The settings the app sends with a start or resume, in its order.
const SETTINGS_ORDER = [
    SETTING_DRYING_MODE,
    SETTING_DRY_LEVEL,
    SETTING_DAMP_DRY_SIGNAL,
    SETTING_STEAM,
    SETTING_WRINKLE_CARE,
    SETTING_TIMER,
    SETTING_DELAY,
]
const OFF_SETTINGS: Record<number, number> = Object.fromEntries(SETTINGS_ORDER.map((id) => [id, 0]))
type Defaults = { mode: number; dryLevel: number; timer: number; wrinkleCare?: number }
const toSettings = (d: Defaults) => ({
    ...OFF_SETTINGS,
    [SETTING_DRYING_MODE]: d.mode,
    [SETTING_DRY_LEVEL]: d.dryLevel,
    [SETTING_TIMER]: d.timer,
    [SETTING_WRINKLE_CARE]: d.wrinkleCare ?? 0,
})

const onOff = (mqttValue: string) => (mqttValue === 'ON' ? 1 : mqttValue === 'OFF' ? 0 : undefined)

// Each course's defaults from its modelJSON function list: drying mode, dry level and timer minutes.
// Damp dry signal, anti-crease, steam and delay default to off for every course.
const COURSE_DEFAULTS: Record<number, Defaults> = {
    7: { mode: 2, dryLevel: 3, timer: 0 }, // NORMAL
    44: { mode: 2, dryLevel: 0, timer: 0 }, // AI_COURSE
    2: { mode: 2, dryLevel: 0, timer: 0 }, // TOWELS
    5: { mode: 2, dryLevel: 3, timer: 0 }, // EASYCARE
    16: { mode: 3, dryLevel: 0, timer: 0 }, // ALLERGYCARE
    23: { mode: 2, dryLevel: 0, timer: 0 }, // BABYWEAR
    9: { mode: 3, dryLevel: 0, timer: 0 }, // QUICKDRY
    22: { mode: 3, dryLevel: 0, timer: 0 }, // WATERREPELLENT
    20: { mode: 3, dryLevel: 0, timer: 0 }, // PADDINGREFRESH
    8: { mode: 1, dryLevel: 0, timer: 0 }, // SPORTWEAR
    11: { mode: 2, dryLevel: 0, timer: 0 }, // WOOL
    15: { mode: 2, dryLevel: 0, timer: 0 }, // BEDDINGBRUSH
    4: { mode: 2, dryLevel: 0, timer: 0 }, // BEDDING
    19: { mode: 3, dryLevel: 0, timer: 0 }, // TUBCLEAN
    21: { mode: 2, dryLevel: 0, timer: 50 }, // TIMEDRY
    13: { mode: 0, dryLevel: 0, timer: 30 }, // COOLAIR
    18: { mode: 3, dryLevel: 0, timer: 0 }, // CONDENSERCARE
}

// rec[23]: the cycle stored in the download slot, the cloud's downloadCourse. Unlike the US model it
// never reads 0: the slot always holds something, and the byte reports it even with the dryer off.
// This is all eight of the modelJSON's SmartCourse entries, each pushed from the app with the cloud
// naming it in the same frame. Names are the app's; Minimize Wrinkles and Rack Dry share their codes
// with the US model.
const DOWNLOAD_COURSE_OFFSET = 23
const DOWNLOAD_COURSE = Enum.of({
    'Gym Clothes': 102, // GYMCLOTHES
    'Rainy Days': 105, // RAINYDAY
    'Easy Ironing': 110, // EASYIRON
    'Minimize Wrinkles': 114, // MINIMIZEWRINKLES
    Silent: 126, // OVERNIGHTDRY
    'Rack Dry': 140, // RACKDRY
    'Shrinkage Relief': 142, // CLOTHINGCARE
    'Super Dry': 148, // POWER, the factory default
})

// What the app sends with each downloaded cycle: the course it is built on (the modelJSON SmartCourse's
// Course, as the 0x0c byte) and that SmartCourse's defaults. Every base was captured as 0x0c when the
// app downloaded the cycle, and the defaults are the values it sent alongside.
const DOWNLOAD_DEFAULTS: Record<number, Defaults & { base: number }> = {
    102: { base: 49, mode: 1, dryLevel: 0, timer: 0 }, // GYMCLOTHES
    105: { base: 50, mode: 3, dryLevel: 0, timer: 0 }, // RAINYDAY
    110: { base: 51, mode: 3, dryLevel: 0, timer: 0 }, // EASYIRON
    114: { base: 7, mode: 2, dryLevel: 3, timer: 0, wrinkleCare: 1 }, // MINIMIZEWRINKLES, on NORMAL
    126: { base: 45, mode: 2, dryLevel: 0, timer: 0 }, // OVERNIGHTDRY, on SILENT
    140: { base: 12, mode: 1, dryLevel: 0, timer: 30 }, // RACKDRY
    142: { base: 46, mode: 2, dryLevel: 2, timer: 0 }, // CLOTHINGCARE, on CLOTHCARE
    148: { base: 17, mode: 2, dryLevel: 0, timer: 0 }, // POWER
}

// Dry level, rec[1]. The panel's five Dryness level settings in panel order, which is the code order:
// Extra Dry lit while the byte read 5, Light Dry selected as it read 2, and Eco's default of Cupboard
// reading 3. The cloud's names for the same
// codes are shifted against the panel's (DAMPDRY, LESSDRY, IRON, CUPBOARD, VERYDRY), so they are not
// used, and neither are the shared DRY_LEVELS labels, which do not match this panel either. 0
// (NO_DRYLEVEL) is what the cycles that do not sense dryness report, 'Not selected' as in DRY_LEVELS.
const DRY_LEVEL = Enum.of({
    'Not selected': 0,
    Iron: 1,
    Light: 2,
    Cupboard: 3,
    'Very Dry': 4,
    'Extra Dry': 5,
})

// The panel's Drying mode, rec[2], which the cloud calls ecoHybrid: ECOHYBRID_ECO/NORMAL/TURBO, each
// confirmed with the panel LED. The panel's Balanced is the shared ECO_HYBRID's Normal, hence a table of
// its own. 0 is NO_ECOHYBRID, reported by cycles that do not offer it, 'Not selected' as in ECO_HYBRID.
const DRYING_MODE = Enum.of({
    'Not selected': 0,
    Eco: 1,
    Balanced: 2,
    Turbo: 3,
})

// Buzzer volume, rec[19]. The panel only toggles between Off and 4, both cloud-confirmed; 1-3 are the
// modelJSON's own indices for the same field.
const BUZZER = Enum.of({
    Off: 0,
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-circle-outline',
                    },
                    set_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_course',
                        state_topic: '$this/set_course',
                        command_topic: '$this/set_course/set',
                        name: 'Set course',
                        icon: 'mdi:tune-vertical',
                        options: COURSE.options,
                    },
                    set_dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-set_dry_level',
                        state_topic: '$this/set_dry_level',
                        command_topic: '$this/set_dry_level/set',
                        name: 'Set dryness level',
                        icon: 'mdi:water-percent',
                        options: DRY_LEVEL.options,
                    },
                    set_eco_hybrid: {
                        platform: 'select',
                        unique_id: '$deviceid-set_eco_hybrid',
                        state_topic: '$this/set_eco_hybrid',
                        command_topic: '$this/set_eco_hybrid/set',
                        name: 'Set drying mode',
                        icon: 'mdi:leaf',
                        options: DRYING_MODE.options,
                    },
                    set_wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_wrinkle_care',
                        state_topic: '$this/set_wrinkle_care',
                        command_topic: '$this/set_wrinkle_care/set',
                        name: 'Set Anti-crease',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    set_damp_dry_signal: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_damp_dry_signal',
                        state_topic: '$this/set_damp_dry_signal',
                        command_topic: '$this/set_damp_dry_signal/set',
                        name: 'Set Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    set_timer: {
                        platform: 'number',
                        unique_id: '$deviceid-set_timer',
                        state_topic: '$this/set_timer',
                        command_topic: '$this/set_timer/set',
                        name: 'Set Timed Dry length',
                        icon: 'mdi:timer-cog-outline',
                        min: TIMER_MIN,
                        max: TIMER_MAX,
                        step: 10,
                        unit_of_measurement: 'min',
                    },
                    set_delay_end: {
                        platform: 'number',
                        unique_id: '$deviceid-set_delay_end',
                        state_topic: '$this/set_delay_end',
                        command_topic: '$this/set_delay_end/set',
                        name: 'Set delayed end',
                        icon: 'mdi:timer-sand',
                        min: 0,
                        max: DELAY_MAX_HOURS,
                        step: 1,
                        unit_of_measurement: 'h',
                    },
                    delay: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay',
                        state_topic: '$this/delay',
                        name: 'Delay end',
                        icon: 'mdi:clock-start',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    set_download_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_download_course',
                        state_topic: '$this/set_download_course',
                        command_topic: '$this/set_download_course/set',
                        name: 'Set downloaded cycle',
                        icon: 'mdi:cloud-download-outline',
                        options: DOWNLOAD_COURSE.options,
                    },
                    download_course_button: {
                        platform: 'button',
                        unique_id: '$deviceid-download_course_button',
                        command_topic: '$this/download_course/set',
                        payload_press: '',
                        name: 'Download cycle',
                        icon: 'mdi:download',
                    },
                    start_course: {
                        platform: 'button',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        payload_press: 'PRESS',
                        name: 'Start course',
                        icon: 'mdi:play-box-outline',
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
                    download_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-download_course',
                        state_topic: '$this/download_course',
                        name: 'Downloaded cycle',
                        icon: 'mdi:cloud-download-outline',
                        device_class: 'enum',
                        options: DOWNLOAD_COURSE.options,
                        entity_category: 'diagnostic',
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
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dryness level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVEL.options,
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Drying mode',
                        icon: 'mdi:leaf',
                        device_class: 'enum',
                        options: DRYING_MODE.options,
                    },
                    buzzer: {
                        platform: 'sensor',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        device_class: 'enum',
                        options: BUZZER.options,
                        entity_category: 'diagnostic',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Anti-crease',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    detect_load: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-detect_load',
                        state_topic: '$this/detect_load',
                        name: 'Detect load',
                        icon: 'mdi:scale',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        icon: 'mdi:lightbulb',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock', // HA's lock class is inverted: ON means unlocked
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock', // HA's lock class is inverted: ON means unlocked
                    },
                },
            }),
        )
    }

    // This dryer only volunteers a status frame when something changes, so without asking, every
    // restart would leave Home Assistant at unknown until someone touched the panel. Asking once per
    // connect is what LG's cloud does: captured as the dryer rejoined after a mains power cycle, it
    // sent exactly this query, byte for byte the US model's, and the dryer replied with a single 0xEB
    // record matching the cloud's full state dump.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    // Settings picked in Home Assistant but not sent yet, by setting id. Like the app, nothing goes to
    // the dryer when a setting is picked: the picks travel with the next Start course or Resume, so a
    // course and its options arrive together. Until something is picked, each control follows what the
    // dryer reports.
    private pending = new Map<number, number>()
    private reported = new Map<number, number>()
    private reportedInitialTime: number | undefined

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power':
                if (mqttValue === 'ON') this.send(command([SETTING_POWER, POWER_ON]))
                else if (mqttValue === 'OFF') this.send(command([SETTING_POWER, POWER_OFF]))
                return
            case 'pause':
                this.send(command([SETTING_RUN, RUN_PAUSE]))
                return
            case 'resume': {
                // A paused cycle cannot change course, so a picked course waits for Start course.
                const settings = this.hasPendingSettings() ? this.fullSettings(this.reportedSettings()) : []
                this.send(command(...settings, [SETTING_RUN, RUN_RESUME]))
                this.clearPending(true)
                return
            }
            case 'start_course': {
                // Like the app, this needs Remote Start enabled at the panel; the dryer enforces that itself.
                const code = this.pending.get(SETTING_COURSE) ?? this.reported.get(SETTING_COURSE)
                if (code === COURSE_DOWNLOAD) {
                    // This starts the stored cycle; a different one has to be downloaded first, which
                    // is what the Download cycle button is for. The app always sends the full form.
                    const id = this.reported.get(SETTING_DOWNLOAD)
                    const picked = this.pending.get(SETTING_DOWNLOAD)
                    if (picked !== undefined && picked !== id) return
                    const d = id === undefined ? undefined : DOWNLOAD_DEFAULTS[id]
                    if (id === undefined || d === undefined) return
                    this.send(
                        command(
                            [SETTING_COURSE, COURSE_DOWNLOAD],
                            [SETTING_DOWNLOAD, id],
                            [SETTING_DOWNLOAD_BASE, d.base],
                            ...this.fullSettings(toSettings(d)),
                            [SETTING_RUN, RUN_START],
                        ),
                    )
                    this.clearPending(false)
                    return
                }
                const defaults = code === undefined ? undefined : COURSE_DEFAULTS[code]
                if (code === undefined || defaults === undefined) return
                const settings = this.hasPendingSettings() ? this.fullSettings(toSettings(defaults)) : []
                this.send(command([SETTING_COURSE, code], ...settings, [SETTING_RUN, RUN_START]))
                this.clearPending(false)
                return
            }
            case 'download_course': {
                // Stores the cycle and turns the dryer to it, without starting; Start course then runs it.
                const id = this.downloadId()
                const d = id === undefined ? undefined : DOWNLOAD_DEFAULTS[id]
                if (id === undefined || d === undefined) return
                this.send(
                    command(
                        [SETTING_DOWNLOAD, id],
                        [SETTING_COURSE, COURSE_DOWNLOAD],
                        [SETTING_DOWNLOAD_BASE, d.base],
                        ...this.fullSettings(toSettings(d)),
                    ),
                )
                // The dryer does not always report the change on its own (it did not when a cycle was
                // paused), so ask, which keeps the stored-cycle sensor and selector current.
                this.send(Buffer.from(STATUS_REQUEST, 'hex'))
                this.clearPending(false)
                return
            }
            case 'set_course':
                this.pick(SETTING_COURSE, COURSE.unmap(mqttValue))
                return
            case 'set_download_course':
                this.pick(SETTING_DOWNLOAD, DOWNLOAD_COURSE.unmap(mqttValue))
                return
            case 'set_dry_level':
                this.pick(SETTING_DRY_LEVEL, DRY_LEVEL.unmap(mqttValue))
                return
            case 'set_eco_hybrid':
                this.pick(SETTING_DRYING_MODE, DRYING_MODE.unmap(mqttValue))
                return
            case 'set_wrinkle_care':
                this.pick(SETTING_WRINKLE_CARE, onOff(mqttValue))
                return
            case 'set_damp_dry_signal':
                this.pick(SETTING_DAMP_DRY_SIGNAL, onOff(mqttValue))
                return
            case 'set_timer': {
                const minutes = Number(mqttValue)
                const valid = Number.isInteger(minutes) && minutes >= TIMER_MIN && minutes <= TIMER_MAX
                this.pick(SETTING_TIMER, valid ? minutes : undefined)
                return
            }
            case 'set_delay_end': {
                // 0 is how the app expresses "no delay"; anything else must be within the modelJSON range.
                const hours = Number(mqttValue)
                const valid =
                    Number.isInteger(hours) && (hours === 0 || (hours >= DELAY_MIN_HOURS && hours <= DELAY_MAX_HOURS))
                this.pick(SETTING_DELAY, valid ? hours * 60 : undefined)
                return
            }
        }
    }

    private pick(id: number, value: number | undefined) {
        if (value !== undefined) this.pending.set(id, value)
        this.publishSettings()
    }

    private hasPendingSettings() {
        return SETTINGS_ORDER.some((id) => this.pending.has(id))
    }

    private downloadId() {
        return this.pending.get(SETTING_DOWNLOAD) ?? this.reported.get(SETTING_DOWNLOAD)
    }

    // Every setting in the app's order, each as picked or else as `base` has it.
    private fullSettings(base: Record<number, number>): [number, number][] {
        return SETTINGS_ORDER.map((id) => [id, this.pending.get(id) ?? base[id] ?? 0])
    }

    private reportedSettings(): Record<number, number> {
        const settings: Record<number, number> = { ...OFF_SETTINGS }
        for (const id of SETTINGS_ORDER) {
            const v = this.reported.get(id)
            if (v !== undefined) settings[id] = v
        }
        // The timer has no field of its own in the status record. On the timed courses the initial time
        // carries it; elsewhere the course's own default (0) is what the app sends.
        const course = this.reported.get(SETTING_COURSE)
        const defaults = course === undefined ? undefined : COURSE_DEFAULTS[course]
        settings[SETTING_TIMER] = defaults?.timer ? (this.reportedInitialTime ?? defaults.timer) : 0
        return settings
    }

    // The dryer is the authority on what runs once a command has gone out; let the controls follow it
    // again. A Resume leaves a picked course in place, since it was not sent.
    private clearPending(keepCourse: boolean) {
        const course = this.pending.get(SETTING_COURSE)
        this.pending.clear()
        if (keepCourse && course !== undefined) this.pending.set(SETTING_COURSE, course)
        this.publishSettings()
    }

    private publishSettings() {
        const value = (id: number) => this.pending.get(id) ?? this.reported.get(id)
        const mapped = (id: number, e: Enum<string>) => {
            const v = value(id)
            return v === undefined ? undefined : e.map(v)
        }
        const flag = (id: number) => {
            const v = value(id)
            return v === undefined ? undefined : v ? 'ON' : 'OFF'
        }
        this.publishProperty('set_course', mapped(SETTING_COURSE, COURSE))
        this.publishProperty('set_download_course', mapped(SETTING_DOWNLOAD, DOWNLOAD_COURSE))
        this.publishProperty('set_dry_level', mapped(SETTING_DRY_LEVEL, DRY_LEVEL))
        this.publishProperty('set_eco_hybrid', mapped(SETTING_DRYING_MODE, DRYING_MODE))
        this.publishProperty('set_wrinkle_care', flag(SETTING_WRINKLE_CARE))
        this.publishProperty('set_damp_dry_signal', flag(SETTING_DAMP_DRY_SIGNAL))
        // The timer has no reported counterpart to follow; it shows only a pick.
        this.publishProperty('set_timer', this.pending.get(SETTING_TIMER))
        const delay = value(SETTING_DELAY)
        this.publishProperty('set_delay_end', delay === undefined ? undefined : Math.round(delay / 60))
    }

    processAABB(buf: Buffer) {
        if (buf.length < 13 || buf[0] !== CLASS_BYTE || buf[1] !== ENVELOPE_TYPE) return

        const innerLen = buf.readUInt16BE(INNER_LEN_OFFSET)
        switch (buf[INNER_TYPE_OFFSET]) {
            case STATUS_FRAME_TYPE:
                if (innerLen !== STATUS_INNER_LEN) return
                return this.processStatus(buf, STATUS_RECORD_OFFSET, STATUS_BUF_LEN)
            case SINGLE_STATUS_FRAME_TYPE:
                if (innerLen !== SINGLE_INNER_LEN) return
                return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_BUF_LEN)
            // The other envelope types (0x01, 0x3e energy totals, ...) are not status records.
        }
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        const error = rec[ERROR_OFFSET]
        this.publishProperty('error_message', ERRORS.map(error)) // message first, as RC90U2_WW does
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('download_course', DOWNLOAD_COURSE.map(rec[DOWNLOAD_COURSE_OFFSET]))
        this.publishProperty('dry_level', DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('eco_hybrid', DRYING_MODE.map(rec[DRYING_MODE_OFFSET]))
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16BE(SPENT_POWER_OFFSET))

        const opt1 = rec[OPT1_OFFSET]
        this.publishProperty('wrinkle_care', (opt1 & OPT1_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (opt1 & OPT1_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (opt1 & OPT1_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('detect_load', (opt2 & OPT2_DETECT_LOAD) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (opt2 & OPT2_DOOR_LOCK) !== 0 ? 'OFF' : 'ON') // lock class: OFF = locked
        this.publishProperty('child_lock', (opt2 & OPT2_CHILD_LOCK) !== 0 ? 'OFF' : 'ON') // inverted, as door_lock
        this.publishProperty('delay', rec.readUInt16BE(DELAY_OFFSET))

        // What the setting controls follow until something is picked in Home Assistant.
        this.reported.set(SETTING_COURSE, rec[COURSE_OFFSET])
        this.reported.set(SETTING_DOWNLOAD, rec[DOWNLOAD_COURSE_OFFSET])
        this.reported.set(SETTING_DRY_LEVEL, rec[DRY_LEVEL_OFFSET])
        this.reported.set(SETTING_DRYING_MODE, rec[DRYING_MODE_OFFSET])
        this.reported.set(SETTING_WRINKLE_CARE, (opt1 & OPT1_WRINKLE_CARE) !== 0 ? 1 : 0)
        this.reported.set(SETTING_DAMP_DRY_SIGNAL, (opt1 & OPT1_DAMP_DRY_SIGNAL) !== 0 ? 1 : 0)
        this.reported.set(SETTING_DELAY, rec.readUInt16BE(DELAY_OFFSET))
        this.reportedInitialTime = rec.readUInt16BE(INITIAL_TIME_OFFSET)
        this.publishSettings()

        // Not published: rec[14], the cloud's preState (the state before the current one); rec[16], the
        // cycle-phase index the US model also leaves out; rec[20], the cycle actually loaded, which
        // differs from rec[5] only on AI Dry and the Download position; and rec[27], fixed at 0x80 here,
        // where the US model carries Cycle Optimization and Remote Maintain, neither of which this model's
        // modelJSON enables.
    }
}
