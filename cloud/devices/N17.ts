import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'

// LG LDNPQ445S dishwasher, reporting modelName "N17" (deviceType 204, BEKEN_BK7234). "N17" is much
// shorter than the usual LG model codes, so it is probably a board/platform identifier rather than an
// appliance model — expect other appliances to match this same string.
//
// Every decoded field and every command below was confirmed on a live appliance (firmware
// clip_bkn_v1.9.226), using bridge mode to capture LG's own cloud traffic, with the LG app and the
// front panel as ground truth.
//
// Commands, as LG's cloud sends them:
//
//   F0 26 10 <course> <delayHours> 00 <opt3> <opt4> 00   start
//                                        ^ 0x04 extra dry, 0x08 high temp, 0x80 steam
//   F0 26 13                                             pause
//   F0 26 14                                             resume
//   F0 26 11                                             cancel (runs the ~67 s process-0x63 drain)
//   F0 26 12                                             power off (straight to Standby, no drain)
//   F0 26 <rinse> 00 <opts> 40 00 <light> 00 00          settings snapshot (see the SETTING_*
//                                                        constants). Byte 2 doubles as the "opcode":
//                                                        rinse levels 0-4 never collide with the
//                                                        action opcodes 0x10-0x16.
//
// 0x11 and 0x12 are different actions, not two forms of cancel: the app's Cancel Cycle control sends
// 0x11 in every machine state — even for a delayed cycle that never took on water, where the drain
// still runs — while its separate power button sends 0x12. So Cancel always sends 0x11, and Power Off
// is its own button.
//
// The start command's course and option bytes override whatever the panel had selected. LG sends
// opt4 = 0x00 for every start, the download cycle included.
//
// Not offered, because LG's cloud was never seen sending them to this appliance: wake-up (F0 26 16),
// and any course code outside START_COURSES. The model has no extra rinse option at all: the panel
// has no such button and the app's option list is exactly Steam / High Temp / Extra Dry.
//
// Two properties of the write path:
//   - The appliance ignores a start unless its remote-start bit (flags2 0x02) is set. It clears that
//     bit itself when a cycle ends, so remote start has to be re-armed at the panel for each wash.
//   - Commands are unconfirmable. The 0x32 0x00 acknowledgement echoes only the opcode it is acking —
//     no success/failure signal — and LG's own cloud re-sends an ignored start 5 s later. The status
//     frames are the only evidence a command took effect.
//
// Frame envelope, after AABBDevice strips "AA <len>" and "<checksum> BB":
//   buf[0] = 0x32   constant across every frame (the dishwasher class byte; the dryers use 0x30)
//   buf[1] = type
//
// Frame types. The appliance does not transmit continuously: it goes quiet for minutes at a time and
// then emits a burst lasting about a minute, during which 0x0A arrives every 1-5s and 0x3E every 4-6s.
//   0xEB  status, single record — the reply to the 0xF0ED status query, which LG's cloud sends and
//         start() reproduces on connect. Decoded below.
//   0xEC  status, two stacked records (previous, then current) — volunteered on change, unsolicited:
//         one frame per panel action, and once a minute during a wash as remain-time ticks. An idle
//         appliance has no changes to report and sends none. Decoded below.
//   0x3E  energy statistics. Decoded below.
//   0x0A  Two record variants alternating within a burst, 87 and 88 bytes. Body carries a few numeric
//         fields, an incrementing counter, then a length-prefixed ASCII list of component ids
//         ("204-1", "DW-3-3", ...) — a parts manifest, not fault codes. Not decoded. Two oddities:
//         its length byte is 0xFF regardless of the real frame size, and it is the only frame type
//         here that FAILS this repo's AABB checksum (0x31, 0x72 and 0x3E all pass). Neither matters
//         to us, since AABBDevice keys off the 0xAA/0xBB delimiters rather than length or checksum.
//   0x31  79-byte component manifest, ASCII serials. Sent on connect and again after a wash cancel or
//         completion. Not decoded, and it does not need to be: the same bytes arrive as "pcbInfo" in
//         the device_log message.
//   0x88  30-byte packed form of the same part numbers, on connect. Not decoded.
//   0x72  9-byte marker, one frame 1-2s ahead of each wash start/cancel. Not decoded.
//   0x27  3-byte marker, seen shortly after a settings write. Not decoded.
//   0x00  the opcode-echo ack: replies to the cloud's 0xF0 0x0B keepalive (echoing its payload) and
//         acks commands (32 00 26 00 for a settings write). Not decoded.

const STATES = Enum.of({
    // What the appliance settles on after Standby: powered down.
    Off: 0,
    Initial: 1,
    Running: 2,
    Pause: 3,
    Standby: 4,
    // Held for ~30 s at cycle end, alongside process 0x05, before dropping to Standby with the
    // course byte cleared. A cancelled cycle goes to Standby without passing through it.
    Complete: 5,
})

// Names are this US model's panel wording. Each code was seen with the app or the panel naming the
// cycle; codes never seen on this appliance are left out and report unknown.
const COURSES = Enum.of({
    // The course byte reads 0 with nothing selected. Deliberately not labelled 'None': that is the
    // payload publishProperty sends for an undefined value, which HA renders as unknown, and an idle
    // appliance would then be indistinguishable from an unrecognised course code.
    'Not selected': 0x00,
    Auto: 0x01,
    Heavy: 0x02,
    Turbo: 0x04,
    Normal: 0x05,
    'Machine Clean': 0x09,
    'Download Cycle': 0x0b,
})

// This model's downloadable cycles, numbered as on the LG app's "Manage Download Cycles" screen,
// where each cycle carries a "P" number. The numbering is wire-confirmed for P1: a remote start of the
// downloaded cycle reported i20 = 0x01 while the app had Tub Clean loaded.
const SMART_COURSES = Enum.of({
    'Tub Clean': 0x01,
    Express: 0x02,
    Rinse: 0x03,
    'Pots and Pans': 0x04,
    Casseroles: 0x05,
    Glassware: 0x06,
    'Night Care': 0x07,
    Delicate: 0x08,
    Refresh: 0x09,
})

// The course sensor draws its options from both tables. They stay separate because the codes do: the
// base course is i5 and the downloaded one i20.
const COURSE_OPTIONS = [...COURSES.options, ...SMART_COURSES.options]

const CLASS_BYTE = 0x32
const STATUS_FRAME_TYPE = 0xec
const SINGLE_STATUS_FRAME_TYPE = 0xeb
const STATISTICS_FRAME_TYPE = 0x3e

// 0xEB is 37 bytes on the wire, carrying a single 29-byte record behind a 2-byte header of
// [marker][length]. The marker is 0x00 or 0x08 (no difference in the record either way), so only the
// length is checked.
//
// 0xEC is the two-stacked-records form: [marker][len][previous record] [marker][len][current record],
// with the same 29-byte record.
const RECORD_LEN = 0x1d

// Offsets within a record body, each checked against the LG app or the panel:
//
//   i0   state    0x01 Initial -> 0x02 Running -> 0x05 Complete -> 0x04 Standby -> 0x00, tracking the
//                 panel and the cycle
//   i1   process  cycle phase while Running, see PROCESSES
//   i3/4 course time, hours/minutes, matching the app's start -> estimated end
//   i5   course
//   i7/8 remain time, hours/minutes: counts down once a minute in step with the app
//   i9/10 delay start, hours then minutes: an 11-hour delay counts 0x0B 0x00 -> 0x0A 0x3B -> 0x0A 0x3A.
//                 Published as total minutes; the hours byte alone would read "0" for the whole of a
//                 1-hour delay.
//   i11  flags1   0x02 door open. Three settings bits, each labelled by toggling the setting in the
//                 app: 0x40 clean indicator light, 0x20 tub clean reminder, 0x10 automatic selection.
//                 Bit 0x04 tracks rinse aid level > 0. Not published; the level itself is.
//   i12  options  0x04 extra dry, 0x08 high temp, 0x80 steam — the same bits as the start command's
//                 opt3, each labelled by a remote start with only that option selected. Bit 0x01 is
//                 not an option: it tracks delay start. Not published.
//   i13  rinse aid dispenser level, matching the app's Settings screen
//   i15  flags2   0x02 remote start, 0x80 the Chime Sound setting
//   i16  opt2     0x04 the End of Cycle Tone setting. Bit 0x02 tracks course selection, and bit 0x08
//                 is set 3 s before the door auto-opens for drying. Neither is published.
//   i20  downloaded cycle number, 0 when none is active
//   i21  bit 0x40 is the Status Indicator Light setting
const STATE_OFFSET = 0
const PROCESS_OFFSET = 1
const COURSE_TIME_HOUR_OFFSET = 3
const COURSE_TIME_MIN_OFFSET = 4
const COURSE_OFFSET = 5
const REMAIN_TIME_HOUR_OFFSET = 7
const REMAIN_TIME_MIN_OFFSET = 8
const DELAY_START_OFFSET = 9
const DELAY_START_MIN_OFFSET = 10
const FLAGS1_OFFSET = 11
const FLAG1_DOOR_OPEN = 0x02
const FLAG1_TUB_CLEAN_REMINDER = 0x20
const FLAG1_CLEAN_INDICATOR_LIGHT = 0x40
const FLAG1_AUTOMATIC_SELECTION = 0x10
const OPTIONS_OFFSET = 12
const OPTION_EXTRA_DRY = 0x04
const OPTION_HIGH_TEMP = 0x08
const OPTION_STEAM = 0x80
const RINSE_LEVEL_OFFSET = 13
const FLAGS2_OFFSET = 15
const FLAG2_REMOTE_START = 0x02
const FLAG2_CHIME_SOUND = 0x80
const OPT2_OFFSET = 16
const OPT2_END_OF_CYCLE_TONE = 0x04
const SMART_COURSE_OFFSET = 20
const STATUS_LIGHT_OFFSET = 21
const STATUS_LIGHT_ON = 0x40

// Option bits of byte 4 of the settings snapshot command, each captured both set and cleared while
// toggling the matching control on the LG app's Settings screen. The bit positions differ from the
// record's readback bits above, so the two sets of constants stay separate.
const SETTING_CHIME_SOUND = 0x04
const SETTING_END_OF_CYCLE_TONE = 0x40
const SETTING_TUB_CLEAN_REMINDER = 0x01
const SETTING_CLEAN_INDICATOR_LIGHT = 0x08
const SETTING_AUTOMATIC_SELECTION = 0x20

// MQTT property name -> settings-cache key, for the six on/off settings.
const SETTING_SWITCH_KEYS = {
    chime_sound: 'chimeSound',
    end_of_cycle_tone: 'endOfCycleTone',
    tub_clean_reminder: 'tubCleanReminder',
    clean_indicator_light: 'cleanIndicatorLight',
    automatic_selection: 'automaticSelection',
    status_indicator_light: 'statusIndicatorLight',
} as const

// Courses the Start Course button may command — those seen running on this appliance, no more. 0x0b
// runs whatever cycle is loaded in the panel's Downloaded slot; the appliance then reports the real
// cycle in i5 and its catalogue number in i20 (a Tub Clean run reports i5 0x09, i20 0x01).
const COURSE_DOWNLOAD_CYCLE = 0x0b
const START_COURSES = [0x01, 0x02, 0x04, 0x05, COURSE_DOWNLOAD_CYCLE]
const START_COURSE_OPTIONS = START_COURSES.flatMap((code) => COURSES.map(code) ?? [])

// Cycle phase, from the process byte. Washing and Drying are labelled by the LG app's own status
// text. Rinsing is the one inferred label: 0x03 is the phase between Washing and
// Drying, and leaving it out would make the sensor read unknown for part of every wash. 0x00 is what
// the byte reads whenever no cycle is running — labelled Idle rather than 'None', which HA reserves
// for unknown.
const PROCESSES = Enum.of({
    Idle: 0x00,
    // The machine reports state Running for the whole delay window; this code is what separates
    // waiting from washing.
    'Delayed Start': 0x01,
    Washing: 0x02,
    Rinsing: 0x03,
    Drying: 0x04,
    Complete: 0x05,
    // The drain after a cancel. The state byte stays Running throughout, and the cycle then ends at
    // Standby without passing through Complete.
    Cancelling: 0x63,
})

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Dishwasher' })

        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    state: {
                        platform: 'sensor',
                        icon: 'mdi:dishwasher',
                        device_class: 'enum',
                        options: STATES.options,
                        unique_id: '$deviceid-state',
                        state_topic: '$this/state',
                        name: 'State',
                    },
                    course: {
                        platform: 'sensor',
                        icon: 'mdi:dishwasher',
                        device_class: 'enum',
                        options: COURSE_OPTIONS,
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                    },
                    process: {
                        platform: 'sensor',
                        icon: 'mdi:progress-clock',
                        device_class: 'enum',
                        options: PROCESSES.options,
                        unique_id: '$deviceid-process',
                        state_topic: '$this/process',
                        name: 'Process',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer-sand',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    initial_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    delay_start: {
                        platform: 'sensor',
                        icon: 'mdi:clock-fast',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay Start',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        payload_on: 'OPEN',
                        payload_off: 'CLOSE',
                    },
                    energy: {
                        platform: 'sensor',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:lightning-bolt',
                    },
                    extra_dry: {
                        platform: 'binary_sensor',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-extra_dry',
                        state_topic: '$this/extra_dry',
                        name: 'Extra Dry',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    high_temp: {
                        platform: 'binary_sensor',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-high_temp',
                        state_topic: '$this/high_temp',
                        name: 'High Temp',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        icon: 'mdi:kettle-steam',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Settings, mirrored from the appliance's own readback (see the offset comments)
                    // and written as a full snapshot of the cached state. Names are the LG app's own.
                    // `optimistic` hides the ~2 s until the appliance echoes the change back.
                    rinse_level: {
                        platform: 'number',
                        icon: 'mdi:water-plus',
                        entity_category: 'config',
                        unique_id: '$deviceid-rinse_level',
                        state_topic: '$this/rinse_level',
                        command_topic: '$this/rinse_level/set',
                        name: 'Rinse Aid Dispenser Level',
                        min: 0,
                        max: 4,
                        step: 1,
                        optimistic: true,
                    },
                    chime_sound: {
                        platform: 'switch',
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                        unique_id: '$deviceid-chime_sound',
                        state_topic: '$this/chime_sound',
                        command_topic: '$this/chime_sound/set',
                        name: 'Chime Sound',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                    },
                    end_of_cycle_tone: {
                        platform: 'switch',
                        icon: 'mdi:music-note',
                        entity_category: 'config',
                        unique_id: '$deviceid-end_of_cycle_tone',
                        state_topic: '$this/end_of_cycle_tone',
                        command_topic: '$this/end_of_cycle_tone/set',
                        name: 'End of Cycle Tone',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                    },
                    tub_clean_reminder: {
                        platform: 'switch',
                        icon: 'mdi:bell-outline',
                        entity_category: 'config',
                        unique_id: '$deviceid-tub_clean_reminder',
                        state_topic: '$this/tub_clean_reminder',
                        command_topic: '$this/tub_clean_reminder/set',
                        name: 'Tub Clean Reminder',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                    },
                    clean_indicator_light: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb',
                        entity_category: 'config',
                        unique_id: '$deviceid-clean_indicator_light',
                        state_topic: '$this/clean_indicator_light',
                        command_topic: '$this/clean_indicator_light/set',
                        name: 'Clean Indicator Light',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                    },
                    automatic_selection: {
                        platform: 'switch',
                        icon: 'mdi:auto-fix',
                        entity_category: 'config',
                        unique_id: '$deviceid-automatic_selection',
                        state_topic: '$this/automatic_selection',
                        command_topic: '$this/automatic_selection/set',
                        name: 'Automatic Selection',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                    },
                    status_indicator_light: {
                        platform: 'switch',
                        icon: 'mdi:led-on',
                        entity_category: 'config',
                        unique_id: '$deviceid-status_indicator_light',
                        state_topic: '$this/status_indicator_light',
                        command_topic: '$this/status_indicator_light/set',
                        name: 'Status Indicator Light',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                    },
                    // Controls. Every packet these send reproduces one captured from LG's own cloud
                    // (see the command table at the top).
                    target_course: {
                        platform: 'select',
                        icon: 'mdi:washing-machine',
                        unique_id: '$deviceid-target_course',
                        state_topic: '$this/target_course',
                        command_topic: '$this/target_course/set',
                        name: 'Target Course',
                        // Derived from START_COURSES, which setProperty checks against, so the list HA
                        // offers and the list the write path accepts cannot drift apart.
                        options: START_COURSE_OPTIONS,
                    },
                    // Byte 4 of the start command, in whole hours: a start carrying 0x01 puts the
                    // appliance into a delay counting down 00:59, 00:58, ...
                    target_delay: {
                        platform: 'number',
                        icon: 'mdi:clock-start',
                        unique_id: '$deviceid-target_delay',
                        state_topic: '$this/target_delay',
                        command_topic: '$this/target_delay/set',
                        name: 'Target Delay Start',
                        min: 0,
                        max: 12,
                        step: 1,
                        unit_of_measurement: 'h',
                    },
                    target_high_temp: {
                        platform: 'switch',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-target_high_temp',
                        state_topic: '$this/target_high_temp',
                        command_topic: '$this/target_high_temp/set',
                        name: 'Target High Temp',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    target_extra_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-target_extra_dry',
                        state_topic: '$this/target_extra_dry',
                        command_topic: '$this/target_extra_dry/set',
                        name: 'Target Extra Dry',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    target_steam: {
                        platform: 'switch',
                        icon: 'mdi:kettle-steam',
                        unique_id: '$deviceid-target_steam',
                        state_topic: '$this/target_steam',
                        command_topic: '$this/target_steam/set',
                        name: 'Target Steam',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Unavailable unless the appliance's latest status says remote start is armed. The
                    // bit self-clears when a cycle ends, so this greys out again after every wash until
                    // the panel re-arms it. That mirrors the appliance's own interlock; rethink adds
                    // none, and a start sent anyway is simply ignored by the appliance.
                    start_course: {
                        platform: 'button',
                        icon: 'mdi:play-circle',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        name: 'Start Course',
                        payload_press: 'PRESS',
                        availability: [
                            { topic: '$this/availability' },
                            { topic: '$rethink/availability' },
                            {
                                topic: '$this/remote_start',
                                payload_available: 'ON',
                                payload_not_available: 'OFF',
                            },
                        ],
                        availability_mode: 'all',
                    },
                    pause: {
                        platform: 'button',
                        icon: 'mdi:pause-circle',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        payload_press: 'PRESS',
                    },
                    resume: {
                        platform: 'button',
                        icon: 'mdi:play-pause',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        name: 'Resume',
                        payload_press: 'PRESS',
                    },
                    cancel: {
                        platform: 'button',
                        icon: 'mdi:stop-circle',
                        unique_id: '$deviceid-cancel',
                        command_topic: '$this/cancel/set',
                        name: 'Cancel Cycle',
                        payload_press: 'PRESS',
                    },
                    // 0x12, the app's power button. Distinct from Cancel: it stops without the drain.
                    power_off: {
                        platform: 'button',
                        icon: 'mdi:power',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Power Off',
                        payload_press: 'PRESS',
                    },
                },
            }),
        )
    }

    // The status query LG's own cloud sends — the same family-wide packet the washer, dryer and
    // WashTower handlers in this repo send. The appliance answers with a 0xEB status frame. The
    // trailing 0x18 is not a reply-length field: this appliance's record is 0x1D long.
    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))

        // Seed the target entities so HA has something to show before the first press.
        this.publishProperty('target_course', COURSES.map(this.targetCourse))
        this.publishProperty('target_high_temp', this.targetHighTemp ? 'ON' : 'OFF')
        this.publishProperty('target_extra_dry', this.targetExtraDry ? 'ON' : 'OFF')
        this.publishProperty('target_steam', this.targetSteam ? 'ON' : 'OFF')
        this.publishProperty('target_delay', this.targetDelay)
    }

    // What Start Course will send. Defaults match the appliance's own power-on default: it
    // highlights Auto with no options.
    targetCourse = 0x01
    targetHighTemp = false
    targetExtraDry = false
    targetSteam = false
    targetDelay = 0

    // The latest settings read back from the appliance; undefined until the first status record.
    settings?: {
        rinseLevel: number
        chimeSound: boolean
        endOfCycleTone: boolean
        tubCleanReminder: boolean
        cleanIndicatorLight: boolean
        automaticSelection: boolean
        statusIndicatorLight: boolean
    }

    // The settings snapshot, byte for byte the shape the app sends: there is no per-setting command,
    // every write carries all of them. Byte 5 is 0x40 and bytes 3, 6, 8 and 9 are zero in every
    // command the app sends.
    sendSettings() {
        if (!this.settings) return
        const s = this.settings
        let opts = 0
        if (s.chimeSound) opts |= SETTING_CHIME_SOUND
        if (s.endOfCycleTone) opts |= SETTING_END_OF_CYCLE_TONE
        if (s.tubCleanReminder) opts |= SETTING_TUB_CLEAN_REMINDER
        if (s.cleanIndicatorLight) opts |= SETTING_CLEAN_INDICATOR_LIGHT
        if (s.automaticSelection) opts |= SETTING_AUTOMATIC_SELECTION
        this.send(
            Buffer.from([
                0xf0,
                0x26,
                s.rinseLevel,
                0x00,
                opts,
                0x40,
                0x00,
                s.statusIndicatorLight ? 0x01 : 0x00,
                0x00,
                0x00,
            ]),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'target_course') {
            const code = COURSES.unmap(mqttValue)
            // Reject anything not in the select's option list rather than starting a wrong cycle.
            if (code === undefined || !START_COURSES.includes(code)) return
            this.targetCourse = code
            this.publishProperty('target_course', mqttValue)
        } else if (prop === 'target_high_temp') {
            this.targetHighTemp = mqttValue === 'ON'
            this.publishProperty('target_high_temp', mqttValue)
        } else if (prop === 'target_extra_dry') {
            this.targetExtraDry = mqttValue === 'ON'
            this.publishProperty('target_extra_dry', mqttValue)
        } else if (prop === 'target_steam') {
            this.targetSteam = mqttValue === 'ON'
            this.publishProperty('target_steam', mqttValue)
        } else if (prop === 'target_delay') {
            const hours = parseInt(mqttValue, 10)
            if (isNaN(hours) || hours < 0 || hours > 12) return
            this.targetDelay = hours
            this.publishProperty('target_delay', hours)
        } else if (prop === 'start_course') {
            let opt3 = 0
            if (this.targetHighTemp) opt3 |= OPTION_HIGH_TEMP
            if (this.targetExtraDry) opt3 |= OPTION_EXTRA_DRY
            if (this.targetSteam) opt3 |= OPTION_STEAM
            // Bytes 5/7/8 are zero in every start LG's cloud sends, the download cycle included.
            this.send(Buffer.from([0xf0, 0x26, 0x10, this.targetCourse, this.targetDelay, 0x00, opt3, 0x00, 0x00]))
        } else if (prop === 'rinse_level' || prop in SETTING_SWITCH_KEYS) {
            // A settings write is a full snapshot, so the current values must be known first — a
            // snapshot built from defaults would silently overwrite the appliance's other settings.
            if (!this.settings) {
                log('N17', 'refusing settings write: no status record received yet')
                return
            }
            if (prop === 'rinse_level') {
                const level = parseInt(mqttValue, 10)
                if (isNaN(level) || level < 0 || level > 4) return
                this.settings.rinseLevel = level
            } else {
                this.settings[SETTING_SWITCH_KEYS[prop as keyof typeof SETTING_SWITCH_KEYS]] = mqttValue === 'ON'
            }
            this.sendSettings()
        } else if (prop === 'pause') {
            this.send(Buffer.from('F02613', 'hex'))
        } else if (prop === 'resume') {
            this.send(Buffer.from('F02614', 'hex'))
        } else if (prop === 'cancel') {
            this.send(Buffer.from('F02611', 'hex'))
        } else if (prop === 'power_off') {
            this.send(Buffer.from('F02612', 'hex'))
        }
    }

    processAABB(buf: Buffer) {
        if (buf.length < 2 || buf[0] !== CLASS_BYTE) return
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE) return this.processSingleStatus(buf)
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf)
        if (buf[1] === STATISTICS_FRAME_TYPE) return this.processStatistics(buf)

        // 0x0A / 0x31 / 0x88 / 0x72 / 0x27 / 0x00 land here.
        log('N17', 'undecoded frame', buf.toString('hex'))
    }

    // Body is "32 3E <delta Wh, 2B> <accumulated Wh, 2B> <sequence>":
    //
    //   32 3E 0000 0000 00      idle from boot, 0 Wh
    //   32 3E 0002 0002 01      2 Wh, delta and accumulated moving together
    //
    // The sequence byte is a change counter: it steps exactly when the reading changes, then holds
    // across identical frames. It is not used to drop repeats — a single-byte counter could wrap onto
    // a changed reading, and publishProperty already collapses repeats without that risk.
    processStatistics(buf: Buffer) {
        if (buf.length < 7) return
        this.publishProperty('energy', buf.readUInt16BE(4))
    }

    // The appliance's unsolicited change report, previous record then current — a full wash produces
    // one per minute plus one per panel action.
    processStatus(buf: Buffer) {
        // Second half of the payload is the current state; the first half is the previous state.
        const halfLen = Math.floor((buf.length - 2) / 2)
        const record = buf.subarray(2 + halfLen)
        if (record[1] !== RECORD_LEN) return
        this.publishStatusRecord(record.subarray(2))
    }

    // The single-record form. Body is "32 EB <marker> <0x1D> <29-byte record>".
    processSingleStatus(buf: Buffer) {
        if (buf[3] !== RECORD_LEN) return
        this.publishStatusRecord(buf.subarray(4))
    }

    publishStatusRecord(data: Buffer) {
        if (data.length < RECORD_LEN) return

        this.publishProperty('state', STATES.map(data[STATE_OFFSET]))
        this.publishProperty('process', PROCESSES.map(data[PROCESS_OFFSET]))

        // A smart/downloaded course, when one is active, replaces the base course rather than adding to it.
        const smartCourse = data[SMART_COURSE_OFFSET]
        const baseCourse = data[COURSE_OFFSET]
        this.publishProperty('course', smartCourse !== 0 ? SMART_COURSES.map(smartCourse) : COURSES.map(baseCourse))

        this.publishProperty('initial_time', data[COURSE_TIME_HOUR_OFFSET] * 60 + data[COURSE_TIME_MIN_OFFSET])
        this.publishProperty('remaining_time', data[REMAIN_TIME_HOUR_OFFSET] * 60 + data[REMAIN_TIME_MIN_OFFSET])
        this.publishProperty('delay_start', data[DELAY_START_OFFSET] * 60 + data[DELAY_START_MIN_OFFSET])
        this.publishProperty('door', data[FLAGS1_OFFSET] & FLAG1_DOOR_OPEN ? 'OPEN' : 'CLOSE')
        this.publishProperty('extra_dry', data[OPTIONS_OFFSET] & OPTION_EXTRA_DRY ? 'ON' : 'OFF')
        this.publishProperty('high_temp', data[OPTIONS_OFFSET] & OPTION_HIGH_TEMP ? 'ON' : 'OFF')
        this.publishProperty('steam', data[OPTIONS_OFFSET] & OPTION_STEAM ? 'ON' : 'OFF')
        this.publishProperty('remote_start', data[FLAGS2_OFFSET] & FLAG2_REMOTE_START ? 'ON' : 'OFF')

        // The settings, echoed by the appliance in every record. This readback is also what arms the
        // write path: until it has run once, settings writes are refused.
        this.settings = {
            rinseLevel: data[RINSE_LEVEL_OFFSET],
            chimeSound: (data[FLAGS2_OFFSET] & FLAG2_CHIME_SOUND) !== 0,
            endOfCycleTone: (data[OPT2_OFFSET] & OPT2_END_OF_CYCLE_TONE) !== 0,
            tubCleanReminder: (data[FLAGS1_OFFSET] & FLAG1_TUB_CLEAN_REMINDER) !== 0,
            cleanIndicatorLight: (data[FLAGS1_OFFSET] & FLAG1_CLEAN_INDICATOR_LIGHT) !== 0,
            automaticSelection: (data[FLAGS1_OFFSET] & FLAG1_AUTOMATIC_SELECTION) !== 0,
            statusIndicatorLight: (data[STATUS_LIGHT_OFFSET] & STATUS_LIGHT_ON) !== 0,
        }
        this.publishProperty('rinse_level', this.settings.rinseLevel)
        this.publishProperty('chime_sound', this.settings.chimeSound ? 'ON' : 'OFF')
        this.publishProperty('end_of_cycle_tone', this.settings.endOfCycleTone ? 'ON' : 'OFF')
        this.publishProperty('tub_clean_reminder', this.settings.tubCleanReminder ? 'ON' : 'OFF')
        this.publishProperty('clean_indicator_light', this.settings.cleanIndicatorLight ? 'ON' : 'OFF')
        this.publishProperty('automatic_selection', this.settings.automaticSelection ? 'ON' : 'OFF')
        this.publishProperty('status_indicator_light', this.settings.statusIndicatorLight ? 'ON' : 'OFF')
    }
}
