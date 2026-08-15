import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const DISHWASHER_STATES: Record<number, string> = {
    1: 'INITIAL',
    2: 'RUNNING',
    3: 'PAUSE',
    4: 'STANDBY',
}

const COURSES: Record<number, string> = {
    0x00: 'OFF',
    0x01: 'AUTO',
    0x12: 'ONE_HOUR',
    0x05: 'NORMAL/ECO',
    0x02: 'HEAVY/INTENSIVE',
    0x10: 'SILENT_NIGHT',
    0x08: 'EXPRESS',
    0x0b: 'DOWNLOAD_CYCLE',
    0x09: 'MACHINE_CLEAN',
}

const SMART_COURSES: Record<number, string> = {
    0x05: 'GREASY_TABLEWARE',
    0x0d: 'MACHINE_CLEAN',
    0x0f: 'PLASTIC_WASH',
}

const RINSE_LEVELS: Record<number, string> = {
    0x00: 'OFF',
    0x10: 'LEVEL_1',
    0x20: 'LEVEL_2',
    0x30: 'LEVEL_3',
}

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Dishwasher' })

        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    state: {
                        platform: 'sensor',
                        icon: 'mdi:washing-machine',
                        unique_id: '$deviceid-state',
                        state_topic: '$this/state',
                        name: 'State',
                    },
                    course: {
                        platform: 'sensor',
                        icon: 'mdi:dishwasher',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                    },
                    remain_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer-sand',
                        unique_id: '$deviceid-remain_time',
                        state_topic: '$this/remain_time',
                        name: 'Remain Time',
                        unit_of_measurement: 'min',
                    },
                    course_time: {
                        platform: 'sensor',
                        icon: 'mdi:timer',
                        unique_id: '$deviceid-course_time',
                        state_topic: '$this/course_time',
                        name: 'Course Time',
                        unit_of_measurement: 'min',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        payload_on: 'OPEN',
                        payload_off: 'CLOSE',
                    },
                    high_temp_dry: {
                        platform: 'binary_sensor',
                        icon: 'mdi:weather-sunny',
                        unique_id: '$deviceid-high_temp_dry',
                        state_topic: '$this/high_temp_dry',
                        name: 'High Temp Dry',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    sterilize: {
                        platform: 'binary_sensor',
                        icon: 'mdi:thermometer-high',
                        unique_id: '$deviceid-sterilize',
                        state_topic: '$this/sterilize',
                        name: 'Sterilize',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    rinse_level: {
                        platform: 'sensor',
                        icon: 'mdi:water-plus',
                        unique_id: '$deviceid-rinse_level',
                        state_topic: '$this/rinse_level',
                        name: 'Rinse Level',
                    },
                    delay_start: {
                        platform: 'sensor',
                        icon: 'mdi:clock-fast',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay Start (Hours)',
                        unit_of_measurement: 'h',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        icon: 'mdi:remote',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                },
            }),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02616', 'hex')) // Wake Up
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F02612', 'hex')) // Immediate Power Off
            }
        }
    }

    processAABB(buf: Buffer) {
        if (buf[0] === 0x32 && buf[1] === 0xec) {
            const payloadLen = buf.length - 2
            const halfLen = Math.floor(payloadLen / 2)
            if (halfLen > 10) {
                const curStatus = buf.subarray(2 + halfLen, buf.length)
                this.processStatus(curStatus)
            }
        }
    }

    processStatus(curStatus: Buffer) {
        if (curStatus[0] === 0x00 && curStatus[1] === 0x18) {
            const data = curStatus.subarray(2, 26) // 24 bytes

            const stateCode = data[0]
            const processCode = data[1]
            const stateStr = DISHWASHER_STATES[stateCode] || `UNKNOWN(${stateCode})`

            // 전원 상태는 STANDBY(4) 이거나 취소 중(processCode: 0x63)일 때 OFF로 처리하여 스위치 튕김 방지
            const isPowerOff = stateCode === 4 || processCode === 0x63

            this.publishProperty('state', stateStr)
            this.publishProperty('power', isPowerOff ? 'OFF' : 'ON')

            // Course (Index 5)
            const baseCourseCode = data[5]
            const smartCourseCode = data[20]

            let courseStr = ''
            if (smartCourseCode !== 0) {
                // If a smart course is active, use it instead of the base course
                courseStr =
                    SMART_COURSES[smartCourseCode] ||
                    `DOWNLOAD_COURSE(0x${smartCourseCode.toString(16).padStart(2, '0')})`
            } else {
                courseStr = COURSES[baseCourseCode] || `UNKNOWN(0x${baseCourseCode.toString(16).padStart(2, '0')})`
            }

            this.publishProperty('course', courseStr)

            // Initial(Course) Time (Index 3: hour, Index 4: minute)
            const initialHour = data[3]
            const initialMinute = data[4]
            this.publishProperty('course_time', initialHour * 60 + initialMinute)

            // Remain Time (Index 7: hour, Index 8: minute)
            const remainHour = data[7]
            const remainMinute = data[8]
            this.publishProperty('remain_time', remainHour * 60 + remainMinute)

            // Delay Start Hour (Index 9)
            const delayHour = data[9]
            this.publishProperty('delay_start', delayHour)

            // Door (Index 11 bit 0x02)
            const isDoorOpen = (data[11] & 0x02) !== 0
            this.publishProperty('door', isDoorOpen ? 'OPEN' : 'CLOSE')

            // High Temp Dry (Index 12 bit 0x04)
            const isExtraDry = (data[12] & 0x04) !== 0
            this.publishProperty('high_temp_dry', isExtraDry ? 'ON' : 'OFF')

            // Sterilize (Index 12 bit 0x08)
            const isHighTemp = (data[12] & 0x08) !== 0
            this.publishProperty('sterilize', isHighTemp ? 'ON' : 'OFF')

            // Remote Start (Index 15 bit 0x02)
            const isRemoteStart = (data[15] & 0x02) !== 0
            this.publishProperty('remote_start', isRemoteStart ? 'ON' : 'OFF')

            // Rinse Level (Index 21)
            const rinseCode = data[21]
            const rinseStr = RINSE_LEVELS[rinseCode] || `UNKNOWN(${rinseCode})`
            this.publishProperty('rinse_level', rinseStr)
        }
    }
}
