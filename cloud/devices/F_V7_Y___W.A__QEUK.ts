import HADevice from './base'
import AABBDevice from './aabb_device'
import type { Device as Thinq2Device } from '../thinq2/device'
import { tombstone, type Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { RINSES, SOIL_LEVELS, SPINS, TEMPERATURES, SMART_COURSES } from './washer_common'

// LG WV5-1275W, tested on firmware 2.9.61. Start/Resume use the panel-selected
// programme and settings; Wake up only wakes standby, not a fully powered-off washer.
// This A-generation model differs from the F_C and B-generation F_V handlers:
// course is rec[7], door lock is rec[17] bit 6, and D8 reports the tub-clean count.
// Record A is previous state; record B is current. E2/BD/CD/DC have other layouts.
const STATES = Enum.of({
    Off: 0,
    Standby: 1,
    Paused: 2,
    Delayed: 3,
    Detecting: 4,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    Drying: 9,
    End: 10,
    'Cool down': 11,
    'Rinse hold': 12,
    Refreshing: 14,
    'Steam softening': 15,
    Demo: 16,
    Error: 18,
})
// Native courses differ from washer_common: notably 4 is Cotton+, not Eco 40-60.
const COURSES = Enum.of({
    Cotton: 1,
    'Easy Care': 2,
    'Cotton+': 4,
    Duvet: 5,
    Mix: 7,
    'Sports Wear': 8,
    'Silent Wash': 9,
    'Rinse + Spin': 14,
    'Tub Clean': 18,
    Wool: 27,
    Delicate: 32,
    'Quick 30': 34,
    'Baby Steam Care': 44,
    'Allergy Care': 45,
})
// Base courses paired with downloaded programmes in the 24 captured stored-course reports.
const DOWNLOADED_BASE_COURSES: Record<number, number> = {
    71: 1,
    58: 5,
    77: 1,
    63: 32,
    121: 23,
    56: 8,
    72: 10,
    57: 32,
    108: 1,
    52: 1,
    101: 27,
    74: 32,
    102: 1,
    64: 9,
    113: 48,
    55: 1,
    100: 14,
    62: 34,
    76: 1,
    107: 1,
    73: 34,
    122: 23,
    59: 1,
    54: 27,
}
// The bridge acknowledged these types in the capture, but not the large BD/CD dumps.
const ACK_TYPES = new Set([0x72, 0xd8, 0xe2, 0xdc])

export default class Device extends AABBDevice {
    private record?: Buffer
    private connected = true

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
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
                        device_class: 'power',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        device_class: 'enum',
                        options: STATES.options,
                        icon: 'mdi:state-machine',
                    },
                    completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-completed',
                        state_topic: '$this/completed',
                        name: 'Cycle complete',
                        icon: 'mdi:check-circle',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        device_class: 'enum',
                        options: [...new Set([...COURSES.options, ...SMART_COURSES.options])],
                        icon: 'mdi:pin-outline',
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded cycle',
                        device_class: 'enum',
                        options: SMART_COURSES.options,
                        icon: 'mdi:download',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        device_class: 'enum',
                        options: SPINS.options,
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'enum',
                        options: TEMPERATURES.options,
                        icon: 'mdi:thermometer',
                    },
                    temperature_setting: tombstone('sensor'),
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-outline',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-sand',
                    },
                    delay_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_remaining',
                        state_topic: '$this/delay_remaining',
                        name: 'Delay remaining',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:clock-start',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    standby: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-standby',
                        state_topic: '$this/standby',
                        name: 'Standby',
                        icon: 'mdi:power-sleep',
                        entity_category: 'diagnostic',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock-outline',
                        entity_category: 'diagnostic',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-plus-outline',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:weather-fog',
                    },
                    medic_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-medic_rinse',
                        state_topic: '$this/medic_rinse',
                        name: 'Medic rinse',
                        icon: 'mdi:medical-bag',
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        device_class: 'enum',
                        options: RINSES.options,
                        icon: 'mdi:water',
                    },
                    wash_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-wash_mode',
                        state_topic: '$this/wash_mode',
                        name: 'Soil level',
                        device_class: 'enum',
                        options: SOIL_LEVELS.options,
                        icon: 'mdi:waves',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since tub clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: 'PRESS',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: 'PRESS',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: 'PRESS',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    wake_up: {
                        platform: 'button',
                        unique_id: '$deviceid-wake_up',
                        command_topic: '$this/wake_up/set',
                        payload_press: 'PRESS',
                        name: 'Wake up',
                        icon: 'mdi:sleep-off',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: 'PRESS',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                },
            }),
        )
    }

    override drop() {
        this.record = undefined
        this.connected = false
        super.drop()
    }

    override setProperty(key: string, value: string) {
        if (!this.connected || value !== 'PRESS') return
        if (key === 'wake_up') return this.send(Buffer.from('f02a0100', 'hex'))
        if (key === 'pause') return this.send(Buffer.from('f024040100', 'hex'))
        if (key === 'power_off') return this.send(Buffer.from('f024010100', 'hex'))
        if (key !== 'start' && key !== 'resume') return

        const r = this.record
        // Validate the encoding and programme, not the appliance's safety interlocks.
        // Never invent settings or reuse a snapshot from an earlier connection.
        if (!r || !this.validCurrentSettings(r)) {
            this.log('Waiting for a supported current programme before Start/Resume')
            return
        }
        const settings = Buffer.alloc(16)
        settings[0] = r[7] // base course
        settings[1] = r[9] // wash mode
        settings[2] = r[10] // spin
        settings[3] = r[11] // temperature
        settings[4] = r[12] // rinse
        settings[9] = r[16] // pre-wash, medic rinse and steam
        settings[12] = r[22] // active downloaded course
        // LG Start uses initialBit + remoteStart; Resume uses only remoteStart.
        // The captured HA Start also echoed doorLock (0x43); use LG's 0x03 flags.
        settings[10] = key === 'start' ? 3 : 2
        if (key === 'resume') {
            settings[6] = r[14]
            settings[7] = r[15]
        }
        this.send(Buffer.concat([Buffer.from([0xf0, 0x26]), settings]))
    }

    private validCurrentSettings(r: Buffer) {
        return (
            (r[22] ? DOWNLOADED_BASE_COURSES[r[22]] === r[7] : COURSES.map(r[7]) !== undefined) &&
            r[9] <= 4 &&
            r[10] <= 11 &&
            r[11] <= 7 &&
            r[12] <= 5 &&
            r[13] === 0 &&
            (r[16] & ~0xd0) === 0 &&
            r[14] <= 19 &&
            r[15] <= 59
        )
    }

    override processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return
        if (buf.length === 4 && buf[1] === 0 && [0x24, 0x25, 0x26, 0x2a].includes(buf[2]) && buf[3] !== 0) {
            this.log(`Command ${buf[2].toString(16)} returned ${buf[3].toString(16)}`)
        }
        if (ACK_TYPES.has(buf[1])) this.thinq.send_ack(AABBDevice.frame(Buffer.from([0xf0, 0, buf[1], 4])))
        // On this model D8 carries TCLCount, not the F_C sibling's door-lock state.
        // The cloud reports this value before the following EC snapshot arrives.
        if (buf.length === 3 && buf[1] === 0xd8) {
            this.publishProperty('tub_clean_count', buf[2] <= 60 ? buf[2] : undefined)
            return
        }
        this.processCommonStatus(buf, 0x20, 30, this.processRecord)
    }

    // EC captures contain two 30-byte records; the common handler selects the current one.
    // Its EB single-record path uses the same layout, but has not been captured on this washer.
    private processRecord(rec: Buffer) {
        if (rec[0] !== 0 || rec[1] !== 28) return
        if (rec[3] > 30 || rec[4] > 59 || rec[5] > 30 || rec[6] > 59) return
        this.record = Buffer.from(rec)
        const state = STATES.map(rec[2])
        const binary = (key: string, value: boolean) => this.publishProperty(key, value ? 'ON' : 'OFF')
        this.publishProperty('status', state)
        this.publishProperty('power', state === undefined ? undefined : rec[2] === 0 ? 'OFF' : 'ON')
        this.publishProperty('completed', state === undefined ? undefined : rec[2] === 10 ? 'ON' : 'OFF')
        // A selected downloaded cycle overrides its base course, which remains in rec[7].
        this.publishProperty('course', rec[22] ? SMART_COURSES.map(rec[22]) : COURSES.map(rec[7]))
        this.publishProperty('downloaded_course', SMART_COURSES.map(rec[25]))
        this.publishProperty('spin', SPINS.map(rec[10]))
        this.publishProperty('temp', TEMPERATURES.map(rec[11]))
        this.publishProperty('rinse', RINSES.map(rec[12]))
        this.publishProperty('wash_mode', SOIL_LEVELS.map(rec[9]))
        this.publishProperty('remaining_time', rec[3] * 60 + rec[4])
        this.publishProperty('initial_time', rec[5] * 60 + rec[6])
        const delayValid = (rec[14] === 0 || (rec[14] >= 1 && rec[14] <= 19)) && rec[15] <= 59
        this.publishProperty('delay_remaining', delayValid ? rec[14] * 60 + rec[15] : undefined)
        binary('pre_wash', Boolean(rec[16] & 0x40))
        binary('steam', Boolean(rec[16] & 0x80))
        binary('medic_rinse', Boolean(rec[16] & 0x10))
        binary('remote_start', Boolean(rec[17] & 2))
        // Bit 0 marks standby and clears when the washer wakes.
        // INITIAL (state 1) occurs both asleep and awake; it is not the standby flag.
        binary('standby', Boolean(rec[29] & 1))
        binary('child_lock', Boolean(rec[17] & 0x80))
        // HA's lock class uses ON=unlocked and OFF=locked.
        binary('door_lock', !(rec[17] & 0x40))
        this.publishProperty('tub_clean_count', rec[23] <= 60 ? rec[23] : undefined)
    }
}
