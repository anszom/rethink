import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG front-load washer — matched on modelId "F3S1CWKB__". This is the washer unit of the split-module
// WKEX200HBA WashTower variant whose two halves register as separate ThinQ devices (this unit is
// deviceType 221; the matching dryer is RV13S1AMJW_US, deviceType 222). It is a different dialect from
// both the combined WashTower (WTL_FXU_BDV_NA_01) and the F3L* washers: status records are
// length-prefixed rather than marker-led, and the run phase arrives in the 0xBD/0xCD status dumps.
//
// AABB frames (buf = the AABB body) start with 0x33 and are discriminated by buf[1]:
//   0xEC        status frame — two length-prefixed 43-byte records (previous state, then current);
//               we read the current one.
//   0xEB        single-record status frame — same 43-byte layout, seen on (re)connect.
//   0xE2        post-cycle burst replaying a frozen snapshot of the finished cycle — not decoded.
//   0xBD / 0xCD full status dumps (~405 bytes). The header carries the run phase: the marker
//               01 02 0B followed by the phase byte, then remaining/total minutes. This is the only
//               source of Washing/Rinsing/Spinning — the EC record's own byte 0 stays 0 all cycle.
//   0x19        short power frame (33 19 01 = on). Also the answer to a remote power command.
//   0x31        module boot frame — the record that follows it is a retained pre-boot snapshot,
//               not live state (see bootPending below).
//
// The 43-byte EC/EB record is a selection/state snapshot, live-verified against the physical panel
// (dial sweep through every course, single-variable option toggles, full cycles):
//   [1] soil index, [2] temp code, [4] spin code, [5] course code
//   [11..12] Delay Wash reserve, big-endian minutes
//   [14] live remaining minutes while running (the panel's countdown)
//   [16] post-sensing time estimate (frozen once the cycle starts) — only a fallback for [14]
//   [27] rinse counter, against a per-course baseline learned from rinse-off records
//   [34] bit 0x40 pre-wash, [35] bit 0x10 steam
//   [37] bit 0x40 interaction-session flag (clears a few minutes after the last panel interaction,
//        so it is NOT a power bit on its own), bit 0x10 door lock / Remote Start armed
//   [39] bit 0x40 extra rinse active
//
// Power is inferred: the unit is on when a course is selected or the session flag is set. Two
// replay traps are handled explicitly:
//   * after a remote power-off (or a panel power-off at the end of a cycle) the Wi-Fi module
//     reboots and replays the retained pre-off record, session flag and all — the boot frame and
//     the remote-off latch keep that replay reading as OFF.
//   * an idle wake/check-in replays the retained idle record, whose [14] parks on 1; with no
//     course selected that is an idle marker, not a 1-minute cycle, so remaining reads 0.
//
// Completion has no frame of its own: a course-cleared record arriving after a real run (door
// lock seen set with a course selected) latches status Complete with remaining 0 until a new
// course is selected or the power cycles.
//
// Not published: door position (no byte in any observed frame carries it — the lock bit is the
// door *lock*/Remote-Start-armed flag) and Cold Wash (no EC-record bit identified for it).

const WASHER_UNIT = 0x33
const STATUS_FRAME_TYPE = 0xec
const SINGLE_STATUS_FRAME_TYPE = 0xeb

const SOIL_OFFSET = 1
const TEMP_OFFSET = 2
const SPIN_OFFSET = 4
const COURSE_OFFSET = 5
const RESERVE_OFFSET = 11 // 16-bit big-endian minutes
const REMAINING_OFFSET = 14
const ESTIMATE_OFFSET = 16
const RINSE_COUNT_OFFSET = 27
const PRE_WASH_OFFSET = 34
const PRE_WASH_FLAG = 0x40
const STEAM_OFFSET = 35
const STEAM_FLAG = 0x10
const SESSION_OFFSET = 37
const SESSION_FLAG = 0x40
const LOCK_FLAG = 0x10
const RINSE_OFFSET = 39
const RINSE_FLAG = 0x40

// Phase bytes, shared by the status dumps and (in principle) record byte 0. On this unit the
// record byte stays 0, so an idle-but-on record reads as Selecting.
const STATUS = Enum.of({
    Off: 0x00,
    Selecting: 0x05,
    Paused: 0x06,
    'Delay Wash': 0x0a,
    Sensing: 0x14,
    Washing: 0x17,
    Rinsing: 0x1e,
    Spinning: 0x28,
    Complete: 0x3c,
})

// Every dial position confirmed on the physical panel.
const COURSE = Enum.of({
    Normal: 0x2e,
    Bedding: 0x0d,
    Delicates: 0x16,
    'Heavy Duty': 0x23,
    'Speed Wash': 0x4a,
    Downloaded: 0xff,
    Sanitary: 0x3c,
    'Tub Clean': 0x55,
})

// Option encodings in the EC/EB selection record (labelled panel captures). Note these are this
// model's own codes, unrelated to the F3L* tables.
const TEMP_F3S1 = Enum.of({
    'Extra Cold': 13,
    Cold: 14,
    Warm: 16,
    Hot: 18,
    'Extra Hot': 19,
})

const SPIN_F3S1 = Enum.of({
    'No Spin': 12,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
})

const SOIL = Enum.of({
    Light: 1,
    'Light-Normal': 2,
    Normal: 3,
    'Normal-Heavy': 4,
    Heavy: 5,
})

export default class Device extends AABBDevice {
    // Set by a remote power-off: the module reboots afterwards and replays its retained pre-off
    // record, which must not resurrect the power state.
    private remoteOff = false
    // Set by the 0x31 boot frame: the next record is a retained pre-boot snapshot, read as OFF.
    private bootPending = false
    private seenRecord = false
    // A real run has been observed (course selected with the lock bit set, or a running phase).
    private cycleRan = false
    private completed = false
    private courseSelected = false
    // Per-course rinse-counter baselines, learned from records with extra rinse off.
    private rinseBase: Record<number, number> = {}

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
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
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash time remaining',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-sync',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf.length === 3 && buf[0] === WASHER_UNIT && buf[1] === 0x19) {
            const on = buf[2] !== 0x00
            if (on) {
                this.remoteOff = false
                this.completed = false
                this.cycleRan = false
            }
            this.publishProperty('power', on ? 'ON' : 'OFF')
            return
        }
        if (buf[0] === WASHER_UNIT && buf[1] === 0x31) {
            // Module (re)booted: the next status record is a retained pre-boot snapshot.
            this.bootPending = true
            return
        }
        if (buf[0] === WASHER_UNIT && (buf[1] === STATUS_FRAME_TYPE || buf[1] === SINGLE_STATUS_FRAME_TYPE)) {
            return this.processWasherStatus(buf)
        }
        if (buf[0] === WASHER_UNIT && (buf[1] === 0xbd || buf[1] === 0xcd)) {
            return this.processPhaseFrame(buf)
        }
    }

    // The dumps share a header: 01 02 0B <phase> 00 <remaining> 00 <total>, with the marker at
    // offset 5 (0xCD) or 6 (0xBD) — scan the first bytes rather than assuming one.
    private processPhaseFrame(buf: Buffer) {
        for (let i = 4; i + 3 < Math.min(buf.length, 14); i++) {
            if (buf[i] === 0x01 && buf[i + 1] === 0x02 && buf[i + 2] === 0x0b) {
                const phase = buf[i + 3]
                const label = STATUS.map(phase)
                if (label && phase !== 0x00) {
                    if (this.courseSelected && (phase === 0x14 || phase === 0x17 || phase === 0x1e || phase === 0x28))
                        this.cycleRan = true
                    // Gated on a course/run so the trailing post-completion dump (which still
                    // carries the last phase) cannot resurrect a running status.
                    if (this.courseSelected || this.cycleRan) this.publishProperty('status', label)
                }
                return
            }
        }
    }

    private processWasherStatus(buf: Buffer) {
        let offset = 2
        const records: Buffer[] = []
        while (offset + 2 <= buf.length) {
            const len = buf.readUInt16BE(offset)
            offset += 2
            if (offset + len > buf.length) break
            records.push(buf.subarray(offset, offset + len))
            offset += len
        }
        if (records.length === 0) return

        // 0xEC carries [previous, current]; 0xEB carries only the current record.
        const active = records[records.length - 1]
        if (active.length <= SESSION_OFFSET) return

        const courseCode = active[COURSE_OFFSET]
        this.courseSelected = courseCode !== 0
        if (courseCode !== 0 && (active[SESSION_OFFSET] & LOCK_FLAG) !== 0) this.cycleRan = true

        let powerOn = (active[SESSION_OFFSET] & SESSION_FLAG) !== 0 || courseCode !== 0
        if (this.remoteOff || this.bootPending) powerOn = false
        this.bootPending = false
        if (!this.seenRecord) {
            this.seenRecord = true
            // First snapshot on a fresh connect with no course selected may be the retained
            // replay: stay OFF.
            if (buf[1] === SINGLE_STATUS_FRAME_TYPE && courseCode === 0) powerOn = false
        }

        if (!powerOn) {
            this.publishProperty('power', 'OFF')
            this.publishProperty('status', 'Off')
            this.publishProperty('course', undefined)
            this.publishProperty('remaining_time', 0)
            this.publishProperty('temp', undefined)
            this.publishProperty('spin', undefined)
            this.publishProperty('soil', undefined)
            this.publishProperty('reserve_time', 0)
            this.publishProperty('extra_rinse_count', 0)
            this.publishProperty('extra_rinse', 'OFF')
            this.publishProperty('pre_wash', 'OFF')
            this.publishProperty('steam', 'OFF')
            this.publishProperty('delay_wash', 'OFF')
            this.publishProperty('door_lock', 'OFF')
            this.cycleRan = false
            this.completed = false
            return
        }

        this.publishProperty('power', 'ON')
        if (courseCode !== 0) this.completed = false
        const completed = courseCode === 0 && (this.cycleRan || this.completed)
        if (completed && this.cycleRan) {
            this.cycleRan = false
            this.completed = true
        }
        this.publishProperty(
            'status',
            completed ? 'Complete' : active[0] !== 0x00 ? (STATUS.map(active[0]) ?? 'Running') : 'Selecting',
        )
        this.publishProperty(
            'course',
            courseCode !== 0 ? (COURSE.map(courseCode) ?? `0x${courseCode.toString(16)}`) : undefined,
        )
        // With no course selected the remaining byte parks on an idle marker (1) — not a cycle.
        const remaining =
            completed || courseCode === 0
                ? 0
                : active[REMAINING_OFFSET] || active[ESTIMATE_OFFSET] || active[REMAINING_OFFSET + 1] || 0
        this.publishProperty('remaining_time', remaining)
        this.publishProperty('temp', TEMP_F3S1.map(active[TEMP_OFFSET]))
        this.publishProperty('spin', SPIN_F3S1.map(active[SPIN_OFFSET]))
        this.publishProperty('soil', SOIL.map(active[SOIL_OFFSET]))
        const reserve = active[RESERVE_OFFSET] * 256 + active[RESERVE_OFFSET + 1]
        this.publishProperty('reserve_time', reserve)
        this.publishProperty('delay_wash', reserve > 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (active[STEAM_OFFSET] & STEAM_FLAG) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (active[PRE_WASH_OFFSET] & PRE_WASH_FLAG) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (active[SESSION_OFFSET] & LOCK_FLAG) !== 0 ? 'ON' : 'OFF')
        const rinse = (active[RINSE_OFFSET] & RINSE_FLAG) !== 0
        this.publishProperty('extra_rinse', rinse ? 'ON' : 'OFF')
        if (!rinse) this.rinseBase[courseCode] = active[RINSE_COUNT_OFFSET]
        const rinseBase = this.rinseBase[courseCode]
        this.publishProperty(
            'extra_rinse_count',
            rinse && rinseBase !== undefined ? Math.max(0, active[RINSE_COUNT_OFFSET] - rinseBase) : 0,
        )
    }

    setProperty(prop: string, value: string) {
        if (prop === 'power') {
            const on = value === 'ON' ? 0x01 : 0x00
            this.remoteOff = value !== 'ON'
            this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, 0x01, 0x02, on]))
        }
    }
}
