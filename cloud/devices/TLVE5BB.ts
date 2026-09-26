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

const CLASS_BYTE = 0x20
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 50
const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_INNER_LEN = RECORD_LEN
const SINGLE_STATUS_RECORD_OFFSET = 13
const SINGLE_STATUS_BUF_LEN = 13 + SINGLE_STATUS_INNER_LEN + 1

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
const STATE_END = 16

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
    None: 0,
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
    None: 0,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
    'Dry Intensive': 17,
    Delicate: 18,
})

const TEMP = Enum.of({
    None: 0,
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
    private lastState: number | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
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
                        name: 'Total time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Cycle energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Wash strength',
                        icon: 'mdi:waves',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Water temperature',
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
                        name: 'Cycles',
                        icon: 'mdi:counter',
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
                    notification: {
                        platform: 'event',
                        unique_id: '$deviceid-notification',
                        state_topic: '$this/notification',
                        name: 'Notification',
                        icon: 'mdi:message-badge-outline',
                        event_types: ['washing_is_complete'],
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf.length < 13 || buf[0] !== CLASS_BYTE || buf[1] !== ENVELOPE_TYPE) return

        const innerLen = buf.readUInt16BE(INNER_LEN_OFFSET)
        switch (buf[INNER_TYPE_OFFSET]) {
            case STATUS_FRAME_TYPE:
                if (buf.length !== STATUS_BUF_LEN || innerLen !== STATUS_INNER_LEN) return
                return this.processStatus(buf, STATUS_RECORD_OFFSET)
            case SINGLE_STATUS_FRAME_TYPE:
                if (buf.length !== SINGLE_STATUS_BUF_LEN || innerLen !== SINGLE_STATUS_INNER_LEN) return
                return this.processStatus(buf, SINGLE_STATUS_RECORD_OFFSET)
        }
    }

    private processStatus(buf: Buffer, recordOffset: number) {
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)
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

        if (this.lastState !== undefined && this.lastState !== STATE_END && state === STATE_END) {
            this.HA.publishProperty(this.id, 'notification', JSON.stringify({ event_type: 'washing_is_complete' }))
        }
        this.lastState = state
    }
}
