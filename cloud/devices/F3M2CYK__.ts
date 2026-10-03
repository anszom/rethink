import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import log from '@/util/logging'

// LG front-load washer (WM4500HBA) — matched on modelId "F3M2CYK__". AABB frames (buf = the AABB body, AA+len and
// checksum+BB already stripped, buf[0]==0x20 on every frame) are discriminated by buf[1] (NOT buf[3],
// which is a rolling sequence counter for this model):
//   0x31        one-time device-ID/serial frame at connect — not decoded.
//   0xEC        dial/status frame — two stacked 25/26-byte records (old state, then new state), each
//               starting with a 0x18 marker; we read record B (buf[29:]), the current state.
//   0xEB        single-record status frame — same 25-byte record layout as 0xEC's record B, just without
//               a preceding "old state" record (seen right after the appliance (re)connects, before it has
//               a prior state to diff against). Live-confirmed: identical field offsets to 0xEC's record B.
//   0xBD / 0xCD full status dump / idle keepalive (~406/405 bytes, this washer's actual traffic — it
//               never sends 0xEC/0xEB). Phase, remaining/total time, course and the washes-since-
//               Tub-Clean counter, soil, spin and temp are decoded (see CD_*/BD_* offsets below); the
//               option flags aren't pinned down yet, so they're left unpublished. A 0xBD with event byte 0x03 (476 bytes) is sent once at cycle end.
//   0x72        run heartbeat, buf[3]: 0xC9 = started/resumed, 0xC8 = stopped (cycle end), with a
//               transient 0x00 just before the 0xC8. Drives `power` and the end-of-cycle state.
//   0xD8        washes since the last Tub Clean (same counter as the 0xCD/0xBD byte), sent in bursts
//               of ~10: at power-on a burst of 0x00 followed by the real count, and at cycle end a burst
//               with the updated count (00 after a Tub Clean). The cycle-end burst always follows the
//               transient 0x72 00, but may come before or after the end-of-cycle 0xBD.
// All offsets below are live-verified: captured real traffic via the rethink-agent MCP tools while
// driving the physical washer (dial browsing, single-variable settings toggles, full wash cycles,
// pause/resume, remote start/pause/power-off from the LG app) and correlating each byte change against
// the LG cloud's own decoded washerDryer state at matching timestamps — not guessed from static analysis.
// The 0xCD/0xBD offsets were cross-checked against a ~2-day capture of real traffic and the physical
// display: a full Warm/High/TurboWash load reads total=53, remaining counting down from there, and a
// second, 18-minute load reads total=remaining=18 and goes straight into phase 0x1e (Rinsing), with no
// Washing step. A third capture, a Tub Clean (1:29 total,
// ran 05:21->06:50), showed the time fields are [hour][minute] pairs rather than a uint16 minute count
// (01 17 -> 01 12 -> ... -> 01 03 -> 00 3a) — both readings agree below one hour, which is why the
// first two loads couldn't tell them apart.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 54 // 3B header + 26B record A (old) + 25B record B (current)
const RECORD_B_OFFSET = 29

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 28 // 3B header + 25B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

// 0xCD (idle keepalive, sent every ~5 min) and 0xBD (event, sent on phase/state changes) — both
// ~400-byte full status dumps with the same layout, except that 0xBD has an extra event byte at
// buf[3] (0x01 = cycle selected, 0x02 = phase change, 0x03 = cycle end), shifting everything after it
// by one. Offsets below are for 0xCD; 0xBD adds BD_SHIFT. Phase reuses the same STATUS map as the
// 0xEC/0xEB record; remaining and total time are [hour][minute] pairs like the 0xEC/0xEB record.
const CD_FRAME_TYPE = 0xcd
const BD_FRAME_TYPE = 0xbd
const BD_SHIFT = 1
const BD_EVENT_OFFSET = 3
const BD_EVENT_CYCLE_END = 0x03
const DUMP_PHASE_OFFSET = 8
const DUMP_REMAINING_OFFSET = 9 // [hour][minute]
const DUMP_TOTAL_OFFSET = 11 // [hour][minute]
// Course code, constant for a whole cycle. NOT the same numbering as the 0xEC/0xEB rec[6] COURSE
// map below. Reads 0x00 in the very first 0xBD of a cycle before the machine commits to one.
const DUMP_COURSE_OFFSET = 15
// Washes since the last Tub Clean: read 06 during load 1, 07 after it, 08 after load 2, and 00
// straight after a Tub Clean. The 0xCD/0xBD value is the count as of cycle start, so the end-of-cycle
// 0xBD's copy is stale and isn't published; the updated count arrives in the 0xD8 burst at cycle
// end. There is no days-based counter in any frame.
const DUMP_TUB_CLEAN_COUNT_OFFSET = 29
// Soil, temp and spin, using the same SOIL/TEMP/SPIN indices as the 0xEC/0xEB record. Confirmed
// against six panel photos: Normal/Warm/High/Normal soil reads 03/04/04, Heavy Duty/Cold/Medium/Light
// soil reads 01/02/03, Sanitary/Extra Hot/High/Normal soil reads 03/07/04, Bright Whites/Hot/Extra
// High/Heavy soil reads 05/06/05, Delicates/Tap Cold/Low/Light-Normal soil reads 02/01/02, Perm.
// Press/Tap Cold/Medium/Normal-Heavy soil reads 04/01/03. No Spin (01) was seen on a Speed Wash load. Other loads fit the same scales (Normal and Towels read Warm with
// Normal soil, Rinse+Spin reads Cold with no soil, Tub Clean reads neither). 0x00 means "not applicable": soil
// clears when Rinsing starts and temp when Spinning starts, while spin holds for the whole cycle.
// Delay Wash time remaining, [hour][minute], counting down while phase == Delay Wash (0x0a); 00 00
// otherwise. Same field as rec[13:15] of the 0xEC/0xEB record. Seen on an Allergiene load with a
// 1-hour delay: 01 00 at start, 00 39 four minutes later.
const DUMP_RESERVE_OFFSET = 13
// Options bitfield, same bits as rec[15] of the 0xEC/0xEB record (FLAG_* below). Checked against
// seven panel photos: TurboWash (0x80) set on the Normal and Heavy Duty loads with the TurboWash lamp
// lit and clear on Sanitary, Rinse+Spin, Tub Clean and Allergiene with it off; Steam (0x04) set only on
// Tub Clean and Allergiene, the two with the Steam lamp lit; Delay (0x02) set only on the delayed
// Allergiene load; Extra Rinse (0x40) set on a Bright Whites load with the Extra Rinse lamp lit and
// clear on all the others; Pre-wash (0x08) set only on a Delicates load with the Pre-wash lamp lit.
// Control Lock (0x01, this model's own bit — the 0xEC record has no such flag): set in the one report
// taken while Control Lock was on during a Bedding load, clear before it was engaged and after it was
// released. The washer keeps reporting while locked. TurboWash and Steam can clear once their stage is over (Steam cleared
// when the Tub Clean started rinsing), so like soil/temp a cleared bit only counts before the cycle is
// under way. Delay is a live state instead: it cleared when the Allergiene load's delay ran out.
const DUMP_FLAGS_OFFSET = 24
// Extra Rinse count: 01 on a Bright Whites load with one extra rinse, 02 on a Sportswear load with
// two, 00 on every other load. Same meaning as the high nibble of rec[11] in the 0xEC/0xEB record.
const DUMP_EXTRA_RINSE_COUNT_OFFSET = 19
// Second options byte, the same bitfield as rec[16] of the 0xEC/0xEB record: bit 0x01 = Fresh Care,
// set on the two loads photographed with the Fresh Care lamp lit (Downloaded and Sportswear) and clear
// on every earlier load with it off. Bit 0x10 = Cold Wash (OPT2_COLD_WASH), set only on a Towels load
// photographed with the Cold Wash lamp lit, and clear on the three earlier Cold-temp loads without it.
// Bit 0x80 is set once a cycle is running (likely the door lock, as in rec[16]) — not published.
const DUMP_FLAG_CONTROL_LOCK = 0x01
const DUMP_OPT2_OFFSET = 25
const DUMP_OPT2_FRESH_CARE = 0x01
// ezDispense Detergent Level setting (the amount auto-dispensed, set with the Detergent Level button;
// the panel shows it as 1-3 bars next to ▲/Norm/▼). Bits 0xc0 checked against six panel photos: 0xc0
// with three bars lit (Normal, Heavy Duty), 0x80 with two (Sanitary, Allergiene), 0x40 with one (Bright
// Whites), 0x00 with none (Rinse+Spin, which doesn't dispense). The Heavy Duty load was changed from
// 0x80 to 0xc0 while it was being selected, so it's the setting rather than the tank level.
const DUMP_DETERGENT_OFFSET = 373
const DUMP_DETERGENT_MASK = 0xc0
// Same byte: softener level in bits 0x30, the same scale as detergent one pair of bits down — 0x10 with
// one softener bar set, 0x20 with two lit (Perm. Press), 0x30 with three (Downloaded), 0x00 on every
// load photographed with the softener bars dark. Bit 0x04 = the red softener Refill warning: set only on the Perm. Press
// load photographed with it lit, and gone after the tank was refilled.
const DUMP_SOFTENER_MASK = 0x30
const DUMP_SOFTENER_REFILL = 0x04
const DUMP_SOIL_OFFSET = 17
const DUMP_TEMP_OFFSET = 18
const DUMP_SPIN_OFFSET = 21

// 0xD8: buf[2] = washes since the last Tub Clean. The power-on burst of 0x00 is a placeholder, so a
// zero is only taken from the first 0xD8 after the cycle-end 0x72 00 (i.e. a Tub Clean just finished).
// 0x7F (5 bytes: 20 7F 01 00 XX), sent in a burst about a minute into a cycle once the washer has sensed
// the load: buf[4] is a relative load size — 0x13 with a single washcloth, 0x3a and 0x2d on towel loads,
// 0x40 on the fullest loads. Not a weight in any known unit; higher = heavier. Courses that skip
// sensing (Rinse+Spin, Tub Clean) don't send it. The same value appears later in 0xCD buf[376].
const LOAD_FRAME_TYPE = 0x7f
const LOAD_SIZE_OFFSET = 4
const COUNTER_FRAME_TYPE = 0xd8
const COUNTER_OFFSET = 2

const HEARTBEAT_FRAME_TYPE = 0x72
const HEARTBEAT_STATE_OFFSET = 3
const HEARTBEAT_RUNNING = 0xc9
const HEARTBEAT_STOPPED = 0xc8
const HEARTBEAT_CYCLE_ENDING = 0x00 // transient, sent once just before the cycle-end 0xD8/0xBD/0xC8

// Offsets below are relative to record B's own 0x18 marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute]: the estimated cycle time while Selecting/Delay-pending, or the countdown
// while running. Confirmed exactly against the cloud's initialTimeHour/Minute and remainTimeHour/Minute
// across many single-variable settings toggles and a full wash cycle countdown (13->...->1 min).
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[6]: the course/dial-position identifier (NOT the same as rec[2:4] — an earlier pass mistook the
// time-estimate bytes for a "course code" because each course's default settings produce a distinctive
// default time; rec[6] is the real, stable identifier, confirmed unchanged across a whole settings-toggle
// session on a fixed course). 14 named programs map to 14 distinct values; 0x00 is a transitional/
// no-selection state (also the sentinel value seen at power-off, alongside 0xfe).
const COURSE_OFFSET = 6
const SOIL_OFFSET = 8
const SPIN_OFFSET = 9
const TEMP_OFFSET = 10
// rec[11] high nibble = extra-rinse count (0-3); low nibble is a constant 1.
const EXTRA_RINSE_COUNT_OFFSET = 11
// rec[13:15] = [hour][minute]: Delay Wash reserve time, ticking down like a clock (confirmed across a
// 3:00 -> 2:59 hour-boundary rollover). Only meaningful while phase == PHASE_DELAY.
const RESERVE_HOUR_OFFSET = 13
const RESERVE_MIN_OFFSET = 14
// rec[15]: options bitfield, each bit isolated via a single-variable toggle against the cloud's enum.
const FLAGS_OFFSET = 15
const FLAG_TURBO_WASH = 0x80
const FLAG_EXTRA_RINSE = 0x40
const FLAG_PRE_WASH = 0x08
const FLAG_STEAM = 0x04
const FLAG_DELAY_ACTIVE = 0x02
// rec[16]: a separate bitfield from rec[15] — confirmed by isolating Cold Wash (which also forces the
// temp index to 0x02/Cold) and the door-lock state (unlocks on pause, relocks on resume/start) against
// the cloud's coldWash field and the pause/resume phase transitions, respectively.
const OPT2_OFFSET = 16
const OPT2_DOOR_LOCKED = 0x80
const OPT2_COLD_WASH = 0x10
// rec[17]: plain door-closed sensor, independent of the rec[16] lock bit (the machine can be paused with
// the door shut-but-unlocked). Confirmed both directions against the cloud's doorClose field.
const DOOR_OFFSET = 17
const DOOR_CLOSED = 0x02

const PHASE_OFF = 0x00
const PHASE_SELECTING = 0x05
const PHASE_SENSING = 0x14
const PHASE_COMPLETE = 0x3c

// Phase/status byte. 0x14 (Sensing) carried over from the original qualitative pass — this session's
// Speed Wash runs went straight 0x05->0x17 without an observed Sensing step, so it's unconfirmed but
// harmless to include (anything genuinely unmapped falls back to 'Running').
const STATUS = Enum.of({
    Off: 0x00,
    Selecting: 0x05,
    Paused: 0x06, // seen 2026-09-25: a Rinse+Spin paused right after Start
    'Delay Wash': 0x0a,
    Sensing: 0x14,
    Washing: 0x17,
    Rinsing: 0x1e,
    Spinning: 0x28,
    Complete: 0x3c,
})

const DETERGENT_LEVEL = Enum.of({
    Off: 0x00,
    Less: 0x40,
    Normal: 0x80,
    More: 0xc0,
})

const SOFTENER_LEVEL = Enum.of({
    Off: 0x00,
    Less: 0x10,
    Normal: 0x20,
    More: 0x30,
})

// Course/dial-position identifier -> name. Live-confirmed by turning the dial through every position and
// reading the LG cloud's own apCourseFLUpper25inchBaseUS at each stop.
const COURSE = Enum.of({
    'Tub Clean': 0x01,
    'Bright Whites': 0x02,
    Allergiene: 0x03,
    Sanitary: 0x04,
    Bedding: 0x05,
    'Heavy Duty': 0x06,
    Normal: 0x07,
    Sportswear: 0x08,
    'Perm Press': 0x09,
    Delicates: 0x0a,
    Towels: 0x0b,
    'Speed Wash': 0x0c,
    'Rinse+Spin': 0x0d,
    'Small Load': 0x0e,
})

// 0xCD/0xBD course code -> name. Only courses confirmed by the user are listed; anything else is
// published as its raw hex code so it can be identified from HA.
const DUMP_COURSE = Enum.of({
    Sanitary: 0x02,
    Allergiene: 0x03,
    Bedding: 0x04,
    'Perm. Press': 0x05,
    'Bright Whites': 0x08,
    Delicates: 0x0a,
    'Speed Wash': 0x0c,
    Normal: 0x06,
    'Heavy Duty': 0x07,
    'Tub Clean': 0x0d,
    Towels: 0x0e,
    'Rinse+Spin': 0x10,
    Sportswear: 0x13,
})

// Soil level 1-5, clean sequential mapping confirmed by single-step toggling against the cloud's
// soilWash enum.
const SOIL = Enum.of({
    Light: 1,
    'Light-Normal': 2,
    Normal: 3,
    'Normal-Heavy': 4,
    Heavy: 5,
})

// Spin 2-5 confirmed the same way; 1 (No Spin) is implied by the sequence but wasn't directly toggled to.
const SPIN = Enum.of({
    'No Spin': 1,
    Low: 2,
    Medium: 3,
    High: 4,
    'Extra High': 5,
})

// Temp indices confirmed the same way; 3/5 are unused/skipped on this model.
const TEMP = Enum.of({
    'Tap Cold': 1,
    Cold: 2,
    Warm: 4,
    Hot: 6,
    'Extra Hot': 7,
})

export default class Device extends AABBDevice {
    // set by the cycle-end 0x72 00; the next 0xD8 carries the updated washes-since-Tub-Clean count
    private countFollowsCycleEnd = false

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
                        // free-text (NOT device_class:enum): unmapped phase codes emit 'Running'.
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
                        // dual-purpose on the 0xEC/0xEB path (the estimated cycle time while
                        // selecting, the countdown while running); the 0xCD/0xBD path publishes a
                        // separate initial_time below. Zeroed at cycle end.
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        // only published from 0xCD/0xBD frames, which carry total time separately
                        // from remaining time.
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since Tub Clean',
                        icon: 'mdi:counter',
                        state_class: 'measurement',
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
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-sync',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
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
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'Fresh Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    control_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control Lock',
                        icon: 'mdi:lock',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
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
                    load_size: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_size',
                        state_topic: '$this/load_size',
                        name: 'Sensed load size',
                        icon: 'mdi:weight',
                        state_class: 'measurement',
                    },
                    softener_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener_level',
                        state_topic: '$this/softener_level',
                        name: 'Softener level setting',
                        icon: 'mdi:cup-water',
                    },
                    softener_refill: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-softener_refill',
                        state_topic: '$this/softener_refill',
                        name: 'Softener refill',
                        icon: 'mdi:water-alert',
                    },
                    detergent_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent_level',
                        state_topic: '$this/detergent_level',
                        name: 'Detergent level setting',
                        icon: 'mdi:cup-water',
                    },
                    // Cold wash, door and door lock are only decoded from
                    // 0xEC/0xEB frames, which this model hasn't been seen sending. They're left out
                    // of discovery so they don't sit at Unknown in HA; processStatus still publishes
                    // their state topics if a unit does send those frames.
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) {
            log('F3M2CYK__', 'unrecognized frame', buf.toString('hex'))
            return
        }
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        if (buf[1] === CD_FRAME_TYPE) return this.processDump(buf, 0)
        if (buf[1] === BD_FRAME_TYPE) return this.processDump(buf, BD_SHIFT)
        if (buf[1] === HEARTBEAT_FRAME_TYPE && buf.length > HEARTBEAT_STATE_OFFSET) return this.processHeartbeat(buf)
        if (buf[1] === COUNTER_FRAME_TYPE && buf.length > COUNTER_OFFSET) return this.processCounter(buf)
        if (buf[1] === LOAD_FRAME_TYPE && buf.length > LOAD_SIZE_OFFSET)
            return this.publishProperty('load_size', buf[LOAD_SIZE_OFFSET])
        // 0x31 (serial), 0xE2 (end-of-cycle summary) and anything else not yet decoded land here so
        // they show up in the logs for future status-code hunting.
        log('F3M2CYK__', 'unrecognized frame', buf.toString('hex'))
    }

    // 0xCD/0xBD full status dump: phase, remaining/total time, course, soil/spin/temp and washes since
    // Tub Clean (the option flags are somewhere in the rest of the body but not pinned down yet).
    private processDump(buf: Buffer, shift: number) {
        if (buf.length <= DUMP_TUB_CLEAN_COUNT_OFFSET + shift) {
            log('F3M2CYK__', 'status dump too short', buf.toString('hex'))
            return
        }
        const at = (offset: number) => buf[offset + shift]
        const hm = (offset: number) => at(offset) * 60 + at(offset + 1)

        const phase = at(DUMP_PHASE_OFFSET)
        // The last 0xBD of a cycle still carries the final phase (e.g. Spinning, 1 min left), and on
        // one load it arrived after the 0x72 stop heartbeat, so treat it as the end of the cycle.
        const cycleEnd = shift === BD_SHIFT && buf[BD_EVENT_OFFSET] === BD_EVENT_CYCLE_END
        const total = hm(DUMP_TOTAL_OFFSET)

        if (phase === PHASE_OFF) {
            this.publishProperty('power', 'OFF')
            this.publishProperty('status', STATUS.map(phase))
            this.publishProperty('remaining_time', 0)
            this.publishProperty('initial_time', 0)
        } else if (cycleEnd || phase === PHASE_COMPLETE) {
            this.publishProperty('power', 'OFF')
            this.publishProperty('status', STATUS.map(PHASE_COMPLETE))
            this.publishProperty('remaining_time', 0)
            // the post-cycle 0xCD zeroes the total; keep the last known value in that case
            if (total > 0) this.publishProperty('initial_time', total)
        } else {
            this.publishProperty('power', 'ON')
            this.publishProperty('status', STATUS.map(phase) ?? 'Running')
            this.publishProperty('remaining_time', hm(DUMP_REMAINING_OFFSET))
            this.publishProperty('initial_time', total)
        }

        const course = at(DUMP_COURSE_OFFSET)
        if (course !== 0) {
            this.publishProperty('course', DUMP_COURSE.map(course) ?? `0x${course.toString(16).padStart(2, '0')}`)
            // A 0x00 setting before the cycle is under way means the course doesn't use it (e.g. Tub
            // Clean has no soil level); later in the cycle it only means that stage is over, so the
            // last value is kept.
            const presetting = phase === PHASE_SELECTING || phase === PHASE_SENSING
            const setting = (name: string, offset: number, map: Enum<string>) => {
                const value = at(offset)
                if (value !== 0)
                    this.publishProperty(name, map.map(value) ?? `0x${value.toString(16).padStart(2, '0')}`)
                else if (presetting) this.publishProperty(name, '-')
            }
            setting('soil', DUMP_SOIL_OFFSET, SOIL)
            setting('temp', DUMP_TEMP_OFFSET, TEMP)
            setting('spin', DUMP_SPIN_OFFSET, SPIN)

            const flags = at(DUMP_FLAGS_OFFSET)
            const option = (name: string, bit: number) => {
                if ((flags & bit) !== 0) this.publishProperty(name, 'ON')
                else if (presetting) this.publishProperty(name, 'OFF')
            }
            option('turbo_wash', FLAG_TURBO_WASH)
            option('steam', FLAG_STEAM)
            option('extra_rinse', FLAG_EXTRA_RINSE)
            option('pre_wash', FLAG_PRE_WASH)
            const opt2 = at(DUMP_OPT2_OFFSET)
            if ((opt2 & DUMP_OPT2_FRESH_CARE) !== 0) this.publishProperty('fresh_care', 'ON')
            else if (presetting) this.publishProperty('fresh_care', 'OFF')
            if ((opt2 & OPT2_COLD_WASH) !== 0) this.publishProperty('cold_wash', 'ON')
            else if (presetting) this.publishProperty('cold_wash', 'OFF')
            const extraRinses = at(DUMP_EXTRA_RINSE_COUNT_OFFSET)
            if (extraRinses !== 0 || presetting) this.publishProperty('extra_rinse_count', extraRinses)
            this.publishProperty('delay_wash', (flags & FLAG_DELAY_ACTIVE) !== 0 ? 'ON' : 'OFF')
            // a live state like Delay, not a setting: follows the bit
            this.publishProperty('control_lock', (flags & DUMP_FLAG_CONTROL_LOCK) !== 0 ? 'ON' : 'OFF')
            this.publishProperty('reserve_time', hm(DUMP_RESERVE_OFFSET))

            if (buf.length > DUMP_DETERGENT_OFFSET + shift) {
                const dispense = at(DUMP_DETERGENT_OFFSET)
                const detergent = dispense & DUMP_DETERGENT_MASK
                this.publishProperty(
                    'detergent_level',
                    DETERGENT_LEVEL.map(detergent) ?? `0x${detergent.toString(16).padStart(2, '0')}`,
                )
                this.publishProperty('softener_level', SOFTENER_LEVEL.map(dispense & DUMP_SOFTENER_MASK))
                this.publishProperty('softener_refill', (dispense & DUMP_SOFTENER_REFILL) !== 0 ? 'ON' : 'OFF')
            }
        }
        if (!cycleEnd) this.publishProperty('tub_clean_count', at(DUMP_TUB_CLEAN_COUNT_OFFSET))
    }

    private processCounter(buf: Buffer) {
        const count = buf[COUNTER_OFFSET]
        if (count !== 0 || this.countFollowsCycleEnd) this.publishProperty('tub_clean_count', count)
        this.countFollowsCycleEnd = false
    }

    // 0x72: 0xC9 when a cycle starts/resumes, 0xC8 when it stops. The transient 0x00 at cycle end
    // doesn't change power, but marks the next 0xD8 as the updated count.
    private processHeartbeat(buf: Buffer) {
        const state = buf[HEARTBEAT_STATE_OFFSET]
        if (state === HEARTBEAT_RUNNING) this.publishProperty('power', 'ON')
        else if (state === HEARTBEAT_STOPPED) this.publishProperty('power', 'OFF')
        else if (state === HEARTBEAT_CYCLE_ENDING) this.countFollowsCycleEnd = true
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) {
            // reject header/layout drift
            log('F3M2CYK__', 'status frame length mismatch', buf.toString('hex'))
            return
        }
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== 0x18) {
            // record B should always lead with its marker
            log('F3M2CYK__', 'status frame missing 0x18 marker', buf.toString('hex'))
            return
        }

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(phase) ?? 'Running')
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        // Zeroed on Off rather than trusting the raw bytes — a stray leftover minute was observed on a
        // real power-off capture, and a stale countdown while OFF would be misleading in HA regardless.
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty('reserve_time', isOff ? 0 : rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('extra_rinse_count', rec[EXTRA_RINSE_COUNT_OFFSET] >> 4)

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('extra_rinse', (flags & FLAG_EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (flags & FLAG_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (flags & FLAG_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', (flags & FLAG_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('delay_wash', (flags & FLAG_DELAY_ACTIVE) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('cold_wash', (opt2 & OPT2_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (opt2 & OPT2_DOOR_LOCKED) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('door', rec[DOOR_OFFSET] === DOOR_CLOSED ? 'OFF' : 'ON')
        // not yet located (declared entities intentionally omitted rather than published wrong): error,
        // child_lock, remote_start (the latter two appear cloud-side only — no device-frame bit found for
        // either despite dedicated isolation tests), tub-clean count.
    }
}
