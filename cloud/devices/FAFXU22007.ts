import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WM6700HBA front-load washer. FAFXU25006's framing, but a 51-byte record and different
// temperature codes.
//
//     aa ff 20 0a 00 78 00 05 94 00 01 00 ec 00 66 <payload> <chk16> bb
//           │  │  └─┬─┘    └─┬─┘       │  │  └─┬─┘
//           │  │    │        │         │  │    └ buf[11:13] payload length
//           │  │    │        │         │  └ buf[10] inner type
//           │  │    │        │         └ buf[9] delivery class: 0 sent once, else repeated until acked
//           │  │    │        └ buf[5:7] sequence
//           │  │    └ buf[2:4] frame length
//           │  └ buf[1] 0a envelope
//           └ buf[0] class, 0x20
//
// Inner types: 0xEC previous + current record; 0xEB current record (status query reply); 0x03 event.

const CLASS_BYTE = 0x20
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 51

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

// The door is only an event, never in the record, and not sent at power-on:
//
//     10 0b 01 0b 10 01
//     │              │
//     │              └ 1 open, 2 shut
//     └ id 10: door (11, the panel menu, has the same length)
const EVENT_FRAME_TYPE = 0x03
const DOOR_EVENT_INNER_LEN = 6
const DOOR_EVENT_BUF_LEN = 13 + DOOR_EVENT_INNER_LEN + 1

const DOOR_EVENT_ID = 0x10
const DOOR_EVENT_ID_OFFSETS = [13, 17]
const DOOR_EVENT_VALUE_OFFSET = 18

const DOOR_OPEN = 1
const DOOR_SHUT = 2

//     aa 07 20 d8 17 <chk> bb
//              │  │
//              │  └ 0 open, else the wash count (rec[28])
//              └ ezDispense drawer
const DRAWER_FRAME_TYPE = 0xd8
const DRAWER_BUF_LEN = 3
const DRAWER_OPEN = 0

const STATUS_REQUEST = 'F0ED112101000000180411120000'

// Set property:
//
//     aa 0f f0 e5 00 02 01 ff 02 0a 4e 03 01 bb bb
//                             │  └────┬────┘
//                             │       └ (prop, value) × count; Delay Start (0x7f) takes 2 bytes, big-endian
//                             └ count
const SET_PROPERTY = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff]
const PROP_POWER = 0x02
const PROP_CYCLE = 0x03
const PROP_COURSE = 0x0a // 0xff, then PROP_DOWNLOADED_COURSE, for a downloaded course
const PROP_DOWNLOADED_COURSE = 0x0b
const PROP_BUZZER = 0x13
const PROP_CYCLE_OPTIMIZATION = 0x4c
const PROP_SPLASH_SCREEN = 0x51
const PROP_QUICK_LOAD_SENSE = 0x56

const COURSE_DOWNLOADED = 0xff
const CYCLE = Enum.of({ start: 1, pause: 2, resume: 3 })

// The app always writes these together, in this order.
const BUNDLE = [
    { prop: 0x1f, key: 'temp', width: 1 },
    { prop: 0x21, key: 'spin', width: 1 },
    { prop: 0x1e, key: 'soil', width: 1 },
    { prop: 0x20, key: 'rinse', width: 1 },
    { prop: 0x3e, key: 'steam', width: 1 },
    { prop: 0x34, key: 'pre_wash', width: 1 },
    { prop: 0x38, key: 'cold_wash', width: 1 },
    { prop: 0x35, key: 'turbo_wash', width: 1 },
    { prop: 0x44, key: 'fresh_care', width: 1 },
    { prop: 0x7f, key: 'reserve_time', width: 2 },
] as const
type BundleKey = (typeof BUNDLE)[number]['key']
const BUNDLE_SWITCHES: BundleKey[] = ['steam', 'pre_wash', 'cold_wash', 'turbo_wash', 'fresh_care']

// The app sets these with Cold Wash on and offers no soil above Medium; the washer enforces neither.
const COLD_WASH_TEMP = 14 // Cold
const COLD_WASH_SOIL = 3 // Medium

// Delay Start; 0 cancels
const RESERVE_TIME_MIN = 60
const RESERVE_TIME_MAX = 1140
const RESERVE_TIME_STEP = 30

// Write reply. Results: 0x00 accepted, 0x11 unchanged, 0x03 refused (e.g. chime while off), 0x13 busy.
//
//     aa 40 20 e6 00 02 01 ff 01 13 00 <record> <chk> bb
//                             │  └─┬─┘ │
//                             │    │   └ current status
//                             │    └ (prop, result) × count
//                             └ buf[6] count
const WRITE_REPLY_TYPE = 0xe6
const WRITE_REPLY_COUNT_OFFSET = 6
const WRITE_REFUSED = 0x03

const SOIL_OFFSET = 1
const TEMP_OFFSET = 2
const RINSE_OFFSET = 3
const SPIN_OFFSET = 4
const COURSE_OFFSET = 5
const RESERVE_TIME_OFFSET = 11 // minutes, big-endian unlike the other counts
const REMAIN_TIME_OFFSET = 14
const INITIAL_TIME_OFFSET = 16
const SPENT_POWER_OFFSET = 18 // Wh, cleared at power-on
const LOADED_COURSE_OFFSET = 20 // = rec[5], except where rec[5] is 0xff (a downloaded course)
const STATE_OFFSET = 21
const TUB_CLEAN_COUNT_OFFSET = 28
const BUZZER_OFFSET = 29
const DETERGENT_LEVEL_OFFSET = 30
const SOFTENER_LEVEL_OFFSET = 31
const DETERGENT_AMOUNT_OFFSET = 32 // mL
const SOFTENER_AMOUNT_OFFSET = 33 // mL
const DOOR_LOCK_OFFSET = 38
const SPLASH_SCREEN_OFFSET = 46
const SOFTENER_TANK_USE_OFFSET = 48

const NOZZLE_CLEAN_OFFSET = 47
const NOZZLE_CLEAN_MASK = 0x60

const OPT1_OFFSET = 34
const OPT1_COLD_WASH = 0x04
const OPT1_TURBO_WASH = 0x20
const OPT1_PRE_WASH = 0x40

const OPT2_OFFSET = 35
const OPT2_STEAM = 0x10

const OPT3_OFFSET = 36
const OPT3_FRESH_CARE = 0x40

const OPT4_OFFSET = 37
const OPT4_CONTROL_LOCK = 0x20

const OPT5_OFFSET = 39
const OPT5_DELAY_START = 0x80

const OPT6_OFFSET = 40
const OPT6_CYCLE_OPTIMIZATION = 0x08

const OPT7_OFFSET = 50
const OPT7_QUICK_LOAD_SENSE = 0x04

const STATE_POWEROFF = 0

// modelJSON state indices
const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Pause: 2,
    Detecting: 3,
    Filling: 5,
    'Detecting load': 6,
    Reserved: 7,
    Soak: 8,
    'Pre-wash': 9,
    Running: 11,
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    End: 16,
    Refreshing: 21,
    'Error auto off': 23,
    'Frozen prevent initial': 27,
    'Frozen prevent pause': 28,
    'Frozen prevent running': 29,
    'Audible diagnosis': 34,
    'Auto DT open pause': 35,
    'Confirm start for control': 36,
    'Clothing recognition': 37,
    'Detergent input': 38,
    'Softener input': 39,
    'Pollution detecting': 40,
    'Tub cleaning': 41,
    'End remote maintain on': 42,
    Steam: 43,
    'Laundry care': 47,
    'EZDispense cleaning': 48,
})

const COURSE = Enum.of({
    Allergiene: 5,
    Bedding: 13,
    'Color Care': 18,
    Delicates: 22,
    'Hand/Wool': 34,
    'Heavy Duty': 35,
    Jeans: 38,
    'Kids Wear': 39,
    Normal: 46,
    'Overnight Wash': 47,
    'Perm. Press': 48,
    'Rinse + Spin': 55,
    Sanitary: 60,
    'Small Load': 68,
    'Quick Wash': 74,
    'Spin Only': 78,
    Towels: 84,
    'Tub Clean': 85,
    'Bright Whites': 90,
    'Active Wear': 99,
    'Sweat Stains': 113,
    'AI Wash': 114,
    'ezDispense Nozzle Clean': 128,
    Swimwear: 130,
    Dresses: 131,
    'Large Load': 132,
    'X Large Load': 133,
})

// download ids, which differ from the rec[20] codes
const DOWNLOADED_COURSE_ID: Partial<Record<string, number>> = {
    'Overnight Wash': 106,
}

// 0 on courses without the setting, here and for temp and spin
const SOIL = Enum.of({
    Light: 1,
    'Medium Light': 2,
    Medium: 3,
    'Medium Heavy': 4,
    Heavy: 5,
})

const TEMP = Enum.of({
    'Tap Cold': 13,
    Cold: 14,
    Warm: 16,
    Hot: 18,
    'Extra Hot': 19,
})

const RINSE = Enum.of({
    Normal: 14,
    '+1': 15,
    '+2': 16,
    '+3': 17,
})

const SPIN = Enum.of({
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
})

const BUZZER = Enum.of({
    Off: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Very High': 4,
})

// panel order
const DISPENSE_LEVEL = Enum.of({
    Off: 0,
    Minimum: 4,
    Less: 1,
    Normal: 2,
    More: 3,
    Maximum: 5,
})

const SOFTENER_TANK_USE = Enum.of({
    Softener: 0,
    'Link Tanks': 1,
})

const NOZZLE_CLEAN = Enum.of({
    'Detergent Tank': 0x20,
    'Softener Tank': 0x40,
    'Both Tanks': 0x60,
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

const onOff = (v: boolean) => (v ? 'ON' : 'OFF')
const bit = (byte: number, mask: number) => ((byte & mask) !== 0 ? 1 : 0)

export default class Device extends AABBDevice {
    protected override readonly deliveryAcks = true

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
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
                        options: STATE.options,
                    },
                    course: {
                        platform: 'select',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        command_topic: '$this/course/set',
                        options: COURSE.options,
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
                    reserve_time: {
                        platform: 'number',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        command_topic: '$this/reserve_time/set',
                        min: 0,
                        max: RESERVE_TIME_MAX,
                        step: RESERVE_TIME_STEP,
                        mode: 'box',
                        name: 'Delay Start time',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    delay_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay Start',
                        icon: 'mdi:clock-plus-outline',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    drawer: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drawer',
                        state_topic: '$this/drawer',
                        name: 'ezDispense drawer',
                        device_class: 'opening',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // no state_class: resets at each Tub Clean
                        entity_category: 'diagnostic',
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
                    soil: {
                        platform: 'select',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        command_topic: '$this/soil/set',
                        options: SOIL.options,
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    spin: {
                        platform: 'select',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        command_topic: '$this/spin/set',
                        options: SPIN.options,
                        name: 'Spin',
                        icon: 'mdi:autorenew',
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
                    rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        command_topic: '$this/rinse/set',
                        options: RINSE.options,
                        name: 'Extra Rinse',
                        icon: 'mdi:water-sync',
                    },
                    turbo_wash: {
                        platform: 'switch',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        command_topic: '$this/turbo_wash/set',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    cold_wash: {
                        platform: 'switch',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        command_topic: '$this/cold_wash/set',
                        name: 'Cold Wash',
                        icon: 'mdi:snowflake',
                    },
                    pre_wash: {
                        platform: 'switch',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        command_topic: '$this/pre_wash/set',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        command_topic: '$this/steam/set',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    fresh_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        command_topic: '$this/fresh_care/set',
                        name: 'Fresh Care',
                        icon: 'mdi:air-filter',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control Lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    ez_dispense_detergent: {
                        platform: 'sensor',
                        unique_id: '$deviceid-ez_dispense_detergent',
                        state_topic: '$this/ez_dispense_detergent',
                        name: 'Detergent Level',
                        icon: 'mdi:cup-water',
                        device_class: 'enum',
                        options: DISPENSE_LEVEL.options,
                    },
                    ez_dispense_softener: {
                        platform: 'sensor',
                        unique_id: '$deviceid-ez_dispense_softener',
                        state_topic: '$this/ez_dispense_softener',
                        name: 'Softener Level',
                        icon: 'mdi:cup-water',
                        device_class: 'enum',
                        options: DISPENSE_LEVEL.options,
                    },
                    detergent_amount: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent_amount',
                        state_topic: '$this/detergent_amount',
                        name: 'Default detergent amount',
                        icon: 'mdi:cup-water',
                        device_class: 'volume',
                        unit_of_measurement: 'mL',
                        entity_category: 'diagnostic',
                    },
                    softener_amount: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener_amount',
                        state_topic: '$this/softener_amount',
                        name: 'Default softener amount',
                        icon: 'mdi:cup-water',
                        device_class: 'volume',
                        unit_of_measurement: 'mL',
                        entity_category: 'diagnostic',
                    },
                    softener_tank_use: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener_tank_use',
                        state_topic: '$this/softener_tank_use',
                        name: 'Softener Tank Use',
                        icon: 'mdi:link-variant',
                        device_class: 'enum',
                        options: SOFTENER_TANK_USE.options,
                        entity_category: 'diagnostic',
                    },
                    nozzle_clean_tank: {
                        platform: 'sensor',
                        unique_id: '$deviceid-nozzle_clean_tank',
                        state_topic: '$this/nozzle_clean_tank',
                        name: 'Nozzle Clean tank',
                        icon: 'mdi:spray-bottle',
                        device_class: 'enum',
                        options: NOZZLE_CLEAN.options,
                        entity_category: 'diagnostic',
                    },
                    cycle_optimization: {
                        platform: 'switch',
                        unique_id: '$deviceid-cycle_optimization',
                        state_topic: '$this/cycle_optimization',
                        command_topic: '$this/cycle_optimization/set',
                        name: 'Cycle Optimization',
                        icon: 'mdi:sort',
                        entity_category: 'config',
                    },
                    quick_load_sense: {
                        platform: 'switch',
                        unique_id: '$deviceid-quick_load_sense',
                        state_topic: '$this/quick_load_sense',
                        command_topic: '$this/quick_load_sense/set',
                        name: 'QuickLoadSense',
                        icon: 'mdi:scale',
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
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // not device_class 'lock', which is inverted
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    // BUNDLE values from the last record, plus writes not yet reflected in one
    private readonly bundle = new Map<BundleKey, number>()
    private course?: { code: number; loaded: number }

    private writeProps(...pairs: number[]) {
        const inner = Buffer.from([...SET_PROPERTY, pairs.length / 2, ...pairs])
        this.queueWrite(() => inner)
    }

    private writeBundle(key: BundleKey, value: number) {
        if (this.bundle.size !== BUNDLE.length) return
        this.bundle.set(key, value)
        if (key === 'cold_wash' && value === 1) {
            this.bundle.set('temp', COLD_WASH_TEMP)
            this.bundle.set('soil', COLD_WASH_SOIL)
        }
        this.queueWrite(() => {
            const body = BUNDLE.flatMap(({ prop, key, width }) => {
                const v = this.bundle.get(key)!
                return width === 2 ? [prop, v >> 8, v & 0xff] : [prop, v]
            })
            return Buffer.from([...SET_PROPERTY, BUNDLE.length, ...body])
        })
    }

    // The app sends Start with the course: 0a <code> 03 01.
    private writeCycle(cycle: number) {
        if (cycle !== CYCLE.unmap('start')) return this.writeProps(PROP_CYCLE, cycle)
        if (!this.course) return
        if (this.course.code !== COURSE_DOWNLOADED)
            return this.writeProps(PROP_COURSE, this.course.code, PROP_CYCLE, cycle)
        // not captured from the app
        const id = DOWNLOADED_COURSE_ID[COURSE.map(this.course.loaded) ?? '']
        if (id !== undefined)
            this.writeProps(PROP_COURSE, COURSE_DOWNLOADED, PROP_DOWNLOADED_COURSE, id, PROP_CYCLE, cycle)
    }

    setProperty(prop: string, value: string) {
        const cycle = CYCLE.unmap(prop)
        if (cycle !== undefined) return this.writeCycle(cycle)
        if (BUNDLE_SWITCHES.includes(prop as BundleKey)) {
            if (value === 'ON' || value === 'OFF') this.writeBundle(prop as BundleKey, value === 'ON' ? 1 : 0)
            return
        }
        const setting = { soil: SOIL, temp: TEMP, rinse: RINSE, spin: SPIN }[prop]
        if (setting) {
            const idx = setting.unmap(value)
            if (idx === undefined) return
            if (prop === 'soil' && this.bundle.get('cold_wash') === 1 && idx > COLD_WASH_SOIL) return
            this.writeBundle(prop as BundleKey, idx)
            return
        }

        if (prop === 'power') {
            if (value === 'ON' || value === 'OFF') this.writeProps(PROP_POWER, value === 'ON' ? 1 : 0)
        } else if (prop === 'buzzer') {
            const idx = BUZZER.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_BUZZER, idx)
        } else if (prop === 'reserve_time') {
            const minutes = Number(value)
            if (
                Number.isInteger(minutes) &&
                (minutes === 0 || (minutes >= RESERVE_TIME_MIN && minutes <= RESERVE_TIME_MAX)) &&
                minutes % RESERVE_TIME_STEP === 0
            )
                this.writeBundle('reserve_time', minutes)
        } else if (prop === 'cycle_optimization' || prop === 'quick_load_sense') {
            if (value !== 'ON' && value !== 'OFF') return
            const p = prop === 'quick_load_sense' ? PROP_QUICK_LOAD_SENSE : PROP_CYCLE_OPTIMIZATION
            this.writeProps(p, value === 'ON' ? 1 : 0)
        } else if (prop === 'splash_screen') {
            const idx = SPLASH_SCREEN.unmap(value)
            if (idx !== undefined) this.writeProps(PROP_SPLASH_SCREEN, idx)
        } else if (prop === 'course') {
            const id = DOWNLOADED_COURSE_ID[value]
            const code = COURSE.unmap(value)
            if (id !== undefined) this.writeProps(PROP_COURSE, COURSE_DOWNLOADED, PROP_DOWNLOADED_COURSE, id)
            else if (code !== undefined) this.writeProps(PROP_COURSE, code)
        }
    }

    processAABB(buf: Buffer) {
        if (buf.length < 2 || buf[0] !== CLASS_BYTE) return
        if (buf[1] === DRAWER_FRAME_TYPE) return this.processDrawer(buf)
        if (buf[1] === WRITE_REPLY_TYPE) {
            this.writeAnswered()
            if (buf.length <= WRITE_REPLY_COUNT_OFFSET) return
            const count = buf[WRITE_REPLY_COUNT_OFFSET]
            const recordOffset = WRITE_REPLY_COUNT_OFFSET + 1 + 2 * count
            for (let i = 0; i < count; i++) if (buf[WRITE_REPLY_COUNT_OFFSET + 2 + 2 * i] === WRITE_REFUSED) return
            return this.processStatus(buf, recordOffset, recordOffset + RECORD_LEN)
        }
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
                if (innerLen !== DOOR_EVENT_INNER_LEN) return
                return this.processDoorEvent(buf)
        }
    }

    // The panel menu event (id 0x11) has the same length.
    private processDoorEvent(buf: Buffer) {
        if (buf.length !== DOOR_EVENT_BUF_LEN) return
        if (DOOR_EVENT_ID_OFFSETS.some((o) => buf[o] !== DOOR_EVENT_ID)) return
        const door = buf[DOOR_EVENT_VALUE_OFFSET]
        if (door !== DOOR_OPEN && door !== DOOR_SHUT) return
        this.publishProperty('door', door === DOOR_OPEN ? 'ON' : 'OFF')
    }

    private processDrawer(buf: Buffer) {
        if (buf.length !== DRAWER_BUF_LEN) return
        this.publishProperty('drawer', buf[2] === DRAWER_OPEN ? 'ON' : 'OFF')
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF
        const course = rec[COURSE_OFFSET]

        this.course = { code: course, loaded: rec[LOADED_COURSE_OFFSET] }
        this.bundle.set('temp', rec[TEMP_OFFSET])
        this.bundle.set('spin', rec[SPIN_OFFSET])
        this.bundle.set('soil', rec[SOIL_OFFSET])
        this.bundle.set('rinse', rec[RINSE_OFFSET])
        this.bundle.set('steam', bit(rec[OPT2_OFFSET], OPT2_STEAM))
        this.bundle.set('pre_wash', bit(rec[OPT1_OFFSET], OPT1_PRE_WASH))
        this.bundle.set('cold_wash', bit(rec[OPT1_OFFSET], OPT1_COLD_WASH))
        this.bundle.set('turbo_wash', bit(rec[OPT1_OFFSET], OPT1_TURBO_WASH))
        this.bundle.set('fresh_care', bit(rec[OPT3_OFFSET], OPT3_FRESH_CARE))
        this.bundle.set('reserve_time', rec.readUInt16BE(RESERVE_TIME_OFFSET))

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('course', COURSE.map(course === COURSE_DOWNLOADED ? rec[LOADED_COURSE_OFFSET] : course))
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('rinse', RINSE.map(rec[RINSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16LE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16LE(INITIAL_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16LE(SPENT_POWER_OFFSET))
        this.publishProperty('reserve_time', rec.readUInt16BE(RESERVE_TIME_OFFSET))
        this.publishProperty('delay_start', (rec[OPT5_OFFSET] & OPT5_DELAY_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('ez_dispense_detergent', DISPENSE_LEVEL.map(rec[DETERGENT_LEVEL_OFFSET]))
        this.publishProperty('ez_dispense_softener', DISPENSE_LEVEL.map(rec[SOFTENER_LEVEL_OFFSET]))
        this.publishProperty('detergent_amount', rec[DETERGENT_AMOUNT_OFFSET])
        this.publishProperty('softener_amount', rec[SOFTENER_AMOUNT_OFFSET])
        this.publishProperty('softener_tank_use', SOFTENER_TANK_USE.map(rec[SOFTENER_TANK_USE_OFFSET]))
        this.publishProperty('nozzle_clean_tank', NOZZLE_CLEAN.map(rec[NOZZLE_CLEAN_OFFSET] & NOZZLE_CLEAN_MASK))

        const opt1 = rec[OPT1_OFFSET]
        this.publishProperty('turbo_wash', (opt1 & OPT1_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cold_wash', (opt1 & OPT1_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (opt1 & OPT1_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPT2_OFFSET] & OPT2_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPT3_OFFSET] & OPT3_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPT4_OFFSET] & OPT4_CONTROL_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cycle_optimization', (rec[OPT6_OFFSET] & OPT6_CYCLE_OPTIMIZATION) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', rec[DOOR_LOCK_OFFSET] !== 0 ? 'ON' : 'OFF')
        this.publishProperty('quick_load_sense', onOff((rec[OPT7_OFFSET] & OPT7_QUICK_LOAD_SENSE) !== 0))
        this.publishProperty('splash_screen', SPLASH_SCREEN.map(rec[SPLASH_SCREEN_OFFSET]))
    }
}
