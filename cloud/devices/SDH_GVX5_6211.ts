import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import AABBDevice from './aabb_device'

// LG RHX5009NHB heat-pump dryer (EU) — modelId "SDH_GVX5_6211" (DeviceType 202, protocolVer 7).
// Status comes enveloped (class 0x30, see AABBDevice.processEnvelopedStatus): one (0xEB) or two (0xEC,
// current last) 50-byte blocks, each led by a 0x0a marker.
// All offsets below were confirmed live against the physical appliance.
// The status block, the events and the writes are documented on the wiki page Appliance:SDH_GVX5_6211.

const CLASS_BYTE = 0x30
const BLOCK_LENGTH = 50
const BLOCK_MARKER = 0x0a

// Family-wide "report your state" request, same as the EU washers and US dryers.
const STATUS_REQUEST = 'F0ED1121010000001800'

// F0E5 writes: 000201FF, a field count, then (field, value) pairs, each acked in a 30E6 echo. Fields: 02
// power (01 / 00), 03 run (01 start, 02 pause, 03 resume), 0A course, 1E dry level and 1F dry mode (both
// coded as in the status record), 34 damp alert and 0F anti crease (01 / 00), 70 Timed Dry time (minutes,
// two bytes).
const WRITE_HEADER = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff]
const FIELD_POWER = 0x02
const FIELD_RUN = 0x03
const FIELD_COURSE = 0x0a
const FIELD_ANTI_CREASE = 0x0f
const FIELD_DRY_LEVEL = 0x1e
const FIELD_DRY_MODE = 0x1f
const FIELD_DAMP_ALERT = 0x34
const FIELD_DRY_TIME = 0x70
const RUN_START = 0x01
const RUN_PAUSE = 0x02
const RUN_RESUME = 0x03
// Timed Dry's time range, whose minimum is also its default (modelJSON moreLessTime, the owner's manual).
const DRY_TIME_MIN = 20
const DRY_TIME_MAX = 180
// The cloud's answer to the dryer's 30 7F 04 after a start or resume; the run has already begun, so it is
// not what starts it. Sent after Start for an unbridged dryer; a bridged one gets it twice and accepts both.
const START_FOLLOW_UP = 'F024120114'

// An F0E5 write of the given fields, each [field, ...value bytes].
function write(...fields: number[][]) {
    return Buffer.from([...WRITE_HEADER, fields.length, ...fields.flat()])
}

// rec[1]: dry level, 0 on courses without one; modelJSON `dryLevel` knows no other values.
const DRY_LEVEL_OFFSET = 1
const DRY_LEVELS = Enum.of({
    Iron: 0x01,
    Cupboard: 0x03,
    Extra: 0x05,
})

// rec[2]: dry mode; each course remembers its own.
const DRY_MODE_OFFSET = 2
const DRY_MODES = Enum.of({
    Efficiency: 0x02,
    Turbo: 0x03,
})

// rec[7..8]: Delay End (3-19 h until the cycle finishes) in minutes, big-endian (armed flag is FLAG2_DELAY)
const DELAY_OFFSET = 7
// rec[9..10] / rec[11..12]: remaining / initial estimate in minutes, big-endian
const REMAIN_TIME_OFFSET = 9
const INITIAL_TIME_OFFSET = 11
// rec[17..18]: energy of the current (or last) cycle in Wh, big-endian, as the ThinQ app shows it
const ENERGY_OFFSET = 17

// rec[13]: phase, LG's state index (modelJSON `state`, the table BDH_D30007_US uses). Seen live: 0, 1,
// 3, 4, 5, 7, 8, 9, 14, 17, 20 (while Drum Care runs) and 21; the rest are LG's own indices.
// rec[14] holds the phase this one replaced, rec[15] the error code.
const PHASE_OFFSET = 13
const ERROR_OFFSET = 15
const PHASE_OFF = 0x00
const PHASE_PAUSE = 0x03
const PHASE_ERROR = 0x05
const STATES = Enum.of({
    Off: 0,
    Initial: 1,
    Running: 2,
    Pause: 3,
    End: 4,
    Error: 5,
    'Audible diagnosis': 6,
    Drying: 7,
    Cooling: 8,
    'Wrinkle care': 9,
    Reserved: 10,
    'Delay load': 11,
    'Spin reserve': 12,
    'Auto test': 13,
    Detecting: 14,
    Steam: 15,
    'Clothing recognition': 16,
    'Condenser clean': 17,
    'Bedding brushing': 18,
    'Dry refreshing': 19,
    'Allergy care': 20,
    'Condenser care': 21,
    'End remote maintain on': 22,
    'Dry ready': 23,
    'Laundry care': 24,
    Dehumidification: 25,
    'Dehumidification end': 26,
    'End waiting': 27,
    'Cooldown pause': 29,
    'Cooldown standby': 30,
    // Not a phase: Off with FLAG2_SLEEP set, see processStatus.
    Sleep: [],
})

// rec[15]: error code, LG's index (modelJSON `error`, as on WTL_FXU_BDV_NA_01's dryer). Labels follow the
// RHX5009*** owner's manual, with the code the panel shows; dE2 is only in modelJSON.
const ERRORS = Enum.of({
    OK: 0,
    'Temperature sensor error (tE1)': 1,
    'Temperature sensor error (tE2)': 2,
    'Temperature sensor error (tE4)': 4,
    'Drain pump error (OE)': 14,
    'Empty water (drN)': 15,
    'Door open (dE1)': 16,
    'No lint filter (IF)': 18,
    'Temperature error (F1)': 20,
    'Compressor error (LE2)': 21,
    'Compressor error (AE)': 22,
    'Motor locked error (LE1)': 31,
    'Door error (dE4)': 38,
    dE2: 43,
    'Power error (PS)': 44,
    'Condenser cover error (CC)': 55,
})

// rec[20]: course id, as Start writes it, in dial order. Condenser Care and Drum Care are button-hold
// maintenance courses; the app hides Condenser Care, yet the dryer accepts both from Start.
const COURSE_OFFSET = 20
const COURSES = Enum.of({
    Cotton: 0x07,
    Eco: 0x19,
    'Mixed Fabric': 0x06,
    'Easy Care': 0x05,
    Wool: 0x0b,
    Activewear: 0x08,
    'Download Cycle': 0x0a,
    Towels: 0x02,
    'Allergy Care': 0x10,
    'Timed Dry': 0x15,
    TurboDry: 0x26,
    'AI Dry': 0x1c,
    'Condenser Care': 0x12,
    'Drum Care': 0x13,
})

// Dry levels and dry modes the courses accept (modelJSON `selectable`, matching the owner's manual); the
// other courses have fixed ones. Start leaves a picked value out where the course doesn't accept it.
const ADJUSTABLE: Partial<Record<(typeof COURSES.options)[number], { levels: string[]; modes?: string[] }>> = {
    Cotton: { levels: ['Iron', 'Cupboard', 'Extra'] },
    Eco: { levels: ['Iron', 'Cupboard', 'Extra'] },
    'Mixed Fabric': { levels: ['Iron', 'Cupboard', 'Extra'], modes: ['Efficiency', 'Turbo'] },
    'Easy Care': { levels: ['Iron', 'Cupboard'], modes: ['Efficiency', 'Turbo'] },
}

// Courses that take Damp Alert (modelJSON dampDryBeep `selectable`, the owner's manual).
const DAMP_ALERT_COURSES: string[] = ['Cotton', 'Eco', 'Mixed Fabric', 'Easy Care']

// Courses that take Anti Crease: every drying programme (modelJSON wrinkleCare `selectable`, the owner's
// manual). Not the maintenance courses, nor Download Cycle, where the downloaded course decides.
const ANTI_CREASE_COURSES: string[] = [
    'Cotton',
    'Eco',
    'Mixed Fabric',
    'Easy Care',
    'Wool',
    'Activewear',
    'Towels',
    'Allergy Care',
    'Timed Dry',
    'TurboDry',
    'AI Dry',
]

// rec[19]: bit 0x04 is the beeper setting, default ON (set even in the powered-off block)
const FLAGS0_OFFSET = 19
const FLAG0_BEEP = 0x04

// rec[24]: options bitfield and the drum light
const FLAGS_OFFSET = 24
const FLAG_ANTI_CREASE = 0x08
const FLAG_DRUM_LIGHT = 0x20
const FLAG_DAMP_ALERT = 0x40

// rec[26]: 0x02 asleep (phase Off; Power ON wakes it), 0x40 remote start: armed on the panel or set by
// the dryer itself for any started cycle (modelJSON autoRemoteStart), cleared at End, by power-off or by
// a pause on the panel.
const FLAGS2_OFFSET = 26
const FLAG2_SLEEP = 0x02
const FLAG2_DELAY = 0x08
const FLAG2_CHILD_LOCK = 0x10
const FLAG2_REMOTE_START = 0x40

// rec[27]: bit 0x80 latches on at the first power-on after module boot and never clears,
// while the phase byte reads 0x01 even in the freshly-booted powered-off block — only the
// conjunction (bit set AND phase nonzero) gives the real power state.
const POWER_OFFSET = 27
const POWER_BIT = 0x80

// What Start sends, as wire codes; dry level and mode 0 where the course has none.
type Settings = {
    course: number
    level: number
    mode: number
    dampAlert: boolean
    antiCrease: boolean
    dryTime: number
}

function parseSwitch(mqttValue: string) {
    return mqttValue === 'ON' ? true : mqttValue === 'OFF' ? false : undefined
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                // The dryer reports only its LG model code, so the sales model is spelled out here.
                ...HADevice.config(meta, { name: 'LG Dryer', model: 'RHX5009NHB', model_id: meta.modelName }),
                components: {
                    // The dryer takes an explicit on or off, so no toggle is needed.
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    // Needs Remote Start armed on the panel first (see the remote_start entity).
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    // What Start runs: the panel's settings, unless picked here. Nothing reaches the dryer
                    // before Start, as in the app.
                    set_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_course',
                        state_topic: '$this/set_course',
                        command_topic: '$this/set_course/set',
                        name: 'Set course',
                        icon: 'mdi:tune-vertical',
                        options: COURSES.options,
                    },
                    // Start sends these where the course accepts them.
                    set_dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-set_dry_level',
                        state_topic: '$this/set_dry_level',
                        command_topic: '$this/set_dry_level/set',
                        name: 'Set dry level',
                        icon: 'mdi:water-percent',
                        options: DRY_LEVELS.options,
                    },
                    set_dry_mode: {
                        platform: 'select',
                        unique_id: '$deviceid-set_dry_mode',
                        state_topic: '$this/set_dry_mode',
                        command_topic: '$this/set_dry_mode/set',
                        name: 'Set dry mode',
                        icon: 'mdi:fan',
                        options: DRY_MODES.options,
                    },
                    set_damp_alert: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_damp_alert',
                        state_topic: '$this/set_damp_alert',
                        command_topic: '$this/set_damp_alert/set',
                        name: 'Set damp alert',
                        icon: 'mdi:water-alert-outline',
                    },
                    set_anti_crease: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_anti_crease',
                        state_topic: '$this/set_anti_crease',
                        command_topic: '$this/set_anti_crease/set',
                        name: 'Set anti crease',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    // Timed Dry only; the app sets it to the minute.
                    set_dry_time: {
                        platform: 'number',
                        unique_id: '$deviceid-set_dry_time',
                        state_topic: '$this/set_dry_time',
                        command_topic: '$this/set_dry_time/set',
                        name: 'Set dry time',
                        icon: 'mdi:timer-cog-outline',
                        min: DRY_TIME_MIN,
                        max: DRY_TIME_MAX,
                        step: 1,
                        unit_of_measurement: 'min',
                    },
                    // Pause only; Start resumes (see setProperty).
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.options,
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                        device_class: 'enum',
                        options: ERRORS.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
                    },
                    dry_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_mode',
                        state_topic: '$this/dry_mode',
                        name: 'Dry mode',
                        icon: 'mdi:fan',
                        device_class: 'enum',
                        options: DRY_MODES.options,
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
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    delay_end: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_end',
                        state_topic: '$this/delay_end',
                        name: 'Delay end',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti crease',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    damp_alert: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_alert',
                        state_topic: '$this/damp_alert',
                        name: 'Damp alert',
                        icon: 'mdi:water-alert-outline',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        device_class: 'light',
                    },
                    beep: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-beep',
                        state_topic: '$this/beep',
                        name: 'Beep',
                        icon: 'mdi:volume-high',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // Ask once per connect, or the entities stay blank until the next physical interaction
    // and the unanswered appliance keeps retransmitting 0x03 records instead of status.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
        this.publishSettings()
    }

    processAABB(buf: Buffer) {
        this.processEnvelopedStatus(buf, CLASS_BYTE, BLOCK_LENGTH, this.processStatus)
    }

    // Start's settings as the panel last showed them, and those picked in HA since the last Start.
    reported: Partial<Settings> = {}
    picked: Partial<Settings> = {}
    // The last status was Pause, so Start resumes instead of programming a new run.
    paused = false

    processStatus(rec: Buffer) {
        if (rec[0] !== BLOCK_MARKER) return

        const phase = rec[PHASE_OFFSET]
        const flags2 = rec[FLAGS2_OFFSET]
        const isOff = (rec[POWER_OFFSET] & POWER_BIT) === 0 || phase === PHASE_OFF
        const asleep = phase === PHASE_OFF && (flags2 & FLAG2_SLEEP) !== 0
        this.paused = !isOff && phase === PHASE_PAUSE
        const error = phase === PHASE_ERROR ? rec[ERROR_OFFSET] : 0

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('error_message', this.decode('error', ERRORS, error))
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', asleep ? 'Sleep' : isOff ? 'Off' : this.decode('state', STATES, phase))
        this.publishProperty('course', this.decode('course', COURSES, rec[COURSE_OFFSET]))
        this.publishProperty('dry_level', this.decode('dry level', DRY_LEVELS, rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('dry_mode', this.decode('dry mode', DRY_MODES, rec[DRY_MODE_OFFSET]))
        const remaining = isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET)
        this.publishProperty('remaining_time', remaining)
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))

        this.publishProperty('delay_end', (flags2 & FLAG2_DELAY) !== 0 ? rec.readUInt16BE(DELAY_OFFSET) : 0)
        this.publishProperty('remote_start', (flags2 & FLAG2_REMOTE_START) !== 0 ? 'ON' : 'OFF')

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('anti_crease', (flags & FLAG_ANTI_CREASE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_alert', (flags & FLAG_DAMP_ALERT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (flags & FLAG_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('beep', (rec[FLAGS0_OFFSET] & FLAG0_BEEP) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (flags2 & FLAG2_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')

        // A Timed Dry run's initial time is the time set for it.
        const course = rec[COURSE_OFFSET]
        this.reported = {
            course: course || undefined,
            level: rec[DRY_LEVEL_OFFSET],
            mode: rec[DRY_MODE_OFFSET],
            dampAlert: (flags & FLAG_DAMP_ALERT) !== 0,
            antiCrease: (flags & FLAG_ANTI_CREASE) !== 0,
            dryTime: COURSES.map(course) === 'Timed Dry' ? rec.readUInt16BE(INITIAL_TIME_OFFSET) : undefined,
        }
        this.publishSettings()
    }

    // A code missing from its table is logged, which is what lets the tables be completed from a capture.
    decode(what: string, table: { map(code: number): string | undefined }, code: number) {
        const label = table.map(code)
        if (label === undefined && code !== 0) this.log(`undecoded ${what}`, code.toString(16))
        return label
    }

    // Start resumes from Pause. Otherwise it runs what the set_* entities show (see startWrite) and drops the
    // choices made in HA, so the entities follow the panel again; then the cloud's follow-up.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'set_course') this.pick('course', COURSES.unmap(mqttValue))
        if (prop === 'set_dry_level') this.pick('level', DRY_LEVELS.unmap(mqttValue))
        if (prop === 'set_dry_mode') this.pick('mode', DRY_MODES.unmap(mqttValue))
        if (prop === 'set_damp_alert') this.pick('dampAlert', parseSwitch(mqttValue))
        if (prop === 'set_anti_crease') this.pick('antiCrease', parseSwitch(mqttValue))
        if (prop === 'set_dry_time') {
            const minutes = parseInt(mqttValue, 10)
            this.pick('dryTime', minutes >= DRY_TIME_MIN && minutes <= DRY_TIME_MAX ? minutes : undefined)
        }
        if (prop === 'power' && (mqttValue === 'ON' || mqttValue === 'OFF')) {
            this.send(write([FIELD_POWER, mqttValue === 'ON' ? 1 : 0]))
        }
        if (prop === 'pause') this.send(write([FIELD_RUN, RUN_PAUSE]))
        if (prop === 'start') {
            if (this.paused) {
                this.send(write([FIELD_RUN, RUN_RESUME]))
            } else {
                const start = this.startWrite()
                if (!start) {
                    this.log('start ignored: no course picked or shown on the panel')
                    return
                }
                this.send(start)
                this.picked = {}
                this.publishSettings()
            }
            this.send(Buffer.from(START_FOLLOW_UP, 'hex'))
        }
    }

    // A choice made in HA, kept for Start; a value outside the entity's range leaves the choices as they were.
    pick<K extends keyof Settings>(key: K, value: Settings[K] | undefined) {
        if (value !== undefined) this.picked[key] = value
        this.publishSettings()
    }

    // What Start would use: the choice made in HA, else what the panel shows.
    setting<K extends keyof Settings>(key: K): Settings[K] | undefined {
        return this.picked[key] ?? this.reported[key]
    }

    publishSettings() {
        const onOff = (on: boolean | undefined) => (on === undefined ? undefined : on ? 'ON' : 'OFF')
        this.publishProperty('set_course', COURSES.map(this.setting('course') ?? 0))
        this.publishProperty('set_dry_level', DRY_LEVELS.map(this.setting('level') ?? 0))
        this.publishProperty('set_dry_mode', DRY_MODES.map(this.setting('mode') ?? 0))
        this.publishProperty('set_damp_alert', onOff(this.setting('dampAlert')))
        this.publishProperty('set_anti_crease', onOff(this.setting('antiCrease')))
        this.publishProperty('set_dry_time', this.setting('dryTime'))
    }

    // The app's start write, in its order: the course, the options the course accepts, then the start
    // command. Without a known course there is nothing to start.
    startWrite() {
        const code = this.setting('course')
        const course = code === undefined ? undefined : COURSES.map(code)
        if (code === undefined || course === undefined) return undefined
        const adjustable = ADJUSTABLE[course]
        const mode = this.setting('mode') ?? 0
        const level = this.setting('level') ?? 0
        const modeLabel = DRY_MODES.map(mode)
        const levelLabel = DRY_LEVELS.map(level)
        const fields = [[FIELD_COURSE, code]]
        if (modeLabel && adjustable?.modes?.includes(modeLabel)) fields.push([FIELD_DRY_MODE, mode])
        if (levelLabel && adjustable?.levels.includes(levelLabel)) fields.push([FIELD_DRY_LEVEL, level])
        if (DAMP_ALERT_COURSES.includes(course)) fields.push([FIELD_DAMP_ALERT, this.setting('dampAlert') ? 1 : 0])
        if (ANTI_CREASE_COURSES.includes(course)) fields.push([FIELD_ANTI_CREASE, this.setting('antiCrease') ? 1 : 0])
        if (course === 'Timed Dry') {
            const minutes = this.setting('dryTime') ?? DRY_TIME_MIN
            fields.push([FIELD_DRY_TIME, minutes >> 8, minutes & 0xff])
        }
        fields.push([FIELD_RUN, RUN_START])
        return write(...fields)
    }
}
