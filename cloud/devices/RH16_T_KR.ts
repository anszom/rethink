import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

/*
 * LG RH16_T_KR heat-pump dryer, deviceType 202.
 *
 * This intentionally exposes only the state fields grounded by this exact
 * appliance. Its real AABB traffic uses a 0x30 device byte, a 0x19 record
 * marker, a 29-byte EB body and a 56-byte EC body. The current record begins
 * at body offset 30 in EC frames. Owner traffic captured both state 0 while
 * powered off and state 1 while the appliance was in Initial; those values
 * match this model JSON's MonitoringValue.state table. Other model fields are
 * not exposed until a labelled non-zero transition isolates their offsets.
 */
const DEVICE_TYPE = 0x30
const SINGLE_STATUS = 0xeb
const DOUBLE_STATUS = 0xec
const SINGLE_BODY_LEN = 29
const DOUBLE_BODY_LEN = 56
const SINGLE_RECORD_OFFSET = 3
const DOUBLE_CURRENT_RECORD_OFFSET = 30
const RECORD_MARKER = 0x19
const STATE_OFFSET = 1
// RH16 uses the same dryer record layout as the captured RV13 family and the
// same relative error position as F24VDD: rec[7]. The owner's normal RH16
// snapshots all report 0 here; non-zero labels come from this model's own
// MonitoringValue.error table.
const ERROR_OFFSET = 7
// This run isolated rec[10] as MonitoringValue.processState: it changed
// 0 (Detecting) -> 2 (Drying) while the top-level state stayed Running.
const PROCESS_STATE_OFFSET = 10
// Owner-labelled ON→OFF transition isolated rec[15] bit 0x08:
// ON current record ...00 08 08..., OFF ...00 00 08.... The adjacent
// rec[16] bit remained set across the lock transition and power cycle.
const CHILD_LOCK_OFFSET = 15
const CHILD_LOCK_FLAG = 0x08
// remainTime/initialTime (rec[2:4]/rec[4:6]) read equal HH:MM while a run is
// only reserved or just started, and the Time Dry capture's minutes matched
// the user-selected 30 exactly, confirming these are the model's own
// remainTimeHour/Minute and initialTimeHour/Minute fields, in that order.
const REMAIN_HOUR_OFFSET = 2
const REMAIN_MINUTE_OFFSET = 3
const INITIAL_HOUR_OFFSET = 4
const INITIAL_MINUTE_OFFSET = 5
// Single-toggle ON→OFF with course/eco/dry-level/reserve held constant
// isolated rec[15] bit 0x02: ON ...03 99..., OFF ...01 99.... Same byte as
// the child-lock flag; the 0x01 bit tracks a pending reservation.
const ANTI_CREASE_OFFSET = 15
const ANTI_CREASE_FLAG = 0x02
// Owner-labelled remote-control ON→OFF transition isolated rec[16] bit
// 0x01: 0x19→0x18 while the unrelated 0x18 bits remained set.
const REMOTE_START_OFFSET = 16
const REMOTE_START_FLAG = 0x01
// Owner-labelled 19h and 3h reservations isolated rec[11] (remaining hour)
// and rec[13] (set hour): both read 19 on the Energy/Delicate/19h run and 3
// on the Speed/Low/3h run, while the no-reserve baseline reads 0 on both.
const RESERVE_REMAIN_HOUR_OFFSET = 11
const RESERVE_SET_HOUR_OFFSET = 13
const STATE_POWEROFF = 0
const STATE_RUNNING = 2
const STATE_DIAGNOSIS = 8
const STATUS_REQUEST = 'F0ED1121010000001800'
const PAUSE_COMMAND = 'F024040100'
// Owner-labelled ThinQ app power-off, MCP toDevice seq 222.
const POWER_OFF_COMMAND = 'F024010100'
// F026 course-start templates: the exact ThinQ app bytes captured per
// course (MCP toDevice seq in comments). Only the reserve byte (index 8)
// is ever overwritten: it reads back the selected hours on all 20
// reservation captures and 0 on both immediate starts. Every other byte,
// including the dry level (3), eco (4) and anti-crease (11) positions,
// stays exactly as captured unless the course's own model table declares
// the field selectable (see *_WRITABLE below). The Standard template is
// the captured no-reserve base frame, which is also what the app replays
// for Resume.
const COURSE_TEMPLATE: Record<number, string> = {
    1: 'f0260100020000000300000003080000', // seq190 Steam Refresh, reserve 3
    2: 'f0260200020000000300000003000000', // seq150 Towel, reserve 3
    4: 'f0260400030000000400000203000000', // seq156 Bulky Item, reserve 4, anti-crease on
    5: 'f0260503020000000300000003000000', // seq163 Easy Care, dry Standard, reserve 3
    7: 'f0260703020000000000000001000000', // captured no-reserve base = Resume frame
    8: 'f0260800010000000400000003000000', // seq94 Sports Wear, reserve 4
    9: 'f0260900030000000300000203000000', // seq101 Quick Dry, reserve 3, anti-crease on
    11: 'f0260b00020000000300000003000000', // seq107 Wool, reserve 3
    15: 'f0260f00030000000400000003000000', // seq120 Bedding Brush, reserve 4
    16: 'f0261000030000000300000003080000', // seq126 Allergy Care, reserve 3
    18: 'f0261200030000000000000003080000', // seq212 Condenser Care, immediate
    19: 'f0261300030000000300000003080000', // seq218 Tub Clean, reserve 3
    20: 'f0261400030000000300000003000000', // seq196 Padding Refresh, reserve 3
    21: 'f0261500021e00000300000003000000', // seq114 Time Dry 30min, reserve 3
    22: 'f0261600033c00000300000003000000', // seq206 Outdoor Refresh, reserve 3
    23: 'f0261700020000000400000003000000', // seq144 Baby Wear, reserve 4
}
const TEMPLATE_DRY_OFFSET = 3
const TEMPLATE_ECO_OFFSET = 4
const TEMPLATE_RESERVE_OFFSET = 8
const TEMPLATE_AC_OFFSET = 11
const AC_BYTE_ON = 0x02
// Per-course, per-field write whitelists from the model's own Course
// function tables: dry level is selectable only on Standard (all five)
// and Easy Care (Light/Standard); eco only on Standard; anti-crease on
// every course whose model entry declares it (all but Condenser Care and
// Tub Clean). A value outside the whitelist leaves the template byte
// untouched instead of sending a combo the app can never produce.
const DRY_WRITABLE: Record<number, number[]> = { 7: [1, 2, 3, 4, 5], 5: [2, 3] }
const ECO_WRITABLE: Record<number, number[]> = { 7: [1, 2, 3] }
const AC_WRITABLE = [1, 2, 4, 5, 7, 8, 9, 11, 15, 16, 20, 21, 22, 23]
// Model Course function defaults per course: selecting a course resets the
// remembered options to what the app itself shows, so a Start without
// touching the selects replays exactly that.
const COURSE_DEFAULTS: Record<number, { dry: number; eco: number; ac: number }> = {
    1: { dry: 0, eco: 2, ac: 0 },
    2: { dry: 0, eco: 2, ac: 0 },
    4: { dry: 0, eco: 3, ac: 1 },
    5: { dry: 3, eco: 2, ac: 0 },
    7: { dry: 3, eco: 2, ac: 0 },
    8: { dry: 0, eco: 1, ac: 0 },
    9: { dry: 0, eco: 3, ac: 1 },
    11: { dry: 0, eco: 2, ac: 0 },
    15: { dry: 0, eco: 3, ac: 0 },
    16: { dry: 0, eco: 3, ac: 0 },
    18: { dry: 0, eco: 3, ac: 0 },
    19: { dry: 0, eco: 3, ac: 0 },
    20: { dry: 0, eco: 3, ac: 0 },
    21: { dry: 0, eco: 2, ac: 0 },
    22: { dry: 0, eco: 3, ac: 0 },
    23: { dry: 0, eco: 2, ac: 0 },
}

function buildCourseFrame(
    courseId: number,
    reserveHours: number,
    dry: number,
    eco: number,
    antiCrease: number,
): Buffer | undefined {
    const template = COURSE_TEMPLATE[courseId]
    if (template === undefined) return undefined
    const bytes = Buffer.from(template, 'hex')
    bytes[TEMPLATE_RESERVE_OFFSET] = reserveHours
    if (DRY_WRITABLE[courseId]?.includes(dry)) bytes[TEMPLATE_DRY_OFFSET] = dry
    if (ECO_WRITABLE[courseId]?.includes(eco)) bytes[TEMPLATE_ECO_OFFSET] = eco
    if (AC_WRITABLE.includes(courseId)) bytes[TEMPLATE_AC_OFFSET] = antiCrease === 1 ? AC_BYTE_ON : 0x00
    return bytes
}
// Sixteen course codes isolated from owner-labelled ThinQ app starts with
// matching state records: Standard 07, Sports Wear 08, Quick Dry 09,
// Wool 0B, Bedding Brush 0F, Allergy Care 10, Condenser Care
// 12, Tub Clean 13, Padding Refresh 14, Time Dry 15, Outdoor
// Refresh 16, Baby Wear 17, Steam Refresh 01, Towel 02, Bulky Item 04,
// Easy Care 05. The model's RACKDRY and COOLAIR entries have no captured code
// yet and read back as 'Unsupported' through the safe fallback below.
//
// HA's MQTT sensor treats the literal payload 'None' as PAYLOAD_NONE and
// forces the state to unknown, so a real reading must never publish that
// string. 'Off' carries code 0, which is what the appliance reports for a
// course that does not offer the setting at all.
const COURSE_OFFSET = 6
const COURSE = Enum.of({
    Unsupported: [],
    Off: 0,
    'Steam Refresh': 1,
    Towel: 2,
    'Bulky Item': 4,
    'Easy Care': 5,
    Standard: 7,
    'Sports Wear': 8,
    'Quick Dry': 9,
    Wool: 11,
    'Bedding Brush': 15,
    'Allergy Care': 16,
    'Condenser Care': 18,
    'Tub Clean': 19,
    'Padding Refresh': 20,
    'Time Dry': 21,
    'Outdoor Refresh': 22,
    'Baby Wear': 23,
})
// Rec[8] follows the model's own dryLevel index table (1 DAMP, 2 LESS,
// 3 IRON, 4 CUPBOARD, 5 VERY); the owner-facing names are the ThinQ app
// labels reported for those levels. 0 is the model default NO_DRYLEVEL,
// captured live on Steam Refresh, Towel, Bulky Item, Sports Wear, Quick
// Dry, Wool and every other course that does not offer a dry level, and
// shows as Off exactly like the app greys the setting out.
const DRY_LEVEL_OFFSET = 8
const DRY_LEVEL = Enum.of({
    Off: 0,
    Delicate: 1,
    Light: 2,
    Standard: 3,
    'Standard+': 4,
    Strong: 5,
})
// Rec[9] follows the model's own ecoHybrid index table (1 ECO, 2 NORMAL
// labelled Auto in the app, 3 TURBO labelled Speed). Every captured run
// reads back either the selected value or the course default from the
// model's own Course function table.
const ECO_HYBRID_OFFSET = 9
const ECO_HYBRID = Enum.of({
    Unsupported: [],
    Energy: 1,
    Auto: 2,
    Speed: 3,
})
// Selects offer only what can actually be sent. 'Unsupported' is the
// read-only fallback for a code with no captured meaning, so it never
// belongs in a writable option list. 'Off' stays: the appliance really does
// report a dry level or eco setting of Off on courses that do not expose it,
// and an HA select's state has to be one of its own options.
const selectable = (options: string[]) => options.filter((option) => option !== 'Unsupported')
const COURSE_SELECT_OPTIONS = selectable(COURSE.options).filter(
    (option) => COURSE_TEMPLATE[COURSE.unmap(option) ?? -1] !== undefined,
)
const DRY_LEVEL_SELECT_OPTIONS = selectable(DRY_LEVEL.options)
const ECO_HYBRID_SELECT_OPTIONS = selectable(ECO_HYBRID.options)
// Steam courses (Steam refresh, Steam sterilize, Condenser care, Steam tub
// sterilize) read rec[17] 0x08 while all 17 non-steam captures read 0x00,
// and the same courses carry the 0x08 byte in the start payload tail.
const STEAM_OFFSET = 17
const STEAM_FLAG = 0x08

const STATE = Enum.of({
    Unsupported: [],
    'Power off': 0,
    Standby: 1,
    Drying: 2,
    Pause: 3,
    Complete: 4,
    Error: 5,
    'Smart diagnosis': 8,
    Reserved: 100,
})

const PROCESS_STATE = Enum.of({
    Detecting: 0,
    Steam: 1,
    Drying: [2, 3, 4],
    Cooling: 5,
    'Anti crease': 6,
    Complete: 7,
})
const STATUS_OPTIONS = [...new Set([...STATE.options, ...PROCESS_STATE.options])]

const ERROR_MESSAGE = Enum.of({
    Unsupported: [],
    Normal: 0,
    tE1: 1,
    tE2: 2,
    tE4: 4,
    tE5: 5,
    tE6: 6,
    CE1: 7,
    'OE Drain motor': 13,
    'Empty water': 14,
    'dE Door': 15,
    'Filter clogging': 16,
    'No filter': 17,
    F1: 19,
    LE2: 20,
    AE: 21,
    LE1: 30,
    dE4: 37,
    LE3: 39,
    dE2: 42,
})

export default class Device extends AABBDevice {
    // Tracks what the HA selects were last set to, so Start course and
    // Resume can build a full frame. Defaults match the captured
    // no-reserve Standard base frame (dry Standard, eco Auto, no reserve,
    // anti-crease off).
    private selectedCourse = 7
    private reserveHours = 0
    private dryCode = 3
    private ecoCode = 2
    private antiCreaseCode = 0

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:power',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: '',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        device_class: 'enum',
                        options: COURSE.options,
                        icon: 'mdi:playlist-check',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        device_class: 'enum',
                        options: DRY_LEVEL.options,
                        icon: 'mdi:thermometer',
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco hybrid',
                        device_class: 'enum',
                        options: ECO_HYBRID.options,
                        icon: 'mdi:leaf',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:cloud-outline',
                    },
                    // Only courses with a captured start template are offered.
                    // Start course replays the exact captured app bytes for the
                    // selected course with the chosen reserve/options folded in
                    // wherever the model declares them selectable.
                    course_select: {
                        platform: 'select',
                        unique_id: '$deviceid-course_select',
                        state_topic: '$this/course_select',
                        command_topic: '$this/course_select/set',
                        name: 'Course select',
                        options: COURSE_SELECT_OPTIONS,
                        icon: 'mdi:playlist-edit',
                    },
                    reserve_hours: {
                        platform: 'number',
                        unique_id: '$deviceid-reserve_hours',
                        state_topic: '$this/reserve_hours',
                        command_topic: '$this/reserve_hours/set',
                        name: 'Reserve hours',
                        min: 0,
                        max: 19,
                        step: 1,
                        icon: 'mdi:calendar-clock',
                        entity_category: 'config',
                    },
                    dry_level_select: {
                        platform: 'select',
                        unique_id: '$deviceid-dry_level_select',
                        state_topic: '$this/dry_level_select',
                        command_topic: '$this/dry_level_select/set',
                        name: 'Dry level select',
                        options: DRY_LEVEL_SELECT_OPTIONS,
                        icon: 'mdi:thermometer',
                        entity_category: 'config',
                    },
                    eco_hybrid_select: {
                        platform: 'select',
                        unique_id: '$deviceid-eco_hybrid_select',
                        state_topic: '$this/eco_hybrid_select',
                        command_topic: '$this/eco_hybrid_select/set',
                        name: 'Eco hybrid select',
                        options: ECO_HYBRID_SELECT_OPTIONS,
                        icon: 'mdi:leaf',
                        entity_category: 'config',
                    },
                    anti_crease_select: {
                        platform: 'select',
                        unique_id: '$deviceid-anti_crease_select',
                        state_topic: '$this/anti_crease_select',
                        command_topic: '$this/anti_crease_select/set',
                        name: 'Anti crease select',
                        options: ['Off', 'On'],
                        icon: 'mdi:tshirt-crew-outline',
                        entity_category: 'config',
                    },
                    start_course: {
                        platform: 'button',
                        unique_id: '$deviceid-start_course',
                        command_topic: '$this/start_course/set',
                        payload_press: '',
                        name: 'Start course',
                        icon: 'mdi:play-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        device_class: 'enum',
                        options: STATUS_OPTIONS,
                        icon: 'mdi:tumble-dryer',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:lock',
                        entity_category: 'diagnostic',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti crease',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:cellphone-check',
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error_message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        device_class: 'enum',
                        options: ERROR_MESSAGE.options,
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    smart_diagnosis: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-smart_diagnosis',
                        state_topic: '$this/smart_diagnosis',
                        name: 'Smart diagnosis',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'problem',
                        icon: 'mdi:stethoscope',
                        entity_category: 'diagnostic',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        state_class: 'measurement',
                        icon: 'mdi:timer-sand',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        state_class: 'measurement',
                        icon: 'mdi:timer-outline',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Reserve time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        state_class: 'measurement',
                        icon: 'mdi:calendar-clock',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Power',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                        icon: 'mdi:lightning-bolt',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
        this.publishProperty('course_select', COURSE.map(this.selectedCourse))
        this.publishProperty('reserve_hours', this.reserveHours)
        this.publishProperty('dry_level_select', DRY_LEVEL.map(this.dryCode))
        this.publishProperty('eco_hybrid_select', ECO_HYBRID.map(this.ecoCode))
        this.publishProperty('anti_crease_select', 'Off')
        // Energy offset not yet isolated for RH16 (tail bytes vary without a
        // labelled transition) — expose as 0 until a running vs idle capture
        // grounds it, same convention as F24VDD. The model's own
        // EnergyMonitoring.powertable gives reference wattage per dry level
        // (1400-2600W) but no cumulative Wh field has been captured on the wire.
        this.publishProperty('energy', 0)
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'pause') this.send(Buffer.from(PAUSE_COMMAND, 'hex'))
        if (prop === 'power_off') this.send(Buffer.from(POWER_OFF_COMMAND, 'hex'))
        if (prop === 'course_select') {
            const id = COURSE.unmap(mqttValue)
            if (id === undefined || COURSE_TEMPLATE[id] === undefined) return
            this.selectedCourse = id
            const def = COURSE_DEFAULTS[id] ?? { dry: 0, eco: 2, ac: 0 }
            this.dryCode = def.dry
            this.ecoCode = def.eco
            this.antiCreaseCode = def.ac
            this.publishProperty('course_select', mqttValue)
            this.publishProperty('dry_level_select', DRY_LEVEL.map(def.dry) ?? 'Off')
            this.publishProperty('eco_hybrid_select', ECO_HYBRID.map(def.eco) ?? 'Auto')
            this.publishProperty('anti_crease_select', def.ac === 1 ? 'On' : 'Off')
            return
        }
        if (prop === 'reserve_hours') {
            const hours = Number(mqttValue)
            if (!Number.isInteger(hours) || hours < 0 || hours > 19) return
            this.reserveHours = hours
            this.publishProperty('reserve_hours', hours)
            return
        }
        if (prop === 'dry_level_select') {
            const code = DRY_LEVEL.unmap(mqttValue)
            if (code === undefined) return
            this.dryCode = code
            this.publishProperty('dry_level_select', mqttValue)
            return
        }
        if (prop === 'eco_hybrid_select') {
            const code = ECO_HYBRID.unmap(mqttValue)
            if (code === undefined) return
            this.ecoCode = code
            this.publishProperty('eco_hybrid_select', mqttValue)
            return
        }
        if (prop === 'anti_crease_select') {
            if (mqttValue !== 'Off' && mqttValue !== 'On') return
            this.antiCreaseCode = mqttValue === 'On' ? 1 : 0
            this.publishProperty('anti_crease_select', mqttValue)
            return
        }
        // Resume replays the remembered full start frame: the captured
        // ThinQ app resume is byte-identical in structure to a start with
        // the same options, so both buttons build from the same templates.
        if (prop === 'start_course' || prop === 'resume') {
            const frame = buildCourseFrame(
                this.selectedCourse,
                this.reserveHours,
                this.dryCode,
                this.ecoCode,
                this.antiCreaseCode,
            )
            if (frame !== undefined) this.send(frame)
            return
        }
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== DEVICE_TYPE) return

        let recordOffset: number
        if (buf[1] === SINGLE_STATUS && buf.length === SINGLE_BODY_LEN) recordOffset = SINGLE_RECORD_OFFSET
        else if (buf[1] === DOUBLE_STATUS && buf.length === DOUBLE_BODY_LEN) recordOffset = DOUBLE_CURRENT_RECORD_OFFSET
        else return

        if (buf[recordOffset] !== RECORD_MARKER) return
        const state = buf[recordOffset + STATE_OFFSET]
        const processState = buf[recordOffset + PROCESS_STATE_OFFSET]
        const errorCode = buf[recordOffset + ERROR_OFFSET]
        const reservePending =
            buf[recordOffset + RESERVE_REMAIN_HOUR_OFFSET] !== 0 || buf[recordOffset + RESERVE_SET_HOUR_OFFSET] !== 0
        this.publishProperty('power', state === STATE_POWEROFF ? 'OFF' : 'ON')
        this.publishProperty(
            'status',
            state === STATE_RUNNING
                ? reservePending
                    ? 'Reserved'
                    : (PROCESS_STATE.map(processState) ?? 'Drying')
                : (STATE.map(state) ?? 'Unsupported'),
        )
        this.publishProperty(
            'child_lock',
            (buf[recordOffset + CHILD_LOCK_OFFSET] & CHILD_LOCK_FLAG) !== 0 ? 'ON' : 'OFF',
        )
        this.publishProperty(
            'anti_crease',
            (buf[recordOffset + ANTI_CREASE_OFFSET] & ANTI_CREASE_FLAG) !== 0 ? 'ON' : 'OFF',
        )
        this.publishProperty(
            'remote_start',
            (buf[recordOffset + REMOTE_START_OFFSET] & REMOTE_START_FLAG) !== 0 ? 'ON' : 'OFF',
        )
        this.publishProperty('error', errorCode === 0 ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERROR_MESSAGE.map(errorCode) ?? 'Unsupported')
        this.publishProperty('smart_diagnosis', state === STATE_DIAGNOSIS ? 'ON' : 'OFF')
        this.publishProperty('course', COURSE.map(buf[recordOffset + COURSE_OFFSET]) ?? 'Unsupported')
        this.publishProperty('dry_level', DRY_LEVEL.map(buf[recordOffset + DRY_LEVEL_OFFSET]) ?? 'Unsupported')
        this.publishProperty('eco_hybrid', ECO_HYBRID.map(buf[recordOffset + ECO_HYBRID_OFFSET]) ?? 'Unsupported')
        this.publishProperty('steam', (buf[recordOffset + STEAM_OFFSET] & STEAM_FLAG) !== 0 ? 'ON' : 'OFF')
        this.publishProperty(
            'remaining_time',
            buf[recordOffset + REMAIN_HOUR_OFFSET] * 60 + buf[recordOffset + REMAIN_MINUTE_OFFSET],
        )
        this.publishProperty(
            'initial_time',
            buf[recordOffset + INITIAL_HOUR_OFFSET] * 60 + buf[recordOffset + INITIAL_MINUTE_OFFSET],
        )
        this.publishProperty('reserve_time', buf[recordOffset + RESERVE_REMAIN_HOUR_OFFSET] * 60)
    }
}
