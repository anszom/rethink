import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { COURSES as COURSE, SMART_COURSES } from './tl_us_washer_courses'
import { SMART_COURSE_PRESETS, smartCoursePreset } from './T17A1EFHU_F_courses'

// LG WT7305CV / WT7305CW top-load washer, matched by ThinQ model ID T17A1EFHU_F. WT7305CV captures
// from a dial/option sweep and a complete Deep Wash cycle on 2026-11-01 confirm the fields below.
// The codes agree with T1789EFH_F (WT7300CW) where observed, but this model uses long AABB envelopes
// containing one 29-byte record (EB snapshot) or two (EC old/current update).
// All offsets below are relative to the complete 29-byte record.
const RECORD_LENGTH = 29
// Tested locally on WT7305CV: the WT7300CW's short status query returns a long EB envelope
// containing one 29-byte snapshot. Request it on connect instead of waiting for a setting change.
const STATUS_REQUEST = 'F0ED1121010000001800'
const PHASE_OFFSET = 2
const PHASE_PAUSED = 0x02
const TIME_HOUR_OFFSET = 3
const TIME_MIN_OFFSET = 4
const COURSE_OFFSET = 7
const SOIL_OFFSET = 9
const SPIN_OFFSET = 10
const TEMP_OFFSET = 11
const RINSE_OFFSET = 12
const DELAY_HOUR_OFFSET = 14
const DELAY_MIN_OFFSET = 15
const FLAGS_OFFSET = 16
const OPTIONS_OFFSET = 17
const REMOTE_START_OFFSET = 18
const DEEP_FILL_MAX_OFFSET = 18
// The Full Load Wash -> Small Load -> Juice & Food Stains download captures confirm both offsets.
// The stored slot remains set when the dial leaves Downloaded; the active Smart Course clears.
const SMART_COURSE_OFFSET = 22
const DOWNLOADED_COURSE_OFFSET = 25

const FLAG_CONTROL_LOCK = 0x01
const FLAG_DOOR_LOCK = 0x04
const FLAG_COLD_WASH = 0x20
const FLAG_TURBO_WASH = 0x40
const OPTION_EXTRA_RINSE = 0x01
const OPTION_DEEP_FILL = 0x02
const OPTION_STAIN_CARE = 0x08
const OPTION_SOAK = 0x20
const REMOTE_START_ON = 0x01
const DEEP_FILL_MAX_ON = 0x08

// WT7300CW's F0 26 command was tested locally on WT7305CV with Heavy Duty selected: the washer
// replied 20 00 26 00 and physically started/resumed with verbs 03/01. The settings travel in this
// command, so HA selections are staged until Start is pressed, as in Y_V8_Y___W.B32QEUK. Untouched
// fields follow the washer, and the appliance enforces its own interlocks.
const CMD_START = [0xf0, 0x26]
const VERB_START = 0x03
const VERB_RESUME = 0x01
const COMMAND_MAX_FILL = 0x08
// Tested during the same local Heavy Duty run; the owner confirmed both pause and power-off.
const CMD_PAUSE = [0xf0, 0x24, 0x04, 0x01, 0x00]
const CMD_POWER_OFF = [0xf0, 0x24, 0x01, 0x01, 0x00]
// Locally verified: F0 25 03 0F writes a 15-byte preset to the Downloaded slot without starting it.
// The data shares the Start layout. LG's Sweat Stains download confirms Soak at data[8], in
// addition to the options bit at data[13]. Smart Course is data[11]; data[14] is zero for a download.
// LG's delayed Start confirms delay hours/minutes at data[9:11]. Full layout:
// course soil spin temp rinse 00 00 00 soak delayH delayM smartCourse flags options verb
const CMD_DOWNLOAD = [0xf0, 0x25, 0x03, 0x0f]

// State, soil, spin and temperature indexes come from this model's LG modelJSON v0.7.
// Captures establish the record offsets and verify the codes used in the local command tests.
const STATUS = Enum.of({
    Off: 0,
    Standby: 1,
    Paused: 2,
    Detecting: 3,
    Soaking: 4,
    Washing: 5,
    Rinsing: 6,
    Spinning: 7,
    End: 8,
    Delayed: 9,
    'Updating firmware': 10,
    'Smart Diagnosis': 11,
})

const SOIL = Enum.of({
    'Not selected': 0,
    Light: 1,
    'Light-Normal': 2,
    Normal: 3,
    'Normal-Heavy': 4,
    Heavy: 5,
})

const SPIN = Enum.of({
    'No Spin': 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Extra High': 4,
})

const TEMP = Enum.of({
    'Not selected': 0,
    'Tap Cold': 1,
    Cold: 2,
    'Semi Warm': 3,
    Warm: 4,
    Hot: 5,
    // The shared enum also defines Extra Hot (6), but no course on this model offers it.
})

const USE_WASHER_SETTING = 'Use washer setting'
const SELECT_SETTINGS = {
    course: { values: COURSE, offset: COURSE_OFFSET },
    soil: { values: SOIL, offset: SOIL_OFFSET },
    spin: { values: SPIN, offset: SPIN_OFFSET },
    temp: { values: TEMP, offset: TEMP_OFFSET },
}
type SelectSetting = keyof typeof SELECT_SETTINGS
type PendingSettings = Partial<
    Record<SelectSetting, number> & {
        turbo_wash: boolean
        cold_wash: boolean
        extra_rinse: boolean
        stain_care: boolean
        deep_fill: boolean
        deep_fill_max: boolean
        soak: boolean
        delay_wash: number
        rinse_count: number
    }
>

function settingOptions(values: Enum<string>) {
    return [USE_WASHER_SETTING, ...values.options.filter((label) => label !== 'Not selected')]
}

// Bytes 5/6 are not the WT7300CW's initial time: they stay at 04 15 throughout a 62-minute
// countdown.
// Control Lock is monitored from labelled panel captures.

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Unacknowledged envelopes repeat with the same sequence number about every 1.6 seconds.
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
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS.options,
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
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        name: 'Start',
                        icon: 'mdi:play',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        icon: 'mdi:pause',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Power off',
                        icon: 'mdi:power',
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
                    smart_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-smart_course',
                        state_topic: '$this/smart_course',
                        name: 'Smart course',
                        icon: 'mdi:download-circle-outline',
                        device_class: 'enum',
                        options: SMART_COURSES.options,
                    },
                    downloaded_course: {
                        platform: 'select',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        command_topic: '$this/downloaded_course/set',
                        name: 'Downloaded course',
                        icon: 'mdi:download',
                        options: Object.keys(SMART_COURSE_PRESETS),
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'Turbo Wash',
                        icon: 'mdi:speedometer',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold Wash',
                        icon: 'mdi:snowflake',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra Rinse',
                        icon: 'mdi:water-sync',
                    },
                    soak: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-soak',
                        state_topic: '$this/soak',
                        name: 'Soak',
                        icon: 'mdi:water-outline',
                    },
                    stain_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-stain_care',
                        state_topic: '$this/stain_care',
                        name: 'Stain Care',
                        icon: 'mdi:liquid-spot',
                    },
                    deep_fill: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-deep_fill',
                        state_topic: '$this/deep_fill',
                        name: 'Deep Fill',
                        icon: 'mdi:water-plus',
                    },
                    deep_fill_max: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-deep_fill_max',
                        state_topic: '$this/deep_fill_max',
                        name: 'Maximum Deep Fill',
                        icon: 'mdi:water-plus',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control Lock',
                        icon: 'mdi:lock-alert',
                        entity_category: 'diagnostic',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin speed',
                        icon: 'mdi:rotate-3d-variant',
                        device_class: 'enum',
                        options: SPIN.options,
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
                    set_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_course',
                        state_topic: '$this/set_course',
                        command_topic: '$this/set_course/set',
                        name: 'Set course',
                        icon: 'mdi:pin-outline',
                        options: settingOptions(COURSE),
                    },
                    set_soil: {
                        platform: 'select',
                        unique_id: '$deviceid-set_soil',
                        state_topic: '$this/set_soil',
                        command_topic: '$this/set_soil/set',
                        name: 'Set soil level',
                        icon: 'mdi:liquid-spot',
                        options: settingOptions(SOIL),
                    },
                    set_spin: {
                        platform: 'select',
                        unique_id: '$deviceid-set_spin',
                        state_topic: '$this/set_spin',
                        command_topic: '$this/set_spin/set',
                        name: 'Set spin speed',
                        icon: 'mdi:rotate-3d-variant',
                        options: settingOptions(SPIN),
                    },
                    set_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-set_temp',
                        state_topic: '$this/set_temp',
                        command_topic: '$this/set_temp/set',
                        name: 'Set temperature',
                        icon: 'mdi:thermometer',
                        options: settingOptions(TEMP),
                    },
                    set_turbo_wash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_turbo_wash',
                        state_topic: '$this/set_turbo_wash',
                        command_topic: '$this/set_turbo_wash/set',
                        name: 'Set Turbo Wash',
                        icon: 'mdi:speedometer',
                    },
                    set_cold_wash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_cold_wash',
                        state_topic: '$this/set_cold_wash',
                        command_topic: '$this/set_cold_wash/set',
                        name: 'Set Cold Wash',
                        icon: 'mdi:snowflake',
                    },
                    set_extra_rinse: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_extra_rinse',
                        state_topic: '$this/set_extra_rinse',
                        command_topic: '$this/set_extra_rinse/set',
                        name: 'Set Extra Rinse',
                        icon: 'mdi:water-sync',
                    },
                    set_extra_rinses: {
                        platform: 'number',
                        unique_id: '$deviceid-set_extra_rinses',
                        state_topic: '$this/set_extra_rinses',
                        command_topic: '$this/set_extra_rinses/set',
                        name: 'Set extra rinses',
                        icon: 'mdi:water-sync',
                        min: 0,
                        max: 2,
                        step: 1,
                        mode: 'box',
                    },
                    set_stain_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_stain_care',
                        state_topic: '$this/set_stain_care',
                        command_topic: '$this/set_stain_care/set',
                        name: 'Set Stain Care',
                        icon: 'mdi:liquid-spot',
                    },
                    set_deep_fill: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_deep_fill',
                        state_topic: '$this/set_deep_fill',
                        command_topic: '$this/set_deep_fill/set',
                        name: 'Set Deep Fill',
                        icon: 'mdi:water-plus',
                    },
                    set_soak: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_soak',
                        state_topic: '$this/set_soak',
                        command_topic: '$this/set_soak/set',
                        name: 'Set Soak',
                        icon: 'mdi:water-outline',
                    },
                    set_deep_fill_max: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_deep_fill_max',
                        state_topic: '$this/set_deep_fill_max',
                        command_topic: '$this/set_deep_fill_max/set',
                        name: 'Set Maximum Deep Fill',
                        icon: 'mdi:water-plus',
                    },
                    set_delay_wash: {
                        platform: 'number',
                        unique_id: '$deviceid-set_delay_wash',
                        state_topic: '$this/set_delay_wash',
                        command_topic: '$this/set_delay_wash/set',
                        name: 'Set Delay Wash',
                        icon: 'mdi:timer-sand',
                        unit_of_measurement: 'h',
                        min: 0,
                        max: 19,
                        step: 1,
                        mode: 'box',
                    },
                    reset_settings: {
                        platform: 'button',
                        unique_id: '$deviceid-reset_settings',
                        command_topic: '$this/reset_settings/set',
                        name: 'Reset settings',
                        icon: 'mdi:restore',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    setProperty(prop: string, value: string) {
        if (prop === 'downloaded_course') {
            this.downloadCourse(value)
            return
        }

        if (prop === 'reset_settings') {
            this.resetSettings()
            return
        }

        const setting = prop.slice(4) as SelectSetting
        if (prop.startsWith('set_') && Object.prototype.hasOwnProperty.call(SELECT_SETTINGS, setting)) {
            if (value === USE_WASHER_SETTING) delete this.pending[setting]
            else {
                const code = SELECT_SETTINGS[setting].values.unmap(value)
                if (code === undefined || value === 'Not selected') return
                this.pending[setting] = code
            }
            this.publishSettings()
            return
        }

        if (prop === 'set_delay_wash') {
            const hours = Number(value)
            if (value.trim() === '' || !Number.isInteger(hours) || hours < 0 || hours > 19) return
            this.pending.delay_wash = hours
            this.publishSettings()
            return
        }

        if (prop === 'set_extra_rinses') {
            const count = Number(value)
            if (value.trim() === '' || !Number.isInteger(count) || count < 0 || count > 2) return
            this.pending.rinse_count = count
            delete this.pending.extra_rinse
            this.publishSettings()
            return
        }

        if (
            prop === 'set_turbo_wash' ||
            prop === 'set_cold_wash' ||
            prop === 'set_extra_rinse' ||
            prop === 'set_stain_care' ||
            prop === 'set_deep_fill' ||
            prop === 'set_deep_fill_max' ||
            prop === 'set_soak'
        ) {
            if (value !== 'ON' && value !== 'OFF') return
            if (prop === 'set_cold_wash' && value === 'ON') {
                // Match the panel selection and LG's captured Start: Cold, with Turbo Wash off.
                this.pending.temp = TEMP.unmap('Cold')
                this.pending.turbo_wash = false
            }
            if (prop === 'set_extra_rinse' && (value === 'OFF' || this.pending.rinse_count === 0)) {
                delete this.pending.rinse_count
            }
            this.pending[
                prop.slice(4) as
                    | 'turbo_wash'
                    | 'cold_wash'
                    | 'extra_rinse'
                    | 'stain_care'
                    | 'deep_fill'
                    | 'deep_fill_max'
                    | 'soak'
            ] = value === 'ON'
            this.publishSettings()
            return
        }

        if (prop === 'pause') {
            this.send(Buffer.from(CMD_PAUSE))
            return
        }

        if (prop === 'power_off') {
            this.send(Buffer.from(CMD_POWER_OFF))
            this.resetSettings()
            return
        }

        const rec = this.lastRecord
        if (prop !== 'start' || !rec) return

        // Apply each option to the latest record rather than caching the whole bitfield when the
        // switch is changed. Other bits can change independently while a selection is pending.
        let flags = rec[FLAGS_OFFSET] & ~FLAG_DOOR_LOCK
        if (this.pending.turbo_wash !== undefined) {
            flags = this.pending.turbo_wash ? flags | FLAG_TURBO_WASH : flags & ~FLAG_TURBO_WASH
        }
        if (this.pending.cold_wash !== undefined) {
            flags = this.pending.cold_wash ? flags | FLAG_COLD_WASH : flags & ~FLAG_COLD_WASH
        }
        // Soak needs its own data byte as well as the options bit; sending the bit alone clears it.
        const soak = this.pending.soak ?? !!(rec[OPTIONS_OFFSET] & OPTION_SOAK)
        let options = soak ? rec[OPTIONS_OFFSET] | OPTION_SOAK : rec[OPTIONS_OFFSET] & ~OPTION_SOAK
        if (this.pending.stain_care !== undefined) {
            options = this.pending.stain_care ? options | OPTION_STAIN_CARE : options & ~OPTION_STAIN_CARE
        }
        if (this.pending.deep_fill !== undefined) {
            options = this.pending.deep_fill ? options | OPTION_DEEP_FILL : options & ~OPTION_DEEP_FILL
        }
        const { count: rinse, extra: extraRinse } = this.rinseSettings(rec)
        options = extraRinse ? options | OPTION_EXTRA_RINSE : options & ~OPTION_EXTRA_RINSE
        const maxFill = this.pending.deep_fill_max ?? !!(rec[DEEP_FILL_MAX_OFFSET] & DEEP_FILL_MAX_ON)

        this.send(
            Buffer.from([
                ...CMD_START,
                this.pending.course ?? rec[COURSE_OFFSET],
                this.pending.soil ?? rec[SOIL_OFFSET],
                this.pending.spin ?? rec[SPIN_OFFSET],
                this.pending.temp ?? rec[TEMP_OFFSET],
                rinse!, // A complete status record is required above, so the setting is known.
                0,
                0,
                0,
                soak ? 1 : 0,
                this.pending.delay_wash ?? rec[DELAY_HOUR_OFFSET],
                this.pending.delay_wash === undefined ? rec[DELAY_MIN_OFFSET] : 0,
                this.pending.course === undefined ? rec[SMART_COURSE_OFFSET] : 0,
                flags,
                options,
                (rec[PHASE_OFFSET] === PHASE_PAUSED ? VERB_RESUME : VERB_START) | (maxFill ? COMMAND_MAX_FILL : 0),
            ]),
        )
        this.resetSettings()
    }

    private downloadCourse(name: string) {
        const preset = smartCoursePreset(name)
        const smartCourse = SMART_COURSES.unmap(name)
        if (!preset || smartCourse === undefined) return

        const [course, soil, spin, temp, rinse, turboWash, extraRinse, soak, stainCare] = preset
        const flags = turboWash ? FLAG_TURBO_WASH : 0
        const options =
            (extraRinse ? OPTION_EXTRA_RINSE : 0) | (soak ? OPTION_SOAK : 0) | (stainCare ? OPTION_STAIN_CARE : 0)
        this.send(
            Buffer.from([
                ...CMD_DOWNLOAD,
                course,
                soil,
                spin,
                temp,
                rinse,
                0,
                0,
                0,
                soak ? 1 : 0,
                0,
                0,
                smartCourse,
                flags,
                options,
                0,
            ]),
        )
        // Report only the appliance's confirmed slot. An ACK alone does not prove it changed.
        // A newly downloaded preset also replaces staged choices intended for the previous course.
        this.resetSettings()
    }

    processAABB(buf: Buffer) {
        // E2 settings echoes can replay the cycle's starting state after End. Only EB/EC are status.
        this.processEnvelopedStatus(buf, 0x20, RECORD_LENGTH, this.processStatus)
    }

    private lastRecord?: Buffer
    private pending: PendingSettings = {}

    private resetSettings() {
        this.pending = {}
        this.publishSettings()
    }

    private rinseSettings(rec?: Buffer) {
        // Status stores command rinse indexes shifted left one bit: local downloads of 1 and 2
        // reported 2 and 4. Keep the base course's rinse field even when Extra Rinse is off.
        let count = rec ? rec[RINSE_OFFSET] >> 1 : undefined
        let extra = rec ? !!(rec[OPTIONS_OFFSET] & OPTION_EXTRA_RINSE) : undefined
        if (this.pending.rinse_count !== undefined) {
            count = this.pending.rinse_count
            extra = count > 0
        } else if (this.pending.extra_rinse !== undefined) {
            if (this.pending.extra_rinse !== extra) count = this.pending.extra_rinse ? 1 : 0
            extra = this.pending.extra_rinse
        }
        return { count, extra }
    }

    private publishSettings() {
        const rec = this.lastRecord
        for (const [name, { values, offset }] of Object.entries(SELECT_SETTINGS)) {
            const code = this.pending[name as SelectSetting] ?? rec?.[offset]
            const label = code === undefined ? undefined : values.map(code)
            this.publishProperty(`set_${name}`, label && label !== 'Not selected' ? label : USE_WASHER_SETTING)
        }
        const turboWash = this.pending.turbo_wash ?? (rec ? !!(rec[FLAGS_OFFSET] & FLAG_TURBO_WASH) : undefined)
        const coldWash = this.pending.cold_wash ?? (rec ? !!(rec[FLAGS_OFFSET] & FLAG_COLD_WASH) : undefined)
        const { count: rinse, extra: extraRinse } = this.rinseSettings(rec)
        const stainCare = this.pending.stain_care ?? (rec ? !!(rec[OPTIONS_OFFSET] & OPTION_STAIN_CARE) : undefined)
        const deepFill = this.pending.deep_fill ?? (rec ? !!(rec[OPTIONS_OFFSET] & OPTION_DEEP_FILL) : undefined)
        const maxFill =
            this.pending.deep_fill_max ?? (rec ? !!(rec[DEEP_FILL_MAX_OFFSET] & DEEP_FILL_MAX_ON) : undefined)
        const soak = this.pending.soak ?? (rec ? !!(rec[OPTIONS_OFFSET] & OPTION_SOAK) : undefined)
        this.publishProperty('set_turbo_wash', turboWash === undefined ? undefined : turboWash ? 'ON' : 'OFF')
        this.publishProperty('set_cold_wash', coldWash === undefined ? undefined : coldWash ? 'ON' : 'OFF')
        this.publishProperty('set_extra_rinse', extraRinse === undefined ? undefined : extraRinse ? 'ON' : 'OFF')
        this.publishProperty('set_extra_rinses', extraRinse === undefined ? undefined : extraRinse ? rinse : 0)
        this.publishProperty('set_stain_care', stainCare === undefined ? undefined : stainCare ? 'ON' : 'OFF')
        this.publishProperty('set_deep_fill', deepFill === undefined ? undefined : deepFill ? 'ON' : 'OFF')
        this.publishProperty('set_deep_fill_max', maxFill === undefined ? undefined : maxFill ? 'ON' : 'OFF')
        this.publishProperty('set_soak', soak === undefined ? undefined : soak ? 'ON' : 'OFF')
        this.publishProperty('set_delay_wash', this.pending.delay_wash ?? rec?.[DELAY_HOUR_OFFSET])
    }

    private processStatus(rec: Buffer) {
        this.lastRecord = rec
        this.publishProperty('power', rec[PHASE_OFFSET] === 0 ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(rec[PHASE_OFFSET]))
        this.publishProperty('remaining_time', rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('smart_course', SMART_COURSES.map(rec[SMART_COURSE_OFFSET]))
        const downloadedCourse = SMART_COURSES.map(rec[DOWNLOADED_COURSE_OFFSET])
        this.publishProperty('downloaded_course', downloadedCourse === 'Not selected' ? undefined : downloadedCourse)
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('turbo_wash', rec[FLAGS_OFFSET] & FLAG_TURBO_WASH ? 'ON' : 'OFF')
        this.publishProperty('cold_wash', rec[FLAGS_OFFSET] & FLAG_COLD_WASH ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse', rec[OPTIONS_OFFSET] & OPTION_EXTRA_RINSE ? 'ON' : 'OFF')
        // Isolated by the panel's Soak button: options 01 -> 21, with record byte 26 also 0 -> 1.
        this.publishProperty('soak', rec[OPTIONS_OFFSET] & OPTION_SOAK ? 'ON' : 'OFF')
        this.publishProperty('stain_care', rec[OPTIONS_OFFSET] & OPTION_STAIN_CARE ? 'ON' : 'OFF')
        this.publishProperty('deep_fill', rec[OPTIONS_OFFSET] & OPTION_DEEP_FILL ? 'ON' : 'OFF')
        this.publishProperty('deep_fill_max', rec[DEEP_FILL_MAX_OFFSET] & DEEP_FILL_MAX_ON ? 'ON' : 'OFF')
        this.publishProperty('child_lock', rec[FLAGS_OFFSET] & FLAG_CONTROL_LOCK ? 'ON' : 'OFF')
        this.publishProperty('reserve_time', rec[DELAY_HOUR_OFFSET] * 60 + rec[DELAY_MIN_OFFSET])
        // HA's lock binary sensor uses ON for unlocked. Remote Start and the lid lock change separately.
        this.publishProperty('door_lock', rec[FLAGS_OFFSET] & FLAG_DOOR_LOCK ? 'OFF' : 'ON')
        this.publishProperty('remote_start', rec[REMOTE_START_OFFSET] & REMOTE_START_ON ? 'ON' : 'OFF')
        this.publishSettings()
    }
}
