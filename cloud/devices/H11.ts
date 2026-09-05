import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const DISHWASHER_STATES: Record<number, string> = {
    1: 'Initial',
    2: 'Running',
    3: 'Pause',
    4: 'Standby',
}

const COURSES: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Auto',
    0x12: 'One hour',
    0x05: 'Normal/Eco',
    0x02: 'Heavy/Intensive',
    0x10: 'Silent night',
    0x08: 'Express',
    0x0b: 'Download cycle',
    0x09: 'Machine clean',
}

const SMART_COURSES: Record<number, string> = {
    0x05: 'Greasy tableware',
    0x0d: 'Machine clean',
    0x0f: 'Plastic wash',
}

const RINSE_LEVELS: Record<number, string> = {
    0x00: 'Off',
    0x10: 'Level 1',
    0x20: 'Level 2',
    0x30: 'Level 3',
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    // Cache states to allow partial updates via SET command
    private targetCourse: number = 0x01
    private targetDelay: number = 0
    private targetExtraRinse: number = 0
    private targetHighTemp: boolean = false
    private targetExtraDry: boolean = false

    private cachedRinseLevel: number = 2
    private cachedSaltLevel: number = 2
    private cachedBuzzerLevel: string = 'HIGH'
    private cachedEndAlarmSound: boolean = true
    private cachedCleanReminder: boolean = true
    private cachedAutoDry: boolean = true
    private cachedBrightness: boolean = true
    private cachedRemoteStartMode: string = 'OFF'

    private lastStatSequence: number = -1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Dishwasher' })

        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    // ── Status Sensors (read-only, sourced from 32ec status packet) ──────────

                    // Wakes the device up (ON → f0 26 16) or powers it off (OFF → f0 26 12).
                    // The switch is forced to OFF when the device is in STANDBY (state=4)
                    // or during the drain-after-cancel process (processCode=0x63).
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    // Current operating state of the dishwasher.
                    // data[0]: 01=INITIAL, 02=RUNNING, 03=PAUSE, 04=STANDBY
                    state: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:washing-machine',
                        unique_id: '$deviceid-state',
                        state_topic: '$this/state',
                        name: 'State',
                        options: Array.from(new Set([...Object.values(DISHWASHER_STATES), 'unknown'])),
                    },
                    // Active wash course name.
                    // If a download (smart) course is running, data[20] (smart course ID) takes
                    // priority over the base course code in data[5].
                    course: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:dishwasher',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        options: Array.from(
                            new Set([...Object.values(COURSES), ...Object.values(SMART_COURSES), 'unknown']),
                        ),
                    },
                    // Remaining time until the current course finishes.
                    // Computed as data[7] (hour) * 60 + data[8] (minute).
                    remain_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer-sand',
                        unique_id: '$deviceid-remain_time',
                        state_topic: '$this/remain_time',
                        name: 'Remain Time',
                        unit_of_measurement: 'min',
                    },
                    // Total (initial) course duration set when the cycle started.
                    // Computed as data[3] (hour) * 60 + data[4] (minute).
                    course_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer',
                        unique_id: '$deviceid-course_time',
                        state_topic: '$this/course_time',
                        name: 'Course Time',
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
                    // buf[4~5] (big-endian uint16) = total Wh for this cycle.
                    energy_consumption: {
                        platform: 'sensor',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unique_id: '$deviceid-energy_consumption',
                        state_topic: '$this/energy_consumption',
                        name: 'Energy Consumption',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:flash',
                    },
                    // Whether extra high-heat drying is currently active.
                    // The device applies additional heat after the wash cycle to improve drying.
                    // data[12] bit 0x04
                    extra_dry: {
                        platform: 'binary_sensor',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-extra_dry',
                        state_topic: '$this/extra_dry',
                        name: 'Extra Dry',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Whether high-temperature sanitizing wash is currently active.
                    // Heats the wash water to 70°C+ to kill bacteria.
                    // data[12] bit 0x08
                    high_temp: {
                        platform: 'binary_sensor',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-high_temp',
                        state_topic: '$this/high_temp',
                        name: 'High Temp',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Current extra rinse count reported by the device.
                    // data[21]: 0x00=Off, 0x10=Level 1, 0x20=Level 2, 0x30=Level 3
                    // Read-back counterpart of target_extra_rinse.
                    extra_rinse: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:water-plus',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra Rinse (Current)',
                        options: Object.values(RINSE_LEVELS),
                    },

                    // ── Settings (bidirectional, sent via f0 26 Settings Set command) ─────────

                    // Rinse aid dispensing level. Range 0–4.
                    // Sent as [Rinse] byte in: f0 26 [Rinse] [Salt] [Opt1] [Opt2] [Opt3] ...
                    // Read back from data[13].
                    rinse_level: {
                        platform: 'number',
                        icon: 'mdi:water-plus',
                        unique_id: '$deviceid-rinse_level',
                        state_topic: '$this/rinse_level',
                        command_topic: '$this/rinse_level/set',
                        name: 'Rinse Level',
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
                        name: 'Salt Level',
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
                        name: 'Buzzer Level',
                        options: ['OFF', 'LOW', 'HIGH'],
                    },
                    // Plays a completion melody when the wash cycle finishes.
                    // Opt1 bit 0x40. Read back from data[16] bit 0x04.
                    end_alarm_sound: {
                        platform: 'switch',
                        icon: 'mdi:music-note',
                        unique_id: '$deviceid-end_alarm_sound',
                        state_topic: '$this/end_alarm_sound',
                        command_topic: '$this/end_alarm_sound/set',
                        name: 'End Alarm Sound',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // LED indicator light that reminds the user to clean the filter.
                    // Opt1 bit 0x08. Read back from data[11] bit 0x40.
                    clean_reminder: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb',
                        unique_id: '$deviceid-clean_reminder',
                        state_topic: '$this/clean_reminder',
                        command_topic: '$this/clean_reminder/set',
                        name: 'Clean Reminder Light',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Automatically opens the door slightly after the cycle ends to assist drying.
                    // Opt1 bit 0x20. Read back from data[11] bit 0x10.
                    auto_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-auto_dry',
                        state_topic: '$this/auto_dry',
                        command_topic: '$this/auto_dry/set',
                        name: 'Auto Dry',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Brightness of the time display panel on the appliance.
                    // ON=HIGH, OFF=LOW. Opt3 bit 0x40. Read back from data[19] bit 0x40.
                    brightness: {
                        platform: 'switch',
                        icon: 'mdi:brightness-6',
                        unique_id: '$deviceid-brightness',
                        state_topic: '$this/brightness',
                        command_topic: '$this/brightness/set',
                        name: 'Time Indicator Brightness',
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
                        name: 'Remote Start Mode',
                        options: ['PERMANENT', 'ONE_TIME', 'OFF'],
                    },
                    // Delay start hours as currently set on the device.
                    // 0 means no delay (start immediately). Read back from data[9].
                    delay_start: {
                        platform: 'sensor',
                        icon: 'mdi:clock-fast',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay Start (Hours)',
                        unit_of_measurement: 'h',
                    },
                    // Whether the physical Remote Start button on the appliance is currently active.
                    // The user must press this button before a remote start command can be accepted.
                    // data[15] bit 0x02.
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
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
                    // Cancels the current cycle. Sends: f0 26 11
                    // The device drains residual water (~1 min, RUNNING state with processCode 0x63)
                    // before powering off. Pressing again during drain stops pumping immediately.
                    cancel: {
                        platform: 'button',
                        icon: 'mdi:stop',
                        unique_id: '$deviceid-cancel',
                        command_topic: '$this/cancel/set',
                        name: 'Cancel / Drain Stop',
                        payload_press: 'PRESS',
                    },

                    // ── Target Controls (pre-select options before Remote Start) ───────────────
                    // These entities stage the parameters for the next remote start command.
                    // All values are assembled into a single f0 26 10 packet by start_course.

                    // Selects the wash course for the next remote start.
                    // Becomes the [Course] byte in: f0 26 10 [Course] [DelayHour] [Opt2] [Opt3] [Opt4] [Opt5]
                    // 'Off' is excluded — the device must run a valid course.
                    target_course: {
                        platform: 'select',
                        icon: 'mdi:washing-machine',
                        unique_id: '$deviceid-target_course',
                        state_topic: '$this/target_course',
                        command_topic: '$this/target_course/set',
                        name: 'Target Course',
                        options: Object.values(COURSES).filter((c) => c !== 'Off'),
                    },
                    // Sets the delay before the cycle starts. 0 = start immediately.
                    // Range 0–12 hours. Becomes [DelayHour] in the remote start command.
                    target_delay: {
                        platform: 'number',
                        icon: 'mdi:clock-start',
                        unique_id: '$deviceid-target_delay',
                        state_topic: '$this/target_delay',
                        command_topic: '$this/target_delay/set',
                        name: 'Delay Start Hour',
                        min: 0,
                        max: 12,
                        step: 1,
                    },
                    // Enables sanitizing wash for the next cycle.
                    // Sets opt3 bit 0x08 in the remote start command.
                    // Read-back counterpart: high_temp (data[12] bit 0x08).
                    target_high_temp: {
                        platform: 'switch',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-target_high_temp',
                        state_topic: '$this/target_high_temp',
                        command_topic: '$this/target_high_temp/set',
                        name: 'High Temp',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // Enables extra high-heat drying for the next cycle.
                    // Sets opt3 bit 0x04 in the remote start command.
                    // Read-back counterpart: extra_dry (data[12] bit 0x04).
                    target_extra_dry: {
                        platform: 'switch',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-target_extra_dry',
                        state_topic: '$this/target_extra_dry',
                        command_topic: '$this/target_extra_dry/set',
                        name: 'Extra Dry',
                        payload_on: 'ON',
                        payload_off: 'OFF',
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
                        name: 'Extra Rinse',
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
                        name: 'Start Course',
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

    sendSettings() {
        // Opt1 (End Alarm, Auto Dry, Clean Reminder, Buzzer)
        let opt1 = 0x00
        if (this.cachedEndAlarmSound) opt1 |= 0x40
        if (this.cachedAutoDry) opt1 |= 0x20
        if (this.cachedCleanReminder) opt1 |= 0x08
        if (this.cachedBuzzerLevel === 'HIGH') opt1 |= 0x04
        else if (this.cachedBuzzerLevel === 'LOW') opt1 |= 0x02

        // Opt2 (Remote Start Mode)
        let opt2 = 0x00
        if (this.cachedRemoteStartMode === 'OFF') opt2 = 0xc0
        else if (this.cachedRemoteStartMode === 'PERMANENT') opt2 = 0x80
        else if (this.cachedRemoteStartMode === 'ONE_TIME') opt2 = 0x40

        // Opt3 (Brightness)
        let opt3 = 0x00
        if (this.cachedBrightness) opt3 |= 0x40

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
     * - Cancel / Drain Stop: f0 26 11
     * - Settings Set: f0 26 [Rinse] [Salt] [Opt1] [Opt2] [Opt3] [Opt4] [Opt5] [Opt6] [Opt7]
     * - Remote Start: f0 26 10 [Course] [DelayHour] [Opt2] [Opt3] [Opt4] [Opt5]
     */
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02616', 'hex')) // Wake Up
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F02612', 'hex')) // Immediate Power Off
            }
        } else if (prop === 'pause') {
            this.send(Buffer.from('F02613', 'hex')) // Pause
        } else if (prop === 'resume') {
            this.send(Buffer.from('F02614', 'hex')) // Resume
        } else if (prop === 'cancel') {
            this.send(Buffer.from('F02611', 'hex')) // Course Cancel / Drain Stop
        } else if (prop === 'target_course') {
            const courseKey = Object.keys(COURSES).find((k) => COURSES[parseInt(k, 10)] === mqttValue)
            if (courseKey !== undefined) {
                this.targetCourse = parseInt(courseKey, 10)
                this.publishProperty('target_course', mqttValue)
            }
        } else if (prop === 'target_delay') {
            const val = parseInt(mqttValue, 10)
            if (!isNaN(val)) {
                this.targetDelay = val
                this.publishProperty('target_delay', val)
            }
        } else if (prop === 'target_high_temp') {
            this.targetHighTemp = mqttValue === 'ON'
            this.publishProperty('target_high_temp', mqttValue)
        } else if (prop === 'target_extra_dry') {
            this.targetExtraDry = mqttValue === 'ON'
            this.publishProperty('target_extra_dry', mqttValue)
        } else if (prop === 'target_extra_rinse') {
            const val = parseInt(mqttValue, 10)
            if (!isNaN(val)) {
                this.targetExtraRinse = val
                this.publishProperty('target_extra_rinse', mqttValue)
            }
        } else if (prop === 'rinse_level') {
            const val = parseInt(mqttValue, 10)
            if (!isNaN(val)) {
                this.cachedRinseLevel = val
                this.sendSettings()
            }
        } else if (prop === 'salt_level') {
            const val = parseInt(mqttValue, 10)
            if (!isNaN(val)) {
                this.cachedSaltLevel = val
                this.sendSettings()
            }
        } else if (prop === 'buzzer_level') {
            this.cachedBuzzerLevel = mqttValue
            this.sendSettings()
        } else if (prop === 'end_alarm_sound') {
            this.cachedEndAlarmSound = mqttValue === 'ON'
            this.sendSettings()
        } else if (prop === 'clean_reminder') {
            this.cachedCleanReminder = mqttValue === 'ON'
            this.sendSettings()
        } else if (prop === 'auto_dry') {
            this.cachedAutoDry = mqttValue === 'ON'
            this.sendSettings()
        } else if (prop === 'brightness') {
            this.cachedBrightness = mqttValue === 'HIGH'
            this.sendSettings()
        } else if (prop === 'remote_start_mode') {
            this.cachedRemoteStartMode = mqttValue
            this.sendSettings()
        } else if (prop === 'start_course') {
            // f0 26 10 [Course] [DelayHour] [Opt2] [Opt3] [Opt4] [Opt5]
            let opt3 = 0
            if (this.targetHighTemp) opt3 |= 0x08
            if (this.targetExtraDry) opt3 |= 0x04

            let opt4 = 0
            if (this.targetExtraRinse === 1) opt4 |= 0x08
            else if (this.targetExtraRinse === 2) opt4 |= 0x10
            else if (this.targetExtraRinse === 3) opt4 |= 0x18

            if (this.targetCourse === 0x0b) {
                // Download cycle flag
                opt4 |= 0x40
            }

            this.send(Buffer.from([0xf0, 0x26, 0x10, this.targetCourse, this.targetDelay, 0x00, opt3, opt4, 0x00]))
        }
    }

    processAABB(buf: Buffer) {
        if (buf[0] === 0x32 && buf[1] === 0xec) {
            // Scan for '00 18' status TLV blocks starting at offset 2.
            // Older firmware sends 54-byte packets (two 26-byte blocks).
            // Newer firmware sends larger packets (e.g. 94 bytes) with additional
            // TLV data appended after each 24-byte status block.
            let offset = 2
            while (offset + 26 <= buf.length) {
                if (buf[offset] === 0x00 && buf[offset + 1] === 0x18) {
                    this.processStatus(buf.subarray(offset))
                    offset += 2 + 0x18 // tag(1) + len(1) + data(24)
                } else {
                    offset++
                }
            }
        } else if (buf[0] === 0x32 && buf[1] === 0x3e) {
            this.processStatistics(buf)
        }
    }

    processStatistics(buf: Buffer) {
        if (buf.length < 7) return

        const sequence = buf[6]
        if (sequence === this.lastStatSequence) {
            // Deduplicate burst packets
            return
        }
        this.lastStatSequence = sequence

        // 32 3e [Delta Wh 2B] [Accum Wh 2B] [Seq]
        const energyAccum = buf.readUInt16BE(4)
        this.publishProperty('energy_consumption', energyAccum.toString())
    }

    /**
     * 32ec Status Packet (00 18 Tag Block - 24 bytes) Offset Mapping:
     * [0] State: 01(INITIAL), 02(RUNNING), 03(PAUSE), 04(STANDBY)
     * [3~4] Initial Time (Hour, Minute)
     * [5] Course Code (0x01: AUTO, etc.)
     * [7~8] Remain Time (Hour, Minute)
     * [9] Delay Start (예약 시간)
     * [11] Door & Opt1: 0x40(Clean Reminder ON), 0x10(Auto Dry ON), 0x02(Door OPEN)
     * [12] Wash Options: 0x04(Extra Dry ON), 0x08(High Temp ON)
     * [13] Rinse Level (0x00 ~ 0x04)
     * [14] Salt Level (0x00 ~ 0x04)
     * [15] Buzzer & Remote: 0x80(Buzzer HIGH), 0x40(Buzzer LOW), 0x02(Remote Start Active)
     * [16] Opt2: 0x80(Remote PERMANENT), 0x40(Remote ONE_TIME), 0xc0(Remote OFF), 0x04(End Alarm Sound ON)
     * [19] Opt3 (밝기): 0x40(Brightness HIGH)
     * [20] Smart Course (다운로드 코스 ID)
     * [21] Extra Rinse: 00(0회), 10(1회), 20(2회), 30(3회)
     */
    processStatus(curStatus: Buffer) {
        if (curStatus[0] === 0x00 && curStatus[1] === 0x18) {
            const data = curStatus.subarray(2, 26) // 24 bytes

            const stateCode = data[0]
            const processCode = data[1]
            const stateStr = DISHWASHER_STATES[stateCode] || 'unknown'

            // To prevent the switch from bouncing, treat the power as OFF when the state is Standby (4) or cancelling (processCode: 0x63)
            const isPowerOff = stateCode === 4 || processCode === 0x63

            this.publishProperty('state', stateStr)
            this.publishProperty('power', isPowerOff ? 'OFF' : 'ON')

            // Course (Index 5)
            const baseCourseCode = data[5]
            const smartCourseCode = data[20]

            let courseStr = ''
            if (smartCourseCode !== 0) {
                // If a smart course is active, use it instead of the base course
                courseStr = SMART_COURSES[smartCourseCode] || 'unknown'
            } else {
                courseStr = COURSES[baseCourseCode] || 'unknown'
            }

            this.publishProperty('course', courseStr)

            // Initial(Course) Time (Index 3: hour, Index 4: minute)
            const initialHour = data[3]
            const initialMinute = data[4]
            this.publishProperty('course_time', initialHour * 60 + initialMinute)

            // Remain Time (Index 7: hour, Index 8: minute)
            const remainHour = data[7]
            const remainMinute = data[8]
            this.publishProperty('remain_time', remainHour * 60 + remainMinute)

            // Delay Start Hour (Index 9)
            const delayHour = data[9]
            this.publishProperty('delay_start', delayHour)

            // Door (Index 11 bit 0x02)
            const isDoorOpen = (data[11] & 0x02) !== 0
            this.publishProperty('door', isDoorOpen ? 'OPEN' : 'CLOSE')

            // 추가 건조 (Index 12 bit 0x04): 세척 후 고열 추가 건조 활성 여부
            const isExtraDry = (data[12] & 0x04) !== 0
            this.publishProperty('extra_dry', isExtraDry ? 'ON' : 'OFF')

            // 고온 세척 (Index 12 bit 0x08): 고온 가열로 살균 세척 활성 여부
            const isHighTemp = (data[12] & 0x08) !== 0
            this.publishProperty('high_temp', isHighTemp ? 'ON' : 'OFF')

            // Remote Start (Index 15 bit 0x02)
            const isRemoteStart = (data[15] & 0x02) !== 0
            this.publishProperty('remote_start', isRemoteStart ? 'ON' : 'OFF')

            // Parse Settings
            // Rinse & Salt Level (Index 13, 14)
            this.cachedRinseLevel = data[13]
            this.cachedSaltLevel = data[14]
            this.publishProperty('rinse_level', this.cachedRinseLevel)
            this.publishProperty('salt_level', this.cachedSaltLevel)

            // Auto Dry & Clean Reminder (Index 11)
            this.cachedAutoDry = (data[11] & 0x10) !== 0
            this.cachedCleanReminder = (data[11] & 0x40) !== 0
            this.publishProperty('auto_dry', this.cachedAutoDry ? 'ON' : 'OFF')
            this.publishProperty('clean_reminder', this.cachedCleanReminder ? 'ON' : 'OFF')

            // Buzzer Level (Index 15)
            if ((data[15] & 0x80) !== 0) this.cachedBuzzerLevel = 'HIGH'
            else if ((data[15] & 0x40) !== 0) this.cachedBuzzerLevel = 'LOW'
            else this.cachedBuzzerLevel = 'OFF'
            this.publishProperty('buzzer_level', this.cachedBuzzerLevel)

            // Remote Start Mode (Index 16 bits 0xc0)
            const remoteBits = data[16] & 0xc0
            if (remoteBits === 0xc0) this.cachedRemoteStartMode = 'OFF'
            else if (remoteBits === 0x80) this.cachedRemoteStartMode = 'PERMANENT'
            else if (remoteBits === 0x40) this.cachedRemoteStartMode = 'ONE_TIME'
            this.publishProperty('remote_start_mode', this.cachedRemoteStartMode)

            // End Alarm Sound (Index 16 bit 0x04)
            this.cachedEndAlarmSound = (data[16] & 0x04) !== 0
            this.publishProperty('end_alarm_sound', this.cachedEndAlarmSound ? 'ON' : 'OFF')

            // Brightness (Index 19 bit 0x40)
            this.cachedBrightness = (data[19] & 0x40) !== 0
            this.publishProperty('brightness', this.cachedBrightness ? 'HIGH' : 'LOW')

            // Extra Rinse (Index 21): 0x00=0회, 0x10=1회, 0x20=2회, 0x30=3회
            const extraRinseRaw = data[21]
            const extraRinseStr = RINSE_LEVELS[extraRinseRaw] ?? RINSE_LEVELS[0x00]
            this.publishProperty('extra_rinse', extraRinseStr)
            // Sync target_extra_rinse (0~3) from device state
            this.targetExtraRinse =
                extraRinseRaw === 0x10 ? 1 : extraRinseRaw === 0x20 ? 2 : extraRinseRaw === 0x30 ? 3 : 0
            this.publishProperty('target_extra_rinse', this.targetExtraRinse)
        }
    }
}
