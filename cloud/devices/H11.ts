import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'

// LG H11 dishwasher (modelId "H11"). AABBDevice removes AA/length and checksum/BB
// before passing the inner body to processAABB. Incoming bodies begin with 0x32:
//   0xEC  status change (94 bytes): previous and current 46-byte records; read the second.
//   0xEB  status snapshot (48 bytes): one 46-byte record.
//   0x3E  energy statistics: delta Wh, accumulated Wh, and a sequence byte.
// Outgoing bodies begin with F0 26: power/cycle controls, settings, or remote start.
// State 0x00 is a transient value seen before both 0x01 and 0x04. It is not
// currently treated as standby because its power meaning is unconfirmed.
// A complete captured cycle ended with state/process 0x05/0x05 (app END), then
// state/process 0x04/0x00 (app STANDBY), confirming 0x04 as standby.
// A delayed cycle transitions from STANDBY to READY, then RUNNING/RESERVED.
// Cancellation enters RUNNING/CANCEL with one minute remaining. A second cancel
// command stops that operation and returns to READY/IDLE; otherwise it completes
// after about one minute and also returns to READY/IDLE.

const DISHWASHER_STATES = Enum.of({
    Ready: 1,
    Running: 2,
    Pause: 3,
    Standby: 4,
    End: 5,
})
type DishwasherState = (typeof DISHWASHER_STATES.options)[number]

const DISHWASHER_PROCESSES = Enum.of({
    Idle: 0x00,
    Reserved: 0x01,
    Washing: 0x02,
    Rinsing: 0x03,
    Drying: 0x04,
    End: 0x05,
    Cancel: 0x63,
})
type DishwasherProcess = (typeof DISHWASHER_PROCESSES.options)[number]

// While the appliance is Running, the phase is the more informative thing to report as the status.
const RUNNING_PROCESSES: readonly DishwasherProcess[] = ['Reserved', 'Washing', 'Rinsing', 'Drying', 'Cancel']
const STATUS_OPTIONS = Array.from(new Set<string>([...DISHWASHER_STATES.options, ...RUNNING_PROCESSES]))

function dishwasherStatus(state: DishwasherState | undefined, process: DishwasherProcess | undefined) {
    if (state === 'Running' && process !== undefined && RUNNING_PROCESSES.includes(process)) return process
    return state
}

const COURSES = Enum.of({
    Off: 0x00,
    Auto: 0x01,
    'One hour': 0x12,
    'Normal/Eco': 0x05,
    'Heavy/Intensive': 0x02,
    'Silent night': 0x10,
    Express: 0x08,
    'Download cycle': 0x0b,
    'Machine clean': 0x09,
})
const COURSE_OFF = 'Off'

const DOWNLOAD_COURSES = Enum.of({
    'Pots and pans': 0x02,
    'Glassware and wine glasses': 0x03,
    'Grilled meat': 0x04,
    'Greasy tableware': 0x05,
    'Dishes with baked-on food': 0x06,
    'Fish dishes': 0x07,
    Delicate: 0x08,
    'Rinse only': 0x0a,
    'Machine clean': 0x0d,
    'Plastic wash': 0x0f,
})

// The tables below hold each setting's value as a small ordinal, because the appliance reports a
// setting in one bit position and accepts it back in another. The ordinal is what gets cached, and
// each direction shifts it into place: see processStatus for the status bits and sendSettings for
// the command bits.
const BUZZER_LEVELS = Enum.of({
    Off: 0,
    Low: 1,
    High: 2,
})

const REMOTE_START_MODES = Enum.of({
    Off: 3,
    Permanent: 2,
    'One-time': 1,
})

const SWITCH = Enum.of({
    OFF: 0,
    ON: 1,
})

const BRIGHTNESS = Enum.of({
    LOW: 0,
    HIGH: 1,
})

function parseIntegerInRange(value: string, min: number, max: number) {
    if (value.trim() === '') return undefined

    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined
}

// Captured 0xEC frames contain two 46-byte records; 0xEB snapshots contain one.
// Each record contains a flag byte, a 0x18 length byte, 24 status bytes, and 20 trailing bytes.
// This decoder uses only the 24-byte status payload.
const STATUS_RECORD_LENGTH = 46
const STATUS_CHANGE_LENGTH = 2 + STATUS_RECORD_LENGTH * 2
const STATUS_SNAPSHOT_LENGTH = 2 + STATUS_RECORD_LENGTH

function isStatusRecord(record: Buffer) {
    return record.length === STATUS_RECORD_LENGTH && (record[0] === 0x00 || record[0] === 0x08) && record[1] === 0x18
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    // Staged remote-start options.
    private targetCourse: number = 0x01
    private targetDelay: number = 0
    private targetExtraRinse: number = 0
    private targetHighTemp: number = 0
    private targetExtraDry: number = 0

    private cachedRinseLevel?: number
    private cachedSaltLevel?: number
    private cachedBuzzerLevel?: number
    private cachedEndAlarmSound?: number
    private cachedCleanReminder?: number
    private cachedAutoDry?: number
    private cachedBrightness?: number
    private cachedRemoteStartMode?: number

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Dishwasher' })

        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    // ── Status Sensors (read-only, sourced from 32ec status packet) ──────────

                    // Wakes the device up (ON → f0 26 16) or powers it off (OFF → f0 26 12).
                    // HA reports this switch as OFF only in STANDBY. READY and the
                    // RUNNING/CANCEL drain both leave the appliance powered on.
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    // Current operating state, refined by data[1] while data[0] is RUNNING.
                    // data[0]: 01=READY (app INITIAL), 02=RUNNING, 03=PAUSE,
                    //          04=STANDBY, 05=END.
                    // data[1] during RUNNING: 01=RESERVED, 02=WASHING, 03=RINSING,
                    //                         04=DRYING, 63=CANCEL.
                    status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:state-machine',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        options: STATUS_OPTIONS,
                    },
                    // Current cycle phase, separate from the overall state in data[0].
                    // data[1]: 00=NONE, 01=RESERVED, 02=WASHING, 03=RINSING,
                    //          04=DRYING, 05=END, 63=CANCEL.
                    // 0x63 is confirmed while draining after cancellation; no separate
                    // drain process code is reported.
                    process: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:progress-clock',
                        unique_id: '$deviceid-process',
                        state_topic: '$this/process',
                        name: 'Process',
                        options: DISHWASHER_PROCESSES.options,
                    },
                    // Active wash course name.
                    // If a download course is running, data[20] (download course ID) takes
                    // priority over the base course code in data[5].
                    course: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:pin-outline',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        options: Array.from(new Set<string>([...COURSES.options, ...DOWNLOAD_COURSES.options])),
                    },
                    // Remaining time until the current course finishes.
                    // Computed as data[7] (hour) * 60 + data[8] (minute).
                    remaining_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer-sand',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    // Total (initial) course duration set when the cycle started.
                    // Computed as data[3] (hour) * 60 + data[4] (minute).
                    initial_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial cycle duration',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    // Door open/close state.
                    // data[11] bit 0x02: 1=OPEN, 0=CLOSE
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        payload_on: 'OPEN',
                        payload_off: 'CLOSE',
                    },
                    // Accumulated energy consumption for the current wash cycle.
                    // Sourced from the separate 32 3e statistics packet (not the 32 ec status packet).
                    // buf[4~5] (big-endian uint16) = total Wh for this cycle and may reset
                    // when a new cycle begins.
                    energy: {
                        platform: 'sensor',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Cycle energy consumption',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:lightning-bolt',
                    },
                    // Whether the option represented by data[12] bit 0x04 is active.
                    extra_dry: {
                        platform: 'binary_sensor',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-extra_dry',
                        state_topic: '$this/extra_dry',
                        name: 'High heat drying active',
                    },
                    // Whether the option represented by data[12] bit 0x08 is active.
                    high_temp: {
                        platform: 'binary_sensor',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-high_temp',
                        state_topic: '$this/high_temp',
                        name: 'Sanitizing wash active',
                    },
                    // Current extra rinse count reported by the device, 0–3.
                    // data[21] high nibble. Read-back counterpart of target_extra_rinse.
                    extra_rinse: {
                        platform: 'sensor',
                        icon: 'mdi:water-plus',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse count',
                    },

                    // ── Settings (bidirectional, sent via f0 26 Settings Set command) ─────────

                    // Rinse aid dispensing level. Range 0–4.
                    // Sent as [RinseAid] in: f0 26 [RinseAid] [Salt] [Opt1] [Opt2] [Opt3] ...
                    // Read back from data[13].
                    rinse_level: {
                        platform: 'number',
                        icon: 'mdi:water-plus',
                        unique_id: '$deviceid-rinse_level',
                        state_topic: '$this/rinse_level',
                        command_topic: '$this/rinse_level/set',
                        name: 'Rinse aid level',
                        min: 0,
                        max: 4,
                        step: 1,
                    },
                    // Water softener salt dispensing level. Range 0–4.
                    // Sent as [Salt] byte in the Settings Set command.
                    // Read back from data[14].
                    salt_level: {
                        platform: 'number',
                        icon: 'mdi:shaker',
                        unique_id: '$deviceid-salt_level',
                        state_topic: '$this/salt_level',
                        command_topic: '$this/salt_level/set',
                        name: 'Salt dispensing level',
                        min: 0,
                        max: 4,
                        step: 1,
                    },
                    // Appliance alert beep volume during operation.
                    // Opt1 bit 0x04=HIGH, bit 0x02=LOW, both off=OFF.
                    // Read back from data[15] bits 0x80 (HIGH) / 0x40 (LOW).
                    buzzer_level: {
                        platform: 'select',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-buzzer_level',
                        state_topic: '$this/buzzer_level',
                        command_topic: '$this/buzzer_level/set',
                        name: 'Buzzer volume',
                        options: BUZZER_LEVELS.options,
                    },
                    // Plays a completion melody when the wash cycle finishes.
                    // Opt1 bit 0x40. Read back from data[16] bit 0x04.
                    end_alarm_sound: {
                        platform: 'switch',
                        icon: 'mdi:music-note',
                        unique_id: '$deviceid-end_alarm_sound',
                        state_topic: '$this/end_alarm_sound',
                        command_topic: '$this/end_alarm_sound/set',
                        name: 'End alarm sound',
                    },
                    // Machine clean reminder setting.
                    // Opt1 bit 0x08. Read back from data[11] bit 0x40.
                    clean_reminder: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb',
                        unique_id: '$deviceid-clean_reminder',
                        state_topic: '$this/clean_reminder',
                        command_topic: '$this/clean_reminder/set',
                        name: 'Machine clean reminder',
                    },
                    // Automatic drying setting.
                    // Opt1 bit 0x20. Read back from data[11] bit 0x10.
                    auto_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-auto_dry',
                        state_topic: '$this/auto_dry',
                        command_topic: '$this/auto_dry/set',
                        name: 'Auto dry',
                    },
                    // Brightness of the time display panel on the appliance.
                    // ON=HIGH, OFF=LOW. Opt3 bit 0x40. Read back from data[19] bit 0x40.
                    brightness: {
                        platform: 'switch',
                        icon: 'mdi:brightness-6',
                        unique_id: '$deviceid-brightness',
                        state_topic: '$this/brightness',
                        command_topic: '$this/brightness/set',
                        name: 'Time indicator brightness',
                        payload_on: 'HIGH',
                        payload_off: 'LOW',
                    },
                    // Controls whether the appliance accepts remote start commands.
                    // PERMANENT: always enabled, ONE_TIME: enabled for one cycle only, OFF: disabled.
                    // Opt2 bits 0x80=PERMANENT, 0x40=ONE_TIME, 0xc0=OFF.
                    // Read back from data[16] bits 0xc0.
                    remote_start_mode: {
                        platform: 'select',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start_mode',
                        state_topic: '$this/remote_start_mode',
                        command_topic: '$this/remote_start_mode/set',
                        name: 'Remote start mode',
                        options: REMOTE_START_MODES.options,
                    },
                    // Remaining delay before the cycle starts.
                    // Computed as data[9] (hour) * 60 + data[10] (minute).
                    delay_start: {
                        platform: 'sensor',
                        icon: 'mdi:clock-fast',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay start remaining',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    // Whether the physical Remote Start button on the appliance is currently active.
                    // The user must press this button before a remote start command can be accepted.
                    // data[15] bit 0x02.
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start enabled',
                    },

                    // ── Control Buttons (write-only, f0 26 commands) ──────────────────────────

                    // Pauses the running wash cycle. Sends: f0 26 13
                    pause: {
                        platform: 'button',
                        icon: 'mdi:pause',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        payload_press: 'PRESS',
                    },
                    // Resumes a paused wash cycle. Sends: f0 26 14
                    resume: {
                        platform: 'button',
                        icon: 'mdi:play',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        name: 'Resume',
                        payload_press: 'PRESS',
                    },
                    // Cancels the current cycle and starts draining. Sends: f0 26 11.
                    // The appliance reports RUNNING/CANCEL with one minute remaining.
                    // Sending the command again during CANCEL returns it to READY/IDLE.
                    cancel: {
                        platform: 'button',
                        icon: 'mdi:stop',
                        unique_id: '$deviceid-cancel',
                        command_topic: '$this/cancel/set',
                        name: 'Cancel / drain',
                        payload_press: 'PRESS',
                    },

                    // ── Target Controls (pre-select options before Remote Start) ───────────────
                    // These entities stage the parameters for the next remote start command.
                    // All values are assembled into a single f0 26 10 packet by start_course.

                    // Selects the wash course for the next remote start.
                    // Becomes [Course] in: f0 26 10 [Course] [DelayHour] 00 [Opt3] [Opt4] 00
                    // 'Off' is excluded — the device must run a valid course.
                    target_course: {
                        platform: 'select',
                        icon: 'mdi:washing-machine',
                        unique_id: '$deviceid-target_course',
                        state_topic: '$this/target_course',
                        command_topic: '$this/target_course/set',
                        name: 'Target course',
                        options: COURSES.options.filter((course) => course !== COURSE_OFF),
                    },
                    // Sets the delay before the cycle starts. 0 = start immediately.
                    // Range 0–12 hours. Becomes [DelayHour] in the remote start command.
                    target_delay: {
                        platform: 'number',
                        icon: 'mdi:clock-start',
                        unique_id: '$deviceid-target_delay',
                        state_topic: '$this/target_delay',
                        command_topic: '$this/target_delay/set',
                        name: 'Start delay setting',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                        min: 0,
                        max: 12,
                        step: 1,
                    },
                    // Enables target_high_temp for the next cycle.
                    // Sets opt3 bit 0x08 in the remote start command.
                    // Read-back counterpart: high_temp (data[12] bit 0x08).
                    target_high_temp: {
                        platform: 'switch',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-target_high_temp',
                        state_topic: '$this/target_high_temp',
                        command_topic: '$this/target_high_temp/set',
                        name: 'Target sanitizing wash',
                    },
                    // Enables target_extra_dry for the next cycle.
                    // Sets opt3 bit 0x04 in the remote start command.
                    // Read-back counterpart: extra_dry (data[12] bit 0x04).
                    target_extra_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-target_extra_dry',
                        state_topic: '$this/target_extra_dry',
                        command_topic: '$this/target_extra_dry/set',
                        name: 'Target high heat drying',
                    },
                    // Number of additional rinse cycles to perform (0–3).
                    // Sets opt4 bits: 1→0x08, 2→0x10, 3→0x18 in the remote start command.
                    // Also sets opt4 bit 0x40 when course is Download Cycle (0x0b).
                    // Read-back counterpart: extra_rinse (data[21]).
                    target_extra_rinse: {
                        platform: 'number',
                        icon: 'mdi:water-plus',
                        unique_id: '$deviceid-target_extra_rinse',
                        state_topic: '$this/target_extra_rinse',
                        command_topic: '$this/target_extra_rinse/set',
                        name: 'Target extra rinse count',
                        min: 0,
                        max: 3,
                        step: 1,
                    },
                    // Sends the remote start command using all staged target_* values.
                    // Assembles and transmits: f0 26 10 [Course] [DelayHour] 0x00 [Opt3] [Opt4] 0x00
                    start_course: {
                        platform: 'button',
                        icon: 'mdi:play-circle',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        name: 'Start course',
                        payload_press: 'PRESS',
                    },
                },
            }),
        )
    }

    start() {
        super.start()
        this.publishProperty('target_course', 'Auto')
        this.publishProperty('target_delay', 0)
        this.publishProperty('target_high_temp', 'OFF')
        this.publishProperty('target_extra_dry', 'OFF')
        this.publishProperty('target_extra_rinse', 0)
    }

    private rejectValue(prop: string, mqttValue: string) {
        log('H11', 'ignoring invalid value', prop, JSON.stringify(mqttValue))
    }

    private sendSettings() {
        if (
            this.cachedRinseLevel === undefined ||
            this.cachedSaltLevel === undefined ||
            this.cachedBuzzerLevel === undefined ||
            this.cachedEndAlarmSound === undefined ||
            this.cachedCleanReminder === undefined ||
            this.cachedAutoDry === undefined ||
            this.cachedBrightness === undefined ||
            this.cachedRemoteStartMode === undefined
        ) {
            // A settings write carries every setting at once, so we cannot send one until a status
            // frame has told us the current value of all of them.
            log('H11', 'ignoring settings command, cached settings are incomplete')
            return
        }

        // Opt1: end alarm 0x40, auto dry 0x20, clean reminder 0x08, buzzer 0x02/0x04
        const opt1 =
            (this.cachedEndAlarmSound << 6) |
            (this.cachedAutoDry << 5) |
            (this.cachedCleanReminder << 3) |
            (this.cachedBuzzerLevel << 1)

        // Opt2: remote start mode 0x40/0x80/0xc0
        const opt2 = this.cachedRemoteStartMode << 6

        // Opt3: brightness 0x40
        const opt3 = this.cachedBrightness << 6

        this.send(
            Buffer.from([0xf0, 0x26, this.cachedRinseLevel, this.cachedSaltLevel, opt1, opt2, opt3, 0x00, 0x00, 0x00]),
        )
    }

    /**
     * f0 26 Control Packets:
     * - Wake Up: f0 26 16
     * - Power Off: f0 26 12
     * - Pause: f0 26 13
     * - Resume: f0 26 14
     * - Cancel / Drain: f0 26 11
     * - Settings Set: f0 26 [RinseAid] [Salt] [Opt1] [Opt2] [Opt3] [Opt4] [Opt5] [Opt6] [Opt7]
     * - Remote Start: f0 26 10 [Course] [DelayHour] 00 [Opt3] [Opt4] 00
     */
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02616', 'hex')) // Wake Up
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F02612', 'hex')) // Immediate Power Off
            } else this.rejectValue(prop, mqttValue)
        } else if (prop === 'pause') {
            if (mqttValue === 'PRESS')
                this.send(Buffer.from('F02613', 'hex')) // Pause
            else this.rejectValue(prop, mqttValue)
        } else if (prop === 'resume') {
            if (mqttValue === 'PRESS')
                this.send(Buffer.from('F02614', 'hex')) // Resume
            else this.rejectValue(prop, mqttValue)
        } else if (prop === 'cancel') {
            if (mqttValue === 'PRESS')
                this.send(Buffer.from('F02611', 'hex')) // Course cancel / drain
            else this.rejectValue(prop, mqttValue)
        } else if (prop === 'target_course') {
            const code = mqttValue === COURSE_OFF ? undefined : COURSES.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.targetCourse = code
            this.publishProperty('target_course', mqttValue)
        } else if (prop === 'target_delay') {
            const value = parseIntegerInRange(mqttValue, 0, 12)
            if (value === undefined) return this.rejectValue(prop, mqttValue)
            this.targetDelay = value
            this.publishProperty('target_delay', value)
        } else if (prop === 'target_high_temp') {
            const code = SWITCH.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.targetHighTemp = code
            this.publishProperty('target_high_temp', mqttValue)
        } else if (prop === 'target_extra_dry') {
            const code = SWITCH.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.targetExtraDry = code
            this.publishProperty('target_extra_dry', mqttValue)
        } else if (prop === 'target_extra_rinse') {
            const value = parseIntegerInRange(mqttValue, 0, 3)
            if (value === undefined) return this.rejectValue(prop, mqttValue)
            this.targetExtraRinse = value
            this.publishProperty('target_extra_rinse', value)
        } else if (prop === 'rinse_level') {
            const value = parseIntegerInRange(mqttValue, 0, 4)
            if (value === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedRinseLevel = value
            this.sendSettings()
        } else if (prop === 'salt_level') {
            const value = parseIntegerInRange(mqttValue, 0, 4)
            if (value === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedSaltLevel = value
            this.sendSettings()
        } else if (prop === 'buzzer_level') {
            const code = BUZZER_LEVELS.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedBuzzerLevel = code
            this.sendSettings()
        } else if (prop === 'end_alarm_sound') {
            const code = SWITCH.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedEndAlarmSound = code
            this.sendSettings()
        } else if (prop === 'clean_reminder') {
            const code = SWITCH.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedCleanReminder = code
            this.sendSettings()
        } else if (prop === 'auto_dry') {
            const code = SWITCH.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedAutoDry = code
            this.sendSettings()
        } else if (prop === 'brightness') {
            const code = BRIGHTNESS.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedBrightness = code
            this.sendSettings()
        } else if (prop === 'remote_start_mode') {
            const code = REMOTE_START_MODES.unmap(mqttValue)
            if (code === undefined) return this.rejectValue(prop, mqttValue)
            this.cachedRemoteStartMode = code
            this.sendSettings()
        } else if (prop === 'start_course') {
            if (mqttValue !== 'PRESS') return this.rejectValue(prop, mqttValue)

            // f0 26 10 [Course] [DelayHour] 00 [Opt3] [Opt4] 00
            // Opt3: high temp 0x08, extra dry 0x04
            const opt3 = (this.targetHighTemp << 3) | (this.targetExtraDry << 2)

            // Opt4: extra rinse 0x08/0x10/0x18, download cycle 0x40
            let opt4 = this.targetExtraRinse << 3
            if (this.targetCourse === 0x0b) opt4 |= 0x40

            this.send(Buffer.from([0xf0, 0x26, 0x10, this.targetCourse, this.targetDelay, 0x00, opt3, opt4, 0x00]))
        }
    }

    processAABB(buf: Buffer) {
        if (buf[0] === 0x32 && buf[1] === 0xec) {
            if (buf.length !== STATUS_CHANGE_LENGTH) return

            const previous = buf.subarray(2, 2 + STATUS_RECORD_LENGTH)
            const current = buf.subarray(2 + STATUS_RECORD_LENGTH)
            if (isStatusRecord(previous) && isStatusRecord(current)) this.processStatus(current)
        } else if (buf[0] === 0x32 && buf[1] === 0xeb) {
            if (buf.length !== STATUS_SNAPSHOT_LENGTH) return

            const snapshot = buf.subarray(2)
            if (isStatusRecord(snapshot)) this.processStatus(snapshot)
        } else if (buf[0] === 0x32 && buf[1] === 0x3e) {
            this.processStatistics(buf)
        }
    }

    processStatistics(buf: Buffer) {
        if (buf.length !== 7) return

        // 32 3e [Delta Wh 2B] [Accum Wh 2B] [Seq]
        const energyAccum = buf.readUInt16BE(4)
        this.publishProperty('energy', energyAccum)
    }

    /**
     * 0x32EC/0x32EB status payload offsets after the flag and 0x18 length byte:
     * [0] State: 01(READY; app INITIAL), 02(RUNNING), 03(PAUSE), 04(STANDBY), 05(END)
     * [1] Process: 00(IDLE; app NONE), 01(RESERVED), 02(WASHING), 03(RINSING), 04(DRYING), 05(END), 63(CANCEL)
     * [3~4] Initial Time (Hour, Minute)
     * [5] Course Code (0x01: AUTO, etc.)
     * [7~8] Remaining Time (Hour, Minute)
     * [9~10] Delay Start Remaining (Hour, Minute)
     * [11] Door & Opt1: 0x40(Clean Reminder ON), 0x10(Auto Dry ON), 0x02(Door OPEN)
     * [12] Wash Options: 0x04(extra_dry ON), 0x08(high_temp ON)
     * [13] Rinse Aid Level (0x00 ~ 0x04)
     * [14] Salt Level (0x00 ~ 0x04)
     * [15] Buzzer & Remote: 0x80(Buzzer HIGH), 0x40(Buzzer LOW), 0x02(Remote Start Active)
     * [16] Opt2: 0x80(Remote PERMANENT), 0x40(Remote ONE_TIME), 0xc0(Remote OFF), 0x04(End Alarm Sound ON)
     * [19] Opt3: 0x40(Brightness HIGH)
     * [20] Download Course ID
     * [21] Extra Rinse: 00(0), 10(1), 20(2), 30(3)
     */
    processStatus(curStatus: Buffer) {
        if (isStatusRecord(curStatus)) {
            const data = curStatus.subarray(2, 26) // 24 bytes

            const state = DISHWASHER_STATES.map(data[0])
            const process = DISHWASHER_PROCESSES.map(data[1])

            this.publishProperty('status', dishwasherStatus(state, process))
            this.publishProperty('process', process)
            // Ready and Running/Cancel remain powered on; only Standby is off.
            this.publishProperty('power', state === 'Standby' ? 'OFF' : 'ON')

            // Course (Index 5)
            const baseCourseCode = data[5]
            const downloadCourseCode = data[20]

            // If a download course is active, use it instead of the base course.
            const course =
                downloadCourseCode !== 0 ? DOWNLOAD_COURSES.map(downloadCourseCode) : COURSES.map(baseCourseCode)

            this.publishProperty('course', course)

            // Initial course time (Index 3: hour, Index 4: minute)
            const initialHour = data[3]
            const initialMinute = data[4]
            this.publishProperty('initial_time', initialHour * 60 + initialMinute)

            // Remaining time (Index 7: hour, Index 8: minute)
            const remainHour = data[7]
            const remainMinute = data[8]
            this.publishProperty('remaining_time', remainHour * 60 + remainMinute)

            // Delay Start Remaining (Index 9: hour, Index 10: minute)
            const delayHour = data[9]
            const delayMinute = data[10]
            this.publishProperty('delay_start', delayHour * 60 + delayMinute)

            // Door (Index 11 bit 0x02)
            const isDoorOpen = (data[11] & 0x02) !== 0
            this.publishProperty('door', isDoorOpen ? 'OPEN' : 'CLOSE')

            // extra_dry (Index 12 bit 0x04)
            const isExtraDry = (data[12] & 0x04) !== 0
            this.publishProperty('extra_dry', isExtraDry ? 'ON' : 'OFF')

            // high_temp (Index 12 bit 0x08)
            const isHighTemp = (data[12] & 0x08) !== 0
            this.publishProperty('high_temp', isHighTemp ? 'ON' : 'OFF')

            // Remote Start (Index 15 bit 0x02)
            const isRemoteStart = (data[15] & 0x02) !== 0
            this.publishProperty('remote_start', isRemoteStart ? 'ON' : 'OFF')

            // Parse Settings
            // Rinse aid and salt levels (Index 13, 14)
            const rinseLevel = data[13]
            const saltLevel = data[14]
            this.cachedRinseLevel = rinseLevel <= 4 ? rinseLevel : undefined
            this.cachedSaltLevel = saltLevel <= 4 ? saltLevel : undefined
            if (this.cachedRinseLevel !== undefined) this.publishProperty('rinse_level', this.cachedRinseLevel)
            if (this.cachedSaltLevel !== undefined) this.publishProperty('salt_level', this.cachedSaltLevel)

            // Auto Dry & Clean Reminder (Index 11 bits 0x10, 0x40)
            this.cachedAutoDry = (data[11] >> 4) & 1
            this.cachedCleanReminder = (data[11] >> 6) & 1
            this.publishProperty('auto_dry', SWITCH.map(this.cachedAutoDry))
            this.publishProperty('clean_reminder', SWITCH.map(this.cachedCleanReminder))

            // Buzzer Level (Index 15 bits 0xc0). An unlisted code is cached as unknown, so that a
            // later settings command cannot send a level the appliance never reported.
            const buzzerCode = (data[15] & 0xc0) >> 6
            const buzzerLevel = BUZZER_LEVELS.map(buzzerCode)
            this.cachedBuzzerLevel = buzzerLevel === undefined ? undefined : buzzerCode
            this.publishProperty('buzzer_level', buzzerLevel)

            // Remote Start Mode (Index 16 bits 0xc0)
            const remoteStartCode = (data[16] & 0xc0) >> 6
            const remoteStartMode = REMOTE_START_MODES.map(remoteStartCode)
            this.cachedRemoteStartMode = remoteStartMode === undefined ? undefined : remoteStartCode
            this.publishProperty('remote_start_mode', remoteStartMode)

            // End Alarm Sound (Index 16 bit 0x04)
            this.cachedEndAlarmSound = (data[16] >> 2) & 1
            this.publishProperty('end_alarm_sound', SWITCH.map(this.cachedEndAlarmSound))

            // Brightness (Index 19 bit 0x40)
            this.cachedBrightness = (data[19] >> 6) & 1
            this.publishProperty('brightness', BRIGHTNESS.map(this.cachedBrightness))

            // Extra rinse (Index 21, in the high nibble): 0x00=0, 0x10=1, 0x20=2, 0x30=3
            const extraRinse = data[21] >> 4
            this.publishProperty('extra_rinse', extraRinse <= 3 ? extraRinse : undefined)
        }
    }
}
