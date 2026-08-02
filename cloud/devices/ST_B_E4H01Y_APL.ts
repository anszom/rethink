import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type ComponentInfo, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'

/*
 * LG Styler (KR Baron Plus, S5BBP), ThinQ model ST_B_E4H01Y_APL, deviceType 203.
 *
 * WHERE THE BYTE OFFSETS COME FROM
 * --------------------------------
 * This model's modelJSON has no tlv_* labels (unlike the clip/TLV humidifier and
 * dehumidifiers) — it is an AA..BB appliance, so the byte layout lives only in the Wi-Fi
 * module's firmware and on LG's server.
 *
 * Recovered 2026-07-28 with tools/lg-oracle.mjs, which makes LG's own cloud do the decode:
 * rethink relays what the appliance sends, and the management API can inject a frame as if
 * the appliance had sent it. Each probe re-injected the appliance's real state frame with
 * EXACTLY ONE byte changed and read LG's snapshot back, so every offset below rests on a
 * direct observation, seen twice (once when its probe set it, once when the next probe
 * reverted it). A plain ramp was not enough here: byte[i]=i is not a valid code for most of
 * these enums, and three of the bytes turn out to be bitfields, which a ramp cannot separate.
 *
 * Base frame (real, captured 2026-07-28):
 *   aaff310a00 3a00 53ea 000100eb0028 00000000 010001000001 000000000000200000000000000000
 *   014e420000040300000000000000 25 7205bb
 *
 * Frame shape: `aa ff 31 0a 00 | <len16 LE> | <seq16> | …payload… | <crc16 XMODEM> bb`.
 * Confirmed layout, absolute offsets into the whole 58-byte frame:
 *
 *   17 state              18 remainTimeHour     19 remainTimeMinute
 *   20 initialTimeHour    21 initialTimeMinute  22 course
 *   23 error              24 preState
 *   29 reserveTimeHour    30 reserveTimeMinute
 *   31 flags  0x01 childLock  0x02 nightDry  0x04 initialBit  0x08 remoteStart
 *   34..35 energyMonitoring, big-endian 16-bit (byte34=0x01 read back 256; byte35=0x01 read 1)
 *   37 smartCourse
 *   40 currentDownloadCourseCount   41..44 currentDownloadCourse1..4
 *   45 buzzer
 *   46 flags  0x01 applyRemoteMaintain  0x02 applyBuzzer  0x04 remoteMaintain
 *   47 endMelody          48 internalLightingTime
 *   49 flags  0x01 isLastCourse  0x02 smartCareFineDust  0x04 smartCareHumidity
 *             0x08 smartCareNightCare  0x10 smartPairing  0x20 currentTimeDisplay
 *   50 nightCareStartTime_Hour  51 nightCareStartTime_Minute
 *   52 nightCareEndTime_Hour    53 nightCareEndTime_Minute
 *   54 TCLCount
 *
 * That is all 38 `styler.*` keys LG publishes for this unit, and nothing is left over.
 * The three flag bytes were split bit by bit (0x01, 0x02, 0x04, … one injection each);
 * byte 31 bit 0x20 and byte 49 bits 0x40/0x80 move no field and are left alone.
 *
 * THE OTHER FRAMES THIS APPLIANCE SENDS ARE NOT STATE.
 * `aa ff 31 0a 00 23 00 …` (35 B) looks like a status frame but is not one: every byte from
 * 9 to 31 was probed with 0xff and not one field in LG's snapshot moved. The 112/113-byte
 * frames are the downloadable-course name list (ASCII "203-1", "ST-4"…), and `aa 07 31 c3 02`
 * is a heartbeat. Only the 58-byte frame is decoded here.
 *
 * WRITE DIRECTION
 * ---------------
 * Eleven commands were captured on 2026-07-28 — every option of every one, thirty-one frames,
 * recorded in `/share/local_addons/rethink/captures/styler-vacuum-commands-20260728.md`.
 *
 * They came from LG's own cloud, not from reading the read map backwards:
 * `dataops/v1/s2p/backend/convert/control` converts a capability command into this appliance's
 * protocol and sends it down, and rethink relays it. Every frame below answered CL-0000 and was
 * ACKed by the appliance (`aa 08 31 00 24 00 …`; a refusal answers `… 24 ff …`).
 *
 *   aa <len> f0 24 <controlDataType> <valueLength> [<controlDataType_sub>] <value…> <ck> bb
 *
 *   01 POWERON/POWEROFF          len 1   off 0, on 1
 *   13 UPCENTER, then a sub id and the value:
 *      01 ENDMELODY              len 1   the melody's index, 0..11
 *      03 UPBUZZER               len 1   the buzzer level, 0..4
 *      04 SC_FINEDUST            len 1   off 0, on 1
 *      05 SC_HUMIDITY            len 1   off 0, on 1
 *      06 SC_NIGHTCARE           len 1   off 0, on 1
 *      07 SC_NIGHTCARE_START     len 2   hour, minute
 *      08 SC_NIGHTCARE_END       len 2   hour, minute
 *      09 CTRL_IS_LAST_COURSE    len 1   off 0, on 1
 *
 * `controlDataType`, `controlDataValueLength` and `controlDataType_sub` are modelJSON's own
 * `ControlWifi` vocabulary, and every value is the code the read map above already uses for
 * that field — so the two maps check each other.
 *
 * The earlier note here said control was refused. It was: with the argument names the aircon
 * uses (`{"setOnOff":{"onOff":"on"}}`). This family wants what `convert/capabilitySchema`
 * declares — `{"setOnOff":{"value":"on"}}` — and answers CL-0000 once asked that way.
 * `CL-0005` is a second gate and means the appliance is in no state to take the command: every
 * setting is refused while it is powered off, and the night-care times are refused while
 * night care itself is off.
 *
 * WHERE LG'S CONVERTER RUNS OUT, THE APPLIANCE STILL ANSWERS
 * `remoteControlStatus setRemoteControlType` answers CL-0000 but emits the SAME frame for every
 * argument tried — twelve of them, `on` / `off` / `enable` / `remoteMaintain` / `1` / `0` … —
 * always `aa09f0241001008dbb`, REMOTE_MAINTAIN = 0. LG's converter cannot express the ON side.
 *
 * That is not the end of it. The frame shape is known, so the ON frame was built and sent to
 * the appliance directly (management socket, `sendToDevice`) and the appliance took it:
 *
 *   aa09f0241001018cbb -> ack `aa 08 31 00 24 00`, and the next state frame came back with
 *                         byte 46 bit 0x04 set — Remote control allowed ON in Home Assistant
 *   aa09f0241001008dbb -> the same round trip, back to OFF
 *
 * A command the appliance acknowledges and then reports back is evidence of the same kind as a
 * frame LG sent: it is the appliance answering, not a guess. So Remote control allowed ships as a switch.
 *
 * COURSE CONTROL
 * `cycles start` and `cycles setCurrentCycle` both fail conversion, but `operationState` works,
 * with the course's NUMERIC id as a string — `{"startCycle":{"cycle":{"id":"1"}}}` -> CL-0000:
 *
 *   start  aa 34 f0 26 | <46-byte course block> | ck bb
 *   pause  aa 09 f0 24 04 01 00                             (PAUSE, LG's controlDataType 0x04)
 *   resume aa 33 f0 26 | <course id> <44 zero bytes> | ck bb
 *
 * The course block is `<id> 01 00 04 00 00 00 00 00` followed by this model's own course
 * parameters, and those parameters are modelJSON's `Course[id].function` defaults in
 * declaration order — with `TimeDry` folded into bit 0x80 of the `PreSteam1_Time` byte, which
 * is why the block is one byte shorter than the field list. Two courses were captured off LG's
 * converter, Standard (id 1) and Quick (id 3), and the table below reproduces BOTH byte for byte; the
 * test suite asserts exactly that. The rest of the table is the same rule applied to the same
 * declaration, which is the only reason it ships without a capture of its own.
 *
 * `cycles setCurrentCycle` answers CL-0002 with an empty error, so there is no way to select a
 * course without starting it. Course select is therefore a local choice this driver remembers, and
 * Start course is what sends it — which is also the order LG's own app puts them in.
 */

/** State frame: 58 bytes, `aa ff 31 0a 00`, CRC16/XMODEM tail. */
/*
 * Frame shape: `aa ff 31 0a 00 | <len16 LE> | <seq16> | 00 01 | 00 <tag> | <record bytes, BE16> |
 * …records… | <crc16 XMODEM> bb`. Fifteen header bytes, three trailer.
 *
 * THE RECORD COUNT VARIES, SO IT IS COUNTED RATHER THAN ASSUMED.
 * At rest the appliance sends ONE 40-byte record (58-byte frame). The moment it is doing
 * anything it sends TWO (98-byte frame) — previous record, then current — exactly like the
 * water purifier in this repo. A decoder keyed on "58 bytes" therefore goes blind the instant
 * the appliance is switched on, which is when it matters: measured 2026-07-28, LG read the
 * 98-byte frames as state INITIAL / course STANDARD / remote-start ON while this driver was
 * still publishing Power off off the last 58-byte frame.
 *
 * So the payload is measured: header 15, trailer 3, and what is between must be a whole number
 * of 40-byte records, cross-checked against the record-bytes field the frame declares at 13..14.
 * The last record is the current state. That also rejects the 112/113-byte course-name lists
 * (not a multiple of 40) and the 35-byte frame, which carries no state at all.
 */
const HEADER_LEN = 15
const TRAILER_LEN = 3
const RECORD_LEN = 40
/** buf[13..14], big-endian: how many record bytes the frame says it carries. */
const RECORD_BYTES_OFF = 13
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
    energyHi: 19,
    energyLo: 20,
    smartCourse: 22,
    downloadCourseCount: 25,
    downloadCourse1: 26,
    buzzer: 30,
    flagsB: 31,
    endMelody: 32,
    internalLightingTime: 33,
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
 * Korean text is from this model's own ko-KR packs: the product pack for states and melodies,
 * and the per-model pack (`langPackModelUri`) for course names. Where two courses share a
 * name ("Standard" for both styling and sanitising) the modelJSON `_comment`'s category prefix
 * disambiguates them, so the label is still LG's wording on both halves.
 */

/*
 * `styler.state` — and this one is NOT positional, which the first pass got wrong.
 *
 * The idle codes happen to line up with the declaration order, so three idle observations made
 * the whole table look right. They are not: the moment a course runs the appliance reports 50,
 * 51, 52 …, which the positional table published as `Code 52`. Measured 2026-07-28 by injecting
 * each code and reading LG's own name back (tools/lg-oracle.mjs's method) — every entry below is
 * one such observation, and 10..49 and 60 answered NOT_DEFINE_VALUE, so the gap is LG's, not ours.
 *
 * Korean text is this model's own ko-KR pack. LG deliberately collapses phases: PREHEAT, STEAM
 * and STAY all print Refreshing, and COOLING / DRYING / ENDCOOLING all print Drying — the app
 * shows the same. FOTA has a name in the pack but no code was found for it.
 */
const STATE: Record<number, string> = {
    0: 'Power off', // POWEROFF
    1: 'Standby', // INITIAL
    2: 'Styling', // RUNNING
    3: 'Pause', // PAUSE
    4: 'Course complete', // COMPLETE
    5: 'Check appliance', // ERROR
    6: 'Smart diagnosing', // DIAGNOSIS
    7: 'Storing', // NIGHTDRY
    8: 'Reserved', // RESERVED
    9: 'Power-save running', // SLEEP
    50: 'Steam preparing', // PRESTEAM
    51: 'Refreshing', // PREHEAT
    52: 'Refreshing', // STEAM
    53: 'Refreshing', // STAY
    54: 'Drying', // COOLING
    55: 'Drying', // DRYING
    56: 'Drying', // ENDCOOLING
    57: 'Sterilizing', // STERILIZE
    58: 'Course complete', // RUNNINGEND
    59: 'Course complete', // END_REMOTE_MAINTAIN_ON
}

/*
 * `styler.error` — and like `styler.state`, the codes are NOT the declaration order. LG's own
 * Error table skips values, so a positional reading drifts one place from E2 onward and lands
 * Water refill on the wrong number. Every entry below was measured on 2026-07-28 by injecting that
 * code and reading LG's name back; 12..17, 19..22, 24 and 27..30 answer NOT_DEFINE_VALUE.
 *
 * These matter beyond display: the appliance refuses to start a course while one is standing,
 * which is why Check needed is published as its own problem sensor.
 *
 * Korean text is this model's own pack, using the label LG shows the owner (Water refill / drain)
 * rather than the service code where it has one.
 */
const ERROR: Record<number, string> = {
    0: 'Normal', // ERROR_NO
    1: 'TE1',
    2: 'TE2',
    3: 'TE3',
    4: 'TE4',
    5: 'TE5',
    6: 'E1',
    7: 'E2',
    8: 'Water refill', // ERROR_E3 — LG's own _comment is "E3_Water refill LED"
    9: 'E4',
    10: 'LE2',
    11: 'AE',
    18: 'LE',
    23: 'Normal', // ERROR_NONE
    25: 'Water drain', // ERROR_DRAINE
    26: 'Door open', // ERROR_DE_OPEN
    31: 'Check door closed', // ERROR_DE_CLOSE
    32: 'E6',
    33: 'PS',
    34: 'No filter', // ERROR_IF
}

/** The two codes that mean "nothing wrong". Everything else stops a course from starting. */
const ERROR_CLEAR = new Set([0, 23])

/** modelJSON `Course`, id -> ko-KR name (per-model language pack). */
const COURSE: Record<number, string> = {
    0: 'None',
    1: 'Styling Standard',
    3: 'Styling Quick',
    5: 'Styling Intensive',
    6: 'Wool/Knit',
    7: 'Suit/Coat',
    11: 'Sterilize Standard',
    15: 'Auto Dry',
    17: 'Timed Dry 30',
    18: 'Timed Dry 60',
    19: 'Timed Dry 90',
    20: 'Timed Dry 120',
    23: 'Room Dehumidify 120',
    24: 'Room Dehumidify 240',
    28: 'Padding Care',
    30: 'Fine dust',
    31: 'Virus',
    32: 'Jeans Care',
    33: 'Fur/Leather Care',
    36: 'Suit/Uniform Sterilize',
    37: 'Silk',
    38: 'Cashmere',
}

/** modelJSON `SmartCourse`, id -> ko-KR name. Id 1 is LG's panel-pairing pseudo-course. */
const SMART_COURSE: Record<number, string> = {
    0: 'None',
    1: 'Panel course',
    61: 'Suit/Uniform Sterilize',
    62: 'Scarf Care',
    66: 'Pants Care',
    67: 'Quiet Care',
    68: 'Coat warm',
    69: 'Static removal',
    71: 'Old-clothes Care',
    73: 'Blanket warm',
    75: 'Dress-shirt Dry',
    76: 'Snow/Rain Dry',
    78: 'Fur/Leather Care',
    93: 'Jeans Care',
    94: 'Baby-clothes Sterilize',
    95: 'Doll Sterilize',
    96: 'Wool/Knit Dry',
    97: 'Rainy-season Laundry Dry',
    98: 'Uniform Care',
    99: 'Padding Care',
    100: 'Thin Padding Dry',
    101: 'Thick Padding Dry',
    112: 'Yoga/Pilates Care',
    113: 'Yoga/Pilates Dry',
    114: 'Swimwear Dry',
    115: 'Functional',
    119: 'Bedding Sterilize',
}

/** `styler.buzzer`: the byte is n in BUZZER_n (byte 45 = 4 read BUZZER_4, = 1 read BUZZER_1). */
const BUZZER: Record<number, string> = { 0: 'Mute', 1: 'Small', 2: 'Normal', 3: 'Large', 4: 'Very large' }

/** `styler.endMelody`: the byte is n in END_MELODY_n (byte 47 = 1 read END_MELODY_1). */
const END_MELODY: Record<number, string> = {
    0: 'Default sound',
    1: 'Vivaldi Winter',
    2: 'Bach Minuet',
    3: 'Home Sweet Home',
    4: 'Breeze',
    5: 'Old MacDonald',
    6: 'Verdi Brindisi',
    7: 'Bubble',
    8: 'Beethoven Symphony No.5 5',
    9: 'Arirang',
    10: 'Pachelbel Canon',
    11: 'Beethoven Choral',
    12: 'Jingle Bells (intro)',
    13: 'Jingle Bells (chorus)',
    14: 'We Wish You a Merry Christmas',
    15: 'Silent Night',
    16: 'O Christmas Tree',
}

/** The melodies LG's own capability schema offers for this unit — codes 0..11, in this order,
 *  and a command frame was captured for every one. Codes 12..16 in the table above are read
 *  labels only; LG does not list them for this model, so the select does not offer them. */
const END_MELODY_OPTIONS = Array.from({ length: 12 }, (_, i) => END_MELODY[i])

/** The courses this unit can be told to run — every id with a block above, under the name the
 *  read table gives it, so Course select and the Course sensor speak the same words. */
const COURSE_IDS = Object.keys(COURSE_PARAMS).map(Number)
const COURSE_OPTIONS = COURSE_IDS.map((id) => COURSE[id])

const enumOf = (table: Record<number, string>, raw: number) => table[raw] ?? `Code ${raw}`
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
        /** A setting the appliance takes a command for, offered as its own Korean labels. */
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
                    status: sensor('status', 'State', { icon: 'mdi:hanger' }),
                    course: sensor('course', 'Course', { icon: 'mdi:playlist-check' }),
                    // Choosing a course does not start it — LG's own app works the same way,
                    // and its setCurrentCycle does not convert for this model.
                    course_select: choice('course_select', 'Course select', COURSE_OPTIONS, {
                        icon: 'mdi:playlist-edit',
                    }),
                    start_course: press('start_course', 'Start course', 'mdi:play-circle-outline'),
                    pause_course: press('pause_course', 'Pause', 'mdi:pause-circle-outline'),
                    resume_course: press('resume_course', 'Resume', 'mdi:play-pause'),
                    smart_course: sensor('smart_course', 'Smart course', { icon: 'mdi:playlist-star' }),
                    remaining: minutes('remaining', 'Time remaining', { icon: 'mdi:timer-sand' }),
                    total: minutes('total', 'Total time', { icon: 'mdi:timer-outline' }),
                    reserved_at: sensor('reserved_at', 'Reserved time', { icon: 'mdi:calendar-clock' }),
                    error: sensor('error', 'Error', { icon: 'mdi:alert-circle-outline' }),
                    // The appliance will not start a course while an error stands — Water refill is
                    // the everyday one — so it gets a problem sensor of its own rather than
                    // hiding inside a text reading nobody has an automation on.
                    problem: flag('problem', 'Check needed', {
                        device_class: 'problem',
                        icon: 'mdi:alert',
                    }),
                    child_lock: flag('child_lock', 'Button lock', { icon: 'mdi:lock' }),
                    night_dry: flag('night_dry', 'Store', { icon: 'mdi:weather-night' }),
                    remote_start: flag('remote_start', 'Remote-control ready', { icon: 'mdi:cellphone-check' }),
                    remote_maintain: toggle('remote_maintain', 'Remote control allowed', {
                        icon: 'mdi:cellphone-wireless',
                    }),
                    buzzer: choice('buzzer', 'Alert sound', Object.values(BUZZER), {
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                    }),
                    end_melody: choice('end_melody', 'End melody', END_MELODY_OPTIONS, {
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
                    // Replaced by the two settable halves above. Removing a component from the
                    // config is not enough to retire the entity Home Assistant already made —
                    // a config carrying nothing but its platform is what says "this is gone",
                    // and it has to carry that, or HA rejects the whole device payload.
                    night_care_window: { platform: 'sensor' } as ComponentInfo,
                    download_course: sensor('download_course', 'Downloaded course', {
                        icon: 'mdi:download',
                        entity_category: 'diagnostic',
                    }),
                    tcl_count: sensor('tcl_count', 'Sterilize-tank clean alert count', {
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                        // Resets when the maintenance course runs, so total_increasing would
                        // wrongly accumulate across the reset — no state_class.
                    }),
                    energy: sensor('energy', 'Energy monitoring', {
                        icon: 'mdi:flash',
                        entity_category: 'diagnostic',
                    }),
                    previous_status: sensor('previous_status', 'Previous state', {
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    }),
                    internal_light: sensor('internal_light', 'Interior light setting', {
                        icon: 'mdi:lightbulb-outline',
                        entity_category: 'diagnostic',
                        // LG's snapshot exposes styler.internalLightingTime but this model's
                        // modelJSON does not declare its value list, so the raw code is published
                        // rather than an invented label. 0 read back NO_SETTING, 1 read LIGHTING_TIME_0.
                    }),
                },
            }),
        )
    }

    /*
     * Offsets above are stated against the whole frame, the way the probes recorded them, so
     * the frame is read unstripped rather than through the base class's body view.
     */
    processData(buf: Buffer) {
        if (buf[0] !== 0xaa || buf[1] !== 0xff || buf[2] !== STATE_TAG) return
        if (buf[buf.length - 1] !== 0xbb) return
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
        this.publishProperty('status', enumOf(STATE, at(OFF.state)))
        this.publishProperty('power', this.poweredOn ? 'ON' : 'OFF')
        this.publishProperty('previous_status', enumOf(STATE, at(OFF.preState)))
        this.publishProperty('error', enumOf(ERROR, at(OFF.error)))
        this.publishProperty('problem', this.hasProblem ? 'ON' : 'OFF')
        this.publishProperty('course', enumOf(COURSE, at(OFF.course)))
        this.publishProperty('smart_course', enumOf(SMART_COURSE, at(OFF.smartCourse)))

        // Track whatever the appliance is actually set to, so Course select opens on the right one.
        // Idle it reports NONE, which is not an option — that leaves the last choice standing.
        const running = COURSE_PARAMS[at(OFF.course)] !== undefined ? at(OFF.course) : undefined
        if (running !== undefined) {
            this.selectedCourse = running
            this.publishProperty('course_select', COURSE[running])
        }

        // LG reports the times split into hours and minutes; HA wants one duration.
        this.publishProperty('remaining', at(OFF.remainTimeHour) * 60 + at(OFF.remainTimeMinute))
        this.publishProperty('total', at(OFF.initialTimeHour) * 60 + at(OFF.initialTimeMinute))

        const rh = at(OFF.reserveTimeHour)
        const rm = at(OFF.reserveTimeMinute)
        this.publishProperty('reserved_at', rh === 0 && rm === 0 ? 'No reservation' : hhmm(rh, rm))

        this.publishProperty('child_lock', on(flagsA, F_CHILD_LOCK))
        this.publishProperty('night_dry', on(flagsA, F_NIGHT_DRY))
        this.publishProperty('remote_start', on(flagsA, F_REMOTE_START))
        this.publishProperty('remote_maintain', on(flagsB, F_REMOTE_MAINTAIN))

        // Both are selects, and a select's state has to be one of its options — publishing
        // `Code N` for something outside the list would make Home Assistant reject the state and
        // log it, so an unlisted code leaves the previous value standing.
        this.publishOption('buzzer', BUZZER[at(OFF.buzzer)])
        this.publishOption('end_melody', END_MELODY_OPTIONS[at(OFF.endMelody)])

        this.publishProperty('keep_last_course', on(flagsC, F_IS_LAST_COURSE))
        this.publishProperty('smart_care_finedust', on(flagsC, F_SC_FINEDUST))
        this.publishProperty('smart_care_humidity', on(flagsC, F_SC_HUMIDITY))
        this.publishProperty('smart_care_nightcare', on(flagsC, F_SC_NIGHTCARE))

        this.publishProperty('night_care_start', hhmm(at(OFF.nightCareStartHour), at(OFF.nightCareStartMinute)))
        this.publishProperty('night_care_end', hhmm(at(OFF.nightCareEndHour), at(OFF.nightCareEndMinute)))

        // Only slot 1 is meaningful on this unit: Config.maxDownloadCourseNum is 1, and the
        // count byte 40 reads 1. Slots 2..4 hold leftovers and are not published.
        this.publishProperty('download_course', enumOf(SMART_COURSE, at(OFF.downloadCourse1)))

        this.publishProperty('tcl_count', at(OFF.tclCount))
        this.publishProperty('energy', (at(OFF.energyHi) << 8) | at(OFF.energyLo))
        this.publishProperty('internal_light', at(OFF.internalLightingTime))
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
        if (params === undefined) return console.warn(`Styler: Course cannot start ${id}`)
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
    private echo(prop: string, value: string | number) {
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
                const id = COURSE_IDS.find((c) => COURSE[c] === mqttValue)
                if (id === undefined) return console.warn(`Styler: Unknown course '${mqttValue}'`)
                this.selectedCourse = id
                // Nothing goes to the appliance until Start course — this is a choice, not a command.
                return this.publishProperty('course_select', mqttValue)
            }
            case 'start_course':
                this.runCourse(this.selectedCourse)
                // The course itself, so the dashboard shows what was asked for straight away.
                return this.echo('course', COURSE[this.selectedCourse])
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
                const code = Object.entries(BUZZER).find(([, label]) => label === mqttValue)?.[0]
                if (code === undefined) return console.warn(`Styler: Unknown alert sound '${mqttValue}'`)
                this.setUpCenter(UP.buzzer, Number(code))
                return this.echo(prop, mqttValue)
            }
            case 'end_melody': {
                const code = END_MELODY_OPTIONS.indexOf(mqttValue)
                if (code < 0) return console.warn(`Styler: Unknown end melody '${mqttValue}'`)
                this.setUpCenter(UP.endMelody, code)
                return this.echo(prop, mqttValue)
            }
            case 'night_care_start':
            case 'night_care_end': {
                // The text entity carries the pattern, but a driver that trusts it would write a
                // stray byte into the schedule on any other producer. The appliance only takes
                // whole and half hours, which is LG's own constraint, not ours.
                const m = HALF_HOUR.exec(mqttValue.trim())
                if (!m) return console.warn(`Styler: Night-care time format error '${mqttValue}'`)
                const sub = prop === 'night_care_start' ? UP.nightCareStart : UP.nightCareEnd
                // Hour and minute travel in one frame, exactly as LG's own setter sent them.
                this.setUpCenter(sub, Number(m[1]), Number(m[2]))
                return this.echo(prop, mqttValue.trim())
            }
            default:
                console.warn(`Styler: Item does not support writing ${prop}`)
        }
    }
}
