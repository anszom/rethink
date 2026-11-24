import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { tombstone, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { STATES, DRY_LEVELS, TEMPERATURES, ERRORS } from './dryer_common'

// 0x00 while the dryer is off: the whole settings cluster clears with it. Published as 'Off' rather than
// left unmapped, which would go out as "None", the MQTT payload Home Assistant reads as unknown.
const COURSES = Enum.of({
    Off: 0x00,
    'Heavy Duty': 0x01,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': 0x12,
})

// Status query, as the other US dryers and washers send it on every connect (RV13B6ES_D_US_WIFI,
// F3L7CYK5W_US_WIFI). 0xF0ED is the family-wide "report your state" request; actuating commands are
// 0xF0E5, so this only ever reads. Confirmed on a live DLE7300WE: without it the dryer sends nothing
// but its 0x31 identity and 0x72 heartbeat frames, even mid-cycle; with it, it answers with a 0xEB
// snapshot within a second and then streams 0xEC updates.
const STATUS_REQUEST = 'F0ED1121010000001800'

// rec[17] bit 0x01: drum/blower turning. Seen as 0xa8 (stopped), 0xa9 and 0xab (turning); the 0x02 bit
// varies independently mid-cycle, so only bit 0x01 is tested.
const DRUM_RUNNING_OFFSET = 17

// rec[8]: error code (rec[7] of the sibling RV13 dryers, which count from the 0x1b marker), located by
// injecting it into a bridged simulated appliance and reading the cloud's error field.
const ERROR_OFFSET = 8
const DRUM_RUNNING_BIT = 0x01

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Ack every frame as the cloud would; this dryer is otherwise at risk of the unacked repeats and
        // dropped connections seen on the T1789EFH_F washer.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
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
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    drum_running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_running',
                        state_topic: '$this/drum_running',
                        name: 'Drum running',
                        icon: 'mdi:rotate-3d-variant',
                    },
                    cycle: tombstone('sensor'),
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMPERATURES.options,
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
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        // Off and End keep the last countdown value (1 min) in rec[4]; nothing is left to run.
        const mins = phase === STATES.unmap('Off') || phase === STATES.unmap('End') ? 0 : rec[4]

        this.publishProperty('status', STATES.map(phase))
        const error = rec[ERROR_OFFSET]
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('remaining_time', mins)
        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_running', rec[DRUM_RUNNING_OFFSET] & DRUM_RUNNING_BIT ? 'ON' : 'OFF')
        this.publishProperty('course', COURSES.map(rec[7]))
        this.publishProperty('temp', TEMPERATURES.map(rec[10]))
        this.publishProperty('dry_level', DRY_LEVELS.map(rec[9]))
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30) return

        if (buf[1] === 0xec && buf.length === 60) {
            // 0xEC: two back-to-back 29-byte records, previous then current. Consecutive frames chain:
            // each one's first record repeats the previous frame's second, and countdowns tick in the
            // second record first, so the second is the live state.
            this.processRecord(buf.subarray(31, 60))
        } else if (buf[1] === 0xeb && buf.length === 31) {
            // 0xEB: single record sent after reconnect
            this.processRecord(buf.subarray(2, 31))
        }
    }
}
