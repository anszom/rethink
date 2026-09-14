import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG heat-pump dryer, matched on modelId "BDH_D30007_US" (thinq2 deviceType 202), sold as DLHC5502V.
//
// Like its matching washer (see FAFXU25006.ts) this model uses the long, length-escaped AABB framing
// rather than the short one the RV13* dryers use. A frame on the wire looks like:
//
//     aa ff 30 0a 00 66 00 00 7e 00 01 00 ec 00 54 <payload> <chk16> bb
//      │  │  │  │  └──┬──┘             │  └──┬──┘
//      │  │  │  │     │                │     └ inner payload length
//      │  │  │  │     │                └ inner frame type
//      │  │  │  │     └ 16-bit total frame length
//      │  │  │  └ envelope type
//      │  │  └ class byte, 0x30 for the dryer (the washer uses 0x20)
//      │  └ 0xFF escape: the real length follows as 16 bits, not in this byte
//      └ AA
//
// AABBDevice.processData hands us buf = the frame minus AA/length and minus the trailing checksum and
// BB, so buf[0] is the class byte and the inner type sits at buf[10] rather than at buf[1]. The
// checksum is 16-bit in this framing, so buf carries one byte past the payload; that is why the
// expected buf lengths below are one more than header + inner length.
//
// Inner types:
//   0xEC  two stacked 42-byte records, previous state at buf[13] and current state at buf[55]
//   0xEB  a single current-state record at buf[13], same field layout, sent in reply to a status query
//   0x85/0x86  not status at all, an ASCII list of deactivated content ids
//   0x00/0x31/0x4d/0x7f/0xc3/0x19/0x72/0xd8  not decoded
//
// Records are 42 bytes here against 72 on the washer and 28/29 on the RV13* dryers, and the fields sit
// at different offsets from all of them, so this cannot be aliased to any existing handler.
//
// Every offset and table entry was confirmed live: real wire traffic captured while the dryer was
// driven by hand at the panel and from the ThinQ app, with rethink bridged to the LG cloud so each
// byte change could be matched against the cloud's own decoded washerDryer state at the same timestamp.

const CLASS_BYTE = 0x30
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 42

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

// Status query, sent on every connect. LG's own, lifted verbatim from the cloud's traffic while
// bridging, and byte for byte the same query it sends the matching washer. 0xF0ED is the family-wide
// "report your state" request; actuating commands are 0xF0E5, so this only ever reads.
const STATUS_REQUEST = 'F0ED112101000000180411120000'

// Offsets are relative to the start of the 42-byte record.
const DRY_LEVEL_OFFSET = 1
const ECO_HYBRID_OFFSET = 2
const COURSE_OFFSET = 5
// rec[9:11] and rec[11:13] are BIG-endian 16-bit minute counts. Note this is the opposite byte order
// from the matching washer, which is little-endian. Confirmed on 46 and 42 samples respectively.
const REMAIN_TIME_OFFSET = 9
const INITIAL_TIME_OFFSET = 11
const STATE_OFFSET = 13
const PRE_STATE_OFFSET = 14
// rec[17:19], big-endian: energy used so far by the running cycle, in Wh, matching the cloud's
// courseSpendPower on all 46 samples.
const SPENT_POWER_OFFSET = 17
const BUZZER_OFFSET = 19
// rec[20] is the cloud's baseDownloadCourseData, the cycle the appliance has actually loaded, which
// is a different field from rec[5] rather than a copy of it. They agree on most cycles, both reading 7
// while the cloud says NORMAL for each, and part on five seen so far: AI Dry loads SHIRT1EA, Shrinkage
// Relief loads LOWTEMPDRY, Easy Ironing loads AIRDRY, Silent Dry loads ULTRADELICATES and Rainy Days
// loads SPEEDDRY. That is the same dial-position-versus-loaded-cycle split the RV13B6ES has on its
// Downloaded Cycle. rec[5] is what the cloud calls course, so that is what gets published; rec[20] has
// no table here because its values are the loaded sub-cycles rather than anything an owner selects.
// rec[24]: options bitfield, each bit isolated by toggling one control at a time against the cloud.
const OPT1_OFFSET = 24
const OPT1_WRINKLE_CARE = 0x08
const OPT1_DRUM_LIGHT = 0x20
const OPT1_DAMP_DRY_BEEP = 0x40
// rec[26]: a second options bitfield.
const OPT2_OFFSET = 26
const OPT2_DETECT_LOAD = 0x04
// Remote Start, mirroring the cloud's remoteStart. Confirmed by switching it off at the panel on an
// idle machine: rec[26] went 0x44 to 0x04 with nothing else moving and the cloud reporting
// REMOTE_START_OFF.
//
// The appliance re-enables it on its own: starting a cycle by hand, with Remote Start off moments
// earlier, took the byte back to 0x44 as the machine entered DETECTING, cloud REMOTE_START_ON in the
// same frame. There is no way to turn this auto-enable off, so an ON here just means a cycle is
// running or about to.
const OPT2_REMOTE_START = 0x40
// Condenser clean: set for exactly as long as the state byte in the same record reads 17
// CONDENSER_CLEAN, and clear either side of it, on every cycle that runs one. The cloud names it
// selfCleaning, not anything containing "condenser", which is worth knowing before hunting for it by
// name: rec[26] goes 0x40 to 0x60 as the state becomes CONDENSER_CLEAN with
// selfCleaning:"SELFCLEANING_ON" in the same frame, and back again five minutes later with
// SELFCLEANING_OFF.
const OPT2_CONDENSER_CLEAN = 0x20
// rec[27]: a third flag byte. 0x40 and 0x80 have both been seen and are undecoded.
const OPT3_OFFSET = 27
// Cycle Optimization, which is what both the ThinQ app and the panel call it; LG's cloud files it as
// autoCourseArrange. Toggled from the app in both directions with the bit alone moving in the record
// and the cloud naming it in the same frame. It is on by default, which is why the bit reads 1 in
// almost every record captured.
const OPT3_CYCLE_OPTIMIZATION = 0x01
// Remote Maintain, the setting that keeps the drum tumbling after a cycle ends. Confirmed on four
// transitions across three cycles, each with the cloud naming it in the same second: 0x81 to 0x83 as
// a run reaches DRYING, matched by remoteMaintain:"REMOTE_MAINTAIN_ON", and 0x83 back to 0x81 at
// power-off, matched by REMOTE_MAINTAIN_OFF. This is also what makes a cycle end into state 22 rather
// than 4 END, whether it was started by hand or from the app.
const OPT3_REMOTE_MAINTAIN = 0x02

const STATE_POWEROFF = 0

// State codes. This dryer's wire codes follow its modelJSON enum indices exactly, the same as its
// matching washer and unlike the LG range and microwave. Nine values have been seen live: 0 POWEROFF,
// 1 INITIAL, 3 PAUSE and 7 DRYING from a run driven by hand and from the ThinQ app, and 4 END,
// 8 COOLING, 14 DETECTING and 17 CONDENSER_CLEAN from a complete Towels cycle, all eight against the
// cloud's own state field, plus 22 END_REMOTE_MAINTAIN_ON, which every cycle ends into instead of
// 4 END while remoteMaintain is on, whether started by hand or from the app.
//
// The rest of the table is LG's indices for the same field. Anything outside it reports None
// rather than a guess.
const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Running: 2,
    Pause: 3,
    End: 4,
    Error: 5,
    'Audible diagnosis': 6,
    Drying: 7,
    Cooling: 8,
    'Wrinkle care': 9,
    Reserved: 10,
    'Delay load': 11,
    'Spin reserve': 12,
    'Auto test': 13,
    Detecting: 14,
    Steam: 15,
    'Clothing recognition': 16,
    'Condenser clean': 17,
    'Bedding brushing': 18,
    'Dry refreshing': 19,
    'Allergy care': 20,
    'Condenser care': 21,
    'End remote maintain on': 22,
    'Dry ready': 23,
    'Laundry care': 24,
    Dehumidification: 25,
    'Dehumidification end': 26,
    'End waiting': 27,
    'Drum care': 28,
})

// Course codes. Ten are dial positions, the other twelve reachable only from the ThinQ app. This
// model's modelJSON carries no course index table, so every code came from selecting that cycle and
// reading the byte. The cloud's 22-entry panelCrsList happens to match this set, but is not the
// catalogue: on the matching washer it is the panel's currently-assigned slots, seen at ten entries
// and then six, so expect this table to be missing cycles.
//
// Names are what the panel calls each cycle, not the cloud identifiers, which disagree on most of
// them and not merely in wording: code 9 is Small Load here but QUICKDRY there, while the panel's own
// Quick Dry is code 23 (BABYWEAR). Publishing the cloud names would tell an owner their dryer was
// running something it is not, so each entry keeps its identifier as a trailing comment instead.
const COURSE = Enum.of({
    Towels: 2, // TOWELS
    Bedding: 4, // BEDDING
    'Perm. Press': 5, // EASYCARE
    Normal: 7, // NORMAL
    Activewear: 8, // SPORTWEAR
    'Small Load': 9, // QUICKDRY
    Delicates: 10, // DELICATES
    'Air Dry': 13, // COOLAIR
    'Bedding Refresh': 15, // BEDDINGBRUSH
    'Power Dry': 16, // ALLERGYCARE
    'Heavy Duty': 17, // POWER
    'Condenser Care': 18, // CONDENSERCARE
    'Drum Care': 19, // TUBCLEAN
    'Down Jacket Refresh': 20, // PADDINGREFRESH
    'Timed Dry': 21, // TIMEDRY
    'Outerwear Refresh': 22, // WATERREPELLENT
    'Quick Dry': 23, // BABYWEAR
    'AI Dry': 44, // AI_COURSE
    'Silent Dry': 45, // SILENT
    'Shrinkage Relief': 46, // CLOTHCARE
    'Rainy Days': 50, // RAINYDAY
    'Easy Ironing': 51, // EASYIRON
    // Not a cycle of its own: the appliance is running a cycle pushed to it from the app, and which
    // one is in rec[23] rather than here.
    'Downloaded cycle': 255, // DOWNLOAD
})

// rec[23]: which downloaded cycle is loaded, the cloud's downloadCourse, and 0 when none is. It is a
// separate field from the course precisely because rec[5] reads the same 255 sentinel for any of
// them. Two have been pushed to this appliance so far; the app offers more, and an unlisted id
// reports None rather than a guess.
const DOWNLOAD_COURSE_OFFSET = 23
const DOWNLOAD_COURSE = Enum.of({
    None: 0,
    'Wrinkle Prevention': 114, // MINIMIZEWRINKLES
    'Rack Dry': 140, // RACKDRY
})

// Dry level 1-5, confirmed by stepping the button against the cloud's dryLevel. 0 (NO_DRYLEVEL) is
// what the courses that do not sense dryness report, and falls through to None.
const DRY_LEVEL = Enum.of({
    'Damp Dry': 1,
    'Less Dry': 2,
    Iron: 3,
    Cupboard: 4,
    'Very Dry': 5,
})

// Eco Hybrid 1-3, confirmed the same way against the cloud's ecoHybrid. 0 is NO_ECOHYBRID.
const ECO_HYBRID = Enum.of({
    Eco: 1,
    Normal: 2,
    Turbo: 3,
})

// Buzzer volume 0-4, confirmed against the cloud's buzzer. Unlike the RV13B6ES, whose beeper setting
// the cloud never reports, this model publishes it, so the whole scale is cloud-confirmed.
const BUZZER = Enum.of({
    Off: 0,
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
})

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
                        // free-text (NOT device_class:enum): unmapped state codes emit None.
                    },
                    pre_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pre_state',
                        state_topic: '$this/pre_state',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    },
                    download_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-download_course',
                        state_topic: '$this/download_course',
                        name: 'Downloaded cycle',
                        icon: 'mdi:cloud-download-outline',
                        entity_category: 'diagnostic',
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
                    spent_power: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spent_power',
                        state_topic: '$this/spent_power',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco Hybrid',
                        icon: 'mdi:leaf',
                    },
                    buzzer: {
                        platform: 'sensor',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        entity_category: 'diagnostic',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    damp_dry_beep: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_beep',
                        state_topic: '$this/damp_dry_beep',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    detect_load: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-detect_load',
                        state_topic: '$this/detect_load',
                        name: 'Detect load',
                        icon: 'mdi:scale',
                    },
                    cycle_optimization: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cycle_optimization',
                        state_topic: '$this/cycle_optimization',
                        name: 'Cycle optimization',
                        icon: 'mdi:auto-fix',
                        entity_category: 'diagnostic',
                    },
                    remote_maintain: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_maintain',
                        state_topic: '$this/remote_maintain',
                        name: 'Remote maintain',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    condenser_clean: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-condenser_clean',
                        state_topic: '$this/condenser_clean',
                        name: 'Condenser clean',
                        icon: 'mdi:air-filter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        icon: 'mdi:lightbulb',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // This dryer only volunteers a status frame when something changes, so a driver that never asks
    // stays blank until the next physical interaction, and every reconnect would otherwise leave Home
    // Assistant pinned at unknown. Asking once per connect is what makes the entities survive a
    // restart. LG's own cloud does exactly this.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length < 13 || buf[0] !== CLASS_BYTE || buf[1] !== ENVELOPE_TYPE) return

        const innerLen = buf.readUInt16BE(INNER_LEN_OFFSET)
        switch (buf[INNER_TYPE_OFFSET]) {
            case STATUS_FRAME_TYPE:
                if (innerLen !== STATUS_INNER_LEN) return
                return this.processStatus(buf, STATUS_RECORD_OFFSET, STATUS_BUF_LEN)
            case SINGLE_STATUS_FRAME_TYPE:
                if (innerLen !== SINGLE_INNER_LEN) return
                return this.processStatus(buf, SINGLE_RECORD_OFFSET, SINGLE_BUF_LEN)
            // 0x85/0x86 (content id lists) and the rest are not status records and are not decoded.
        }
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('pre_state', STATE.map(rec[PRE_STATE_OFFSET]))
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('download_course', DOWNLOAD_COURSE.map(rec[DOWNLOAD_COURSE_OFFSET]))
        this.publishProperty('dry_level', DRY_LEVEL.map(rec[DRY_LEVEL_OFFSET]))
        this.publishProperty('eco_hybrid', ECO_HYBRID.map(rec[ECO_HYBRID_OFFSET]))
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('spent_power', rec.readUInt16BE(SPENT_POWER_OFFSET))

        const opt1 = rec[OPT1_OFFSET]
        this.publishProperty('wrinkle_care', (opt1 & OPT1_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (opt1 & OPT1_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_beep', (opt1 & OPT1_DAMP_DRY_BEEP) !== 0 ? 'ON' : 'OFF')

        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('detect_load', (opt2 & OPT2_DETECT_LOAD) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('condenser_clean', (opt2 & OPT2_CONDENSER_CLEAN) !== 0 ? 'ON' : 'OFF')

        const opt3 = rec[OPT3_OFFSET]
        this.publishProperty('remote_maintain', (opt3 & OPT3_REMOTE_MAINTAIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('cycle_optimization', (opt3 & OPT3_CYCLE_OPTIMIZATION) !== 0 ? 'ON' : 'OFF')
        // Not published: rec[16], a cycle-phase index that runs the same sequence on every complete
        // cycle and also differs per course while idle, but matches no cloud field and so has no name
        // to publish it under, and the 0x40 and 0x80 bits of rec[27]. The error code was never
        // located. There is no door sensor to find: this model's full state dump carries doorLock but
        // no doorClose, where the matching washer's carries both.
    }
}
