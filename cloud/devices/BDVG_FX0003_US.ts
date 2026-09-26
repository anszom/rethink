import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG DLEX6700B electric dryer. BDH_D30007_US's framing and 42-byte record, but with a temperature
// setting and different option bits.
//
//     aa ff 30 0a 00 66 00 06 9c 00 01 00 ec 00 54 <payload> <chk16> bb
//           │  │  └─┬─┘    └─┬─┘       │  │  └─┬─┘
//           │  │    │        │         │  │    └ buf[11:13] payload length
//           │  │    │        │         │  └ buf[10] inner type
//           │  │    │        │         └ buf[9] delivery class: 0 sent once, else repeated until acked
//           │  │    │        └ buf[5:7] sequence
//           │  │    └ buf[2:4] frame length
//           │  └ buf[1] 0a envelope
//           └ buf[0] class, 0x30
//
// Inner types: 0xEC previous + current record; 0xEB current record (status query reply); 0x03 event:
//
//     0b 0a 02 04 0b 00 d6 00 12 01 1b 00 00 00 00 29 00 02
//     │                          │  │              │  │
//     │                          │  │              │  └ door (id 0a): 1 open
//     │                          │  │              └ the course's default minutes
//     │                          │  └ course, in the rec[20] numbering
//     │                          └ power: 0 off
//     └ id: 08 power-off, 0a door, 0b other

const CLASS_BYTE = 0x30
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 42

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

const STATUS_REQUEST = 'F0ED112101000000180411120000'

// Set property:
//
//     aa 0d f0 e5 00 02 01 ff 01 13 00 f7 bb
//                             │  └─┬─┘
//                             │    └ (prop, value) × count; the minute props (0x70) take 2 bytes, big-endian
//                             └ count
const SET_PROPERTY = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff]
const PROP_POWER = 0x02
const PROP_CYCLE = 0x03
const PROP_COURSE = 0x0a // 0xff, then PROP_DOWNLOADED_COURSE, for a downloaded course
const PROP_DOWNLOADED_COURSE = 0x0b
const PROP_BUZZER = 0x13
const PROP_CYCLE_OPTIMIZATION = 0x4c // switching it on moves the course to AI Dry
const PROP_SPLASH_SCREEN = 0x51
const PROP_KEEP_FRESH = 0x57

const COURSE_DOWNLOADED = 0xff
const CYCLE = Enum.of({ start: 1, pause: 2, resume: 3 })

// The app always writes these together, in this order.
const BUNDLE = [
    { prop: 0x20, key: 'temp', width: 1 },
    { prop: 0x1e, key: 'dry_level', width: 1 },
    { prop: 0x3f, key: 'steam', width: 1 },
    { prop: 0x34, key: 'damp_dry_signal', width: 1 },
    { prop: 0x38, key: 'energy_saver', width: 1 },
    { prop: 0x36, key: 'low_static', width: 1 },
    { prop: 0x0f, key: 'wrinkle_care', width: 1 },
    { prop: 0x70, key: 'dry_time', width: 2 },
] as const
type BundleKey = (typeof BUNDLE)[number]['key']
const BUNDLE_SWITCHES: BundleKey[] = ['steam', 'damp_dry_signal', 'energy_saver', 'low_static', 'wrinkle_care']

// Write reply. Results: 0x00/0x10 accepted, 0x11 unchanged, 0x03 refused (e.g. chime while off), 0x13 busy.
//
//     aa 37 30 e6 00 02 01 ff 01 0a 00 <record> <chk> bb
//                             │  └─┬─┘ │
//                             │    │   └ from before the write: ignored
//                             │    └ (prop, result) × count
//                             └ buf[6] count
const WRITE_REPLY_TYPE = 0xe6
const WRITE_REPLY_PROP_OFFSET = 7
const WRITE_REPLY_RESULT_OFFSET = 8
const WRITE_REFUSED = 0x03

const EVENT_FRAME_TYPE = 0x03
const EVENT_INNER_LEN = 18
const EVENT_PAYLOAD_OFFSET = 13

const EVENT_ID_OFFSET = 0
const EVENT_POWER_OFFSET = 9
const EVENT_DOOR_OFFSET = 16

const DOOR_OPEN = 1
const EVENT_ID_DOOR = 0x0a

const DRY_LEVEL_OFFSET = 1
const TEMP_OFFSET = 3
const COURSE_OFFSET = 5
const REMAIN_TIME_OFFSET = 9 // minutes, big-endian
const INITIAL_TIME_OFFSET = 11 // minutes, big-endian
const STATE_OFFSET = 13
const SPENT_POWER_OFFSET = 17 // Wh, big-endian
const BUZZER_OFFSET = 19
const DOWNLOADED_COURSE_OFFSET = 23 // while rec[5] is 0xff
const SPLASH_SCREEN_OFFSET = 33

const OPT1_OFFSET = 24
const OPT1_LOW_STATIC = 0x02
const OPT1_WRINKLE_CARE = 0x08
const OPT1_DRUM_LIGHT = 0x20 // also lit briefly by panel activity or the door
const OPT1_DAMP_DRY_SIGNAL = 0x40

const OPT2_OFFSET = 25
const OPT2_STEAM = 0x04
const OPT2_ENERGY_SAVER = 0x80 // app only

const OPT3_OFFSET = 26
const OPT3_CONTROL_LOCK = 0x10
const OPT3_REMOTE_START = 0x40

const OPT4_OFFSET = 27
const OPT4_CYCLE_OPTIMIZATION = 0x01
const OPT4_REMOTE_MAINTAIN = 0x02

const OPT5_OFFSET = 28
const OPT5_KEEP_FRESH = 0x10

const STATE_POWEROFF = 0

// modelJSON state indices
const STATE = Enum.of({
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
})

// Dial order, then the app-only courses.
const COURSE = new Enum<string>([
    ['AI Dry', 44],
    ['Timed Dry', 21],
    ['Bedding', 4],
    ['Steam Sanitary', 38],
    ['Towels', 2],
    ['Delicates', 10],
    ['Normal', 7],
    ['Quick Dry', 9],
    ['Power Dry', 16], // app: "Power Dry/Antibacterial"
    ['Steam Fresh', 37],
    ['Air Dry', 35],
    ['Jeans', 3],
    ['Blanket Refresh', 53],
    ['Perm. Press', 26],
    ['Heavy Duty', 29],
    ['Super Dry', 42],
    ['Active Wear', 8],
    ['Low Temp Dry', 32],
    ['Overnight Dry', 54],
    ['Easy Ironing', 51],
    ['Small Load', 24],
    ['Large Load Dry', 55],
    ['X Large Load Dry', 56],
])

const DOWNLOADED_COURSE = Enum.of({
    'Wrinkle Prevention': 114,
    'Rack Dry': 140,
})

// App labels. 0 on courses without a dry level.
const DRY_LEVEL = Enum.of({
    Off: 0,
    Damp: 1,
    Less: 2,
    Normal: 3,
    More: 4,
    Very: 5,
})

// 0 on Air Dry and Rack Dry
const TEMP = Enum.of({
    Low: 1,
    'Medium Low': 2,
    Medium: 3,
    'Medium High': 4,
    High: 5,
})

// "Signal" on the panel
const BUZZER = Enum.of({
    Off: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Very High': 4,
})

// modelJSON INIT_LCD_<n> keys (not label indices)
const SPLASH_SCREEN = new Enum<string>([
    ['Normal', 0],
    ['Snowman 1', 1],
    ['Snowman 2', 2],
    ['Hello Winter', 3],
    ['Sprout', 4],
    ['Earth Day', 5],
    ['The Sun', 6],
    ['Beach Umbrella', 7],
    ['Fall Leaves', 8],
    ['Halloween', 9],
    ['Happy New Year', 10],
    ['Christmas', 11],
])

const COURSE_TIMED_DRY = 21
const DRY_TIME_MIN = 10
const DRY_TIME_MAX = 100
const DRY_TIME_STEP = 10

const onOff = (v: boolean) => (v ? 'ON' : 'OFF')
const bit = (byte: number, mask: number) => ((byte & mask) !== 0 ? 1 : 0)

export default class Device extends AABBDevice {
    protected override readonly deliveryAcks = true

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
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
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATE.options,
                    },
                    course: {
                        platform: 'select',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        command_topic: '$this/course/set',
                        options: [...COURSE.options, ...DOWNLOADED_COURSE.options],
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
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
                        icon: 'mdi:play-pause',
                    },
                    dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        command_topic: '$this/dry_level/set',
                        options: DRY_LEVEL.options,
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    temp: {
                        platform: 'select',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        command_topic: '$this/temp/set',
                        options: TEMP.options,
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    dry_time: {
                        platform: 'number',
                        unique_id: '$deviceid-dry_time',
                        state_topic: '$this/dry_time',
                        command_topic: '$this/dry_time/set',
                        min: DRY_TIME_MIN,
                        max: DRY_TIME_MAX,
                        step: DRY_TIME_STEP,
                        mode: 'box',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Dry time',
                        icon: 'mdi:timer-edit-outline',
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
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
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
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    // refused while off
                    buzzer: {
                        platform: 'select',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        command_topic: '$this/buzzer/set',
                        options: BUZZER.options,
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        icon: 'mdi:lightbulb',
                    },
                    steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        command_topic: '$this/steam/set',
                        name: 'Steam',
                        icon: 'mdi:weather-fog',
                    },
                    wrinkle_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        command_topic: '$this/wrinkle_care/set',
                        name: 'Wrinkle care',
                        icon: 'mdi:iron-outline',
                    },
                    low_static: {
                        platform: 'switch',
                        unique_id: '$deviceid-low_static',
                        state_topic: '$this/low_static',
                        command_topic: '$this/low_static/set',
                        name: 'Low static',
                        icon: 'mdi:flash-off-outline',
                    },
                    damp_dry_signal: {
                        platform: 'switch',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        command_topic: '$this/damp_dry_signal/set',
                        name: 'Damp dry signal',
                        icon: 'mdi:bell-outline',
                    },
                    energy_saver: {
                        platform: 'switch',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        command_topic: '$this/energy_saver/set',
                        name: 'Energy saver',
                        icon: 'mdi:leaf',
                    },
                    keep_fresh: {
                        platform: 'switch',
                        unique_id: '$deviceid-keep_fresh',
                        state_topic: '$this/keep_fresh',
                        command_topic: '$this/keep_fresh/set',
                        name: 'KeepFresh',
                        icon: 'mdi:rotate-3d-variant',
                    },
                    cycle_optimization: {
                        platform: 'switch',
                        unique_id: '$deviceid-cycle_optimization',
                        state_topic: '$this/cycle_optimization',
                        command_topic: '$this/cycle_optimization/set',
                        name: 'Cycle optimization',
                        icon: 'mdi:auto-fix',
                        entity_category: 'config',
                    },
                    splash_screen: {
                        platform: 'select',
                        unique_id: '$deviceid-splash_screen',
                        state_topic: '$this/splash_screen',
                        command_topic: '$this/splash_screen/set',
                        options: SPLASH_SCREEN.options,
                        name: 'Splash screen',
                        icon: 'mdi:monitor-shimmer',
                        entity_category: 'config',
                    },
                    control_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock-outline',
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
                    remote_maintain: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_maintain',
                        state_topic: '$this/remote_maintain',
                        name: 'Remote maintain',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    private pendingPower?: string

    // BUNDLE values from the last record, plus writes not yet reflected in one
    private readonly bundle = new Map<BundleKey, number>()

    private writeProps(...pairs: number[]) {
        const inner = Buffer.from([...SET_PROPERTY, pairs.length / 2, ...pairs])
        this.queueWrite(() => inner)
    }

    private writeBundle(key: BundleKey, value: number) {
        if (this.bundle.size !== BUNDLE.length) return
        // the app clears Energy Saver on any dry level change
        if (key === 'dry_level' && this.bundle.get(key) !== value) this.bundle.set('energy_saver', 0)
        this.bundle.set(key, value)
        this.queueWrite(() => {
            const body = BUNDLE.flatMap(({ prop, key, width }) => {
                const v = this.bundle.get(key)!
                return width === 2 ? [prop, v >> 8, v & 0xff] : [prop, v]
            })
            return Buffer.from([...SET_PROPERTY, BUNDLE.length, ...body])
        })
    }

    setProperty(prop: string, value: string) {
        const cycle = CYCLE.unmap(prop)
        if (cycle !== undefined) return this.writeProps(PROP_CYCLE, cycle)
        if (BUNDLE_SWITCHES.includes(prop as BundleKey)) {
            if (value === 'ON' || value === 'OFF') this.writeBundle(prop as BundleKey, value === 'ON' ? 1 : 0)
            return
        }

        if (prop === 'power') {
            if (value !== 'ON' && value !== 'OFF') return
            this.pendingPower = value
            this.writeProps(PROP_POWER, value === 'ON' ? 1 : 0)
        } else if (prop === 'buzzer') {
            const idx = BUZZER.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_BUZZER, idx)
        } else if (prop === 'dry_level') {
            const idx = DRY_LEVEL.unmap(value)
            if (idx !== undefined) this.writeBundle('dry_level', idx)
        } else if (prop === 'temp') {
            const idx = TEMP.unmap(value)
            if (idx !== undefined) this.writeBundle('temp', idx)
        } else if (prop === 'dry_time') {
            const minutes = Number(value)
            if (
                Number.isInteger(minutes) &&
                minutes >= DRY_TIME_MIN &&
                minutes <= DRY_TIME_MAX &&
                minutes % DRY_TIME_STEP === 0
            )
                this.writeBundle('dry_time', minutes)
        } else if (prop === 'cycle_optimization' || prop === 'keep_fresh') {
            if (value !== 'ON' && value !== 'OFF') return
            this.writeProps(prop === 'keep_fresh' ? PROP_KEEP_FRESH : PROP_CYCLE_OPTIMIZATION, value === 'ON' ? 1 : 0)
        } else if (prop === 'splash_screen') {
            const idx = SPLASH_SCREEN.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_SPLASH_SCREEN, idx)
        } else if (prop === 'course') {
            const code = COURSE.unmap(value)
            const downloaded = DOWNLOADED_COURSE.unmap(value)
            if (code !== undefined) this.writeProps(PROP_COURSE, code)
            else if (downloaded !== undefined)
                this.writeProps(PROP_COURSE, COURSE_DOWNLOADED, PROP_DOWNLOADED_COURSE, downloaded)
        }
    }

    processAABB(buf: Buffer) {
        if (buf.length < 2 || buf[0] !== CLASS_BYTE) return
        if (buf[1] === WRITE_REPLY_TYPE) return this.processWriteReply(buf)
        if (buf.length < 13 || buf[1] !== ENVELOPE_TYPE) return

        const innerLen = buf.readUInt16BE(INNER_LEN_OFFSET)
        switch (buf[INNER_TYPE_OFFSET]) {
            case STATUS_FRAME_TYPE:
                if (innerLen !== STATUS_INNER_LEN) return
                return this.processStatus(buf, STATUS_RECORD_OFFSET, STATUS_BUF_LEN)
            case SINGLE_STATUS_FRAME_TYPE:
                if (innerLen !== SINGLE_INNER_LEN) return
                return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_BUF_LEN)
            case EVENT_FRAME_TYPE:
                if (innerLen !== EVENT_INNER_LEN || buf.length < EVENT_PAYLOAD_OFFSET + EVENT_INNER_LEN) return
                return this.processEvent(buf.subarray(EVENT_PAYLOAD_OFFSET, EVENT_PAYLOAD_OFFSET + EVENT_INNER_LEN))
        }
    }

    private processWriteReply(buf: Buffer) {
        this.writeAnswered()
        if (buf.length <= WRITE_REPLY_RESULT_OFFSET || buf[WRITE_REPLY_PROP_OFFSET] !== PROP_POWER) return
        const value = this.pendingPower
        this.pendingPower = undefined
        if (value !== undefined && buf[WRITE_REPLY_RESULT_OFFSET] !== WRITE_REFUSED)
            this.publishProperty('power', value)
    }

    // After a remote power change the dryer may send no record, only these events.
    private processEvent(payload: Buffer) {
        this.publishProperty('power', onOff(payload[EVENT_POWER_OFFSET] !== 0))
        if (payload[EVENT_ID_OFFSET] === EVENT_ID_DOOR)
            this.publishProperty('door', onOff(payload[EVENT_DOOR_OFFSET] === DOOR_OPEN))
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF
        const course =
            rec[COURSE_OFFSET] === COURSE_DOWNLOADED
                ? DOWNLOADED_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET])
                : COURSE.map(rec[COURSE_OFFSET])

        const timedDry = rec[COURSE_OFFSET] === COURSE_TIMED_DRY
        this.bundle.set('temp', rec[TEMP_OFFSET])
        this.bundle.set('dry_level', rec[DRY_LEVEL_OFFSET])
        this.bundle.set('steam', bit(rec[OPT2_OFFSET], OPT2_STEAM))
        this.bundle.set('damp_dry_signal', bit(rec[OPT1_OFFSET], OPT1_DAMP_DRY_SIGNAL))
        this.bundle.set('energy_saver', bit(rec[OPT2_OFFSET], OPT2_ENERGY_SAVER))
        this.bundle.set('low_static', bit(rec[OPT1_OFFSET], OPT1_LOW_STATIC))
        this.bundle.set('wrinkle_care', bit(rec[OPT1_OFFSET], OPT1_WRINKLE_CARE))
        this.bundle.set('dry_time', timedDry ? rec.readUInt16BE(INITIAL_TIME_OFFSET) : 0)

        this.publishProperty('power', onOff(!isOff))
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('course', course)
        this.publishProperty('dry_level', DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('dry_time', timedDry && !isOff ? rec.readUInt16BE(INITIAL_TIME_OFFSET) : undefined)
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16BE(SPENT_POWER_OFFSET))
        this.publishProperty('drum_light', onOff((rec[OPT1_OFFSET] & OPT1_DRUM_LIGHT) !== 0))
        this.publishProperty('low_static', onOff((rec[OPT1_OFFSET] & OPT1_LOW_STATIC) !== 0))
        this.publishProperty('wrinkle_care', onOff((rec[OPT1_OFFSET] & OPT1_WRINKLE_CARE) !== 0))
        this.publishProperty('damp_dry_signal', onOff((rec[OPT1_OFFSET] & OPT1_DAMP_DRY_SIGNAL) !== 0))
        this.publishProperty('steam', onOff((rec[OPT2_OFFSET] & OPT2_STEAM) !== 0))
        this.publishProperty('energy_saver', onOff((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0))
        this.publishProperty('control_lock', onOff((rec[OPT3_OFFSET] & OPT3_CONTROL_LOCK) !== 0))
        this.publishProperty('remote_start', onOff((rec[OPT3_OFFSET] & OPT3_REMOTE_START) !== 0))
        this.publishProperty('cycle_optimization', onOff((rec[OPT4_OFFSET] & OPT4_CYCLE_OPTIMIZATION) !== 0))
        this.publishProperty('remote_maintain', onOff((rec[OPT4_OFFSET] & OPT4_REMOTE_MAINTAIN) !== 0))
        this.publishProperty('keep_fresh', onOff((rec[OPT5_OFFSET] & OPT5_KEEP_FRESH) !== 0))
        this.publishProperty('splash_screen', SPLASH_SCREEN.map(rec[SPLASH_SCREEN_OFFSET]))
    }
}
