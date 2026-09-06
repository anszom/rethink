import { Device as Thinq2Device } from '../thinq2/device'
import log from '@/util/logging'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

/*
 * LG Styler (S5BBP), ThinQ model ST_B_E4H01Y_APL, deviceType 203.
 *
 * The byte layout was recovered by injecting single-byte-changed state frames through the
 * management API and reading LG cloud's decode back, so each offset rests on a direct
 * observation. Three of the bytes are bitfields, split bit by bit.
 *
 * READ. `aa ff 31 0a 00 | <len16 LE> | <seq16> | 00 01 | 00 <tag> | <record bytes, BE16> |
 * …40-byte records… | <crc16 XMODEM> bb`. Offsets into the whole frame, single-record form:
 *
 *   17 state              18 remainTimeHour     19 remainTimeMinute
 *   20 initialTimeHour    21 initialTimeMinute  22 course
 *   23 error              24 preState
 *   29 reserveTimeHour    30 reserveTimeMinute
 *   31 flags  0x01 childLock  0x02 nightDry  0x04 initialBit  0x08 remoteStart
 *   34..35 energyMonitoring, big-endian 16-bit — not published, the unit is undeclared
 *   37 smartCourse
 *   40 currentDownloadCourseCount   41..44 currentDownloadCourse1..4
 *   45 buzzer
 *   46 flags  0x01 applyRemoteMaintain  0x02 applyBuzzer  0x04 remoteMaintain
 *   47 endMelody          48 internalLightingTime — not published, no declared value list
 *   49 flags  0x01 isLastCourse  0x02 smartCareFineDust  0x04 smartCareHumidity
 *             0x08 smartCareNightCare  0x10 smartPairing  0x20 currentTimeDisplay
 *   50..53 nightCareStartTime / nightCareEndTime, hour then minute
 *   54 TCLCount
 *
 * That covers all 38 `styler.*` keys LG publishes for this unit. Byte 31 bit 0x20 and byte 49
 * bits 0x40/0x80 move no field and are left alone.
 *
 * The record count varies, so it is counted rather than assumed: at rest the appliance sends
 * one 40-byte record, and while it is doing anything it sends two — previous, then current —
 * as the water purifier in this repo does. Header 15 bytes, trailer 3, and what is between
 * must be a whole number of records, cross-checked against the record-bytes field at 13..14.
 * That also rejects the frames which carry no state: the 112/113-byte downloadable-course name
 * lists, the 35-byte `aa ff 31 0a 00 23 00 …` (every byte probed with 0xff, nothing moved) and
 * the `aa 07 31 c3 02` heartbeat.
 *
 * WRITE. Settings go out as
 *
 *   aa <len> f0 24 <controlDataType> <valueLength> [<controlDataType_sub>] <value…> <ck> bb
 *
 *   01 POWERON/POWEROFF          len 1   off 0, on 1
 *   04 PAUSE                     len 1   0
 *   10 REMOTE_MAINTAIN           len 1   off 0, on 1
 *   13 UPCENTER, then a sub id and the value:
 *      01 ENDMELODY              len 1   melody index, 0..11
 *      03 UPBUZZER               len 1   buzzer level, 0..4
 *      04 SC_FINEDUST            len 1   off 0, on 1
 *      05 SC_HUMIDITY            len 1   off 0, on 1
 *      06 SC_NIGHTCARE           len 1   off 0, on 1
 *      07 SC_NIGHTCARE_START     len 2   hour, minute
 *      08 SC_NIGHTCARE_END       len 2   hour, minute
 *      09 CTRL_IS_LAST_COURSE    len 1   off 0, on 1
 *
 * and course control as
 *
 *   start  aa 34 f0 26 | <46-byte course block> | ck bb
 *   resume aa 33 f0 26 | <course id> <44 zero bytes> | ck bb
 *
 * `controlDataType`, `controlDataValueLength` and `controlDataType_sub` are modelJSON's own
 * `ControlWifi` vocabulary, and every value is the code the read map already uses for that
 * field. The frames came from LG's own cloud (`dataops/v1/s2p/backend/convert/control`), which
 * wants `{"setOnOff":{"value":"on"}}` rather than the aircon's `{"onOff":"on"}`, and answers
 * CL-0005 while the appliance is in no state to take the command. REMOTE_MAINTAIN is the one
 * exception: LG's converter only ever emits its OFF frame, so the ON frame was built from the
 * same shape, sent to the appliance directly, acknowledged, and read back on byte 46 bit 0x04.
 *
 * The course block is `<id> 01 00 04 00 00 00 00 00` followed by modelJSON's
 * `Course[id].function` defaults in declaration order, with `TimeDry` folded into bit 0x80 of
 * the `PreSteam1_Time` byte. Standard (id 1) and Quick (id 3) were captured off LG's converter
 * and the suite checks the frames this driver builds for them byte for byte.
 *
 * `cycles setCurrentCycle` does not convert for this model, so course select is a local choice
 * this driver remembers and Start course is what sends it — the order LG's own app uses too.
 */
const HEADER_LEN = 13
const TRAILER_LEN = 1
const RECORD_LEN = 40
/** buf[13..14], big-endian: how many record bytes the frame says it carries. */
const RECORD_BYTES_OFF = 11
const STATE_TAG = 0x31

/** Offsets WITHIN a record. Add the record start to get the absolute frame offset; the
 *  header comment states them against the 58-byte frame, whose single record starts at 15. */
const OFF = {
    state: 2,
    remainTimeHour: 3,
    remainTimeMinute: 4,
    initialTimeHour: 5,
    initialTimeMinute: 6,
    course: 7,
    error: 8,
    preState: 9,
    reserveTimeHour: 14,
    reserveTimeMinute: 15,
    flagsA: 16,
    smartCourse: 22,
    downloadCourseCount: 25,
    downloadCourse1: 26,
    buzzer: 30,
    flagsB: 31,
    endMelody: 32,
    flagsC: 34,
    nightCareStartHour: 35,
    nightCareStartMinute: 36,
    nightCareEndHour: 37,
    nightCareEndMinute: 38,
    tclCount: 39,
} as const

/** byte 31 */
const F_CHILD_LOCK = 0x01
const F_NIGHT_DRY = 0x02
const F_REMOTE_START = 0x08
/** byte 46 */
const F_REMOTE_MAINTAIN = 0x04
/** byte 49 */
const F_IS_LAST_COURSE = 0x01
const F_SC_FINEDUST = 0x02
const F_SC_HUMIDITY = 0x04
const F_SC_NIGHTCARE = 0x08

/** Command frame opcode: `aa <len> f0 24 …`. See the WRITE DIRECTION note. */
const SET_STATE = [0xf0, 0x24]

/** modelJSON `ControlWifi` controlDataType ids, as the captured frames carry them. */
const CTRL_POWER = 0x01
const CTRL_PAUSE = 0x04
const CTRL_REMOTE_MAINTAIN = 0x10
const CTRL_UPCENTER = 0x13

/** Course start and resume travel under their own opcode, carrying a course block. */
const RUN_COURSE = [0xf0, 0x26]
/** `<id> 01 00 04 00 00 00 00 00` — identical in both captured start frames. */
const COURSE_HEAD = [0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]
/** Resume carries the course id and nothing else, one byte shorter than a start block. */
const RESUME_BLOCK_LEN = 45

/*
 * The parameter half of a start block: this model's `Course[id].function` defaults, in LG's
 * declaration order, with TimeDry folded into bit 0x80 of the first byte. Ids are LG's course
 * ids, the same ones the state frame reports.
 *
 * Ids 1 and 3 are the two captured off LG's converter; the suite checks the whole frame this
 * driver builds for them against those captures, byte for byte.
 */
const COURSE_PARAMS: Record<number, string> = {
    1: '02645a00000005005a05b45a01b4001ab40000000000000000000000000000000000000000', // Styling Standard
    3: '82645a00000003005a00000001b4000eb40000000000000000000000000000000000000000', // Styling Quick
    5: '02645a00000007005a05c85a01c80031b40000000000000000000000000000000000000000', // Styling Intensive
    6: '82000000000004000000000001000014780000000000000000000000000000000000000000', // Wool/Knit
    7: '82645a00000004005a04b45a01b40017780000000000000000000000000000000000000000', // Suit/Coat
    11: '0200002d000006000008000003000023780000000000000000000000000000000000000000', // Sterilize Standard
    15: '0000000000000000000000000000005a780000000000000000000000000000000000000000', // Auto Dry
    17: '8000000000000000000000000000001e780000000000000000000000000000000000000000', // Timed Dry 30
    18: '8000000000000000000000000000003c780000000000000000000000000000000000000000', // Timed Dry 60
    19: '8000000000000000000000000000005a780000000000000000000000000000000000000000', // Timed Dry 90
    // Identical to Timed Dry 60 on purpose: LG's modelJSON gives course 20 a Drying1_Time
    // default of 60, the same as course 18. The duration the appliance actually runs comes
    // from the course id, not from this block.
    20: '8000000000000000000000000000003c780000000000000000000000000000000000000000', // Timed Dry 120
    23: '80000000000000000000000000000078000000000000000000000000000000000000000000', // Room Dehumidify 120
    24: '800000000000000000000000000000f0000000000000000000000000000000000000000000', // Room Dehumidify 240
    28: '82005a00000005005a05b45a01b4002eb40000000000000000000000000000000000000000', // Padding Care
    30: '82000000000000000000000005c80000000000000000000003005a02c85a01c80028c80000', // Fine dust
    31: '8200002d000007000008000003000043000000000000000000000000000000000000000000', // Virus
    32: '8200002d000006000008000003000028000000000000000000000000000000000000000000', // Jeans Care
    33: '8000000000000000000000000000001e780000000000000000000000000000000000000000', // Fur/Leather Care
    36: '8200002d00000600000800000300002b780000000000000000000000000000000000000000', // Suit/Uniform Sterilize
    37: '8200002d00000600000800000300002b780000000000000000000000000000000000000000', // Silk
    38: '8200002d00000600000800000300002b780000000000000000000000000000000000000000', // Cashmere
}

/** ...and the controlDataType_sub ids that follow UPCENTER. */
const UP = {
    endMelody: 0x01,
    buzzer: 0x03,
    smartCareFineDust: 0x04,
    smartCareHumidity: 0x05,
    smartCareNightCare: 0x06,
    nightCareStart: 0x07,
    nightCareEnd: 0x08,
    isLastCourse: 0x09,
} as const

/** `styler.state` code 0. The appliance sends no decodable state frame while it is off, so
 *  this is also the value the power switch reports back from. */
const STATE_POWEROFF = 0

/** Both night-care times: LG's own schema accepts whole and half hours only
 *  (`^(0[0-9]|1[0-9]|2[0-3]):(00|30)$`), and the appliance is the one enforcing it. */
const HALF_HOUR = /^([01]\d|2[0-3]):(00|30)$/

/*
 * The enum tables below are LG's own, in LG's own order.
 *
 * `styler.state` / `styler.preState` / `styler.error` are modelJSON `Value.<field>.option`,
 * which lists names but no codes; the code is the position in that list. Three points were
 * observed on the wire and all three agree — byte 17 = 1 read back INITIAL (index 1),
 * byte 24 = 2 read back RUNNING (index 2), byte 23 = 1 read back ERROR_TE1 (index 1) — so
 * the remaining entries follow the same declaration order.
 *
 * `styler.course` and `styler.smartCourse` are NOT positional: the byte is LG's course id
 * straight out of the `Course` / `SmartCourse` tables. Confirmed twice — byte 22 = 1 read
 * back STANDARD (id 1), and the untouched byte 41 = 0x4e = 78 read back FUR_LEATHER (id 78).
 *
 * Labels are English translations of this model's own ko-KR packs — the product pack for
 * states and melodies, the per-model pack (`langPackModelUri`) for course names. Where two
 * courses share a name ("Standard" for both styling and sanitising) the modelJSON `_comment`'s
 * category prefix disambiguates them.
 */

/*
 * `styler.state`, which is NOT positional — the running codes jump to 50 and up. Every entry
 * below was measured by injecting that code and reading LG's own name back; 10..49 and 60
 * answer NOT_DEFINE_VALUE, so the gap is LG's.
 *
 * LG deliberately collapses phases: PREHEAT, STEAM and STAY all print Refreshing, and
 * COOLING / DRYING / ENDCOOLING all print Drying — the app shows the same.
 */
const STATE = Enum.of({
    'Power off': 0, // POWEROFF
    Standby: 1, // INITIAL
    Styling: 2, // RUNNING
    Pause: 3, // PAUSE
    'Course complete': [4, 58, 59], // COMPLETE RUNNINGEND END_REMOTE_MAINTAIN_ON
    'Check appliance': 5, // ERROR
    'Smart diagnosing': 6, // DIAGNOSIS
    Storing: 7, // NIGHTDRY
    Reserved: 8, // RESERVED
    'Power-save running': 9, // SLEEP
    'Steam preparing': 50, // PRESTEAM
    Refreshing: [51, 52, 53], // PREHEAT STEAM STAY
    Drying: [54, 55, 56], // COOLING DRYING ENDCOOLING
    Sterilizing: 57, // STERILIZE
})

/*
 * `styler.error`, also not positional — LG's own Error table skips values. Every entry below was
 * measured by injecting the code and reading LG's name back; 12..17, 19..22, 24 and 27..30
 * answer NOT_DEFINE_VALUE. Where LG has an owner-facing label (Water refill / drain) that is
 * used rather than the service code.
 *
 * These matter beyond display: the appliance refuses to start a course while an error stands,
 * which is why Error is published as a problem sensor of its own, next to the message.
 */
const ERROR = Enum.of({
    Normal: [0, 23], // ERROR_NO ERROR_NONE
    TE1: 1,
    TE2: 2,
    TE3: 3,
    TE4: 4,
    TE5: 5,
    E1: 6,
    E2: 7,
    'Water refill': 8, // ERROR_E3 — LG's own _comment is "E3_Water refill LED"
    E4: 9,
    LE2: 10,
    AE: 11,
    LE: 18,
    'Water drain': 25, // ERROR_DRAINE
    'Door open': 26, // ERROR_DE_OPEN
    'Check door closed': 31, // ERROR_DE_CLOSE
    E6: 32,
    PS: 33,
    'No filter': 34, // ERROR_IF
})

/** The two codes that mean "nothing wrong". Everything else stops a course from starting. */
const ERROR_CLEAR = new Set([0, 23])

/** modelJSON `Course`, id -> name (per-model language pack, translated). */
const COURSE = Enum.of({
    None: 0,
    'Styling Standard': 1,
    'Styling Quick': 3,
    'Styling Intensive': 5,
    'Wool/Knit': 6,
    'Suit/Coat': 7,
    'Sterilize Standard': 11,
    'Auto Dry': 15,
    'Timed Dry 30': 17,
    'Timed Dry 60': 18,
    'Timed Dry 90': 19,
    'Timed Dry 120': 20,
    'Room Dehumidify 120': 23,
    'Room Dehumidify 240': 24,
    'Padding Care': 28,
    'Fine dust': 30,
    Virus: 31,
    'Jeans Care': 32,
    'Fur/Leather Care': 33,
    'Suit/Uniform Sterilize': 36,
    Silk: 37,
    Cashmere: 38,
})

/** modelJSON `SmartCourse`, id -> name. Id 1 is LG's panel-pairing pseudo-course. */
const SMART_COURSE = Enum.of({
    None: 0,
    'Panel course': 1,
    'Suit/Uniform Sterilize': 61,
    'Scarf Care': 62,
    'Pants Care': 66,
    'Quiet Care': 67,
    'Coat warm': 68,
    'Static removal': 69,
    'Old-clothes Care': 71,
    'Blanket warm': 73,
    'Dress-shirt Dry': 75,
    'Snow/Rain Dry': 76,
    'Fur/Leather Care': 78,
    'Jeans Care': 93,
    'Baby-clothes Sterilize': 94,
    'Doll Sterilize': 95,
    'Wool/Knit Dry': 96,
    'Rainy-season Laundry Dry': 97,
    'Uniform Care': 98,
    'Padding Care': 99,
    'Thin Padding Dry': 100,
    'Thick Padding Dry': 101,
    'Yoga/Pilates Care': 112,
    'Yoga/Pilates Dry': 113,
    'Swimwear Dry': 114,
    Functional: 115,
    'Bedding Sterilize': 119,
})

/** `styler.buzzer`: the byte is n in BUZZER_n (byte 45 = 4 read BUZZER_4, = 1 read BUZZER_1). */
const BUZZER = Enum.of({ Mute: 0, Small: 1, Normal: 2, Large: 3, 'Very large': 4 })

/** `styler.endMelody`: the byte is n in END_MELODY_n (byte 47 = 1 read END_MELODY_1). These are
 *  the melodies LG's own capability schema offers for this unit — codes 0..11, in this order,
 *  and a command frame was captured for every one. LG's product pack names five more melodies
 *  (12..16, the Christmas set) which this model neither lists nor reports. */
const END_MELODY = Enum.of({
    'Default sound': 0,
    'Vivaldi Winter': 1,
    'Bach Minuet': 2,
    'Home Sweet Home': 3,
    Breeze: 4,
    'Old MacDonald': 5,
    'Verdi Brindisi': 6,
    Bubble: 7,
    'Beethoven Symphony No.5 5': 8,
    Arirang: 9,
    'Pachelbel Canon': 10,
    'Beethoven Choral': 11,
})

/** The courses this unit can be told to run — every id with a block above, under the name the
 *  read table gives it, so Course select and the Course sensor speak the same words. */
const COURSE_IDS = Object.keys(COURSE_PARAMS).map(Number)
const COURSE_OPTIONS = COURSE_IDS.map((id) => COURSE.map(id)).filter((name) => name !== undefined)

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const sensor = (id: string, name: string, extra: object = {}) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            name,
            ...extra,
        })
        const flag = (id: string, name: string, extra: object = {}) => ({
            platform: 'binary_sensor',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            name,
            payload_on: 'ON',
            payload_off: 'OFF',
            ...extra,
        })
        const minutes = (id: string, name: string, extra: object = {}) =>
            sensor(id, name, {
                device_class: 'duration',
                unit_of_measurement: 'min',
                state_class: 'measurement',
                ...extra,
            })
        /** A reading taken from one of the tables above. Several codes share a label — LG lists
         *  Refreshing, Drying and Course complete more than once — so the options are deduplicated;
         *  HA rejects a repeated option. */
        const reading = (id: string, name: string, table: Enum<string>, extra: object = {}) =>
            sensor(id, name, {
                device_class: 'enum',
                options: table.options,
                ...extra,
            })
        /** A flag the appliance takes a command for. */
        const toggle = (id: string, name: string, extra: object = {}) => ({
            platform: 'switch',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            payload_on: 'ON',
            payload_off: 'OFF',
            ...extra,
        })
        /** A setting the appliance takes a command for, offered as LG's own labels. */
        const choice = (id: string, name: string, options: string[], extra: object = {}) => ({
            platform: 'select',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            options,
            ...extra,
        })
        /** A one-shot command with no state of its own. */
        const press = (id: string, name: string, icon: string) => ({
            platform: 'button',
            unique_id: `$deviceid-${id}`,
            command_topic: `$this/${id}/set`,
            payload_press: '',
            name,
            icon,
        })
        /** One half of the night-care window. LG's own setter takes HH:MM on the half hour. */
        const halfHourClock = (id: string, name: string, extra: object = {}) => ({
            platform: 'text',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            icon: 'mdi:clock-time-four-outline',
            pattern: HALF_HOUR.source,
            min: 5,
            max: 5,
            entity_category: 'config',
            ...extra,
        })

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Styler' }),
                components: {
                    power: toggle('power', 'Power', { icon: 'mdi:power' }),
                    status: reading('status', 'Status', STATE, { icon: 'mdi:hanger' }),
                    course: reading('course', 'Course', COURSE, { icon: 'mdi:playlist-check' }),
                    // Choosing a course does not start it — LG's own app works the same way,
                    // and its setCurrentCycle does not convert for this model.
                    course_select: choice('course_select', 'Course select', COURSE_OPTIONS, {
                        icon: 'mdi:playlist-edit',
                    }),
                    start_course: press('start_course', 'Start course', 'mdi:play-circle-outline'),
                    pause_course: press('pause_course', 'Pause', 'mdi:pause-circle-outline'),
                    resume_course: press('resume_course', 'Resume', 'mdi:play-pause'),
                    smart_course: reading('smart_course', 'Smart course', SMART_COURSE, {
                        icon: 'mdi:playlist-star',
                    }),
                    remaining_time: minutes('remaining_time', 'Remaining time', { icon: 'mdi:timer-sand' }),
                    initial_time: minutes('initial_time', 'Initial time', { icon: 'mdi:timer-outline' }),
                    // LG declares Reserve_Time_H as a 3..19 hour range, so this is a delay before
                    // the course starts, not a wall-clock time; 0 means no reservation.
                    reserve_time: minutes('reserve_time', 'Reserve time', { icon: 'mdi:calendar-clock' }),
                    // The appliance will not start a course while an error stands — Water refill is
                    // the everyday one — so it gets a problem sensor of its own rather than
                    // hiding inside a text reading nobody has an automation on.
                    error: flag('error', 'Error', {
                        device_class: 'problem',
                        icon: 'mdi:check-circle',
                        entity_category: 'diagnostic',
                    }),
                    error_message: reading('error_message', 'Error message', ERROR, {
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    }),
                    child_lock: flag('child_lock', 'Child lock', { icon: 'mdi:lock' }),
                    night_dry: flag('night_dry', 'Store', { icon: 'mdi:weather-night' }),
                    remote_start: flag('remote_start', 'Remote start', { icon: 'mdi:cellphone-check' }),
                    remote_maintain: toggle('remote_maintain', 'Remote control allowed', {
                        icon: 'mdi:cellphone-wireless',
                    }),
                    buzzer: choice('buzzer', 'Alert sound', BUZZER.options, {
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                    }),
                    end_melody: choice('end_melody', 'End melody', END_MELODY.options, {
                        icon: 'mdi:music',
                        entity_category: 'config',
                    }),
                    keep_last_course: toggle('keep_last_course', 'Keep last course', {
                        icon: 'mdi:repeat',
                        entity_category: 'config',
                    }),
                    smart_care_finedust: toggle('smart_care_finedust', 'SmartCare Fine-dust', {
                        icon: 'mdi:weather-dust',
                        entity_category: 'config',
                    }),
                    smart_care_humidity: toggle('smart_care_humidity', 'SmartCare Humidity', {
                        icon: 'mdi:water-percent',
                        entity_category: 'config',
                    }),
                    smart_care_nightcare: toggle('smart_care_nightcare', 'SmartCare Night', {
                        icon: 'mdi:sleep',
                        entity_category: 'config',
                    }),
                    night_care_start: halfHourClock('night_care_start', 'Night-care start time'),
                    night_care_end: halfHourClock('night_care_end', 'Night-care end time'),
                    download_course: reading('download_course', 'Downloaded course', SMART_COURSE, {
                        icon: 'mdi:download',
                        entity_category: 'diagnostic',
                    }),
                    tcl_count: sensor('tcl_count', 'Sterilize-tank clean alert count', {
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                        // Resets when the maintenance course runs, so total_increasing would
                        // wrongly accumulate across the reset — no state_class.
                    }),
                    previous_status: reading('previous_status', 'Previous state', STATE, {
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    }),
                },
            }),
        )
    }

    // AABBDevice strips the leading AA/FF and trailing CRC/BB, so offsets here are two less than
    // the whole-frame positions the probes recorded.
    processAABB(buf: Buffer) {
        if (buf[0] !== STATE_TAG) return
        if (buf.length < HEADER_LEN + RECORD_LEN + TRAILER_LEN) return
        const payload = buf.length - HEADER_LEN - TRAILER_LEN
        if (payload % RECORD_LEN !== 0) return
        // The frame states how many record bytes it carries; disagreeing with the length means
        // this is a different message that happens to divide evenly.
        if (buf.readUInt16BE(RECORD_BYTES_OFF) !== payload) return

        // The trailing record is the current state; a leading one, when present, is the previous.
        const record = buf.length - TRAILER_LEN - RECORD_LEN
        const at = (o: number) => buf[record + o]
        const flagsA = at(OFF.flagsA)
        const flagsB = at(OFF.flagsB)
        const flagsC = at(OFF.flagsC)
        const on = (byte: number, bit: number) => ((byte & bit) !== 0 ? 'ON' : 'OFF')

        this.poweredOn = at(OFF.state) !== STATE_POWEROFF
        this.nightCareEnabled = (flagsC & F_SC_NIGHTCARE) !== 0
        this.hasProblem = !ERROR_CLEAR.has(at(OFF.error))
        this.publishProperty('status', STATE.map(at(OFF.state)))
        this.publishProperty('power', this.poweredOn ? 'ON' : 'OFF')
        this.publishProperty('previous_status', STATE.map(at(OFF.preState)))
        this.publishProperty('error_message', ERROR.map(at(OFF.error)))
        this.publishProperty('error', this.hasProblem ? 'ON' : 'OFF')
        this.publishProperty('course', COURSE.map(at(OFF.course)))
        this.publishProperty('smart_course', SMART_COURSE.map(at(OFF.smartCourse)))

        // Track whatever the appliance is actually set to, so Course select opens on the right one.
        // Idle it reports NONE, which is not an option — that leaves the last choice standing.
        const running = COURSE_PARAMS[at(OFF.course)] !== undefined ? at(OFF.course) : undefined
        if (running !== undefined) {
            this.selectedCourse = running
            this.publishProperty('course_select', COURSE.map(running))
        }

        // LG reports the times split into hours and minutes; HA wants one duration.
        this.publishProperty('remaining_time', at(OFF.remainTimeHour) * 60 + at(OFF.remainTimeMinute))
        this.publishProperty('initial_time', at(OFF.initialTimeHour) * 60 + at(OFF.initialTimeMinute))

        this.publishProperty('reserve_time', at(OFF.reserveTimeHour) * 60 + at(OFF.reserveTimeMinute))

        this.publishProperty('child_lock', on(flagsA, F_CHILD_LOCK))
        this.publishProperty('night_dry', on(flagsA, F_NIGHT_DRY))
        this.publishProperty('remote_start', on(flagsA, F_REMOTE_START))
        this.publishProperty('remote_maintain', on(flagsB, F_REMOTE_MAINTAIN))

        // Both are selects, and a select's state has to be one of its options — publishing
        // `Code N` for something outside the list would make Home Assistant reject the state and
        // log it, so an unlisted code leaves the previous value standing.
        this.publishOption('buzzer', BUZZER.map(at(OFF.buzzer)))
        this.publishOption('end_melody', END_MELODY.map(at(OFF.endMelody)))

        this.publishProperty('keep_last_course', on(flagsC, F_IS_LAST_COURSE))
        this.publishProperty('smart_care_finedust', on(flagsC, F_SC_FINEDUST))
        this.publishProperty('smart_care_humidity', on(flagsC, F_SC_HUMIDITY))
        this.publishProperty('smart_care_nightcare', on(flagsC, F_SC_NIGHTCARE))

        this.publishProperty('night_care_start', hhmm(at(OFF.nightCareStartHour), at(OFF.nightCareStartMinute)))
        this.publishProperty('night_care_end', hhmm(at(OFF.nightCareEndHour), at(OFF.nightCareEndMinute)))

        // Only slot 1 is meaningful on this unit: Config.maxDownloadCourseNum is 1, and the
        // count byte 40 reads 1. Slots 2..4 hold leftovers and are not published.
        this.publishProperty('download_course', SMART_COURSE.map(at(OFF.downloadCourse1)))

        this.publishProperty('tcl_count', at(OFF.tclCount))
    }

    /** What Start course will run. Kept here because LG's setCurrentCycle does not convert, so the
     *  appliance has no notion of a selected-but-not-started course to read back. */
    private selectedCourse = COURSE_IDS[0]
    /** Last state the appliance itself reported. `undefined` means no state frame has arrived. */
    private poweredOn: boolean | undefined
    private nightCareEnabled: boolean | undefined
    private hasProblem: boolean | undefined

    private publishOption(prop: string, label: string | undefined) {
        if (label !== undefined) this.publishProperty(prop, label)
    }

    /** `aa 34 f0 26 | <id> 01 00 04 00 00 00 00 00 | <course parameters> | ck bb`. */
    private runCourse(id: number) {
        const params = COURSE_PARAMS[id]
        if (params === undefined) return log('status', this.id, `Course cannot start ${id}`)
        this.send(
            Buffer.concat([Buffer.from(RUN_COURSE), Buffer.from([id, ...COURSE_HEAD]), Buffer.from(params, 'hex')]),
        )
    }

    /** Resume carries the course id and nothing else. */
    private resumeCourse(id: number) {
        const block = Buffer.alloc(RESUME_BLOCK_LEN)
        block[0] = id
        this.send(Buffer.concat([Buffer.from(RUN_COURSE), block]))
    }

    /**
     * Build and send a command frame: `aa <len> f0 24 <type> <len> <value…> <ck> bb`.
     *
     * The base class's `send` supplies the AA/length prefix and the checksum, so what goes in is
     * `f0 24` plus the body — which reproduces the captured frames byte for byte.
     */
    private setControl(type: number, ...values: number[]) {
        this.send(Buffer.from([...SET_STATE, type, values.length, ...values]))
    }

    /** The UPCENTER settings put their own sub id between the length and the value, and the
     *  length still counts only the value bytes — 1 for a flag, 2 for a clock time. */
    private setUpCenter(sub: number, ...values: number[]) {
        this.send(Buffer.from([...SET_STATE, CTRL_UPCENTER, values.length, sub, ...values]))
    }

    /*
     * Publish what was just asked for, without waiting for the appliance to say it.
     *
     * This appliance reports when it feels like it. A settings change comes back in a second or
     * two, but a course start can take a minute or more: while it runs it mostly sends frames
     * that carry no state at all, so the 98-byte state frame that would confirm the course is
     * simply not due yet. Waiting for it makes every control feel broken and invites a second
     * press. The next real frame overwrites whatever is published here, so the appliance still
     * has the last word. Known refusals are not echoed: this model rejects every setting while
     * powered off, and rejects night-care times while night care is disabled.
     */
    private echo(prop: string, value: string | number | undefined) {
        if (this.poweredOn !== true) return
        if (prop === 'course' && this.hasProblem !== false) return
        if (this.nightCareEnabled === false && (prop === 'night_care_start' || prop === 'night_care_end')) {
            return
        }
        this.publishProperty(prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        const onOff = () => (mqttValue === 'ON' ? 1 : 0)
        switch (prop) {
            case 'power':
                this.setControl(CTRL_POWER, onOff())
                // Every other setting here is confirmed by the state frame the appliance sends
                // back. Power is the exception: switched off, it stops sending a frame this
                // driver can read at all, so the switch would never see OFF. It is published
                // here and corrected by the next real frame.
                if (mqttValue !== 'ON') this.poweredOn = false
                return this.publishProperty('power', mqttValue === 'ON' ? 'ON' : 'OFF')
            case 'remote_maintain':
                this.setControl(CTRL_REMOTE_MAINTAIN, onOff())
                return this.echo(prop, mqttValue)
            case 'keep_last_course':
                this.setUpCenter(UP.isLastCourse, onOff())
                return this.echo(prop, mqttValue)
            case 'course_select': {
                const id = COURSE.unmap(mqttValue)
                if (id === undefined || !COURSE_IDS.includes(id))
                    return log('status', this.id, `Unknown course ${mqttValue}`)
                this.selectedCourse = id
                // Nothing goes to the appliance until Start course — this is a choice, not a command.
                return this.publishProperty('course_select', mqttValue)
            }
            case 'start_course':
                this.runCourse(this.selectedCourse)
                // The course itself, so the dashboard shows what was asked for straight away.
                return this.echo('course', COURSE.map(this.selectedCourse))
            case 'pause_course':
                return this.setControl(CTRL_PAUSE, 0)
            case 'resume_course':
                return this.resumeCourse(this.selectedCourse)
            case 'smart_care_finedust':
                this.setUpCenter(UP.smartCareFineDust, onOff())
                return this.echo(prop, mqttValue)
            case 'smart_care_humidity':
                this.setUpCenter(UP.smartCareHumidity, onOff())
                return this.echo(prop, mqttValue)
            case 'smart_care_nightcare':
                this.setUpCenter(UP.smartCareNightCare, onOff())
                return this.echo(prop, mqttValue)
            case 'buzzer': {
                const code = BUZZER.unmap(mqttValue)
                if (code === undefined) return log('status', this.id, `Unknown alert sound ${mqttValue}`)
                this.setUpCenter(UP.buzzer, code)
                return this.echo(prop, mqttValue)
            }
            case 'end_melody': {
                const code = END_MELODY.unmap(mqttValue)
                if (code === undefined) return log('status', this.id, `Unknown end melody ${mqttValue}`)
                this.setUpCenter(UP.endMelody, code)
                return this.echo(prop, mqttValue)
            }
            case 'night_care_start':
            case 'night_care_end': {
                // The text entity carries the pattern, but a driver that trusts it would write a
                // stray byte into the schedule on any other producer. The appliance only takes
                // whole and half hours, which is LG's own constraint, not ours.
                const m = HALF_HOUR.exec(mqttValue.trim())
                if (!m) return log('status', this.id, `Night-care time format error ${mqttValue}`)
                const sub = prop === 'night_care_start' ? UP.nightCareStart : UP.nightCareEnd
                // Hour and minute travel in one frame, exactly as LG's own setter sent them.
                this.setUpCenter(sub, Number(m[1]), Number(m[2]))
                return this.echo(prop, mqttValue.trim())
            }
            default:
                log('status', this.id, `Item does not support writing ${prop}`)
        }
    }
}
