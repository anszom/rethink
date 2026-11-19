import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WTX5-12W top-load washer (modelJSON "V+ 25inch for ES", country PA), matched on modelId "TLXA5CFPH"
// (thinq2 deviceType 201).
//
// Same family as TLVE5BB: the long AABB envelope carrying a previous and a current record, with the
// shared temp/spin/time/state offsets. The records are 67 bytes rather than 50, and the course, wash
// time and water level are reported as well. Codes follow the modelJSON MonitoringValue tables and were
// matched against the front panel one setting at a time.

// Same request as TLVE5BB; the washer answers with a single-record (0xEB) snapshot.
const STATUS_REQUEST = 'F0ED112101000000180411120000'

const CLASS_BYTE = 0x20
const RECORD_LEN = 67

const TEMP_OFFSET = 2
const RINSES_REMAINING_OFFSET = 3
const SPIN_OFFSET = 4
const COURSE_OFFSET = 5
const WASH_TIME_OFFSET = 8
const WATER_LEVEL_OFFSET = 9
const REMAIN_TIME_OFFSET = 14
const INITIAL_TIME_OFFSET = 16
const STATE_OFFSET = 21
const FLAGS_OFFSET = 38
const STATE_POWEROFF = 0

// bit 3 of the flags byte follows the Auto water level setting, so only bit 0 is the lid lock
const FLAG_LID_LOCK = 0x01

const STATUS = Enum.of({
    Off: 0,
    Standby: [1, 27], // +FROZEN_PREVENT_INITIAL
    Paused: [2, 28], // +FROZEN_PREVENT_PAUSE
    Detecting: 3,
    Filling: 5,
    'Detergent amount': 6,
    Delayed: 7,
    Soaking: 8,
    'Pre-wash': 9,
    Washing: [11, 29], // +FROZEN_PREVENT_RUNNING
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    End: 16,
    Refreshing: 21,
    Error: 23, // ERROR_AUTO_OFF
    'Tub cleaning': 41,
})

// The modelJSON names the courses but not their codes. These were captured by stepping through the
// course dial in both directions; the labels are the front panel's, with the modelJSON's in comments
// where they differ.
const COURSE = Enum.of({
    Duvet: 0x09, // BEDDING
    'Allergy Care': 0x2d, // SANITARY_60
    Cotton: 0x2e, // NORMAL
    'Rinse + Spin': 0x37,
    'Eco Cotton': 0x3e, // SAVING_WATER
    'Quick Wash': 0x4a, // SPEEDWASH
    'Spin Only': 0x4e,
    Delicates: 0x5e, // WOOL
    'AI Wash': 0x72,
    // which smart course was downloaded is not reported in this byte
    Downloaded: 0xff, // DOWNLOAD
})

const SPIN = Enum.of({
    'Not selected': 0,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
    'Dry Intensive': 17,
    Delicate: 18,
})

const TEMP = Enum.of({
    'Not selected': 0,
    Cold: 8,
    Warm: 9,
    Hot: 10,
})

const WASH_TIME = Enum.of({
    'Not selected': 0,
    '3 min': 1,
    '6 min': 2,
    '10 min': 3,
    '12 min': 4,
    '14 min': 5,
    '17 min': 6,
    '19 min': 7,
    '21 min': 8,
    '23 min': 9,
    '25 min': 10,
})

const WATER_LEVEL = Enum.of({
    'Level 1': 0,
    'Level 2': 1,
    'Level 3': 2,
    'Level 4': 3,
    'Level 5': 4,
    'Level 6': 5,
    'Level 7': 6,
    'Level 8': 7,
    'Level 9': 8,
    'Level 10': 9,
    'Not selected': 10,
    Auto: 11,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
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
                        device_class: 'running',
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
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSE.options,
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
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    rinses_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinses_remaining',
                        state_topic: '$this/rinses_remaining',
                        name: 'Rinses remaining',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    wash_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-wash_time',
                        state_topic: '$this/wash_time',
                        name: 'Wash time',
                        icon: 'mdi:timer-cog-outline',
                        device_class: 'enum',
                        options: WASH_TIME.options,
                    },
                    water_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-water_level',
                        state_topic: '$this/water_level',
                        name: 'Water level',
                        icon: 'mdi:waves-arrow-up',
                        device_class: 'enum',
                        options: WATER_LEVEL.options,
                    },
                    lid_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-lid_lock',
                        state_topic: '$this/lid_lock',
                        name: 'Lid lock',
                        icon: 'mdi:lock',
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
        this.processEnvelopedStatus(buf, CLASS_BYTE, RECORD_LEN, this.processStatus)
    }

    private processStatus(rec: Buffer) {
        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        // the washer keeps the last times in the record after power-off
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16LE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16LE(INITIAL_TIME_OFFSET))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('rinses_remaining', rec[RINSES_REMAINING_OFFSET])
        this.publishProperty('wash_time', WASH_TIME.map(rec[WASH_TIME_OFFSET]))
        this.publishProperty('water_level', WATER_LEVEL.map(rec[WATER_LEVEL_OFFSET]))
        this.publishProperty('lid_lock', rec[FLAGS_OFFSET] & FLAG_LID_LOCK ? 'ON' : 'OFF')
    }
}
