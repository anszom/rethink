import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { ERROR, ERROR_CLEAR, STATE } from './styler_common'

/*
 * LG Styler (S5MPC), deviceType 203.
 *
 * The appliance cannot be powered on remotely (a safety lockout LG's own app
 * honours too), and remote start itself takes no command — the app only
 * reports it. Everything else below was driven from the app on 2026-09-07
 * (227 wire frames, 83 LG cloud snapshots) and reproduced byte for byte.
 *
 * READ. `aa <len> 31 <seq> | [ <len16 BE> <record> ]… | <ck> bb`, every record
 * 27 bytes. The trailing record is the current state; a leading one, when
 * present, is the previous state. Frames that do not split into whole 27-byte
 * records are not state and are ignored: the 8-byte `aa 08 31 00 24 00` ACKs,
 * the 9-byte `aa 09 31 72 00 …` notifications that accompany remote-start
 * transitions (seen with both 0xc8 and 0xc9, undecoded), and the 55-byte
 * downloadable-course name list.
 *
 * Offsets WITHIN a 27-byte record:
 *
 *   0 state         — `styler.state`, the table ST_B_E4H01Y_APL measured.
 *                     0 POWEROFF, 1 INITIAL, 3 PAUSE, 8 RESERVED and 50
 *                     PRESTEAM were each seen on the wire while LG reported
 *                     exactly that state.
 *   1..2 remainTimeHour/Minute — e.g. `00 27` read 39 minutes in both the
 *                     PRESTEAM and PAUSE captures; modelJSON names these exact
 *                     fields in this order.
 *   3..4 initialTimeHour/Minute — the same captures read `00 27` (39 minutes),
 *                     with the field order declared by modelJSON.
 *   5 course        — LG's course id (10 only ever appears while a smart
 *                     course runs; it has no plain start frame).
 *   6 error         — `styler.error`, the table ST_B_E4H01Y_APL measured;
 *                     modelJSON declares the same values. Only 0 (ERROR_NO)
 *                     was seen on this unit.
 *   7 preState      — same code set as state, cross-checked the same way.
 *   12..13 reserveTimeHour/Minute — 19/3-hour reservations and the 18:59
 *                     countdown each read back exactly as LG reported them.
 *   14 flagsA       — bit 0x08 is remoteStart: six ON/OFF transitions each
 *                     arrived on this bit in the same second LG's cloud
 *                     reported REMOTE_START_ON/OFF. Bit 0x01 is childLock:
 *                     toggling the physical panel's child-lock button flipped
 *                     only this bit (0x20 <-> 0x21 with flagsA otherwise 0x20)
 *                     in the very next frame, captured 2026-09-08. LG's app
 *                     has no control for this — it is panel-only — so it is
 *                     exposed read-only.
 *   17..18 energy, big-endian 16-bit — this-cycle cumulative Wh (x1).
 *                     Validated 2026-09-11: a full steam cycle reported 0
 *                     here until completion, then 0x0251 = 593Wh, matching
 *                     the ThinQ app's daily 593Wh exactly.
 *   20 smartCourse  — LG's smart-course id, cross-checked on all four
 *                     captured smart runs (76/93/99/121).
 *   23 currentDownloadCourseCount — reads 1 in every capture.
 *   24 currentDownloadCourse1 — the smart course installed on the
 *                     appliance, as on ST_B_E4H01Y_APL. It holds its value
 *                     while idle and powered off, and moved 98 -> 99 -> 121
 *                     across the captures as courses were downloaded. Byte 25
 *                     keeps a leftover 66 while the count reads 1, so it is
 *                     not read.
 *
 * WRITE. Settings go out as
 *
 *   aa <len> f0 24 <controlDataType> <valueLength> <value…> <ck> bb
 *
 *   01 POWERON/POWEROFF          len 1   off 0 (ON never captured: the app
 *                                       cannot switch the appliance on)
 *   04 PAUSE                     len 1   0
 *
 * and course control as
 *
 *   start   aa 34 f0 26 | <9-byte head> <37-byte params> | ck bb
 *   resume  aa 33 f0 26 | <course id> <44 zero bytes> | ck bb
 *   download aa 36 f0 25 | 03 2d <9-byte zeroed head> <37-byte params> | ck bb
 *
 * The 9-byte head is `<id> 01 <smartId> <04|02=store> 00 00 <reserveHour> 00
 * 00`: smartId is the smart-course id (0 for plain courses), reserveHour is
 * the reservation delay in hours (0 = start now; LG declares 3..19). The
 * params are the entry's own modelJSON `function` defaults in declaration
 * order, with `TimeDry` folded into bit 0x80 of the first byte — and that
 * rule reproduces all 20 captured start frames and all 4 captured download
 * frames byte for byte.
 *
 * A smart start is always sent as the download + start pair, in that order —
 * that is exactly what the app emitted before each of the four captured
 * smart runs.
 */
const RECORD_LEN = 27
const STATE_TAG = 0x31

/** Offsets WITHIN a record. */
const OFF = {
    state: 0,
    remainTimeHour: 1,
    remainTimeMinute: 2,
    initialTimeHour: 3,
    initialTimeMinute: 4,
    course: 5,
    error: 6,
    preState: 7,
    reserveTimeHour: 12,
    reserveTimeMinute: 13,
    flagsA: 14,
    energyHigh: 17,
    energyLow: 18,
    smartCourse: 20,
    downloadCourse1: 24,
} as const

/** byte 14 */
const F_REMOTE_START = 0x08
const F_CHILD_LOCK = 0x01

/** Command frame opcode: `aa <len> f0 24 …`. */
const SET_STATE = [0xf0, 0x24]

/** modelJSON `ControlWifi` controlDataType ids, as the captured frames carry them. */
const CTRL_POWER = 0x01
const CTRL_PAUSE = 0x04

/** Course start, resume and smart-download travel under their own opcodes. */
const RUN_COURSE = [0xf0, 0x26]
const DOWNLOAD_COURSE = [0xf0, 0x25]
/** Resume carries the course id and nothing else, one byte shorter than a start block. */
const RESUME_BLOCK_LEN = 45
/** `<id> 01 <smartId> <04|02=store> 00 00 <reserveHour> 00 00`. */
const HEAD_LEN = 9
/** `03 2d`, then the head with smartId set and store/reserve zeroed. */
const DOWNLOAD_PREFIX = [0x03, 0x2d]

/** `styler.state` code 0. */
const STATE_POWEROFF = 0
/** LG's reservation range. 0 means no reservation (start now). */
const RESERVE_MAX = 19

/*
 * modelJSON `Course`, id -> name. Labels follow ST_B_E4H01Y_APL wherever the
 * id is shared, and its smart-course labels for the bases of smart courses.
 * Id 10 never runs on its own — it only appears as the base of smart runs.
 */
const COURSE = Enum.of({
    None: 0,
    'Styling Standard': 1,
    'Styling Quick': 3,
    'Styling Intensive': 5,
    'Wool/Knit': 6,
    'Suit/Coat': 7,
    Functionality: 8,
    'Downloaded Course': 10,
    'Sterilize Standard': 11,
    'Bedding Sterilize': 12,
    // 13/14/16/27/67/78 are never run on their own — they only appear as the
    // base course of a SmartCourse (see SMART_COURSE below) — so they have
    // no captured standalone start frame and stay out of COURSE_IDS, but the
    // read side needs the label so a running smart course reports its base
    // course instead of a raw code.
    'Baby-clothes Sterilize': 13, // SmartCourse 94
    'Doll Sterilize': 14, // SmartCourse 95
    'Auto Dry': 15,
    'Wool/Knit Dry': 16, // SmartCourse 96, also base of Silk Care (102)
    'Timed Dry 30': 17,
    'Timed Dry 60': 18,
    'Timed Dry 90': 19,
    'Timed Dry 120': 20,
    'Uniform Care': 27, // SmartCourse 98
    'Padding Care': 28,
    'Fine dust': 30,
    Virus: 31,
    'Jeans Care': 32,
    'Fur/Leather Care': 33,
    'Suit/Uniform Sterilize': 36,
    'Quiet Care': 67, // SmartCourse 67, also directly controllable
    'Fur/Leather': 78, // SmartCourse 78, also directly controllable
})

/*
 * modelJSON `SmartCourse`, id -> name. Labels follow ST_B_E4H01Y_APL for the
 * ids both models share. Id 1 is LG's panel-pairing pseudo-course.
 */
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
    'Silk Care': 102,
    'Yoga/Pilates Care': 112,
    'Yoga/Pilates Dry': 113,
    'Swimwear Dry': 114,
    'Golf-wear Care': 120,
    'Golf-wear Dry': 121,
})

/*
 * The parameter half of a start/download block: each entry's own modelJSON
 * `function` defaults in declaration order, with `TimeDry` folded into bit
 * 0x80 of the first byte. Generated from S5MPC.model.json by that rule and
 * verified byte-for-byte against all 24 captured start/download frames; the
 * suite re-checks a sample of them.
 *
 * Ids are LG's course ids, the same ones the state frame reports. Base 8 and
 * 12 exist only on this model (ST_B_E4H01Y_APL has no blocks for them).
 */
const COURSE_PARAMS: Record<number, string> = {
    1: '02645a00000005005a05b45a01b4001ab40000000000000000000000000000000000000000', // Styling Standard
    3: '82645a00000003005a00000001b4000eb40000000000000000000000000000000000000000', // Styling Quick
    5: '02645a00000007005a05c85a01c80031b40000000000000000000000000000000000000000', // Styling Intensive
    6: '82000000000004000000000001000014780000000000000000000000000000000000000000', // Wool/Knit
    7: '82645a00000004005a04b45a01b40017780000000000000000000000000000000000000000', // Suit/Coat
    8: '0200000000000300000000000000001400000000000000000400000300000178001a780000', // Functionality
    11: '0200002d000006000008000003000023780000000000000000000000000000000000000000', // Sterilize Standard
    12: '0200002d000006000008000003000028000000000000000000000000000000000000000000', // Bedding Sterilize
    15: '0000000000000000000000000000005a780000000000000000000000000000000000000000', // Auto Dry
    17: '8000000000000000000000000000001e780000000000000000000000000000000000000000', // Timed Dry 30
    18: '8000000000000000000000000000003c780000000000000000000000000000000000000000', // Timed Dry 60
    19: '8000000000000000000000000000005a780000000000000000000000000000000000000000', // Timed Dry 90
    // Identical to Timed Dry 60 on purpose: LG's modelJSON gives course 20 a Drying1_Time
    // default of 60, the same as course 18.
    20: '8000000000000000000000000000003c780000000000000000000000000000000000000000', // Timed Dry 120
    28: '82005a00000005005a05b45a01b4002eb40000000000000000000000000000000000000000', // Padding Care
    30: '82000000000000000000000005c80000000000000000000003005a02c85a01c80028c80000', // Fine dust
    31: '8200002d000007000008000003000043000000000000000000000000000000000000000000', // Virus
    32: '8200002d000006000008000003000028000000000000000000000000000000000000000000', // Jeans Care
    33: '8000000000000000000000000000001e780000000000000000000000000000000000000000', // Fur/Leather Care
    36: '8200002d00000600000800000300002b780000000000000000000000000000000000000000', // Suit/Uniform Sterilize
}

/** Smart params the same way: `[paramsHex, baseCourseId]`. */
const SMART_PARAMS: Record<number, [string, number]> = {
    61: ['8200002d000006000008000003000023780000000000000000000000000000000000000000', 10],
    62: ['82000000000004000000000001000010780000000000000000000000000000000000000000', 10],
    66: ['02000000000006000000000001000023000000000000000004000000000001b40019b40000', 10],
    67: ['8200000000000400000200000200002800000000000000000700000300000200003a000000', 67],
    68: ['8000000000000000000000000000000a780000000000000000000000000000000000000000', 10],
    69: ['82000000000002000000000001780005780000000000000000000000000000000000000000', 10],
    71: ['82000000000005005a05a05a0178001aa00000000000000000000000000000000000000000', 10],
    73: ['8000000000000000000000000000001e780000000000000000000000000000000000000000', 10],
    75: ['82000000000007000002c80001000064780000000000000000000000000000000000000000', 10],
    76: ['0200000000000300000000000100002d780000000000000000000000000000000000000000', 10],
    78: ['8000000000000000000000000000001e780000000000000000000000000000000000000000', 78],
    93: ['8200002d000006000008000003000028000000000000000000000000000000000000000000', 32],
    94: ['0200002d00000500000800000300001f000000000000000000000000000000000000000000', 13],
    95: ['0200002d000006000008000003000030000000000000000000000000000000000000000000', 14],
    96: ['80000000000000000000000000000096780000000000000000000000000000000000000000', 16],
    97: ['8000000000000000000000000000005a780000000000000000000000000000000000000000', 10],
    98: ['02000000000000000000000005c80000000000000000000008005a07c85a01c80031b40000', 27],
    99: ['82005a00000005005a05b45a01b4002eb40000000000000000000000000000000000000000', 28],
    100: ['80000000000000000000000008b40037780000000000000000000000000008b4000ab40000', 17],
    101: ['80000000000000000000000005b4006e780000000000000000000000000005b4001eb40000', 17],
    102: ['82000000000001005a00000001b40014b40000000000000000000000000000000000000000', 16],
    112: ['02005a00000003000005a00001a00017a00000000000000000000000000000000000000000', 10],
    113: ['80000000000000000000000000000064780000000000000000000000000000000000000000', 17],
    114: ['80000000000000000000000000000050780000000000000000000000000000000000000000', 17],
    120: ['02005a00000003005a0000000000000fa00000000000000003005a03005a01a00017a00000', 8],
    121: ['80000000000000000000000000000055780000000000000000000000000000000000000000', 17],
}

/** The courses the app can be told to run: every controllable id. */
const COURSE_IDS = [1, 3, 5, 6, 7, 8, 11, 12, 15, 17, 18, 19, 20, 28, 30, 31, 32, 33, 36]
const COURSE_OPTIONS = [...COURSE_IDS, 10].map((id) => COURSE.map(id)).filter((name) => name !== undefined)
const SMART_IDS = [
    61, 62, 66, 67, 68, 69, 71, 73, 75, 76, 78, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 112, 113, 114, 120, 121,
]
const SMART_OPTIONS = SMART_IDS.map((id) => SMART_COURSE.map(id)).filter((name) => name !== undefined)

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)

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
        /** A reading taken from one of the tables above. */
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
        const hours = (id: string, name: string, extra: object = {}) => ({
            platform: 'number',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            min: 0,
            max: RESERVE_MAX,
            step: 1,
            unit_of_measurement: 'h',
            ...extra,
        })

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Styler' }),
                components: {
                    // Read-only plus a Power off button, like the dryers and washers: the
                    // appliance cannot be powered on remotely (see the header).
                    power: flag('power', 'Power', { icon: 'mdi:power' }),
                    power_off: press('power_off', 'Power off', 'mdi:power'),
                    status: reading('status', 'Status', STATE, { icon: 'mdi:hanger' }),
                    course: reading('course', 'Course', COURSE, { icon: 'mdi:playlist-check' }),
                    // Choosing a course does not start it — LG's own app works the same way.
                    course_select: choice('course_select', 'Course select', COURSE_OPTIONS, {
                        icon: 'mdi:playlist-edit',
                    }),
                    smart_course: reading('smart_course', 'Smart course', SMART_COURSE, {
                        icon: 'mdi:playlist-star',
                    }),
                    smart_course_select: choice('smart_course_select', 'Smart course select', SMART_OPTIONS, {
                        icon: 'mdi:playlist-edit',
                    }),
                    start_course: press('start_course', 'Start course', 'mdi:play-circle-outline'),
                    pause_course: press('pause_course', 'Pause', 'mdi:pause-circle-outline'),
                    resume_course: press('resume_course', 'Resume', 'mdi:play-pause'),
                    remaining_time: minutes('remaining_time', 'Remaining time', { icon: 'mdi:timer-sand' }),
                    initial_time: minutes('initial_time', 'Initial time', { icon: 'mdi:timer-outline' }),
                    // Start modifiers, consumed by Start course: 0 starts now,
                    // otherwise the course begins after this many hours.
                    // LG declares 3..19; the captures ran 3 and 19.
                    reserve_hours: hours('reserve_hours', 'Reserve hours', {
                        icon: 'mdi:calendar-clock',
                        entity_category: 'config',
                    }),
                    store: toggle('store', 'Store', {
                        icon: 'mdi:weather-night',
                        entity_category: 'config',
                    }),
                    // LG declares Reserve_Time_H as a delay before the course
                    // starts, not a wall-clock time; 0 means no reservation.
                    reserve_time: minutes('reserve_time', 'Reserve time', { icon: 'mdi:calendar-clock' }),
                    // The appliance takes no command for this: the app cannot
                    // switch remote start on or off, it only reports it.
                    remote_start: flag('remote_start', 'Remote start', {
                        icon: 'mdi:cellphone-check',
                    }),
                    // Panel-only feature: the physical button toggles it, LG's
                    // app has no control for it, so it is read-only here too.
                    child_lock: flag('child_lock', 'Child lock', { icon: 'mdi:lock' }),
                    // The appliance will not start a course while an error
                    // stands, so it gets a problem sensor of its own rather
                    // than hiding inside a text reading nobody has an
                    // automation on.
                    error: flag('error', 'Error', {
                        device_class: 'problem',
                        icon: 'mdi:check-circle',
                        entity_category: 'diagnostic',
                    }),
                    error_message: reading('error_message', 'Error message', ERROR, {
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    }),
                    download_course: reading('download_course', 'Downloaded course', SMART_COURSE, {
                        icon: 'mdi:download',
                        entity_category: 'diagnostic',
                    }),
                    previous_status: reading('previous_status', 'Previous state', STATE, {
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    }),
                    // This-cycle cumulative energy (Wh, x1) at record+17/+18.
                    // Validated 2026-09-11: a full steam cycle reported 0 in
                    // this field until completion, then 0x0251 = 593Wh,
                    // matching the ThinQ app's daily 593Wh exactly.
                    energy: sensor('energy', 'Energy', {
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                        suggested_display_precision: 0,
                        icon: 'mdi:lightning-bolt',
                    }),
                },
            }),
        )

        this.publishProperty('reserve_hours', 0)
        this.publishProperty('store', 'OFF')
        this.publishProperty('course_select', COURSE.map(this.selectedCourse))
    }

    // AABBDevice strips the leading AA/len and trailing checksum/BB, so buf
    // here starts at the 0x31 tag: `<31> <seq> | [<len16 BE> <record>]…`.
    processAABB(buf: Buffer) {
        if (buf[0] !== STATE_TAG) return
        const body = buf.subarray(2)
        // Every chunk must be a whole 27-byte record; anything else (ACKs,
        // the 9-byte notifications, the course-name list) is not state.
        if (body.length === 0 || body.length % (2 + RECORD_LEN) !== 0) return
        for (let i = 0; i < body.length; i += 2 + RECORD_LEN) {
            if (body.readUInt16BE(i) !== RECORD_LEN) return
        }

        // The trailing record is the current state; a leading one, when
        // present, is the previous state.
        const record = body.subarray(body.length - RECORD_LEN)
        const at = (o: number) => record[o]
        const flagsA = at(OFF.flagsA)

        const state = at(OFF.state)
        this.poweredOn = state !== STATE_POWEROFF
        this.hasProblem = !ERROR_CLEAR.has(at(OFF.error))
        const published = STATE.map(state)
        this.publishProperty('status', published)
        this.publishProperty('power', this.poweredOn ? 'ON' : 'OFF')
        this.publishProperty('previous_status', STATE.map(at(OFF.preState)))
        this.publishProperty('error_message', ERROR.map(at(OFF.error)))
        this.publishProperty('error', this.hasProblem ? 'ON' : 'OFF')
        this.publishProperty('course', COURSE.map(at(OFF.course)))
        this.publishProperty('smart_course', SMART_COURSE.map(at(OFF.smartCourse)))
        this.publishProperty('download_course', SMART_COURSE.map(at(OFF.downloadCourse1)))

        // The installed download is what Start course runs when "Downloaded Course" is chosen,
        // so Smart course select follows it, whoever downloaded it (this driver or the LG app).
        const installed = at(OFF.downloadCourse1)
        if (SMART_IDS.includes(installed)) {
            this.selectedSmart = installed
            this.publishProperty('smart_course_select', SMART_COURSE.map(installed))
        }

        // Track whatever the appliance is actually running, so Course select opens on the right
        // choice. A running smart course shows the "Downloaded Course" placeholder, which is what
        // routes Start course to it.
        const smart = at(OFF.smartCourse)
        if (SMART_IDS.includes(smart)) {
            this.selectedBase = SMART_PARAMS[smart][1]
            this.smartSelected = true
            this.publishProperty('course_select', COURSE.map(10))
        } else if (COURSE_IDS.includes(at(OFF.course))) {
            this.selectedCourse = at(OFF.course)
            this.selectedBase = this.selectedCourse
            this.smartSelected = false
            this.publishProperty('course_select', COURSE.map(this.selectedCourse))
        }

        // The appliance holds remaining at 1 minute through completion and
        // power-off (captured 2026-09-11: state Complete and Power off both
        // report 0h01m) while the cycle is actually done, so report 0 once
        // nothing can remain. Running states keep the wire value as-is.
        const finished = state === STATE_POWEROFF || published === 'Course complete'
        this.publishProperty('remaining_time', finished ? 0 : at(OFF.remainTimeHour) * 60 + at(OFF.remainTimeMinute))
        this.publishProperty('initial_time', at(OFF.initialTimeHour) * 60 + at(OFF.initialTimeMinute))
        this.publishProperty('reserve_time', at(OFF.reserveTimeHour) * 60 + at(OFF.reserveTimeMinute))

        this.publishProperty('remote_start', (flagsA & F_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (flagsA & F_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('energy', (at(OFF.energyHigh) << 8) | at(OFF.energyLow))
    }

    /** What Start course will run. `smartSelected` says which select won last. */
    private selectedCourse = COURSE_IDS[0]
    private selectedSmart = SMART_IDS[0]
    private smartSelected = false
    /** Base id of the last start (smart runs resume under their base id). */
    private selectedBase = COURSE_IDS[0]
    private reserveHours = 0
    private store = false
    /** Last state the appliance itself reported. `undefined` means no state frame has arrived. */
    private poweredOn: boolean | undefined
    private hasProblem: boolean | undefined

    /** `<id> 01 <smart> <04|02> 00 00 <reserve> 00 00` + entry params. */
    private courseBlock(id: number, smart: number): Buffer {
        const params = smart !== 0 ? SMART_PARAMS[smart]?.[0] : COURSE_PARAMS[id]
        if (params === undefined) return Buffer.alloc(0)
        const head = [id, 0x01, smart, 0x04 | (this.store ? 0x02 : 0), 0x00, 0x00, this.reserveHours, 0x00, 0x00]
        return Buffer.concat([Buffer.from(head), Buffer.from(params, 'hex')])
    }

    /** `aa 34 f0 26 | <course block> | ck bb`. */
    private runCourse(id: number, smart: number) {
        const block = this.courseBlock(id, smart)
        if (block.length === 0) return this.log(`Course cannot start ${smart !== 0 ? smart : id}`)
        this.send(Buffer.concat([Buffer.from(RUN_COURSE), block]))
    }

    /** Smart starts go out as the download + start pair, exactly as the app sends them. */
    private runSmartCourse(smart: number) {
        if (this.downloadSmartCourse(smart)) {
            const entry = SMART_PARAMS[smart]
            this.runCourse(entry![1], smart)
        }
    }

    /**
     * Send only the download half for a smart course, without starting it.
     * Selecting a smart course downloads it to the appliance straight away —
     * the same select-then-start split the washer uses — so the appliance
     * (and its next state frame) reflects the choice before Start course.
     * Returns false when the course has no captured download.
     */
    private downloadSmartCourse(smart: number): boolean {
        const entry = SMART_PARAMS[smart]
        if (entry === undefined) {
            this.log(`Course cannot start ${smart}`)
            return false
        }
        const block = this.courseBlock(entry[1], smart)
        if (block.length === 0) {
            this.log(`Course cannot start ${smart}`)
            return false
        }
        const zeroHead = Buffer.from(block.subarray(0, HEAD_LEN))
        zeroHead[3] = 0x00
        zeroHead[6] = 0x00
        this.send(
            Buffer.concat([
                Buffer.from(DOWNLOAD_COURSE),
                Buffer.from(DOWNLOAD_PREFIX),
                zeroHead,
                block.subarray(HEAD_LEN),
            ]),
        )
        return true
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
     * The base class's `send` supplies the AA/length prefix and the checksum,
     * so what goes in is `f0 24` plus the body — which reproduces the captured
     * frames byte for byte.
     */
    private setControl(type: number, ...values: number[]) {
        this.send(Buffer.from([...SET_STATE, type, values.length, ...values]))
    }

    /*
     * Publish what was just asked for, without waiting for the appliance to
     * say it. A course start can go a while without a confirming state frame,
     * so waiting makes every control feel broken and invites a second press.
     * The next real frame overwrites whatever is published here, so the
     * appliance still has the last word. Known refusals are not echoed: the
     * appliance takes nothing while powered off, and no course while an error
     * stands.
     */
    private echo(prop: string, value: string | number | undefined) {
        if (this.poweredOn !== true) return
        if ((prop === 'course' || prop === 'smart_course') && this.hasProblem !== false) return
        this.publishProperty(prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power_off':
                // This unit keeps sending state frames while off, so the next one confirms it.
                return this.setControl(CTRL_POWER, 0)
            case 'course_select': {
                const id = COURSE.unmap(mqttValue)
                if (id === undefined) return this.log(`Unknown course ${mqttValue}`)
                if (id === 10) {
                    // "Downloaded Course": id 10 never runs on its own — selecting it
                    // and pressing Start course runs whatever Smart course select is
                    // currently set to, the same relationship the panel itself uses.
                    this.smartSelected = true
                    return this.publishProperty('course_select', mqttValue)
                }
                if (!COURSE_IDS.includes(id)) return this.log(`Unknown course ${mqttValue}`)
                this.selectedCourse = id
                this.selectedBase = id
                this.smartSelected = false
                // Nothing goes to the appliance until Start course — this is a choice, not a command.
                return this.publishProperty('course_select', mqttValue)
            }
            case 'smart_course_select': {
                const id = SMART_COURSE.unmap(mqttValue)
                if (id === undefined || !SMART_IDS.includes(id)) return this.log(`Unknown smart course ${mqttValue}`)
                this.selectedSmart = id
                this.smartSelected = true
                // Download straight away, as LG's app does on selection; the next state frame
                // confirms it in the download slot (byte 24).
                this.downloadSmartCourse(id)
                this.publishProperty('smart_course_select', mqttValue)
                return this.publishProperty('course_select', COURSE.map(10))
            }
            case 'reserve_hours': {
                const hours = Number(mqttValue)
                // LG declares reservation as 0 (start now) or 3..19 hours; 1
                // and 2 are outside the model's own range and have never
                // been captured.
                if (!Number.isInteger(hours) || (hours !== 0 && (hours < 3 || hours > RESERVE_MAX)))
                    return this.log(`Reserve hours out of range ${mqttValue}`)
                this.reserveHours = hours
                return this.publishProperty('reserve_hours', hours)
            }
            case 'store':
                this.store = mqttValue === 'ON'
                return this.publishProperty('store', mqttValue === 'ON' ? 'ON' : 'OFF')
            case 'start_course':
                if (this.smartSelected) {
                    const entry = SMART_PARAMS[this.selectedSmart]
                    this.selectedBase = entry?.[1] ?? this.selectedBase
                    this.runSmartCourse(this.selectedSmart)
                    return this.echo('smart_course', SMART_COURSE.map(this.selectedSmart))
                }
                this.runCourse(this.selectedCourse, 0)
                // The course itself, so the dashboard shows what was asked for straight away.
                return this.echo('course', COURSE.map(this.selectedCourse))
            case 'pause_course':
                return this.setControl(CTRL_PAUSE, 0)
            case 'resume_course':
                return this.resumeCourse(this.selectedBase)
            default:
                this.log(`Item does not support writing ${prop}`)
        }
    }
}
