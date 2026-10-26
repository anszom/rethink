import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG electric dryer — matched on modelId "RV13S1AMJW_US". This is the dryer unit of the split-module
// WKEX200HBA WashTower variant whose two halves register as separate ThinQ devices (this unit is
// deviceType 222; the matching washer is F3S1CWKB__, deviceType 221). It is NOT an alias of the
// RV13B6* dryers: the framing differs (see below) and the option bytes sit at different offsets.
//
// AABB frames (buf = the AABB body) start with 0x34 and are discriminated by buf[1]:
//   0xEC        status frame — two length-prefixed 28-byte records (previous state, then current);
//               we read the current one. Records are prefixed with a 16-bit big-endian length,
//               unlike the marker-led records of the RV13B6* siblings.
//   0xEB        single-record status frame — same 28-byte layout, seen on (re)connect.
//   0xE2        post-cycle burst replaying a frozen snapshot of the finished cycle — not decoded.
//
// Record layout (28 bytes, live-verified over complete cycles):
//   [0]    phase (0=Off, 1=Initial, 0x32=Drying, 0x33=Cooling, 0x04=End) — NOT a time field
//   [1..2] remaining hours/minutes (counts down while drying)
//   [3..4] initial hours/minutes (the cycle's original estimate)
//   [5]    course code
//   [7]    dry level code (sensor courses only; 0 on Time Dry)
//   [8]    temperature code
//   [14]   options bitfield; Wrinkle Care is bit 0x10

const DRYER_UNIT = 0x34
const STATUS_FRAME_TYPE = 0xec
const SINGLE_STATUS_FRAME_TYPE = 0xeb

const PHASE_OFFSET = 0
const TIME_HOUR_OFFSET = 1
const TIME_MIN_OFFSET = 2
const COURSE_OFFSET = 5
const DRY_LEVEL_OFFSET = 7
const TEMP_OFFSET = 8
const OPTIONS_OFFSET = 14
const OPTION_WRINKLE_CARE = 0x10

const PHASE_OFF = 0x00

const STATUS = Enum.of({
    Off: 0x00,
    Initial: 0x01,
    Pause: 0x03,
    End: 0x04,
    Drying: 0x32,
    Cooling: 0x33,
})

// Course codes confirmed by sweeping every dial position on the physical panel. 0x04 is the
// Downloaded course on this model (there is no Perm Press position on its panel).
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    Downloaded: 0x04,
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
    'Super Dry': 0x1a,
})

// The dry level codes are rotated against the panel's 1-5 scale: the panel's level 1 (Damp) is
// code 5, level 5 (Very) is code 4, and levels 2-4 are codes 1-3.
const DRY_LEVEL = Enum.of({
    'Level 2': 1,
    'Level 3': 2,
    'Level 4': 3,
    'Very Dry': 4,
    Damp: 5,
})

const TEMP = Enum.of({
    Low: 1,
    'Level 2': 2,
    'Level 3': 3,
    'Level 4': 4,
    High: 5,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG WashTower Dryer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
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
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:iron',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] === DRYER_UNIT && (buf[1] === STATUS_FRAME_TYPE || buf[1] === SINGLE_STATUS_FRAME_TYPE)) {
            this.processDryerStatus(buf)
        }
    }

    private processDryerStatus(buf: Buffer) {
        let offset = 2
        const records: Buffer[] = []
        while (offset + 2 <= buf.length) {
            const len = buf.readUInt16BE(offset)
            offset += 2
            if (offset + len > buf.length) break
            records.push(buf.subarray(offset, offset + len))
            offset += len
        }
        if (records.length < 1) return

        // 0xEC carries [previous, current]; 0xEB carries only the current record.
        const active = records.length >= 2 ? records[1] : records[0]
        if (active.length < 6) return

        const phase = active[PHASE_OFFSET]
        const courseCode = active[COURSE_OFFSET]
        const remaining = (active[TIME_HOUR_OFFSET] | 0) * 60 + (active[TIME_MIN_OFFSET] | 0)

        if (phase === PHASE_OFF) {
            this.publishProperty('power', 'OFF')
            this.publishProperty('status', 'Off')
            this.publishProperty('course', undefined)
            this.publishProperty('remaining_time', 0)
            this.publishProperty('dry_level', undefined)
            this.publishProperty('temp', undefined)
            this.publishProperty('wrinkle_care', 'OFF')
            return
        }

        this.publishProperty('power', 'ON')
        this.publishProperty('status', STATUS.map(phase) ?? 'Running')
        this.publishProperty(
            'course',
            courseCode === 0 ? undefined : (COURSE.map(courseCode) ?? `0x${courseCode.toString(16)}`),
        )
        this.publishProperty('remaining_time', courseCode === 0 ? 0 : remaining)
        this.publishProperty('dry_level', DRY_LEVEL.map(active[DRY_LEVEL_OFFSET]))
        this.publishProperty('temp', TEMP.map(active[TEMP_OFFSET]))
        this.publishProperty('wrinkle_care', (active[OPTIONS_OFFSET] & OPTION_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
    }

    setProperty(prop: string, value: string) {
        if (prop === 'power') {
            const on = value === 'ON' ? 0x01 : 0x00
            this.send(Buffer.from([0xf0, 0x24, 0x01, 0x01, on]))
        }
    }
}
