import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import type { Device as ThinQ2Device } from '../thinq2/device'
import AABBDevice from './aabb_device'
import HADevice from './base'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'

// The WM3500CW uses the same status layout as F3L7CYK5W_US_WIFI: a prefix byte
// followed by a 25-byte record starting with 0x18. In 0xEC frames the second
// block is current and the first matches the preceding frame's current block.
const STATUS_LENGTH = 26
const RECORD_MARKER = 0x18
const STATUS_REQUEST = Buffer.from('F0ED1121010000001800', 'hex')
const PHASE_OFF = 0
const PHASE_STANDBY = 5
const PHASE_PAUSED = 6
const PHASE_DETECTING = 20
const PHASE_WASHING = 23
const PHASE_RINSING = 30
const PHASE_RINSE_HOLD = 31
const PHASE_SPINNING = 40
const PHASE_END = 60
const PAUSABLE_PHASES = new Set([PHASE_DETECTING, PHASE_WASHING, PHASE_RINSING, PHASE_RINSE_HOLD, PHASE_SPINNING])
const RINSE_COUNT_OFFSET = 11
const RINSE_COUNT_MASK = 0x0f
const DELAY_HOURS_OFFSET = 13
const DELAY_MINUTES_OFFSET = 14
const WASH_FLAGS_OFFSET = 15
const CONTROL_LOCK = 0x01
const DELAY_WASH = 0x02
const PRE_WASH = 0x08
const RINSE_SPIN = 0x20
const EXTRA_RINSE = 0x40
const CARE_FLAGS_OFFSET = 16
const FRESH_CARE = 0x01
const COLD_WASH = 0x10
const DOOR_LOCKED = 0x80
const LATCH_FLAGS_OFFSET = 17
const DOOR_LATCHED = 0x02
const TUB_CLEAN_COUNT_OFFSET = 22

// Frames sent by the ThinQ app, without the outer AABB framing. Start and
// Resume carry the Normal recipe. Pause and Power off carry no cycle settings.
const REMOTE_CONTROLS = new Map([
    [
        'power_off',
        { name: 'Power off', icon: 'mdi:power-off', availableOn: 'power', request: Buffer.from('f024010100', 'hex') },
    ],
    [
        'start_normal',
        {
            name: 'Start Normal',
            icon: 'mdi:play',
            availableOn: 'remote_start_ready',
            request: Buffer.from('f026050305040000000080200600000000000000000000', 'hex'),
        },
    ],
    [
        'pause',
        {
            name: 'Pause',
            icon: 'mdi:pause',
            availableOn: 'pause_available',
            request: Buffer.from('f024040100', 'hex'),
        },
    ],
    [
        'resume',
        {
            name: 'Resume Normal',
            icon: 'mdi:play',
            availableOn: 'resume_available',
            request: Buffer.from('f026050305040200000080000600000000000000000000', 'hex'),
        },
    ],
])

const COURSE_OFFSET = 6
// Resume includes the settings. Compare the whole settings block against the
// captured paused Normal cycle so a resume does not overwrite other settings.
const NORMAL_RESUME_SETTINGS = Buffer.from('05000305040200000000', 'hex')

// Phase and setting indices come from this model's MonitoringValue definitions.
const STATUS = Enum.of({
    Off: PHASE_OFF,
    Standby: PHASE_STANDBY,
    Paused: PHASE_PAUSED,
    Error: 7,
    Delayed: 10,
    Detecting: PHASE_DETECTING,
    'Detergent amount': 22,
    Washing: PHASE_WASHING,
    Rinsing: PHASE_RINSING,
    'Rinse hold': PHASE_RINSE_HOLD,
    Spinning: PHASE_SPINNING,
    End: PHASE_END,
    Refreshing: 61,
    'Smart Diagnosis': 79,
})

// All ten codes were matched to the labels in a dial sweep on the WM3500CW.
const COURSE = Enum.of({
    'Tub Clean': 0x01,
    Whites: 0x02,
    Bedding: 0x03,
    'Heavy Duty': 0x04,
    Normal: 0x05,
    'Perm. Press': 0x06,
    Delicates: 0x07,
    Towels: 0x08,
    'Speed Wash': 0x09,
    Downloaded: 0x0a,
})

const SOIL = Enum.of({
    Light: 1,
    'Light-Normal': 2,
    Normal: 3,
    'Normal-Heavy': 4,
    Heavy: 5,
})

const SPIN = Enum.of({
    'No Spin': 1,
    Low: 2,
    Medium: 3,
    High: [4, 5], // Both ThinQ codes use the High label on the WM3500CW panel.
})

const TEMPERATURE = Enum.of({
    'Tap Cold': 1,
    Cold: 2,
    'Semi Warm': 3,
    Warm: [4, 5],
    Hot: 6,
    'Extra Hot': 7,
})

export default class Device extends AABBDevice {
    constructor(ha: Connection, thinq: ThinQ2Device, meta: Metadata) {
        super(ha, thinq, true)
        const config = HADevice.config(meta, { name: 'LG Washer', model: 'WM3500CW' })
        const buttons = Object.fromEntries(
            Array.from(REMOTE_CONTROLS, ([property, control]) => [
                property,
                {
                    platform: 'button',
                    unique_id: `$deviceid-${property}`,
                    command_topic: `$this/${property}/set`,
                    payload_press: 'PRESS',
                    name: control.name,
                    icon: control.icon,
                    availability: [
                        ...(config.availability ?? []),
                        {
                            topic: `$this/${control.availableOn}`,
                            payload_available: 'ON',
                            payload_not_available: 'OFF',
                        },
                    ],
                    availability_mode: 'all',
                },
            ]),
        )
        this.setConfig(
            allowExtendedType({
                ...config,
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        device_class: 'power',
                    },
                    ...buttons,
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        device_class: 'enum',
                        options: COURSE.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'enum',
                        options: TEMPERATURE.options,
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse_count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinses remaining',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra Rinse',
                        icon: 'mdi:water-plus',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra Rinse count',
                        icon: 'mdi:water-plus',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre Wash',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control Lock',
                        icon: 'mdi:lock-outline',
                    },
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse+Spin',
                        icon: 'mdi:water-sync',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'Fresh Care',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'ColdWash',
                        icon: 'mdi:snowflake',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash time',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                        // Keep fractional hours slightly above the minute boundary that HA floors to.
                        value_template:
                            '{% set minutes = value | int %}{{ (minutes / 60 + 0.0001) | round(4) if minutes % 60 else minutes / 60 }}',
                        suggested_display_precision: 4,
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since Tub Clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    remote_start_ready: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start_ready',
                        state_topic: '$this/remote_start_ready',
                        name: 'Remote Start ready',
                        icon: 'mdi:remote',
                    },
                },
            }),
        )
    }

    start() {
        // Use the read-only status request from the washer with the same record layout.
        this.send(STATUS_REQUEST)
    }

    setProperty(property: string, value: string) {
        if (value !== 'PRESS') return
        const control = REMOTE_CONTROLS.get(property)
        if (control && this.publishCache.get(control.availableOn) === 'ON') this.send(control.request)
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, 0x20, STATUS_LENGTH, this.processStatus)
    }

    private processStatus(block: Buffer) {
        const record = block.subarray(1)
        if (record[0] !== RECORD_MARKER) return

        const phase = record[1]
        const poweredOff = phase === PHASE_OFF
        const clearTimers = poweredOff || phase === PHASE_END

        this.publishProperty('power', poweredOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(phase))
        this.publishProperty('remaining_time', clearTimers ? 0 : record[2] * 60 + record[3])
        this.publishProperty('initial_time', clearTimers ? 0 : record[4] * 60 + record[5])
        this.publishProperty('course', COURSE.map(record[COURSE_OFFSET]))
        this.publishProperty('soil', SOIL.map(record[8]))
        this.publishProperty('spin', SPIN.map(record[9]))
        this.publishProperty('temp', TEMPERATURE.map(record[10]))
        this.publishProperty('tub_clean_count', record[TUB_CLEAN_COUNT_OFFSET])
        const rinse = record[RINSE_COUNT_OFFSET]
        this.publishProperty('rinse_count', rinse & RINSE_COUNT_MASK)
        this.publishProperty('extra_rinse_count', rinse >> 4)

        const washFlags = record[WASH_FLAGS_OFFSET]
        const delayWash = (washFlags & DELAY_WASH) !== 0
        this.publishProperty('delay_wash', delayWash ? 'ON' : 'OFF')
        this.publishProperty(
            'reserve_time',
            delayWash ? record[DELAY_HOURS_OFFSET] * 60 + record[DELAY_MINUTES_OFFSET] : 0,
        )
        this.publishProperty('pre_wash', (washFlags & PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse', (washFlags & EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (washFlags & CONTROL_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', (washFlags & RINSE_SPIN) !== 0 ? 'ON' : 'OFF')

        const careFlags = record[CARE_FLAGS_OFFSET]
        this.publishProperty('fresh_care', (careFlags & FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cold_wash', (careFlags & COLD_WASH) !== 0 ? 'ON' : 'OFF')
        const doorLocked = (careFlags & DOOR_LOCKED) !== 0
        this.publishProperty('door_lock', doorLocked ? 'ON' : 'OFF')
        // Arming Remote Start sets the lock bit in standby. The separate
        // latch bit followed before the ThinQ app started the cycle.
        const doorLatched = (record[LATCH_FLAGS_OFFSET] & DOOR_LATCHED) !== 0
        this.publishProperty('remote_start_ready', phase === PHASE_STANDBY && doorLocked && doorLatched ? 'ON' : 'OFF')
        this.publishProperty('pause_available', PAUSABLE_PHASES.has(phase) && doorLocked ? 'ON' : 'OFF')
        const canResume =
            phase === PHASE_PAUSED &&
            careFlags === DOOR_LOCKED &&
            record.subarray(COURSE_OFFSET, CARE_FLAGS_OFFSET).equals(NORMAL_RESUME_SETTINGS)
        this.publishProperty('resume_available', canResume ? 'ON' : 'OFF')
    }
}
