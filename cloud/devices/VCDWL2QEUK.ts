import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG F4X7511TWS front-load washer — matched on modelId "VCDWL2QEUK". Unlike the 80-byte
// single-frame F-class washers, this model emits several AABB frame types, discriminated by inner[3]
// (buf = the AABB body, AA+len and checksum+BB already stripped; buf[0]==0x20 on every frame):
//   0x88  config frame  — selected program/options; sent at cycle start / setting-change only.
//   0x92  status frame  — two back-to-back 63-byte records (LG "old state, then new state"); we read
//                         record B = buf[78:141] (current; leads with the soil level, or 0x00 in standby).
//                         cf. the dual-record 0xEC washer in PR #77, which reads the *first* record — this
//                         model uses the second.
//   0x41  door snapshot — carries the current door state; emitted on every door transition / at ready.
// Offsets were reverse-engineered against the LG app and validated in HA; see the PR description for the
// per-offset capture evidence.

const STATUS_FRAME_TYPE = 0x92
const CONFIG_FRAME_TYPE = 0x88
const STATUS_RECORD_OFF = 78 // record B (current state) start within the inner body
const STATUS_RECORD_LEN = 63
const STATUS_FRAME_LEN = 142 // 15B header + 63B recA + 63B recB + 1B trailer
// rec[0] of record B = the wash-intensity (soil) level while washing; 0x00 during the rinse/spin/end
// phases, the spin-only program, and standby (there is no wash intensity then). RE'd by stepping the soil
// level on a fixed course and diffing record B (each level confirmed twice). Power/off is keyed on the
// status byte rec[20], not on this soil lead (see the power-derivation note below).
const SOIL_BY_LEVEL: Record<number, string> = { 1: 'Light', 3: 'Medium', 5: 'Heavy' }
const DOOR_FRAME_TYPE = 0x41
const DOOR_OFFSET = 18 // buf[18] in the 0x41 snapshot: 0x02 = closed, 0x01 = open
const DOOR_CLOSED = 0x02
const DOOR_OPEN = 0x01

// Power/off: a record with BOTH a zero soil lead (rec[0]) AND a zero status byte (rec[20]) is LG POWEROFF
// → OFF (seen on three live power-offs; the two are coincident on every off frame in the captures). Any
// non-zero status is a running frame → ON: the wash phase (soil-led) and the rinse/spin/end phases +
// spin-only program (0x00-soil-led but non-zero status) all share the same record-B offsets. The AND
// (rather than status-alone) guards against a hypothetical soil-led frame with a transient zero status.
const RECORD_B_STANDBY = 0x00

// Settings (temp/spin/course) are read from the status frame's record B — laid out 03 [TEMP] 0e [SPIN]
// [COURSE]… — not from the sparse 0x88 config frame (which fires only at cycle start and is routinely
// missed). These status-frame encodings are distinct from the 0x88 indices, RE'd by diffing record B
// across LG-app "send to machine" pushes one setting at a time. Anything unmapped emits 'unknown'.
// idx 0 = cold wash (no fixed target temperature) → intentionally left unmapped so HA shows None, not 0°C.
const STATUS_TEMP_BY_INDEX: Record<number, number> = { 1: 20, 2: 30, 3: 40, 5: 60, 6: 95 } // idx 4 (50 °C) not offered on this model
const STATUS_SPIN_BY_INDEX: Record<number, number> = { 0: 0, 1: 400, 4: 800, 6: 1000, 8: 1200, 9: 1400 } // full RPM set (no 600 on this model)
const STATUS_COURSE: Record<number, string> = {
    0x72: 'AI Wash',
    0x2e: 'Cotton',
    0x54: 'Towels',
    0x4b: 'Quick 14',
    0x4e: 'Spin only', // a 0x00-soil-led program; decoded like the rinse/spin phases (same record-B offsets)
    0x55: 'Drum Clean',
    // RE'd 2026-06-30 by pushing each program from the LG app and reading rec[4] (cross-checked against
    // the rec[19] repeat). English names for the DK programs this unit offers.
    0x13: 'Eco 40-60',
    0x7a: 'TurboWash 39',
    0x2b: 'Mixed',
    0x16: 'Delicate',
    0x1d: 'Easy Care',
    0x5e: 'Hand/Wool',
    0x4f: 'Activewear',
    0x04: 'Allergy Care',
    0x1b: 'Duvet',
    0x11: 'Cold Wash',
    0x81: 'Bedding',
    0xa9: 'Cuffs & Collars',
    0x6a: 'Rainy Days',
    0x42: 'Silent Wash',
    0x07: 'Baby Steam Care',
    0x73: 'Down Jacket',
    0x88: 'Microplastic Care',
    0x37: 'Rinse + Spin', // pure rinse+spin program: 0x00-soil-led (no wash phase, like spin-only), decoded
    // via the running path since its status byte is non-zero.
}

// Rinse (skyl) level — record B rec[26], a clean 0..5 index, RE'd by stepping the rinse option on a
// fixed course and time-aligning each frame to its label (the "+pause" variants hold water after rinse).
const SKYL_OFFSET = 26
const SKYL_BY_INDEX: Record<number, string> = {
    0: 'None',
    1: 'Normal',
    2: 'Rinse +',
    3: 'Rinse ++',
    4: 'Rinse + Hold',
    5: 'Rinse+ + Hold',
}

// status from record[20] — a course-dependent "step" id (NOT the F-class STATES indices). Maintenance
// courses use their own ids (Drum Clean = 0x29); anything unmapped falls back to 'Running' (free-text
// status, so HA never rejects it).
const STATUS: Record<number, string> = {
    0x01: 'Detecting',
    0x02: 'Paused',
    0x03: 'Detecting', // early detection sub-step (cloud state DETECTING)
    0x0b: 'Washing',
    0x0c: 'Rinsing',
    0x0e: 'Spinning',
    0x10: 'End',
    0x25: 'Detecting', // clothing-recognition sub-step (cloud state CLOTHING_RECOGNITION)
    0x26: 'Washing', // detergent-input sub-step (cloud state DETERGENT_INPUT)
    0x27: 'Rinsing', // softener-input sub-step (cloud state SOFTENER_INPUT)
    0x29: 'Drum Clean',
}

// EzDispense auto-dosing — also in status-frame record B. The two reservoir enable flags and their
// per-wash default doses, RE'd by toggling each dispenser and stepping its dose in the LG app one
// setting at a time and diffing record B (every captured mL value decoded to an exact byte).
// Corroborated on the real drum-clean frame (both enabled, 45/30 mL), so the offsets hold in a running
// cycle, not just at setting-change. Doses go 9–120 mL in 3 mL steps; the byte is the literal mL value.
const DISP_DETERGENT_EN = 29 // rec[29]: 0x02 = detergent dispenser on, 0x00 = off
const DISP_SOFTENER_EN = 30 // rec[30]: 0x02 = softener dispenser on, 0x00 = off
const DISP_DETERGENT_ML = 31 // rec[31]: detergent default dose, direct mL byte
const DISP_SOFTENER_ML = 32 // rec[32]: softener default dose, direct mL byte
const DISP_ON = 0x02

// Program option toggles — a bitfield pair in record B, RE'd by flipping one option at a time (each
// isolated so only its bit moved) and diffing record B; each verified on and off twice.
const OPT_BYTE_A = 33 // rec[33]: pre-wash + TurboWash bits
const OPT_PREWASH = 0x40 // forvask
const OPT_TURBOWASH = 0x20
const OPT_BYTE_B = 34 // rec[34]: steam bit
const OPT_STEAM = 0x10 // damp

// Child-lock + remote-start flags — record B rec[36]. These are toggled on the physical panel (not the
// LG app), and each toggle emits a 0x92; RE'd by flipping each on/off (three cycles) and correlating
// record B against the LG cloud's own childLock/remoteStart fields. Validated both in standby and mid-run
// (rec[36] held its position across a running frame). rec[36] also carries a 0x02 standby-indicator bit
// (set at rest, clears during a run) which is independent of these two flags, so test each bit directly.
const FLAGS_BYTE = 36
const FLAG_CHILD_LOCK = 0x20
const FLAG_REMOTE_START = 0x10

// "Washes since drum clean" counter — record B rec[27]. A single byte (rec[28] is a constant, not a high
// byte). RE'd on a full AI-wash: it read 1 throughout the run and stepped to 2 at status = End, matching
// the LG cloud's TCLCount field (1 → 2) exactly — NOT a lifetime cycle count (this unit exposes no
// lifetime counter; the byte read 32 before a drum-clean and reset to 1 after, i.e. it's the tub-clean
// reminder counter). Present at the same offset in the standby record, so it also reads correctly at
// rest. Published as a plain sensor with NO state_class — it resets at each drum-clean, so total_increasing
// would wrongly accumulate across the reset.
const TUB_CLEAN_OFFSET = 27

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        // Declare only the entities this decoder actually populates (no inherited/zombie entities).
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
                        // free-text (NOT device_class:enum): the step codes are course-dependent and we
                        // emit a 'Running' fallback, both of which an enum constraint would reject.
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        suggested_display_precision: 0,
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door', // payload ON = open, OFF = closed
                    },
                    detergent_dispenser: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-detergent_dispenser',
                        state_topic: '$this/detergent_dispenser',
                        name: 'Detergent dispenser',
                        icon: 'mdi:cup-water',
                    },
                    softener_dispenser: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-softener_dispenser',
                        state_topic: '$this/softener_dispenser',
                        name: 'Softener dispenser',
                        icon: 'mdi:cup-water',
                    },
                    detergent_dose: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent_dose',
                        state_topic: '$this/detergent_dose',
                        name: 'Detergent dose',
                        icon: 'mdi:cup',
                        device_class: 'volume',
                        unit_of_measurement: 'mL',
                        state_class: 'measurement',
                    },
                    softener_dose: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener_dose',
                        state_topic: '$this/softener_dose',
                        name: 'Softener dose',
                        icon: 'mdi:cup-outline',
                        device_class: 'volume',
                        unit_of_measurement: 'mL',
                        state_class: 'measurement',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        // free-text (like course/status): a 'unknown' fallback for unmapped levels.
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water-sync',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    turbowash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
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
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' — that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // No state_class: this counter RESETS to a low value at each drum-clean;
                        // total_increasing would wrongly accumulate across the reset. Raw value is what we want.
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 6) return // < 6 skips the 3-byte heartbeat (need buf[3])
        if (buf[3] === CONFIG_FRAME_TYPE) return this.processConfig(buf)
        if (buf[3] === STATUS_FRAME_TYPE) return this.processStatus(buf)
        if (buf[3] === DOOR_FRAME_TYPE) return this.processDoor(buf)
        // other frame types (0x53 mid-cycle, 0xA0 end snapshot, 0x16/0x4d idle) are not yet decoded.
    }

    // 0x41 — door/ready snapshot. Door state is at buf[18]: 0x02 = closed, 0x01 = open (0x05 =
    // uninitialised at power-on, before the first door event — held, not published). Polarity confirmed
    // against a labelled open/close capture. The 0x41 frame is only emitted while powered on, so the
    // entity retains its last value during off/idle periods.
    private processDoor(buf: Buffer) {
        if (buf.length <= DOOR_OFFSET) return
        const v = buf[DOOR_OFFSET]
        if (v === DOOR_OPEN) this.publishProperty('door', 'ON')
        else if (v === DOOR_CLOSED) this.publishProperty('door', 'OFF')
        // any other value (e.g. 0x05 power-on init) leaves the last published state in place
    }

    // 0x88 — fires at cycle start / setting-change. Settings are read from the status frame (see
    // processStatus), so this frame only serves as an early power-ON signal before the first 0x92.
    private processConfig(_buf: Buffer) {
        this.publishProperty('power', 'ON')
    }

    // 0x92 — runtime status (current-state record B, laid out [SOIL] [TEMP] 0e [SPIN] [COURSE]…):
    //   rec[0]  = soil level (also the running discriminator), rec[1] = temp idx, rec[3] = spin idx,
    //   rec[4]  = course code (status-frame encodings; see the SOIL_BY_LEVEL / STATUS_*_BY_INDEX /
    //            STATUS_COURSE tables — distinct from the 0x88 indices),
    //   rec[20] = status code, rec[13] = remaining min, rec[15] = initial min,
    //   rec[16:18] = energy (big-endian Wh, same shape as the F-class buf[71]*256+buf[72]; confirmed
    //            against the app's per-cycle "Energiforbrug" — 41 Wh cold, 880 Wh @60° — high byte proven),
    //   rec[26] = rinse (skyl) level 0..5 (see SKYL_BY_INDEX),
    //   rec[29:33] = EzDispense (detergent/softener enable + dose mL; see the DISP_* offsets above),
    //   rec[33] = pre-wash/TurboWash bits, rec[34] = steam bit (see the OPT_* masks above).
    private processStatus(buf: Buffer) {
        if (buf.length !== STATUS_FRAME_LEN) return // expected 142B; reject header/layout drift
        const rec = buf.subarray(STATUS_RECORD_OFF, STATUS_RECORD_OFF + STATUS_RECORD_LEN)

        // Powered off / standby: BOTH the soil lead (rec[0]) AND the status byte (rec[20]) are 0 (LG
        // POWEROFF) — coincident on every off frame in the captures. A rinse / spin / end phase and the
        // spin-only program are 0x00-soil-led but carry a NON-zero status, so they fall through to the
        // running decode below. Requiring both to be zero (vs status alone) avoids flipping OFF on a
        // hypothetical soil-led frame with a transient zero status. Zero the countdown so HA doesn't keep
        // a stale remaining time alongside power=OFF; temp/spin/course retain their last values (the
        // standby record is a frozen copy of the last program); energy is left as-is.
        if (rec[0] === RECORD_B_STANDBY && rec[20] === 0x00) {
            this.publishProperty('power', 'OFF')
            this.publishProperty('status', 'Off')
            this.publishProperty('remaining_time', 0)
            this.publishProperty('initial_time', 0)
            // child-lock / remote-start / cycle-count still apply while powered off (same offsets in the
            // standby record) — publish them so HA reflects the panel state and count at rest.
            this.publishPersistent(rec)
            return
        }
        // A running frame. Record B uses the SAME offsets whether it leads with a soil level (wash phase)
        // or 0x00 (rinse / spin / end phases + the spin-only program): the remaining-time countdown at
        // rec[13] was cross-checked against the LG cloud's remainTimeMinute at several rinse points, and
        // initial/spin/course/energy stay consistent across every phase boundary of a full captured cycle.
        // During the non-wash phases soil (rec[0]) and temp (rec[1]) are simply 0 → decode to 'unknown',
        // which is correct (no wash intensity / no active heat then).
        this.publishProperty('power', 'ON')
        this.publishProperty('status', STATUS[rec[20]] ?? 'Running')
        this.publishProperty('soil', SOIL_BY_LEVEL[rec[0]] ?? 'unknown')
        this.publishProperty('rinse', SKYL_BY_INDEX[rec[SKYL_OFFSET]] ?? 'unknown')
        this.publishProperty('temp', STATUS_TEMP_BY_INDEX[rec[1]] ?? 'unknown')
        this.publishProperty('spin', STATUS_SPIN_BY_INDEX[rec[3]] ?? 'unknown')
        this.publishProperty('course', STATUS_COURSE[rec[4]] ?? 'unknown')
        this.publishProperty('remaining_time', rec[13])
        this.publishProperty('initial_time', rec[15])
        this.publishProperty('energy', rec[16] * 256 + rec[17])
        // EzDispense reservoirs: enable flags (0x02 on / else off) + default dose in mL (literal byte).
        this.publishProperty('detergent_dispenser', rec[DISP_DETERGENT_EN] === DISP_ON ? 'ON' : 'OFF')
        this.publishProperty('softener_dispenser', rec[DISP_SOFTENER_EN] === DISP_ON ? 'ON' : 'OFF')
        this.publishProperty('detergent_dose', rec[DISP_DETERGENT_ML])
        this.publishProperty('softener_dose', rec[DISP_SOFTENER_ML])
        // Program option toggles (bitfields): pre-wash + TurboWash in rec[33], steam in rec[34].
        this.publishProperty('prewash', (rec[OPT_BYTE_A] & OPT_PREWASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbowash', (rec[OPT_BYTE_A] & OPT_TURBOWASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPT_BYTE_B] & OPT_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishPersistent(rec)
        // not yet located (declared entities intentionally omitted rather than published wrong): error.
    }

    // Fields that live at stable record-B offsets and persist across power states: child-lock /
    // remote-start bits (rec[36]) and the tub-clean wash counter (rec[27] — washes since the last drum
    // clean, NOT a lifetime count; see the TUB_CLEAN_OFFSET note). Published from both the running and
    // standby paths (record B uses the same offsets in every frame type, including spin-only).
    private publishPersistent(rec: Buffer) {
        this.publishProperty('child_lock', (rec[FLAGS_BYTE] & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (rec[FLAGS_BYTE] & FLAG_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_OFFSET])
    }
}
