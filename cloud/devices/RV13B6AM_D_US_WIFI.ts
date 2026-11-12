import HADevice from './base'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { DRY_LEVELS, STATES, TEMPERATURES } from './dryer_common'
import { Enum } from '@/util/enum'

const DRYER_CLASS = 0x30
const STATUS_LENGTH = 29
const STATUS_MARKER = 0x1b
const PHASE_OFF = 0x00
const TIME_DRY_COURSE = 0x12
const DAMP_DRY_SIGNAL = 0x08
const WRINKLE_CARE = 0x10
const REMOTE_START = 0x01
const ENERGY_SAVER = 0x02

const TIME_DRY_MINUTES = new Map([
    [0x01, 20],
    [0x03, 40],
    [0x05, 60],
])

// These course codes and the remaining-time bytes were checked against the DLE3500W panel.
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    'Small Load': 0x09,
    Downloaded: 0x0d, // The program loaded on the captured unit.
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': TIME_DRY_COURSE,
    'Rack Dry': 0x13,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        const config = HADevice.config(meta, { name: 'LG Dryer', model: 'DLE3500W' })
        this.setConfig(
            allowExtendedType({
                ...config,
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'power',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: 'PRESS',
                        name: 'Power off',
                        icon: 'mdi:power-off',
                        availability_mode: 'all',
                        availability: [
                            ...(config.availability ?? []),
                            {
                                topic: '$this/power',
                                payload_available: 'ON',
                                payload_not_available: 'OFF',
                            },
                        ],
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
                    time_dry_setting: {
                        platform: 'sensor',
                        unique_id: '$deviceid-time_dry_setting',
                        state_topic: '$this/time_dry_setting',
                        name: 'Time Dry setting',
                        icon: 'mdi:timer-cog-outline',
                        device_class: 'duration',
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
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        icon: 'mdi:remote',
                    },
                },
            }),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power_off' && mqttValue === 'PRESS' && this.publishCache.get('power') === 'ON') {
            // Captured from the ThinQ app on this model, followed by the dryer's Off status.
            this.send(Buffer.from('F024010100', 'hex'))
        }
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, DRYER_CLASS, STATUS_LENGTH, this.processStatus)
    }

    private processStatus(status: Buffer) {
        const record = status.subarray(1)
        if (record[0] !== STATUS_MARKER) return

        const phase = record[1]
        const isOff = phase === PHASE_OFF
        const course = record[6]
        const flags = record[15]
        const options = record[16]
        // Power Off leaves the previous cycle's time in the record.
        const remainingMinutes = isOff ? 0 : record[2] * 60 + record[3]
        const timeDrySetting = !isOff && course === TIME_DRY_COURSE ? (TIME_DRY_MINUTES.get(record[10]) ?? 0) : 0

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATES.map(phase))
        this.publishProperty('course', COURSE.map(course))
        this.publishProperty('remaining_time', remainingMinutes)
        this.publishProperty('temp', TEMPERATURES.map(record[9]))
        this.publishProperty('dry_level', DRY_LEVELS.map(record[8]))
        this.publishProperty('time_dry_setting', timeDrySetting)
        this.publishProperty('more_less_time', isOff ? 0 : record.readInt8(12))
        this.publishProperty('energy_saver', options & ENERGY_SAVER ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', flags & DAMP_DRY_SIGNAL ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', flags & WRINKLE_CARE ? 'ON' : 'OFF')
        this.publishProperty('remote_start', options & REMOTE_START ? 'ON' : 'OFF')
    }
}
