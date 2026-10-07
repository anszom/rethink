import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'
import {
    FLAG1_DOOR_OPEN,
    OPTION_EXTRA_DRY,
    OPTION_HIGH_TEMP,
    PROCESS_STATES,
    APPLIANCE_STATES,
    unpackStatus,
} from './dishwasher_common'

// LG LDNPQ445S dishwasher, reporting modelName "N17" (deviceType 204, BEKEN_BK7234).
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
// Frame types. The appliance does not transmit continuously: it goes quiet for minutes at a time and
// then emits a burst lasting about a minute, during which 0x0A arrives every 1-5s and 0x3E every 4-6s.
//   0xEB & 0xEC - like all other appliances. Decoded below.
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

// Names are this US model's panel wording. Each code was seen with the app or the panel naming the
// cycle; codes never seen on this appliance are left out and report unknown.
const COURSES = Enum.of({
    // The course byte reads 0 with nothing selected. Deliberately not labelled 'None': that is the
    // payload publishProperty sends for an undefined value, which HA renders as unknown, and an idle
    // appliance would then be indistinguishable from an unrecognised course code.
    Off: 0x00,
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
const STATUS_RECORD_LENGTH = 31

// Offsets within a record body, each checked against the LG app or the panel:
//
//   i0   state    0x01 Ready -> 0x02 Running -> 0x05 End -> 0x04 Standby -> 0x00 Off, tracking the
//                 panel and the cycle, see STATES
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
//   i16  flags3   0x04 the End of Cycle Tone setting. Bit 0x02 tracks course selection, and bit 0x08
//                 is set 3 s before the door auto-opens for drying. Neither is published.
//   i20  downloaded cycle number, 0 when none is active
//   i21  bit 0x40 is the Status Indicator Light setting
const FLAG1_TUB_CLEAN_REMINDER = 0x20
const FLAG1_CLEAN_INDICATOR_LIGHT = 0x40
const FLAG1_AUTOMATIC_SELECTION = 0x10
const OPTION_STEAM = 0x80
const FLAG2_REMOTE_START = 0x02
const FLAG2_CHIME_SOUND = 0x80
const FLAG3_END_OF_CYCLE_TONE = 0x04
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

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Dishwasher' })

        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    status: {
                        platform: 'sensor',
                        icon: 'mdi:dishwasher',
                        device_class: 'enum',
                        options: APPLIANCE_STATES.options,
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                    },
                    course: {
                        platform: 'sensor',
                        icon: 'mdi:playlist-play',
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
                        options: PROCESS_STATES.options,
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
                    delay_start_time: {
                        platform: 'sensor',
                        icon: 'mdi:clock-fast',
                        unique_id: '$deviceid-delay_start_time',
                        state_topic: '$this/delay_start_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay start time',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
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
                        name: 'Extra dry',
                    },
                    high_temp: {
                        platform: 'binary_sensor',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-high_temp',
                        state_topic: '$this/high_temp',
                        name: 'High temp',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        icon: 'mdi:kettle-steam',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
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
                        name: 'Rinse aid dispenser level',
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
                        name: 'Chime sound',
                        optimistic: true,
                    },
                    end_of_cycle_tone: {
                        platform: 'switch',
                        icon: 'mdi:music-note',
                        entity_category: 'config',
                        unique_id: '$deviceid-end_of_cycle_tone',
                        state_topic: '$this/end_of_cycle_tone',
                        command_topic: '$this/end_of_cycle_tone/set',
                        name: 'End of cycle tone',
                        optimistic: true,
                    },
                    tub_clean_reminder: {
                        platform: 'switch',
                        icon: 'mdi:bell-outline',
                        entity_category: 'config',
                        unique_id: '$deviceid-tub_clean_reminder',
                        state_topic: '$this/tub_clean_reminder',
                        command_topic: '$this/tub_clean_reminder/set',
                        name: 'Tub clean reminder',
                        optimistic: true,
                    },
                    clean_indicator_light: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb',
                        entity_category: 'config',
                        unique_id: '$deviceid-clean_indicator_light',
                        state_topic: '$this/clean_indicator_light',
                        command_topic: '$this/clean_indicator_light/set',
                        name: 'Clean indicator light',
                        optimistic: true,
                    },
                    automatic_selection: {
                        platform: 'switch',
                        icon: 'mdi:auto-fix',
                        entity_category: 'config',
                        unique_id: '$deviceid-automatic_selection',
                        state_topic: '$this/automatic_selection',
                        command_topic: '$this/automatic_selection/set',
                        name: 'Automatic selection',
                        optimistic: true,
                    },
                    status_indicator_light: {
                        platform: 'switch',
                        icon: 'mdi:led-on',
                        entity_category: 'config',
                        unique_id: '$deviceid-status_indicator_light',
                        state_topic: '$this/status_indicator_light',
                        command_topic: '$this/status_indicator_light/set',
                        name: 'Status indicator light',
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
                        name: 'Target course',
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
                        name: 'Target delay start',
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
                        name: 'Target high temp',
                    },
                    target_extra_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-target_extra_dry',
                        state_topic: '$this/target_extra_dry',
                        command_topic: '$this/target_extra_dry/set',
                        name: 'Target extra dry',
                    },
                    target_steam: {
                        platform: 'switch',
                        icon: 'mdi:kettle-steam',
                        unique_id: '$deviceid-target_steam',
                        state_topic: '$this/target_steam',
                        command_topic: '$this/target_steam/set',
                        name: 'Target steam',
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
                        name: 'Start course',
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
                        name: 'Cancel cycle',
                        payload_press: 'PRESS',
                    },
                    // 0x12, the app's power button. Distinct from Cancel: it stops without the drain.
                    power_off: {
                        platform: 'button',
                        icon: 'mdi:power',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Power off',
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
        if (this.processCommonStatus(buf, CLASS_BYTE, STATUS_RECORD_LENGTH, this.processStatus)) return

        if (buf[0] === CLASS_BYTE && buf[1] === 0x3e && buf.length === 7) {
            this.processStatistics(buf)
        }
    }

    processStatistics(buf: Buffer) {
        // 32 3e [Delta Wh 2B] [Accum Wh 2B] [Seq]
        const energyAccum = buf.readUInt16BE(4)
        this.publishProperty('energy', energyAccum)
    }

    processStatus(curStatus: Buffer) {
        // this includes a flag/length prefix
        if (curStatus[1] != STATUS_RECORD_LENGTH - 2) return

        const data = curStatus.subarray(2)
        const s = unpackStatus(data)

        this.publishProperty('status', APPLIANCE_STATES.map(s.state))
        this.publishProperty('process', PROCESS_STATES.map(s.process))

        // A smart/downloaded course, when one is active, replaces the base course rather than adding to it.
        this.publishProperty(
            'course',
            s.downloadCourse !== 0 ? SMART_COURSES.map(s.downloadCourse) : COURSES.map(s.course),
        )

        this.publishProperty('initial_time', s.initialTimeHour * 60 + s.initialTimeMinute)
        this.publishProperty('remaining_time', s.remainingTimeHour * 60 + s.remainingTimeMinute)
        this.publishProperty('delay_start_time', s.delayTimeHour * 60 + s.delayTimeMinute)
        this.publishProperty('door', s.flags1 & FLAG1_DOOR_OPEN ? 'ON' : 'OFF')
        this.publishProperty('extra_dry', s.options & OPTION_EXTRA_DRY ? 'ON' : 'OFF')
        this.publishProperty('high_temp', s.options & OPTION_HIGH_TEMP ? 'ON' : 'OFF')
        this.publishProperty('steam', s.options & OPTION_STEAM ? 'ON' : 'OFF')
        this.publishProperty('remote_start', s.flags2 & FLAG2_REMOTE_START ? 'ON' : 'OFF')

        // The settings, echoed by the appliance in every record. This readback is also what arms the
        // write path: until it has run once, settings writes are refused.
        this.settings = {
            rinseLevel: s.rinseLevel,
            chimeSound: (s.flags2 & FLAG2_CHIME_SOUND) !== 0,
            endOfCycleTone: (s.flags3 & FLAG3_END_OF_CYCLE_TONE) !== 0,
            tubCleanReminder: (s.flags1 & FLAG1_TUB_CLEAN_REMINDER) !== 0,
            cleanIndicatorLight: (s.flags1 & FLAG1_CLEAN_INDICATOR_LIGHT) !== 0,
            automaticSelection: (s.flags1 & FLAG1_AUTOMATIC_SELECTION) !== 0,
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
