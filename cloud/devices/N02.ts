import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'
import { FLAG1_DOOR_OPEN, OPTION_HIGH_TEMP, PROCESS_STATES, APPLIANCE_STATES, unpackStatus } from './dishwasher_common'

// LG LDPH7972S dishwasher, modelName "N02" (deviceType 204). Same 0x32/0xEB/0xEC family as
// N17/D0211/H11, confirmed live against a real unit on 2026-10-06. Richer settings screen than N17:
// Time Indicator is new, the other five settings reuse N17's exact bit positions (independently
// reconfirmed, not assumed). Not exposed: Tub Light Timing (absent from this unit's app) and a
// separate "Keep Clean Indicator On" (same bit as Clean Light Reminder, just a second label).
//
// Every entity was caught as a live transition this session unless noted otherwise below. The
// record's own length byte reads 0x18 (24) rather than the 29 you'd expect for a 31-byte record;
// unexplained, and not relied on (frame length alone already gates processCommonStatus).
//
// Commands, all confirmed on the wire:
//   F0 26 10 <course> <delayHours> 00 <opt3> <opt4> 00   start — N17's shape, plus a real opt4 byte
//                                     N17 doesn't use. Per-bit confidence is noted at each OPTION_*/
//                                     OPT4_* constant below rather than repeated here.
//   F0 26 13 / F0 26 14 / F0 26 11                   pause / resume / cancel (all confirmed)
//   F0 26 <rinse> 00 <opts> 00 00 00 00 00           settings snapshot (confirmed per toggle below)
//
// Cancel's drain matches N17's: state stays Running with process Cancel (0x63) for about a minute,
// then the appliance drops to Standby on its own and clears remote start.
const CLASS_BYTE = 0x32
const STATUS_RECORD_LENGTH = 31

// This model's own course list, from its modelJson, plus Machine Clean (9) and Rinse (6). Every one
// of these was independently confirmed via a real start - "1 Hour" also by its initial time reading
// exactly 1:00, matching the name. Starting "Download Cycle" (0x0b) reports back whichever course is
// actually loaded in that slot rather than 0x0b itself (matching N17's already-documented behavior
// for the same command): Machine Clean and Rinse were each seen there in turn, which is why both get
// their own COURSES entry despite neither being started directly.
//
// A genuinely different command, F0 25 03 00 <course> <slot> 00×11, downloads a cycle into that
// slot - confirmed once (course 0x06 Rinse into slot 3, matching the app's "Rinse (P3)" label
// exactly) but not implemented: one example isn't enough to be sure of the other ~11 trailing zero
// bytes' meaning, and the app only ever offers a fixed small set of named cycles, each apparently
// tied to its own slot number, not a free choice - another unconfirmed assumption. Left as a
// documented capability for a future contribution with more captures.
const COURSES = Enum.of({
    Off: 0x00,
    Auto: 0x01,
    Heavy: 0x02,
    Delicate: 0x03,
    Normal: 0x05,
    Rinse: 0x06,
    Refresh: 0x07,
    'Machine Clean': 0x09,
    'Download Cycle': 0x0b,
    '1 Hour': 0x12,
})

// The courses this unit was seen remotely starting. Keeping the select's option list this narrow -
// rather than every course the device can show on its panel - mirrors N17's handling of an
// unconfirmed course: refuse rather than guess. Machine Clean is deliberately excluded: only reached
// via "Download Cycle" in practice, never confirmed as a direct start.
const START_COURSES = [0x01, 0x02, 0x03, 0x05, 0x07, 0x0b, 0x12]
const START_COURSE_OPTIONS = START_COURSES.flatMap((code) => COURSES.map(code) ?? [])

// opt3 of the start command. Steam, High Temp (shared OPTION_HIGH_TEMP) and Flex Zone were each
// confirmed via an isolated real start on this unit. Extra Dry (the shared OPTION_EXTRA_DRY other
// family members use) isn't here at all: this unit's app has no Extra Dry control, only Dry Boost.
const OPTION_STEAM = 0x80
// Flex Zone, confirmed symmetric between this options byte and the write side, all three panel
// modes: Dual 0x10, Lower 0x20, Upper 0x40.
const FLEX_ZONE_MASK = 0x70
const FLEX_ZONE = Enum.of({ Off: 0x00, Dual: 0x10, Lower: 0x20, Upper: 0x40 })

// opt4 of the start command, confirmed via two isolated real starts (see header comment).
const OPT4_DRY_BOOST_LOW = 0x01
const OPT4_DRY_BOOST_HIGH = 0x03
const OPT4_NIGHT_DRY = 0x04

// Not exposed as its own entity: a real delayed start showed the options-byte readback setting bit
// 0x01 while delay_start_time counted down - the same "delay pending" bit D0211 documents at this
// position - but delay_start_time already conveys the same information more precisely.

// flags1 (byte 11), beyond the shared door bit. Each was caught toggling live; the bit positions
// happen to match N17's FLAG1_* constants exactly, independently reconfirmed rather than assumed.
const FLAG1_AUTO_SELECT = 0x10
const FLAG1_MACHINE_CLEAN_REMINDER = 0x20
const FLAG1_CLEAN_LIGHT_REMINDER = 0x40
// No N17 equivalent (N17 doesn't expose Night Dry at all); confirmed live, course-selection screen
// through to Running.
const FLAG1_NIGHT_DRY = 0x80

// flags2 (byte 15). Remote start and Chime Sound match N17's bit positions, reconfirmed live. Time
// Indicator has no N17 equivalent - it's a genuinely new setting on this model.
const FLAG2_REMOTE_START = 0x02
const FLAG2_TIME_INDICATOR = 0x08
const FLAG2_CHIME_SOUND = 0x80
// Dry Boost, confirmed live and labelled against the display at each step: Off clears both bits, Low
// sets 0x10, High sets 0x10|0x20 (not an independent bit - High stacks on top of Low).
const FLAG2_DRY_BOOST_MASK = 0x30
const DRY_BOOST = Enum.of({ Off: 0x00, Low: 0x10, High: 0x30 })

// flags3 (byte 16), confirmed live, same bit N17 uses for the same setting.
const FLAG3_END_OF_CYCLE_TONE = 0x04

// Settings-snapshot bitmask (byte 4 of the F0 26 write), confirmed one bit at a time. Five of six
// match N17's SETTING_* bits; Time Indicator's 0x10 is new.
const SETTING_MACHINE_CLEAN_REMINDER = 0x01
const SETTING_CHIME_SOUND = 0x04
const SETTING_CLEAN_LIGHT_REMINDER = 0x08
const SETTING_TIME_INDICATOR = 0x10
const SETTING_AUTO_SELECT = 0x20
const SETTING_END_OF_CYCLE_TONE = 0x40

// MQTT property name -> settings-cache key, for the six on/off settings.
const SETTING_SWITCH_KEYS = {
    machine_clean_reminder: 'machineCleanReminder',
    chime_sound: 'chimeSound',
    clean_light_reminder: 'cleanLightReminder',
    time_indicator: 'timeIndicator',
    auto_select: 'autoSelect',
    end_of_cycle_tone: 'endOfCycleTone',
} as const

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
                        options: COURSES.options,
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
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                    },
                    flex_zone: {
                        platform: 'sensor',
                        icon: 'mdi:view-split-horizontal',
                        device_class: 'enum',
                        options: FLEX_ZONE.options,
                        unique_id: '$deviceid-flex_zone',
                        state_topic: '$this/flex_zone',
                        name: 'Flex zone',
                    },
                    dry_boost: {
                        platform: 'sensor',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: DRY_BOOST.options,
                        unique_id: '$deviceid-dry_boost',
                        state_topic: '$this/dry_boost',
                        name: 'Dry boost',
                    },
                    night_dry: {
                        platform: 'binary_sensor',
                        icon: 'mdi:weather-night',
                        unique_id: '$deviceid-night_dry',
                        state_topic: '$this/night_dry',
                        name: 'Night dry',
                    },
                    // Settings, mirrored from the appliance's own readback and written as a full
                    // snapshot of the cached state - there is no per-setting command. `optimistic`
                    // hides the ~1 s until the appliance echoes the change back.
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
                    machine_clean_reminder: {
                        platform: 'switch',
                        icon: 'mdi:bell-outline',
                        entity_category: 'config',
                        unique_id: '$deviceid-machine_clean_reminder',
                        state_topic: '$this/machine_clean_reminder',
                        command_topic: '$this/machine_clean_reminder/set',
                        name: 'Machine clean reminder',
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
                    clean_light_reminder: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb',
                        entity_category: 'config',
                        unique_id: '$deviceid-clean_light_reminder',
                        state_topic: '$this/clean_light_reminder',
                        command_topic: '$this/clean_light_reminder/set',
                        name: 'Clean light reminder',
                        optimistic: true,
                    },
                    time_indicator: {
                        platform: 'switch',
                        icon: 'mdi:clock-outline',
                        entity_category: 'config',
                        unique_id: '$deviceid-time_indicator',
                        state_topic: '$this/time_indicator',
                        command_topic: '$this/time_indicator/set',
                        name: 'Time indicator',
                        optimistic: true,
                    },
                    auto_select: {
                        platform: 'switch',
                        icon: 'mdi:auto-fix',
                        entity_category: 'config',
                        unique_id: '$deviceid-auto_select',
                        state_topic: '$this/auto_select',
                        command_topic: '$this/auto_select/set',
                        name: 'Auto select',
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
                    // Controls.
                    target_course: {
                        platform: 'select',
                        icon: 'mdi:dishwasher',
                        unique_id: '$deviceid-target_course',
                        state_topic: '$this/target_course',
                        command_topic: '$this/target_course/set',
                        name: 'Target course',
                        options: START_COURSE_OPTIONS,
                    },
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
                    target_flex_zone: {
                        platform: 'select',
                        icon: 'mdi:view-split-horizontal',
                        unique_id: '$deviceid-target_flex_zone',
                        state_topic: '$this/target_flex_zone',
                        command_topic: '$this/target_flex_zone/set',
                        name: 'Target flex zone',
                        options: FLEX_ZONE.options,
                    },
                    // opt4, confirmed via a real isolated start - see header comment.
                    target_dry_boost: {
                        platform: 'select',
                        icon: 'mdi:tumble-dryer',
                        unique_id: '$deviceid-target_dry_boost',
                        state_topic: '$this/target_dry_boost',
                        command_topic: '$this/target_dry_boost/set',
                        name: 'Target dry boost',
                        options: DRY_BOOST.options,
                    },
                    target_night_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-night',
                        unique_id: '$deviceid-target_night_dry',
                        state_topic: '$this/target_night_dry',
                        command_topic: '$this/target_night_dry/set',
                        name: 'Target night dry',
                    },
                    target_steam: {
                        platform: 'switch',
                        icon: 'mdi:kettle-steam',
                        unique_id: '$deviceid-target_steam',
                        state_topic: '$this/target_steam',
                        command_topic: '$this/target_steam/set',
                        name: 'Target steam',
                    },
                    // Unavailable unless the appliance's latest status says remote start is armed -
                    // confirmed live (arming at the panel, self-clearing when the cycle ended).
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
                },
            }),
        )
    }

    // Family-wide status query (same bytes N17/D0211/the washers and WashTower handlers send); not
    // independently captured for this model, since the bridge was already attached when this unit
    // came online.
    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))

        this.publishProperty('target_course', COURSES.map(this.targetCourse))
        this.publishProperty('target_high_temp', this.targetHighTemp ? 'ON' : 'OFF')
        this.publishProperty('target_steam', this.targetSteam ? 'ON' : 'OFF')
        this.publishProperty('target_flex_zone', FLEX_ZONE.map(this.targetFlexZone))
        this.publishProperty('target_dry_boost', DRY_BOOST.map(this.targetDryBoost))
        this.publishProperty('target_night_dry', this.targetNightDry ? 'ON' : 'OFF')
        this.publishProperty('target_delay', this.targetDelay)
    }

    // Defaults match the appliance's own power-on default: Normal, no options.
    targetCourse = 0x05
    targetHighTemp = false
    targetSteam = false
    targetFlexZone = 0x00
    targetDryBoost = 0x00
    targetNightDry = false
    targetDelay = 0

    // The latest settings read back from the appliance; undefined until the first status record.
    settings?: {
        rinseLevel: number
        machineCleanReminder: boolean
        chimeSound: boolean
        cleanLightReminder: boolean
        timeIndicator: boolean
        autoSelect: boolean
        endOfCycleTone: boolean
    }

    // The settings snapshot, byte for byte the shape this unit's app sent for every toggle captured
    // this session: there is no per-setting command, every write carries all six. Bytes 5, 7, 8 and 9
    // were 0x00 in every captured command.
    sendSettings() {
        if (!this.settings) return
        const s = this.settings
        let opts = 0
        if (s.machineCleanReminder) opts |= SETTING_MACHINE_CLEAN_REMINDER
        if (s.chimeSound) opts |= SETTING_CHIME_SOUND
        if (s.cleanLightReminder) opts |= SETTING_CLEAN_LIGHT_REMINDER
        if (s.timeIndicator) opts |= SETTING_TIME_INDICATOR
        if (s.autoSelect) opts |= SETTING_AUTO_SELECT
        if (s.endOfCycleTone) opts |= SETTING_END_OF_CYCLE_TONE
        this.send(Buffer.from([0xf0, 0x26, s.rinseLevel, 0x00, opts, 0x00, 0x00, 0x00, 0x00, 0x00]))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'target_course') {
            const code = COURSES.unmap(mqttValue)
            if (code === undefined || !START_COURSES.includes(code)) return
            this.targetCourse = code
            this.publishProperty('target_course', mqttValue)
        } else if (prop === 'target_high_temp') {
            this.targetHighTemp = mqttValue === 'ON'
            this.publishProperty('target_high_temp', mqttValue)
        } else if (prop === 'target_steam') {
            this.targetSteam = mqttValue === 'ON'
            this.publishProperty('target_steam', mqttValue)
        } else if (prop === 'target_flex_zone') {
            const code = FLEX_ZONE.unmap(mqttValue)
            if (code === undefined) return
            this.targetFlexZone = code
            this.publishProperty('target_flex_zone', mqttValue)
        } else if (prop === 'target_dry_boost') {
            const code = DRY_BOOST.unmap(mqttValue)
            if (code === undefined) return
            this.targetDryBoost = code
            this.publishProperty('target_dry_boost', mqttValue)
        } else if (prop === 'target_night_dry') {
            this.targetNightDry = mqttValue === 'ON'
            this.publishProperty('target_night_dry', mqttValue)
        } else if (prop === 'target_delay') {
            const hours = parseInt(mqttValue, 10)
            if (isNaN(hours) || hours < 0 || hours > 12) return
            this.targetDelay = hours
            this.publishProperty('target_delay', hours)
        } else if (prop === 'start_course') {
            let opt3 = 0
            if (this.targetHighTemp) opt3 |= OPTION_HIGH_TEMP
            if (this.targetSteam) opt3 |= OPTION_STEAM
            opt3 |= this.targetFlexZone // write-side value is identical to the readback's (see FLEX_ZONE)
            // targetDryBoost is cached using its readback-style value (0x00/0x10/0x30, matching
            // DRY_BOOST); opt4 uses a different encoding for the same three levels (see header).
            let opt4 = 0
            if (this.targetDryBoost === 0x30) opt4 |= OPT4_DRY_BOOST_HIGH
            else if (this.targetDryBoost === 0x10) opt4 |= OPT4_DRY_BOOST_LOW
            if (this.targetNightDry) opt4 |= OPT4_NIGHT_DRY
            this.send(Buffer.from([0xf0, 0x26, 0x10, this.targetCourse, this.targetDelay, 0x00, opt3, opt4, 0x00]))
        } else if (prop === 'rinse_level' || prop in SETTING_SWITCH_KEYS) {
            // A settings write is a full snapshot, so the current values must be known first - a
            // snapshot built from defaults would silently overwrite the appliance's other settings.
            if (!this.settings) {
                log('N02', 'refusing settings write: no status record received yet')
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
        const data = curStatus.subarray(2)
        const s = unpackStatus(data)

        this.publishProperty('status', APPLIANCE_STATES.map(s.state))
        this.publishProperty('process', PROCESS_STATES.map(s.process))
        this.publishProperty('course', COURSES.map(s.course))

        // The appliance's last tick before Standby/Off/End is always 0:01, never 0:00 - confirmed
        // repeatedly live, including a natural (non-cancelled) completion. Gating this the same way
        // D0211 gates course/options avoids publishing that stale minute once no cycle is active.
        const cycleGone = s.state === 0x00 || s.state === 0x04 || s.state === 0x05 // Off, Standby, End
        this.publishProperty('initial_time', s.initialTimeHour * 60 + s.initialTimeMinute)
        this.publishProperty('remaining_time', cycleGone ? 0 : s.remainingTimeHour * 60 + s.remainingTimeMinute)
        this.publishProperty('delay_start_time', s.delayTimeHour * 60 + s.delayTimeMinute)
        this.publishProperty('door', s.flags1 & FLAG1_DOOR_OPEN ? 'ON' : 'OFF')
        this.publishProperty('remote_start', s.flags2 & FLAG2_REMOTE_START ? 'ON' : 'OFF')
        this.publishProperty('flex_zone', FLEX_ZONE.map(s.options & FLEX_ZONE_MASK))
        this.publishProperty('night_dry', s.flags1 & FLAG1_NIGHT_DRY ? 'ON' : 'OFF')
        this.publishProperty('dry_boost', DRY_BOOST.map(s.flags2 & FLAG2_DRY_BOOST_MASK))

        // The settings, echoed by the appliance in every record. This readback is also what arms the
        // write path: until it has run once, settings writes are refused.
        this.settings = {
            rinseLevel: s.rinseLevel,
            machineCleanReminder: (s.flags1 & FLAG1_MACHINE_CLEAN_REMINDER) !== 0,
            cleanLightReminder: (s.flags1 & FLAG1_CLEAN_LIGHT_REMINDER) !== 0,
            autoSelect: (s.flags1 & FLAG1_AUTO_SELECT) !== 0,
            timeIndicator: (s.flags2 & FLAG2_TIME_INDICATOR) !== 0,
            chimeSound: (s.flags2 & FLAG2_CHIME_SOUND) !== 0,
            endOfCycleTone: (s.flags3 & FLAG3_END_OF_CYCLE_TONE) !== 0,
        }
        this.publishProperty('rinse_level', this.settings.rinseLevel)
        this.publishProperty('machine_clean_reminder', this.settings.machineCleanReminder ? 'ON' : 'OFF')
        this.publishProperty('chime_sound', this.settings.chimeSound ? 'ON' : 'OFF')
        this.publishProperty('clean_light_reminder', this.settings.cleanLightReminder ? 'ON' : 'OFF')
        this.publishProperty('time_indicator', this.settings.timeIndicator ? 'ON' : 'OFF')
        this.publishProperty('auto_select', this.settings.autoSelect ? 'ON' : 'OFF')
        this.publishProperty('end_of_cycle_tone', this.settings.endOfCycleTone ? 'ON' : 'OFF')
    }
}
