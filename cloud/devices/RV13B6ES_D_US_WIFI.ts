import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG electric dryer — matched on modelId "RV13B6ES_D_US_WIFI". Frame layout is identical to its close
// relative RV13B6BSD_D_US_WIFI (see that file): AABB frames (buf = the AABB body, AA+len and
// checksum+BB already stripped) start with 0x30 and are discriminated by buf[1]:
//   0xEC        dial/status frame — two stacked records (29-byte old state, 28-byte current state), each
//               starting with a 0x1b marker; we read the current-state record (buf[32:]).
//   0xEB        single-record status frame (28-byte record at buf[3:]) — same field layout as 0xEC's
//               current-state record, seen right after the appliance (re)connects.
//   0x31/0xE2/0xD8/0x72  serial, idle snapshot and heartbeat frames — not decoded.
//
// This model is NOT a straight alias of RV13B6BSD_D_US_WIFI. Two differences were found by live capture:
//   * Wrinkle Care lives in rec[15] bit 0x10, not rec[16] bit 0x10. Aliasing to the relative would have
//     silently reported Wrinkle Care as permanently OFF, because rec[16] bit 0x10 is never set here.
//   * rec[23] carries a "load item" count that the relative does not decode at all.
//
// Every offset and table entry below was confirmed live: captured real wire traffic while driving the
// physical dryer and correlated each byte change against the LG cloud's own decoded washerDryer state at
// matching timestamps — not guessed from static analysis. The course/dry-level/temperature tables were
// derived mechanically from those pairings rather than copied.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 60 // 3B header + 29B record A (old) + 28B record B (current)
const RECORD_B_OFFSET = 32

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 31 // 3B header + 28B record, no preceding "old state" record
const SINGLE_RECORD_OFFSET = 3

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request —
// the fridges, the EU washers and the US WashTower all use it; actuating commands are 0xF0E5,
// so this only ever reads. Confirmed on a live RV13B6ES: the dryer answered within a second
// with a 0xEB snapshot, then resumed normal 0xEC updates.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Offsets below are relative to the record's own 0x1b marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute]: the live countdown while running, or the estimated cycle time while
// Initial/Selecting. Confirmed against the cloud's remainTimeHour/Minute, including the hour rollover
// (Antibacterial reported 1h10m and decoded as 70 minutes).
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute]: a genuine separate initial-time estimate that stays fixed once a cycle is
// running while rec[2:4] counts down — confirmed against the cloud's initialTimeHour/Minute.
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
const COURSE_OFFSET = 6
const DRY_LEVEL_OFFSET = 8
const TEMP_OFFSET = 9
// rec[11]: the Signal (end-of-cycle beeper) setting. This one is NOT cloud-confirmed like everything else
// in this file — the LG cloud sends no signal field for this dryer at all (verified against a full
// allDeviceInfoUpdate snapshot). It was mapped from the wire alone: pressing Signal cycles the byte
// 0x00 -> 0x01 -> 0x04 -> 0x00 with nothing else in the record moving, and the three values were tied to
// the panel's own Off/Low/High indicator by reading the lit LED after each press.
const SIGNAL_OFFSET = 11
// rec[12]: the More/Less Time adjustment, a SIGNED byte holding the number of minutes added to or
// removed from the course's default time. Confirmed against the cloud's moreLessTime (which reports the
// same byte unsigned) across a Speed Dry trimmed from its 25-minute default down to 10:
// 0xfe/-2 -> 23 min, 0xf9/-7 -> 18, 0xf6/-10 -> 15, 0xf1/-15 -> 10. Every value matched 25 + offset.
const MORE_LESS_TIME_OFFSET = 12
// rec[15]: options bitfield, each bit isolated via a single-variable toggle against the cloud's enum.
// The 0x40 "base" bit is present while the panel is awake and clears on panel idle timeout and while
// actively drying — it is not part of any single option, so it is not exposed as its own entity.
const FLAGS_OFFSET = 15
const FLAG_CHILD_LOCK = 0x01
const FLAG_REDUCE_STATIC = 0x02
const FLAG_DAMP_DRY_SIGNAL = 0x08
// Confirmed across six clean on/off transitions, matching the cloud's wrinkleCare exactly, observed both
// with and without the 0x40 base bit present. This is the offset that differs from RV13B6BSD_D_US_WIFI.
const FLAG_WRINKLE_CARE = 0x10
// rec[16]: a separate options bitfield from rec[15].
const OPT2_OFFSET = 16
// Remote Start. RV13B6BSD_D_US_WIFI documents this as not findable in any device frame ("appears
// cloud-side only"); on this model it is rec[16] bit 0x01, isolated cleanly when the bit flipped in a
// frame that changed nothing else and the cloud reported remoteStart:"REMOTE_START_ON" 300ms later.
const OPT2_REMOTE_START = 0x01
const OPT2_ENERGY_SAVER = 0x02
const OPT2_TURBO_STEAM = 0x04
// rec[23]: literal count of "load items", matching the cloud's loadItem (LOADITEM_OFF/2/5 seen as
// 0x00/0x02/0x05). Not decoded by RV13B6BSD_D_US_WIFI.
const LOAD_ITEM_OFFSET = 23

const PHASE_OFF = 0x00

// Phase/status byte. Every value below was observed directly on this appliance across a full Speed Dry
// run and cross-checked against the cloud's own state field (POWEROFF / INITIAL / PAUSE / DRYING /
// COOLING / END). Anything outside this table falls back to 'Running' rather than being reported wrongly.
const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x03: 'Pause',
    0x32: 'Drying',
    0x33: 'Cooling',
    0x04: 'End',
}

// Course identifier -> name, derived from the capture by pairing rec[6] with the cloud's
// courseDryer27inchBase at matching timestamps. All 14 values below were observed on this appliance.
// 'Super Dry' is the Downloaded Cycle dial position, which reports whichever smart course is loaded
// into it (the cloud confirmed it as both courseDryer27inchBase and smartCourseDryer27inchBase).
const COURSE: Record<number, string> = {
    0x01: 'Heavy Duty',
    0x02: 'Towels',
    0x03: 'Normal',
    0x04: 'Perm Press',
    0x05: 'Delicates',
    0x07: 'Bedding',
    0x08: 'Antibacterial',
    0x10: 'Speed Dry',
    0x11: 'Air Dry',
    0x12: 'Time Dry',
    0x15: 'Steam Fresh',
    0x16: 'Steam Sanitary',
    0x1a: 'Super Dry',
}

// Dry level 1-5, confirmed by single-step toggling against the cloud's dryLevel enum. 0 (NO_DRYLEVEL)
// is used by courses that do not auto-sense dryness (Speed Dry, Air Dry, Steam Fresh, Time Dry) and
// falls back to 'unknown' below.
const DRY_LEVEL: Record<number, string> = {
    1: 'Damp',
    2: 'Less',
    3: 'Normal',
    4: 'More',
    5: 'Very',
}

// Temp 1-5, confirmed the same way against the cloud's temp enum. 0 (NO_TEMP) is used by courses with
// no heating element (Air Dry) and falls back to 'unknown' below.
const TEMP: Record<number, string> = {
    1: 'Ultra Low',
    2: 'Low',
    3: 'Medium',
    4: 'Mid High',
    5: 'High',
}

// Signal (beeper) volume. Panel-confirmed rather than cloud-confirmed — see SIGNAL_OFFSET.
const SIGNAL: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Low',
    0x04: 'High',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
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
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time estimate',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
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
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    load_item: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_item',
                        state_topic: '$this/load_item',
                        name: 'Load items',
                        icon: 'mdi:tshirt-crew-outline',
                        state_class: 'measurement',
                    },
                    signal: {
                        platform: 'sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell-outline',
                        entity_category: 'diagnostic',
                    },
                    reduce_static: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-reduce_static',
                        state_topic: '$this/reduce_static',
                        name: 'Reduce static',
                        icon: 'mdi:flash-off-outline',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    turbo_steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_steam',
                        state_topic: '$this/turbo_steam',
                        name: 'Turbo Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                },
            }),
        )
    }

    // These dryers only volunteer a status frame when something changes, so a driver that never
    // asks stays blank until the next physical interaction — and every reconnect (container
    // restart, appliance reboot) discards the last known state, leaving Home Assistant pinned at
    // "Off"/unknown indefinitely. Asking once per connect is what makes the entities survive a
    // restart.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0x31 (serial), 0xE2 (idle snapshot) and 0xD8/0x72 (heartbeats) are not decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== 0x1b) return // the current-state record should always lead with its marker

        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Running')
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('dry_level', DRY_LEVEL[rec[DRY_LEVEL_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        this.publishProperty('load_item', rec[LOAD_ITEM_OFFSET])
        this.publishProperty('signal', SIGNAL[rec[SIGNAL_OFFSET]] ?? 'unknown')
        // signed: negative trims the course default, positive extends it
        this.publishProperty('more_less_time', isOff ? 0 : rec.readInt8(MORE_LESS_TIME_OFFSET))

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('reduce_static', (flags & FLAG_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (flags & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_steam', (opt2 & OPT2_TURBO_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        // not yet located (declared entities intentionally omitted rather than published wrong): error
        // codes and a door sensor. Opening the door mid-cycle produces the same generic Pause phase a
        // button press would, with no distinguishing byte found.
    }
}
