import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG WM4000HWA front-load washer — matched on modelId "F3P2CYUBE__" (ThinQ2, deviceType 201, "TITAN27_BIG"
// panel per its modelJson; consumer model confirmed from the appliance plaque, serial 312TNZN1G525).
// Panel photo confirms: 12 dial courses (see COURSE) + a Downloaded slot, and 5 levels each on Temp/Spin/Soil. Same AABB frame family as the F3L2CYU__ sibling, but a LONGER record: 44 bytes led by a 0x2B
// marker (the sibling's is 25 bytes led by 0x18), so every offset below is this model's own.
//
// Frames are discriminated by buf[1] (buf[0] == 0x20 on every frame):
//   0xEC   status frame, 92-byte body: 3B header + 45B record A (previous state) + 44B record B (current).
//          We read record B at buf[48:]. Verified: record A is byte-identical to the previous frame's record B.
//   0xEB   single-record status frame, 47-byte body: the same 44-byte record at buf[3:]. Seen at (re)connect.
//   0xBD / 0xCD  full status dump / idle keepalive (~405-410 bytes) — not decoded.
//   0x31, 0x72, 0xD8, 0xE6, 0x00  serial / heartbeat / misc — not decoded.
//
// Field offsets are relative to the record's 0x2B marker (rec[0]). Values were verified against the LG cloud's
// own decoded washerDryer state (bridge mode) and the LG ThinQ integration in Home Assistant, and by driving the
// panel and watching the byte move. Enum indices are the modelJson's MonitoringValue indices verbatim.
//
//   rec[2]   soil            enum (SOIL)
//   rec[3]   temp            enum (TEMP)
//   rec[4]   rinse level     0x0E none .. 0x11 +3 extra — published as extra_rinse (flag) + extra_rinse_count (0..3)
//   rec[5]   spin            enum (SPIN)
//   rec[6]   course          dial position; COURSE maps the codes to names (read off the dial — the modelJson
//                            names the courses but assigns them no numeric ids)
//   rec[12:14] reserve       delay-wash minutes, 16-bit big-endian; 0 unless a delay is armed
//   rec[14:16] remainTime    hour, minute — remaining time
//   rec[16:18] initialTime   hour, minute — total cycle time
//   rec[19]  courseSpendPower LG's field name; tracks a cloud value but its unit/meaning is undocumented — published raw
//   rec[22]  state           enum (STATE); rec[23] holds the previous state
//   rec[28]  rinse count     TOTAL rinses incl. a course's built-ins; NOT published (extra_rinse_count is the added count)
//   rec[29]  cycles          count since the last Tub Clean
//   rec[30]  bit 0x04        Signal (end-of-cycle chime / button beeps)
//   rec[35]  bit 0x04 cold wash, 0x20 turbo wash (course-locked on some courses), 0x40 pre-wash
//   rec[36]  bit 0x10 steam, 0x20 Rinse+Spin subcycle (temp & soil report null while it is active)
//   rec[37]  bit 0x40 FreshCare
//   rec[38]  bit 0x10 remote start (drives the annunciator lamp), 0x20 child lock, 0x40 DOOR OPEN (doorClose),
//            0x80 Add Item (addGarment)
//   rec[41]  bit 0x01 AI DD badge (AIDDLed) — course-linked (on for Normal & Bright Whites)
//
// Examined and left unmapped (not user-facing features): rec[21] single-frame transient; rec[25] phase-progress
// sub-byte, redundant with state. Door POSITION is carried (rec[38] 0x40 = doorClose) but NOT published: the module
// frames only on a STATE change, never on the door, so it would sit stale. The physical door LOCK is NOT in-frame
// and not in LG's MonitoringValue (its app shows no lock tile either). Error codes not yet observed.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 92 // 3B header + 45B record A + 44B record B
const RECORD_B_OFFSET = 48

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 47 // 3B header + 44B record
const SINGLE_RECORD_OFFSET = 3

const RECORD_MARKER = 0x2b

const SOIL_OFFSET = 2
const TEMP_OFFSET = 3
const RINSE_OFFSET = 4
const SPIN_OFFSET = 5
const COURSE_OFFSET = 6
const REMAIN_HOUR_OFFSET = 14
const REMAIN_MIN_OFFSET = 15
const INITIAL_HOUR_OFFSET = 16
const INITIAL_MIN_OFFSET = 17
const RESERVE_HI_OFFSET = 12 // reserve (delay-wash) minutes, 16-bit big-endian at rec[12:14]; 0 unless armed
const RESERVE_LO_OFFSET = 13
const ENERGY_OFFSET = 19
const STATE_OFFSET = 22
const PRESTATE_OFFSET = 23
// SmartCourse code currently sitting in the 0xFF "Downloaded" slot — the specialty cycle the app shows as loaded,
// echoed back in every status frame. Same code the WMDownload command carries (the byte after `10 0b`). Long
// mislabeled a constant 0x69 because the slot rests on Small Load; it is NOT constant — it tracks each SmartCourse
// as it is downloaded (verified across the 2026-09-05 capture). Mapped to a name via SMARTCOURSE.
const DOWNLOAD_COURSE_OFFSET = 24
const CYCLES_OFFSET = 29
const SIGNAL_OFFSET = 30 // panel "Signal" (end-of-cycle chime / button beeps). CONFIRMED via an off/on capture:
const SIGNAL_BIT = 0x04 // rec[30] 0x00 -> 0x04 as Signal was toggled on; symmetric in the previous-state record.
// rec[35] options byte (base 0x20). Cold Wash pinned live: 0x20->0x24 with cloud coldWash ON, and it forces
// temp to Cold + lengthens the estimate, matching the sibling. Other bits of this byte not yet isolated.
const OPTS35_OFFSET = 35
const OPT35_COLD_WASH = 0x04
// Turbo Wash pinned live on Speed Wash: rec[35] bit 0x20, 0x00<->0x20 tracking the cloud's turboWash. Also
// explains the Normal lock — on Normal this bit is permanently set (Turbo can't be turned off), so the
// sibling's "Turbo reads ON and can't be cycled on Normal" is the same effect, one byte over.
const OPT35_TURBO_WASH = 0x20
const OPT35_PRE_WASH = 0x40 // pinned live: rec[35] 0x20->0x60 with cloud preWash ON
// rec[36] bit 0x10 = steam, bit 0x20 = Rinse+Spin subcycle (temp/soil null while active). rec[37] bit 0x40 = FreshCare.
// rec[38] bit 0x10 = REMOTE START (LG's remoteStart field): ON while the machine is running or armed to run
// unattended, by ANY start method (panel, delay/timer, or a remote arm). It drives the panel's remote/annunciator
// lamp and can be toggled off from the panel mid-run. It is NOT the door lock — it clears with the door still
// physically locked. The physical door lock is not reliably observable in this frame (nor shown in LG's app).
const OPTS36_OFFSET = 36
const OPT36_STEAM = 0x10
const OPT36_RINSE_SPIN = 0x20 // pinned live: rec[36] bit 0x20 = Rinse+Spin subcycle active (a modifier on the
// selected course, not a course itself); while set, temp & soil report null (0x00) since it does not wash
const OPTS37_OFFSET = 37
const OPT37_FRESH_CARE = 0x40 // pinned live: rec[37] 0x00->0x40 with cloud freshCare ON
const OPTS38_OFFSET = 38
const OPT38_REMOTE_START = 0x10
const OPT38_CHILD_LOCK = 0x20 // child lock; confirmed against the cloud's childLock (this model exposes it in-frame, unlike the sibling)
// rec[38] bit 0x40 = door OPEN/closed (LG's doorClose/initialBit, a MonitoringValue). CONFIRMED live against labeled
// frames: 0x00 closed -> 0x40 open, independent of remote_start (0x10) and child_lock (0x20). Door POSITION, not the
// lock. NOT published: the module frames only on STATE changes, never on the door, so the value sits stale (reads
// "open" after the door is shut). The physical door LOCK is not in-frame (LG never puts it in MonitoringValue).
const OPT38_ADD_ITEM = 0x80 // Add Item annunciator (LG's addGarment). CONFIRMED live: set for the whole Add-Item
// episode (which pauses, drains, and unlocks); a PLAIN pause clears remote_start WITHOUT setting this bit, which is
// what distinguishes it. Cleared on resume.
const AIDDLED_OFFSET = 41
const AIDDLED_BIT = 0x01 // AI DD fabric-sensing badge (LG's AIDDLed). Purely a function of the selected course (on
// for Normal & Bright Whites, off for all others) — the cloud reports it, so we mirror it.

const STATE_OFF = 0x00

// modelJson MonitoringValue.state — indices verbatim, labels de-shouted.
const STATE: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x02: 'Paused',
    0x03: 'Detecting',
    0x05: 'Add Drain',
    0x06: 'Detergent Amount',
    0x07: 'Reserved',
    0x09: 'Pre-wash',
    0x0b: 'Running',
    0x0c: 'Rinsing',
    0x0d: 'Rinse Hold',
    0x0e: 'Spinning',
    0x0f: 'Drying',
    0x10: 'End',
    0x15: 'Refreshing',
    0x17: 'Error Auto Off',
    0x1b: 'Frozen Prevent Initial',
    0x1c: 'Frozen Prevent Pause',
    0x1d: 'Frozen Prevent Running',
    0x22: 'Audible Diagnosis',
    0x23: 'Auto DT Open Pause',
    0x24: 'Confirm Start For Control',
}

const SOIL: Record<number, string> = {
    0: 'None',
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

const TEMP: Record<number, string> = {
    0: 'None',
    13: 'Tap Cold',
    14: 'Cold',
    15: 'Eco Warm',
    16: 'Warm',
    17: 'Warm Rinse',
    18: 'Hot',
    19: 'Extra Hot',
}

const SPIN: Record<number, string> = {
    0: 'None',
    12: 'Drain Only',
    13: 'Low',
    14: 'Medium',
    15: 'High',
    16: 'Extra High',
}

// Course code -> name. The modelJson names the courses but assigns no numeric codes, so these were read off
// the dial live against the cloud's own course field — a full sweep of every dial position (2026-09-05),
// including the long-press Spin Only. 0xFF is the downloaded-course slot.
const COURSE: Record<number, string> = {
    0x00: 'None', // idle / nothing selected — the dial hasn't been read (power-on, standby)
    0x05: 'Allergiene',
    0x0d: 'Bedding',
    0x16: 'Delicates',
    0x23: 'Heavy Duty',
    0x2e: 'Normal',
    0x30: 'Perm. Press',
    0x3c: 'Sanitary',
    0x4a: 'Speed Wash',
    0x4e: 'Spin Only',
    0x54: 'Towels',
    0x55: 'Tub Clean',
    0x5a: 'Bright Whites',
    0xff: 'Downloaded Course',
}

// name -> course code, for the remote config/start command (speaks the exact codes the decoder reads).
const COURSE_REV: Record<string, number> = Object.fromEntries(
    Object.entries(COURSE).map(([code, name]) => [name, Number(code)]),
)
// The 13 dial positions offered for a remote start (excludes only 'None'). 'Downloaded Course' (0xFF) starts
// whatever is currently in the Downloaded slot — the RUN half of the specialty flow (download a SmartCourse into
// the slot, then start it here). A bare config/start on 0xFF runs the slot's current course.
const START_COURSE_OPTIONS = [
    'Normal',
    'Heavy Duty',
    'Towels',
    'Perm. Press',
    'Delicates',
    'Bedding',
    'Bright Whites',
    'Allergiene',
    'Sanitary',
    'Speed Wash',
    'Tub Clean',
    'Spin Only',
    'Downloaded Course',
]
const DELAY_MAX_HOURS = 19 // the app's delay-start ceiling

// ---- SmartCourse download (the "Specialty cycle" flow) ----
// The 17 SmartCourses the app can DOWNLOAD into the machine's 0xFF slot — cycles that are NOT dial positions
// (Baby Clothes, Denim, EconoWash, Overnight, …). Each entry: display name, the machine's own SmartCourse code
// (the byte after `10 0b` in the WMDownload command AND the value echoed back in status at rec[24]), and the exact
// captured WMDownload inner frame. Captured off the wire 2026-09-05 by pushing every one from the LG app; all 17
// codes confirmed by name against the machine. NOTE the code is the MACHINE's SmartCourse id, NOT the modelJson
// numeric `id` — the two disagree (modelJson calls EconoWash id 106, but its on-wire code is 0x78 / 120).
// Flow: pick one on the `specialty` select -> it downloads (stores that cycle in the slot); `downloaded_course`
// then reads back which is loaded; `start_course` -> 'Downloaded Course' runs it. Download is a write, so it is
// gated by Remote Start like every other command (beep-and-ignore if off). The inner frames are checksum-verified:
// re-framing each through send() reproduces the captured on-wire bytes exactly.
const SPECIALTY_COURSES: Array<{ name: string; code: number; download: string }> = [
    {
        name: 'Sweat Stains',
        code: 0x65,
        download: 'f0e5000201ff100b650aff0c2e1f10210f1e013d00200e220010003e0034003800350144007f0000',
    },
    {
        name: 'Swimwear',
        code: 0x67,
        download: 'f0e5000201ff100b670aff0c161f0e210d1e013d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'Baby Clothes',
        code: 0x68,
        download: 'f0e5000201ff100b680aff0c2e1f12210f1e033d00200f220010003e0034013800350044007f0000',
    },
    {
        name: 'Small Load',
        code: 0x69,
        download: 'f0e5000201ff100b690aff0c441f10210f1e033d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'Overnight',
        code: 0x6a,
        download: 'f0e5000201ff100b6a0aff0c2e1f10210d1e033d00200e220010003e0034003800350044017f0000',
    },
    {
        name: 'Single Garments',
        code: 0x6b,
        download: 'f0e5000201ff100b6b0aff0c4a1f12210f1e013d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'Rainy Day',
        code: 0x6d,
        download: 'f0e5000201ff100b6d0aff0c2e1f1021101e033d00200e220010003e0034003800350144007f0000',
    },
    {
        name: 'Gym Clothes',
        code: 0x6e,
        download: 'f0e5000201ff100b6e0aff0c4f1f10210e1e013d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'Color Care',
        code: 0x6f,
        download: 'f0e5000201ff100b6f0aff0c2e1f0e210e1e033d00200e220010003e0034003800350144007f0000',
    },
    {
        name: 'Denim',
        code: 0x70,
        download: 'f0e5000201ff100b700aff0c2e1f0e210e1e033d00200e220010003e0034003800350144007f0000',
    },
    {
        name: 'Full Load',
        code: 0x71,
        download: 'f0e5000201ff100b710aff0c2e1f10210f1e053d00200f220010003e0034003800350044007f0000',
    },
    {
        name: 'Beachwear',
        code: 0x73,
        download: 'f0e5000201ff100b730aff0c161f0e210e1e013d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'New Clothes',
        code: 0x74,
        download: 'f0e5000201ff100b740aff0c2e1f0e210d1e013d00200e220010003e0034003800350144007f0000',
    },
    {
        name: 'Half Load',
        code: 0x76,
        download: 'f0e5000201ff100b760aff0c2e1f10210f1e033d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'EconoWash',
        code: 0x78,
        download: 'f0e5000201ff100b780aff0c2e1f0e210f1e033d00200e220010003e0034003801350044007f0000',
    },
    {
        name: 'Delicate Dresses',
        code: 0x79,
        download: 'f0e5000201ff100b790aff0c161f0e210d1e013d00200e220010003e0034003800350044007f0000',
    },
    {
        name: 'Hand Wash/Wool',
        code: 0xdd,
        download: 'f0e5000201ff100bdd0aff0c221f10210d1e033d00200e220010003e0034003800350044007f0000',
    },
]
const SMARTCOURSE: Record<number, string> = Object.fromEntries(SPECIALTY_COURSES.map((c) => [c.code, c.name])) // code -> name, for decoding the downloaded_course status byte (rec[24])
const SPECIALTY_DOWNLOAD: Record<string, string> = Object.fromEntries(
    SPECIALTY_COURSES.map((c) => [c.name, c.download]),
) // name -> WMDownload inner frame, for the specialty select's write
// 'unknown' leads so the select rests un-armed and every pick is a fresh change (the machine ignores a re-download
// of the course already loaded — snapping back to 'unknown' keeps HA always sending a real transition).
const SPECIALTY_OPTIONS = ['unknown', ...SPECIALTY_COURSES.map((c) => c.name)]

export default class Device extends AABBDevice {
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
                        // NO device_class: this is power on/off (state != Off), not cycle-running. device_class
                        // 'running' would relabel the ON state as "Running", which reads wrong on an idle-but-
                        // powered machine. Whether a cycle is actually running is the `status` sensor's job.
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    previous_status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-previous_status',
                        state_topic: '$this/previous_status',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    course_code: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course_code',
                        state_topic: '$this/course_code',
                        name: 'Course code',
                        icon: 'mdi:pound',
                        entity_category: 'diagnostic',
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded course',
                        icon: 'mdi:download-box-outline',
                        // Which SmartCourse is loaded in the 0xFF slot (rec[24]), decoded via SMARTCOURSE. This is the
                        // identity the app shows as "downloaded"; pairs with the `specialty` select (writes the slot)
                        // and start_course -> 'Downloaded Course' (runs it). Rests on Small Load out of the box.
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
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Cycle time',
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
                        icon: 'mdi:water-plus',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-plus',
                        state_class: 'measurement',
                    },
                    cold_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cold_wash',
                        state_topic: '$this/cold_wash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
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
                    rinse_spin: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_spin',
                        state_topic: '$this/rinse_spin',
                        name: 'Rinse + Spin',
                        icon: 'mdi:water-sync',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'FreshCare',
                        icon: 'mdi:tumble-dryer',
                    },
                    signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        icon: 'mdi:cellphone-wireless',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                    },
                    add_item: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-add_item',
                        state_topic: '$this/add_item',
                        name: 'Add Item',
                        icon: 'mdi:tshirt-crew',
                    },
                    ai_dd: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-ai_dd',
                        state_topic: '$this/ai_dd',
                        name: 'AI DD',
                        icon: 'mdi:brain',
                        entity_category: 'diagnostic',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start (as dialed)',
                        icon: 'mdi:play',
                        // The bare start verb: runs the cycle currently dialed at the panel, with the panel's settings.
                        // Needs Remote Start armed at the machine (LG's flow: set the cycle, press Remote Start on the
                        // washer, then start remotely). No state in the packet — the machine supplies the cycle.
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    power_off: {
                        platform: 'select',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        state_topic: '$this/power_off',
                        options: ['unknown', 'Power Off'],
                        name: 'Power Off',
                        icon: 'mdi:power',
                        // A select, not a button, so powering off is a deliberate two-step (open the dropdown, pick
                        // 'Power Off') rather than a one-tap — the entity-level guard HA can actually offer, since it
                        // has no button confirm. It resets to 'unknown' after firing. See setProperty for the caveat.
                    },
                    start_course: {
                        platform: 'select',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        options: START_COURSE_OPTIONS,
                        name: 'Start course',
                        icon: 'mdi:play-box-outline',
                        // Optimistic (no state_topic): picking a course fires the config/start command for that
                        // course at its defaults, folding in the current Delay start value. Requires "Remote Start".
                    },
                    specialty: {
                        platform: 'select',
                        unique_id: '$deviceid-specialty',
                        command_topic: '$this/specialty/set',
                        state_topic: '$this/specialty',
                        options: SPECIALTY_OPTIONS,
                        name: 'Specialty cycle (download)',
                        icon: 'mdi:download-box-outline',
                        // Picking a SmartCourse fires its WMDownload — storing that cycle in the 0xFF slot. It does
                        // NOT start anything: `downloaded_course` then shows it loaded, and start_course ->
                        // 'Downloaded Course' runs it. Resets to 'unknown' after firing (see setProperty). This is the
                        // access to LG's specialty cycles the stock integration does not give — the point of the fork.
                    },
                    delay: {
                        platform: 'number',
                        unique_id: '$deviceid-delay',
                        command_topic: '$this/delay/set',
                        state_topic: '$this/delay',
                        min: 0,
                        max: DELAY_MAX_HOURS,
                        step: 1,
                        mode: 'box',
                        unit_of_measurement: 'h',
                        name: 'Delay start',
                        icon: 'mdi:clock-plus-outline',
                        // Hours folded into the next start_course blob (0 = start now). The one cycle variable that
                        // is NOT course-constrained, so it is safe to expose without per-course option logic. Also
                        // doubles as the test hold: set 1, a course pick queues a 1h-delayed cycle you can cancel.
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycles Since Clean',
                        icon: 'mdi:counter',
                        state_class: 'total',
                        entity_category: 'diagnostic',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Course energy',
                        icon: 'mdi:lightning-bolt',
                        state_class: 'measurement',
                        // the cloud calls this courseSpendPower and gives it no unit; published raw
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf, RECORD_B_OFFSET, STATUS_FRAME_LEN)
        if (buf[1] === SINGLE_STATUS_FRAME_TYPE)
            return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_STATUS_FRAME_LEN)
        // 0xBD/0xCD dumps, 0x31 serial, 0x72/0xD8/0xE6/0x00 heartbeats and misc are not yet decoded.
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset)
        if (rec[0] !== RECORD_MARKER) return

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE[state] ?? `Unknown (${state})`)
        this.publishProperty('previous_status', STATE[rec[PRESTATE_OFFSET]] ?? `Unknown (${rec[PRESTATE_OFFSET]})`)
        this.publishProperty('course_code', '0x' + rec[COURSE_OFFSET].toString(16).padStart(2, '0'))
        this.publishProperty('course', COURSE[rec[COURSE_OFFSET]] ?? 'unknown')
        // Which SmartCourse is loaded in the 0xFF Downloaded slot (rec[24]); tracks the specialty download. 0x00 =
        // empty slot; an unmapped code falls back to hex so a new/unknown SmartCourse is still visible, not hidden.
        const dl = rec[DOWNLOAD_COURSE_OFFSET]
        this.publishProperty(
            'downloaded_course',
            SMARTCOURSE[dl] ?? (dl === 0 ? 'None' : '0x' + dl.toString(16).padStart(2, '0')),
        )
        // Zeroed while Off: the machine keeps stale settings bytes after power-off.
        const reserve = (rec[RESERVE_HI_OFFSET] << 8) | rec[RESERVE_LO_OFFSET]
        this.publishProperty('delay_wash', reserve > 0 ? 'ON' : 'OFF')
        this.publishProperty('reserve_time', reserve)
        this.publishProperty('remaining_time', isOff ? 0 : rec[REMAIN_HOUR_OFFSET] * 60 + rec[REMAIN_MIN_OFFSET])
        this.publishProperty('initial_time', isOff ? 0 : rec[INITIAL_HOUR_OFFSET] * 60 + rec[INITIAL_MIN_OFFSET])
        this.publishProperty('soil', SOIL[rec[SOIL_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', TEMP[rec[TEMP_OFFSET]] ?? 'unknown')
        // Extra rinses the user added, off rec[4] (0x0E none .. 0x11 +3), split into a flag + a 0..3 count to
        // match the sibling's shape. (rec[28] holds the TOTAL rinse count including a course's built-in rinses;
        // not published — the added count is what the panel's Extra Rinse button controls.)
        const extraRinses = Math.max(0, Math.min(3, rec[RINSE_OFFSET] - 0x0e))
        this.publishProperty('extra_rinse', extraRinses > 0 ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse_count', extraRinses)
        this.publishProperty('cold_wash', (rec[OPTS35_OFFSET] & OPT35_COLD_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_wash', (rec[OPTS35_OFFSET] & OPT35_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (rec[OPTS35_OFFSET] & OPT35_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPTS36_OFFSET] & OPT36_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('rinse_spin', (rec[OPTS36_OFFSET] & OPT36_RINSE_SPIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPTS37_OFFSET] & OPT37_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('signal', (rec[SIGNAL_OFFSET] & SIGNAL_BIT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (rec[OPTS38_OFFSET] & OPT38_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPTS38_OFFSET] & OPT38_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        // rec[38] 0x40 = door POSITION (LG's doorClose) — decoded and understood, but deliberately NOT published:
        // the module frames only on a STATE change, never on the door itself, so a door sensor sits stale (reads
        // "open" long after the door is shut, untouched). LG monitors doorClose but its app shows no door tile, same
        // reason. rec[38] 0x10, once mistaken for the lock, is remote start; the physical door LOCK is not in-frame.
        this.publishProperty('add_item', (rec[OPTS38_OFFSET] & OPT38_ADD_ITEM) !== 0 ? 'ON' : 'OFF')
        // AI DD badge (LG's AIDDLed): course-linked, mirrored from the cloud (see AIDDLED_OFFSET).
        this.publishProperty('ai_dd', (rec[AIDDLED_OFFSET] & AIDDLED_BIT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('spin', SPIN[rec[SPIN_OFFSET]] ?? 'unknown')
        this.publishProperty('cycles', rec[CYCLES_OFFSET])
        this.publishProperty('energy', rec[ENERGY_OFFSET])
        this.publishProperty('delay', this.delayMinutes / 60) // reflect the write-side delay setting so the number shows it
    }

    // ---- write path (control) ----
    // Command opcode for this model is F0 E5 (the sibling's F0 24/2A does NOT apply here). Each command below
    // is the EXACT inner captured from the real LG cloud driving this machine through rethink's bridge, verified
    // by re-deriving the on-wire checksum via AABBDevice.send(). These commands are GATED by remote start (the
    // remote_start entity, rec[38] 0x10): with it off the appliance just beeps and ignores them. A running cycle
    // auto-enables it unless disabled from the panel; an idle machine leaves it off unless armed.
    //
    // REMOTE-START SCOPE (a deliberate decision — documented for whoever extends this):
    // `start_course` sends the DEFAULT blob for the picked course — that course at its own defaults, start-now.
    // That is the whole feature, on purpose — a customised cycle is started the other way round: set it up at the panel
    // (which enforces each course's option rules) and press `start`, the bare verb. A full remote cycle-builder
    // (override temp/soil/spin/rinse/options at start time) is intentionally NOT built, for two reasons:
    //   1. The start is stateless, so the set of valid commands is combinatorial (course x every option x delay =
    //      hundreds) — a wall of MQTT selects assembling one is the wrong tool.
    //   2. Each course CONSTRAINS which options are legal: Turbo is course-locked (the machine refuses to set it,
    //      proven with a control packet), and some temp/spin levels are disallowed per course. A correct builder
    //      must encode every course's option-availability rules — real work for marginal remote value.
    // To customize a cycle: use the machine's panel, or extend this code. The full config/start grammar and the
    // field ids are on buildConfigStart() below; the parked builder-wip draft has HA entity scaffolding to start from.
    start() {
        // connection init — makes the appliance begin streaming status frames (captured toDevice handshake)
        this.send(Buffer.from('f0ed1121010000001800', 'hex'))
    }

    setProperty(prop: string, value: string) {
        // All commands below are EXACT cloud->device packets captured via bridge mode while driving the LG app,
        // each checksum-verified against AABBDevice.send(). Gated by remote start (see above): beep-and-ignore if off.
        // Two starts exist. `start` is the bare verb: it runs whatever is DIALED at the panel, with the panel's own
        // settings (confirmed live 2026-09-07: Towels dialed, Extra High spin set, Remote Start armed at the machine
        // -> ConfirmStart -> Detecting on Towels). The packet carries no state; the machine supplies the cycle.
        // `start_course` is the stateless config blob — a course chosen remotely, at its defaults. Exposed: start /
        // pause / resume / power_off / start_course / delay / specialty (WMDownload).
        if (prop === 'start') this.send(Buffer.from('f0e5000201ff010301', 'hex'))
        else if (prop === 'pause') this.send(Buffer.from('f0e5000201ff010302', 'hex'))
        else if (prop === 'resume')
            this.send(Buffer.from('f0e5000201ff0244000303', 'hex')) // resume-from-pause: a DISTINCT, longer packet than start
        else if (prop === 'power_off') {
            // WMOff — the app's Power Off, exposed as a select: picking 'Power Off' fires, then it snaps back to
            // 'unknown'. The dropdown IS the guard (a deliberate two-step); HA has no entity-level "Are you sure?"
            // for a button, and LG's own integration ships an unguarded power control that strands the machine on a
            // fat-finger. Caveat, documented not withheld: remote power-off drops the Wi-Fi module with no reliable
            // remote wake, stranding the connection until someone walks to the machine — exactly as the app warns.
            if (value === 'Power Off') {
                this.send(Buffer.from('f0e5000201ff010200', 'hex'))
                this.publishProperty('power_off', 'unknown') // reset the dropdown so it can't sit armed and is re-fireable
            }
        } else if (prop === 'start_course') {
            // config/start: start the picked course at its defaults, folding in the current delay (course-only, per
            // scope). Like all writes, needs "Remote Start" armed or the appliance beeps and ignores it.
            const course = COURSE_REV[value]
            if (course !== undefined) this.send(this.buildConfigStart(course))
        } else if (prop === 'delay') {
            // hours of delay-start for the next start_course. Not sent on its own — it rides in the start blob.
            const h = Math.max(0, Math.min(DELAY_MAX_HOURS, Math.round(Number(value) || 0)))
            this.delayMinutes = h * 60
            this.publishProperty('delay', h)
        } else if (prop === 'specialty') {
            // WMDownload: store the picked SmartCourse into the 0xFF Downloaded slot (the specialty-cycle write).
            // The exact captured download frame, re-checksummed by send(). Then snap back to 'unknown' so it stays
            // re-fireable and never sits looking armed — the loaded cycle is read back on `downloaded_course`, and
            // running it is start_course -> 'Downloaded Course'. Gated by Remote Start like every write.
            const dl = SPECIALTY_DOWNLOAD[value]
            if (dl !== undefined) {
                this.send(Buffer.from(dl, 'hex'))
                this.publishProperty('specialty', 'unknown')
            }
        }
        // Out of scope (grammar known, not built): the full per-field cycle builder (temp/soil/spin/rinse/pre-wash/
        // cold/steam/freshCare/delay overrides — see buildConfigStart); and power ON (WMWakeup, moot after a remote
        // off). WMDownload IS built now — the `specialty` select, one captured frame per SmartCourse.
    }

    // Build the config/start command for a course at its defaults. Grammar reverse-engineered + confirmed against
    // captured app frames:  f0 e5 00 02 01 ff [0x03 + #override-pairs] 0a [course] {[fieldId][value]}... 7f
    // [delayHi delayLo] 03 01.  Course-only here: no override pairs (sub 0x03), delay 0 (0x0000 = start now); the
    // AABB frame + outer checksum are added by send(). Field-pair ids for the full builder (later): temp 0x1f,
    // soil 0x1e, spin 0x21, rinse 0x20, preWash 0x34, coldWash 0x38, steam 0x3e, freshCare 0x44 (turbo 0x35 the
    // machine refuses — it is course-determined).
    // Hours-of-delay (as minutes) folded into the next start_course blob; set by the `delay` number entity. 0 = now.
    private delayMinutes = 0

    private buildConfigStart(course: number): Buffer {
        const d = this.delayMinutes
        return Buffer.from([
            0xf0,
            0xe5,
            0x00,
            0x02,
            0x01,
            0xff,
            0x03,
            0x0a,
            course,
            0x7f,
            (d >> 8) & 0xff,
            d & 0xff,
            0x03,
            0x01,
        ])
    }
}
