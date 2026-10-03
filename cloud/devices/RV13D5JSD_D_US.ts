import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG DLEX4200B electric dryer, matched on modelId "RV13D5JSD_D_US" (ThinQ2 deviceType 202).
// The wire format is the same 29-byte AABB record family used by the RV13B6 dryers:
//   0x30EC  two records, with the current state at buf[32:]
//   0x30EB  one current-state record at buf[3:], normally sent after reconnect
//
// Course, option, timer and phase mappings below were captured from this appliance. The test data
// includes two complete Normal cycles, a full physical dial walk, and isolated option toggles. The
// Downloaded dial position contains a user-selected course and therefore reports that underlying
// course code; with the factory default download installed, it correctly reported Normal (0x03).

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 60
const RECORD_B_OFFSET = 32

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 31
const SINGLE_RECORD_OFFSET = 3

// Family-wide read-only status request. These dryers otherwise report only when something changes.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Offsets are relative to the record's 0x1b marker.
const PHASE_OFFSET = 1
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
const COURSE_OFFSET = 6
const DRY_LEVEL_OFFSET = 8
const TEMP_OFFSET = 9
const TIME_DRY_SETTING_OFFSET = 10
const SIGNAL_OFFSET = 11
const MORE_LESS_TIME_OFFSET = 12
const FLAGS_OFFSET = 15
const OPT2_OFFSET = 16
const LOAD_ITEM_OFFSET = 23

const FLAG_REDUCE_STATIC = 0x02
const FLAG_DAMP_DRY_SIGNAL = 0x08
const FLAG_WRINKLE_CARE = 0x10

const OPT2_ENERGY_SAVER = 0x02
const OPT2_TURBO_STEAM = 0x04

const PHASE_OFF = 0x00
const PHASE_END = 0x04
const PHASE_WRINKLE_CARE = 0x38

const STATUS = Enum.of({
    Off: 0x00,
    Initial: 0x01,
    Pause: 0x03,
    End: 0x04,
    Drying: 0x32,
    Cooling: 0x33,
    'Wrinkle Care': 0x38,
})

// Captured by starting at Normal, walking the physical selector counter-clockwise through every
// position, returning to Normal, then powering off. Time Dry is entered from its panel button.
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    Antibacterial: 0x08,
    'Small Load': 0x09,
    Sportswear: 0x0b,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': 0x12,
    'Steam Fresh': 0x15,
    'Steam Sanitary': 0x16,
})

const DRY_LEVEL = Enum.of({
    Damp: 1,
    Less: 2,
    Normal: 3,
    More: 4,
    Very: 5,
})

const TEMP = Enum.of({
    'Ultra Low': 1,
    Low: 2,
    Medium: 3,
    'Mid High': 4,
    High: 5,
})

// On this panel the captured walk showed High (4) and Off (0). Value 1 is retained from the
// identical sibling record layout so a future Low setting is decoded rather than exposed as unknown.
const SIGNAL = Enum.of({
    Off: 0,
    Low: 1,
    High: 4,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Run state',
                        icon: 'mdi:state-machine',
                    },
                    dry_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dry_completed',
                        state_topic: '$this/dry_completed',
                        name: 'Dry completed',
                        icon: 'mdi:check-circle',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Current course',
                        icon: 'mdi:format-list-bulleted',
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
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVEL.options,
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
                    time_dry_setting: {
                        platform: 'sensor',
                        unique_id: '$deviceid-time_dry_setting',
                        state_topic: '$this/time_dry_setting',
                        name: 'Time Dry setting',
                        icon: 'mdi:timer-cog-outline',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    more_less_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-more_less_time',
                        state_topic: '$this/more_less_time',
                        name: 'More/Less time',
                        icon: 'mdi:plus-minus-variant',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    signal: {
                        platform: 'sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell-outline',
                        device_class: 'enum',
                        options: SIGNAL.options,
                        entity_category: 'diagnostic',
                    },
                    reduce_static: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-reduce_static',
                        state_topic: '$this/reduce_static',
                        name: 'Reduce static',
                        icon: 'mdi:flash-off-outline',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    turbo_steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_steam',
                        state_topic: '$this/turbo_steam',
                        name: 'TurboSteam',
                        icon: 'mdi:kettle-steam',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    load_item: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_item',
                        state_topic: '$this/load_item',
                        name: 'Load items',
                        icon: 'mdi:tshirt-crew-outline',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0xE2 is an idle snapshot containing stale in-cycle values after completion, so it is ignored.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== 0x1b) return

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF
        const isEnd = phase === PHASE_END
        const isWrinkleCare = phase === PHASE_WRINKLE_CARE
        const cycleComplete = isEnd || isWrinkleCare

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(phase) ?? 'Running')
        this.publishProperty('course', isOff ? undefined : COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty(
            'remaining_time',
            isOff || cycleComplete ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET],
        )
        this.publishProperty(
            'initial_time',
            isOff || cycleComplete ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('dry_level', DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('signal', SIGNAL.map(rec[SIGNAL_OFFSET]))
        this.publishProperty('more_less_time', isOff ? 0 : rec.readInt8(MORE_LESS_TIME_OFFSET))
        this.publishProperty('load_item', rec[LOAD_ITEM_OFFSET])

        // The setting code walks 1..5 for 20, 30, 40, 50 and 60 minutes respectively.
        const timeDryCode = rec[TIME_DRY_SETTING_OFFSET]
        this.publishProperty(
            'time_dry_setting',
            rec[COURSE_OFFSET] === 0x12 && timeDryCode >= 1 && timeDryCode <= 5 ? (timeDryCode + 1) * 10 : 0,
        )

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('reduce_static', (flags & FLAG_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (flags & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_steam', (opt2 & OPT2_TURBO_STEAM) !== 0 ? 'ON' : 'OFF')

        // Keep completion latched through the automatic power-off, matching ThinQ's behavior. A new
        // non-Off state clears it. On a cold decoder start, an Off snapshot initializes it OFF.
        if (cycleComplete) this.publishProperty('dry_completed', 'ON')
        else if (!isOff || !this.publishCache.has('dry_completed')) this.publishProperty('dry_completed', 'OFF')
    }
}
