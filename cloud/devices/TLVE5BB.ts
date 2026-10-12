import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WT21BWV6 top-load washer, matched on modelId "TLVE5BB" (thinq2 deviceType 201).
//
// The appliance uses the long AABB envelope also seen on FAFXU25006, but its 0xEC frames contain two
// 50-byte records rather than two 72-byte records. The first record is the previous state and the
// second is current. The core state and time offsets match LG's newer washer layout.

const STATUS_REQUEST = 'F0ED112101000000180411120000'

const CLASS_BYTE = 0x20
const RECORD_LEN = 50

const SOIL_OFFSET = 1
const TEMP_OFFSET = 2
const RINSES_REMAINING_OFFSET = 3
const SPIN_OFFSET = 4
const REMAIN_TIME_OFFSET = 14
const INITIAL_TIME_OFFSET = 16
const ENERGY_OFFSET = 18
const STATE_OFFSET = 21
const TUB_CLEAN_COUNT_OFFSET = 28
const BUZZER_OFFSET = 29
const LID_LOCK_OFFSET = 38
const STATE_POWEROFF = 0

const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Pause: 2,
    Detecting: 3,
    'Add drain': 5,
    'Detergent amount': 6,
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
    'Dry cooling': 52,
})

const SOIL = Enum.of({
    Light: 1,
    'Light/Normal': 2,
    Normal: 3,
    'Normal/Heavy': 4,
    Heavy: 5,
    'Pre-wash': 6,
    Soaking: 7,
    TurboWash: 8,
    'Time save': 9,
    Intensive: 10,
})

const SPIN = Enum.of({
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
    'Dry Intensive': 17,
    Delicate: 18,
})

const TEMP = Enum.of({
    Cold: 8,
    Warm: 9,
    Hot: 10,
    'Cold/Hot': 12,
})

const BUZZER = Enum.of({
    Off: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Very loud': 4,
})

export default class Device extends AABBDevice {
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
                        device_class: 'running',
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
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL.options,
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
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        entity_category: 'diagnostic',
                    },
                    buzzer: {
                        platform: 'sensor',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        device_class: 'enum',
                        options: BUZZER.options,
                        entity_category: 'diagnostic',
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
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16LE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16LE(INITIAL_TIME_OFFSET))
        this.publishProperty('energy', rec.readUInt16LE(ENERGY_OFFSET))
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('rinses_remaining', rec[RINSES_REMAINING_OFFSET])
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('lid_lock', rec[LID_LOCK_OFFSET] !== 0 ? 'ON' : 'OFF')
    }
}
