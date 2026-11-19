import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { unpackStatus } from './dishwasher_common'
import D0211 from './D0211'

// LG D2201 ThinQ dishwasher (deviceType 204), sold as the XD3A15MB.
//
// The status records are D0211's; this adds the appliance's settings, as they appear on the LG app's
// Settings screen, and the smart course ("downloaded cycle") loader. Each was confirmed on a live
// appliance by using it in the app, with bridge mode capturing the command LG's cloud sends and the
// status change that follows.
//
// There is no per-setting command: the app always sends the whole snapshot,
//   F0 26 <rinse level> <softening level> <flags>
// where flags is 0x01 machine clean reminder, 0x04 chime sound, 0x10 clean indicator light. The
// appliance acknowledges with 32 00 26 00 and then echoes the change in a status record:
//   body[13]  rinse aid dispenser level, 0-4
//   body[14]  softening level, 0-4 (dishwasher_common calls it saltLevel). Any level above 0 also
//             raises the salt refill bit in flags1, which D0211 already publishes.
//   flags1    0x10 chime sound, 0x20 machine clean reminder, 0x40 clean indicator light
// The bit positions in the command and in the readback differ, so the two sets of constants stay apart.
const FLAG1_CHIME_SOUND = 0x10
const FLAG1_MACHINE_CLEAN_REMINDER = 0x20
const FLAG1_CLEAN_INDICATOR_LIGHT = 0x40

const SETTING_MACHINE_CLEAN_REMINDER = 0x01
const SETTING_CHIME_SOUND = 0x04
const SETTING_CLEAN_INDICATOR_LIGHT = 0x10

const MAX_LEVEL = 4

// Smart courses are presets the app loads into the appliance, which then offers them as its Downloaded
// cycle. The command is
//   F0 25 03 06 <base course> <smart course> 00 00 00 <options>
// (03 06 being the data type and length, per the modelJson's COURSEDATA / 6). The appliance acknowledges
// with 32 00 25 00 and echoes the load in a status record: body[5] becomes the base course, body[6] 1,
// and the smart course number appears in body[20] and body[23]. Byte 20 only holds it while the
// downloaded cycle is the course selected at the panel; byte 23 keeps the stored preset otherwise, and is
// what the app shows as the current download cycle. The base course and options of each preset are the
// ones the modelJson lists, and all four commands were captured from the app. Loading one only stores
// it: the cycle still has to be selected and started at the panel.
const SMART_COURSES = Enum.of({
    'Pots & Pans': 1,
    Casseroles: 2,
    Glassware: 3,
    'Night Care': 4,
})

const STORED_SMART_COURSE_OFFSET = 23

const SMART_COURSE_AUTO_DOOR = 0x01
const SMART_COURSE_EXTRA_DRY = 0x04

const SMART_COURSE_PRESETS: Record<number, { baseCourse: number; options: number }> = {
    1: { baseCourse: 0x02, options: SMART_COURSE_AUTO_DOOR | SMART_COURSE_EXTRA_DRY },
    2: { baseCourse: 0x02, options: SMART_COURSE_AUTO_DOOR },
    3: { baseCourse: 0x03, options: SMART_COURSE_AUTO_DOOR },
    4: { baseCourse: 0x03, options: SMART_COURSE_AUTO_DOOR | SMART_COURSE_EXTRA_DRY },
}

// MQTT property name -> settings-cache key, for the on/off settings.
const SETTING_SWITCH_KEYS = {
    chime_sound: 'chimeSound',
    machine_clean_reminder: 'machineCleanReminder',
    clean_indicator_light: 'cleanIndicatorLight',
} as const

const SETTING_LEVEL_KEYS = {
    rinse_level: 'rinseLevel',
    softening_level: 'softeningLevel',
} as const

export default class Device extends D0211 {
    // The latest settings read back from the appliance; undefined until the first status record.
    settings?: {
        rinseLevel: number
        softeningLevel: number
        chimeSound: boolean
        machineCleanReminder: boolean
        cleanIndicatorLight: boolean
    }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta)

        // Deliberately not `optimistic`: the appliance ignores commands while it is asleep, or when they come
        // in quick succession, so HA should show what it reports rather than what was asked for.
        const config = this.config!
        this.setConfig(
            allowExtendedType({
                ...config,
                components: {
                    ...config.components,
                    rinse_level: {
                        platform: 'number',
                        icon: 'mdi:water-plus',
                        entity_category: 'config',
                        unique_id: '$deviceid-rinse_level',
                        state_topic: '$this/rinse_level',
                        command_topic: '$this/rinse_level/set',
                        name: 'Rinse aid dispenser level',
                        min: 0,
                        max: MAX_LEVEL,
                        step: 1,
                    },
                    softening_level: {
                        platform: 'number',
                        icon: 'mdi:water-opacity',
                        entity_category: 'config',
                        unique_id: '$deviceid-softening_level',
                        state_topic: '$this/softening_level',
                        command_topic: '$this/softening_level/set',
                        name: 'Softening level',
                        min: 0,
                        max: MAX_LEVEL,
                        step: 1,
                    },
                    chime_sound: {
                        platform: 'switch',
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                        unique_id: '$deviceid-chime_sound',
                        state_topic: '$this/chime_sound',
                        command_topic: '$this/chime_sound/set',
                        name: 'Chime sound',
                    },
                    machine_clean_reminder: {
                        platform: 'switch',
                        icon: 'mdi:bell-outline',
                        entity_category: 'config',
                        unique_id: '$deviceid-machine_clean_reminder',
                        state_topic: '$this/machine_clean_reminder',
                        command_topic: '$this/machine_clean_reminder/set',
                        name: 'Machine clean reminder',
                    },
                    clean_indicator_light: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb',
                        entity_category: 'config',
                        unique_id: '$deviceid-clean_indicator_light',
                        state_topic: '$this/clean_indicator_light',
                        command_topic: '$this/clean_indicator_light/set',
                        name: 'Clean indicator light',
                    },
                    downloaded_cycle: {
                        platform: 'select',
                        icon: 'mdi:download-circle-outline',
                        unique_id: '$deviceid-downloaded_cycle',
                        state_topic: '$this/downloaded_cycle',
                        command_topic: '$this/downloaded_cycle/set',
                        name: 'Downloaded cycle',
                        options: SMART_COURSES.options,
                    },
                },
            }),
        )
    }

    processStatus(curStatus: Buffer) {
        if (!super.processStatus(curStatus)) return false

        const s = unpackStatus(curStatus.subarray(2))

        // This readback also arms the write path: until it has run once, settings writes are refused.
        this.settings = {
            rinseLevel: s.rinseLevel,
            softeningLevel: s.saltLevel,
            chimeSound: (s.flags1 & FLAG1_CHIME_SOUND) !== 0,
            machineCleanReminder: (s.flags1 & FLAG1_MACHINE_CLEAN_REMINDER) !== 0,
            cleanIndicatorLight: (s.flags1 & FLAG1_CLEAN_INDICATOR_LIGHT) !== 0,
        }
        this.publishProperty('rinse_level', this.settings.rinseLevel)
        this.publishProperty('softening_level', this.settings.softeningLevel)
        this.publishProperty('chime_sound', this.settings.chimeSound ? 'ON' : 'OFF')
        this.publishProperty('machine_clean_reminder', this.settings.machineCleanReminder ? 'ON' : 'OFF')
        this.publishProperty('clean_indicator_light', this.settings.cleanIndicatorLight ? 'ON' : 'OFF')
        this.publishProperty('downloaded_cycle', SMART_COURSES.map(curStatus[2 + STORED_SMART_COURSE_OFFSET]))
        return true
    }

    sendSettings() {
        if (!this.settings) return
        const s = this.settings
        let flags = 0
        if (s.machineCleanReminder) flags |= SETTING_MACHINE_CLEAN_REMINDER
        if (s.chimeSound) flags |= SETTING_CHIME_SOUND
        if (s.cleanIndicatorLight) flags |= SETTING_CLEAN_INDICATOR_LIGHT
        this.send(Buffer.from([0xf0, 0x26, s.rinseLevel, s.softeningLevel, flags]))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'downloaded_cycle') {
            const code = SMART_COURSES.unmap(mqttValue)
            if (code === undefined) return
            const { baseCourse, options } = SMART_COURSE_PRESETS[code]
            this.send(Buffer.from([0xf0, 0x25, 0x03, 0x06, baseCourse, code, 0x00, 0x00, 0x00, options]))
        } else if (prop in SETTING_LEVEL_KEYS || prop in SETTING_SWITCH_KEYS) {
            // A settings write is a full snapshot, so the current values must be known first - a
            // snapshot built from defaults would silently overwrite the appliance's other settings.
            if (!this.settings) {
                this.log('refusing settings write: no status record received yet')
                return
            }

            if (prop in SETTING_LEVEL_KEYS) {
                const level = parseInt(mqttValue, 10)
                if (isNaN(level) || level < 0 || level > MAX_LEVEL) return
                this.settings[SETTING_LEVEL_KEYS[prop as keyof typeof SETTING_LEVEL_KEYS]] = level
            } else {
                this.settings[SETTING_SWITCH_KEYS[prop as keyof typeof SETTING_SWITCH_KEYS]] = mqttValue === 'ON'
            }
            this.sendSettings()
        } else {
            console.warn(`D2201: unsupported property ${prop} (value ${mqttValue})`)
        }
    }
}
