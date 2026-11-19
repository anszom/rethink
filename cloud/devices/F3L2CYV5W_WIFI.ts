import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { COURSE, SOIL, SPIN, STATUS, TEMP } from './F3L7CYK5W_US_WIFI'

// LG WM3700HVA front-load washer (ThinQ1, deviceType 201, QC_Modem_1.2.75 firmware). Its 24-byte status
// frame is the F3L7CYK5W_US_WIFI record without the leading 0x18 marker, so every offset here is one
// lower, and the status and course tables are shared. Fields were confirmed against this washer's
// panel: one full Normal cycle and a sweep of all twelve dial positions.

const STATUS_LENGTH = 24

const PHASE_OFFSET = 0
const TIME_HOUR_OFFSET = 1
const TIME_MIN_OFFSET = 2
const INITIAL_TIME_HOUR_OFFSET = 3
const INITIAL_TIME_MIN_OFFSET = 4
const COURSE_OFFSET = 5
const SOIL_OFFSET = 7
const SPIN_OFFSET = 8
const TEMP_OFFSET = 9
// The low nibble is the rinse count; the sibling's high nibble is its extra-rinse setting.
const RINSE_OFFSET = 10
// Washes since the last Tub Clean. Persists across power-off, unlike the previous-phase byte 19.
const TCL_COUNT_OFFSET = 21

const PHASE_OFF = 0x00
const PHASE_COMPLETE = 0x3c

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id, meta.modelId)
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
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL.options,
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
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse_count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinses remaining',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since Tub Clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => {
            if (buf.length !== STATUS_LENGTH) return

            const phase = buf[PHASE_OFFSET]
            const isOff = phase === PHASE_OFF
            // The raw time bytes park on a stale 1 minute at Off and at Complete.
            const idle = isOff || phase === PHASE_COMPLETE

            this.publishProperty('power', isOff ? 'OFF' : 'ON')
            this.publishProperty('status', STATUS.map(phase))
            this.publishProperty('course', COURSE.map(buf[COURSE_OFFSET]))
            this.publishProperty('remaining_time', idle ? 0 : buf[TIME_HOUR_OFFSET] * 60 + buf[TIME_MIN_OFFSET])
            this.publishProperty(
                'initial_time',
                idle ? 0 : buf[INITIAL_TIME_HOUR_OFFSET] * 60 + buf[INITIAL_TIME_MIN_OFFSET],
            )
            this.publishProperty('soil', SOIL.map(buf[SOIL_OFFSET]))
            this.publishProperty('spin', SPIN.map(buf[SPIN_OFFSET]))
            this.publishProperty('temp', TEMP.map(buf[TEMP_OFFSET]))
            this.publishProperty('rinse_count', buf[RINSE_OFFSET] & 0x0f)
            this.publishProperty('tub_clean_count', buf[TCL_COUNT_OFFSET])
        })
    }

    // The washer drops off the network after it powers down, and monitoring doesn't survive that, so
    // this runs on every reconnect.
    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }
}
