import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'
import {
    FLAG1_DOOR_OPEN,
    OPTION_EXTRA_DRY,
    OPTION_HIGH_TEMP,
    PROCESS_STATES,
    APPLIANCE_STATES,
    unpackStatus,
} from './dishwasher_common'

// LG D30 ThinQ dishwasher (deviceType 204), sold as the LDT54788D (US).
//
// Based on the D0211 handler by @Stinocon (github.com/Stinocon/rethink-dishwasher): same
// record layout and status-push request, with the fields re-verified against captures and
// panel photos of an LDT54788D. See the processAABB comment for the field layout.
//

const CLASS_BYTE = 0x32
// [flag][0x18 length] + 24-byte status body
const STATUS_RECORD_LENGTH = 26

// The LDT54788D's panel names; codes verified as listed in the processAABB comment.
const COURSES = Enum.of({
    Off: 0x00,
    Auto: 0x01,
    Heavy: 0x02,
    Delicate: 0x03,
    Turbo: 0x04,
    Normal: 0x05,
    Rinse: 0x06,
    Express: 0x08,
    'Machine Clean': 0x09,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dishwasher' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:dishwasher',
                        device_class: 'enum',
                        options: APPLIANCE_STATES.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:playlist-play',
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    process: {
                        platform: 'sensor',
                        unique_id: '$deviceid-process',
                        state_topic: '$this/process',
                        name: 'Process',
                        icon: 'mdi:progress-clock',
                        device_class: 'enum',
                        options: PROCESS_STATES.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    rinse_refill: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_refill',
                        state_topic: '$this/rinse_refill',
                        name: 'Rinse refill',
                        icon: 'mdi:cup-water',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy saver',
                        icon: 'mdi:leaf',
                    },
                    half_load: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-half_load',
                        state_topic: '$this/half_load',
                        name: 'Half load',
                        icon: 'mdi:package-variant-closed-minus',
                    },
                    extra_dry: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_dry',
                        state_topic: '$this/extra_dry',
                        name: 'Extra dry',
                        icon: 'mdi:weather-sunny',
                    },
                    high_temp: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-high_temp',
                        state_topic: '$this/high_temp',
                        name: 'High temp',
                        icon: 'mdi:thermometer-high',
                    },
                    tub_clean_counter: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_counter',
                        state_topic: '$this/tub_clean_counter',
                        name: 'Tub clean counter',
                        icon: 'mdi:counter',
                        state_class: 'measurement',
                    },
                    delay_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay start',
                        icon: 'mdi:clock-plus-outline',
                    },
                    delay_start_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_start_time',
                        state_topic: '$this/delay_start_time',
                        name: 'Delay start time',
                        icon: 'mdi:clock-fast',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    night_dry: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-night_dry',
                        state_topic: '$this/night_dry',
                        name: 'Night dry',
                        icon: 'mdi:weather-night',
                    },
                    dual_zone: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dual_zone',
                        state_topic: '$this/dual_zone',
                        name: 'Dual zone',
                        icon: 'mdi:view-split-horizontal',
                    },
                },
            }),
        )
    }

    // Status query on connect, verified 2026-09-17 via bridge capture: the LG
    // cloud sends `f0ed1121010000001800` (identical to the washers) to make the
    // device push its current status.
    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    // HA rejects any value outside the declared options, so an undecoded byte is published as
    // undefined — which reaches HA as 'None' — rather than as a raw code. The code goes to the
    // log, where it is useful for extending the table.
    static formatStatus(value: number) {
        const name = APPLIANCE_STATES.map(value)
        if (name === undefined) log('D30', 'undecoded status', value.toString(16))
        return name
    }

    static formatProcess(value: number) {
        const name = PROCESS_STATES.map(value)
        if (name === undefined) log('D30', 'undecoded process', value.toString(16))
        return name
    }

    static formatCourse(value: number) {
        const name = COURSES.map(value)
        if (name === undefined) log('D30', 'undecoded course', value.toString(16))
        return name
    }

    // Status frame follows the common 0xeb/0xec scheme. Each record is [flag][0x18 length] followed
    // by the status body; offsets below are relative to that body:
    //   [0]      state
    //   [1]      process
    //   [3]/[4]  initial time   (hour, minute)   e.g. 03 05 = 3:05 (Intensive)
    //   [5]      course
    //   [7]/[8]  remaining time (hour, minute)   e.g. 02 35 = 2:53, 1/min countdown
    //   [9]/[10] Delay Start time remaining (hour, minute)
    //   [11]     status bitfield:
    //              bit 0 (0x01) = child lock
    //              bit 1 (0x02) = door open
    //              bit 3 (0x08) = rinse aid refill
    //              bit 7 (0x80) = Night Dry
    //   [12]     options bitfield:
    //              bit 0 (0x01) = Delay Start
    //              bit 1 (0x02) = energy saver
    //              bit 2 (0x04) = extra dry
    //              bit 3 (0x08) = high temp,
    //              bit 4 (0x10) = dual zone
    // Still TODO: error codes.
    processAABB(buf: Buffer) {
        // Exact lengths: a 194-byte 0xec was seen once, at cycle end, next to the 0xe1 summary; it
        // doesn't follow the two-record layout (reading it as one briefly reported Off with a zero
        // initial time).
        if (this.processCommonStatus(buf, CLASS_BYTE, STATUS_RECORD_LENGTH, this.processStatus)) return

        if (buf[0] === CLASS_BYTE && buf[1] === 0xd8 && buf.length === 3) {
            // 0xd8 (3 bytes: 32 D8 XX): the wash counter the fork exposed as tub_clean_counter. On an
            // LDT54788D it went 0x28 -> 0x2e over 2026-09-22..24, up by one each time a wash reached
            // its drying stage (Heavy, Delicate, Normal, Turbo, Auto, Express, Rinse), and is resent
            // unchanged at power-on. A completed Machine Clean reset it to 0 (2026-09-25: 0x2e -> 0x00
            // three seconds after the cycle ended), so it counts washes since the last Machine Clean.
            this.publishProperty('tub_clean_counter', buf[2])
        }
    }

    processStatus(curStatus: Buffer) {
        // this includes a flag/length prefix
        if (curStatus[1] != STATUS_RECORD_LENGTH - 2) return

        const data = curStatus.subarray(2)
        const s = unpackStatus(data)

        // Sanity: minutes must be 0..59.
        if (
            s.initialTimeMinute > 59 ||
            s.remainingTimeMinute > 59 ||
            s.delayTimeMinute > 59 ||
            s.initialTimeHour > 99 ||
            s.remainingTimeHour > 99
        ) {
            log('D30', 'suspect time fields', curStatus.toString('hex'))
            return
        }

        // Plain minutes (device_class duration + unit_of_measurement 'min'); the previous
        // H:MM:SS strings left the entities Unavailable since they weren't valid durations.
        this.publishProperty('initial_time', s.initialTimeHour * 60 + s.initialTimeMinute)
        this.publishProperty('remaining_time', s.remainingTimeHour * 60 + s.remainingTimeMinute)
        this.publishProperty('delay_start_time', s.delayTimeHour * 60 + s.delayTimeMinute)

        // status = granular machine state; process = phase.
        this.publishProperty('status', Device.formatStatus(s.state))
        this.publishProperty('process', Device.formatProcess(s.process))

        // 0x01 (Ready) is the panel on with a course picked and the door open, before
        // Start: it shows the selected course and options, but nothing is washing yet.
        const active = s.state === 0x01 || s.state === 0x02 || s.state === 0x03

        // Course clears to 0x00 once the cycle ends (state 0x04/0x05); only publish
        // a course while the cycle is active, otherwise 'Off'.
        this.publishProperty('course', active ? Device.formatCourse(s.course) : 'Off')

        // Options bitfield clears at cycle end like the course byte; gate on
        // active state so the entity reads OFF once the cycle finishes.
        this.publishProperty('energy_saver', active && s.options & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('half_load', active && s.options & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('extra_dry', active && s.options & OPTION_EXTRA_DRY ? 'ON' : 'OFF')
        this.publishProperty('high_temp', active && s.options & OPTION_HIGH_TEMP ? 'ON' : 'OFF')
        this.publishProperty('dual_zone', active && s.options & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('delay_start', active && s.options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('night_dry', s.flags1 & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('rinse_refill', s.flags1 & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('door', s.flags1 & FLAG1_DOOR_OPEN ? 'ON' : 'OFF')
        // device_class 'lock' reads ON as unlocked, so the lock bit is inverted.
        this.publishProperty('child_lock', s.flags1 & 0x01 ? 'OFF' : 'ON')
    }

    setProperty(prop: string, mqttValue: string) {
        // Dishwasher is read-mostly; any command surface (remote start, etc.)
        // is TODO until the captures show what the device accepts.
        console.warn(`D30: unsupported property ${prop} (value ${mqttValue})`)
    }
}
