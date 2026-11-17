import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import { RINSES } from './washer_common'

// LG WHX9016TLC (2026 heat-pump washer-dryer, UK, 11/6 kg). Wi-Fi module RTK_RTL8720cm_SPI_OSP, appInfo
// protocolVer 7, deviceType 201. Its modelJSON (version 0.7, "uniProtocol") names the fields and their
// codes but gives no offsets.
//
// The state comes in the 0x20 envelope, like G2V7_Y___W.B_2QEUK: a 0xeb record answers the status request
// and every change is pushed as a 0xec pair. The 71-byte record is G2V7's 67-byte one with four more bytes:
// every offset read here sits where that model has it, except the dry level, which G2V7 does not have.
// The door is not in the record: it comes as an event frame (see DOOR_EVENT).
//
// Read off one unit, November 2026: a pass along the programme dial and through every timed dry level,
// each option set and cleared at the panel, and whole cycles, with the defaults checked against the
// modelJSON's. Its commands are not G2V7's (see setProperty).

const STATUS_LENGTH = 71
const E6_RESULT_OFFSET = 8

// The programme list as the panel sends it (a 0x4d frame), in dial order from TurboWash 39. Names as the
// manual (MFL05825508) prints them. Each code's defaults match its modelJSON course; Cotton Dry and Easy
// Care Dry share theirs, as do Duvet and Bed Sheets, so those three were named off the panel's display.
const COURSES = Enum.of({
    'TurboWash 39': 0x7a,
    'Mixed Fabric': 0x2b,
    'Timed Dry': 0x53,
    'AI Wash+Dry': 0xa6,
    'Quick Tub Rinse': 0x86,
    'Cotton Dry': 0xab,
    'Easy Care Dry': 0xac,
    'Quick 14': 0x4b,
    'AI Wash': 0x72,
    Cotton: 0x2e,
    'Eco 40-60': 0x13,
    'Easy Care': 0x1d,
    'Hand/Wool': 0x5e,
    'Wool Dry': 0xad,
    'Tub Clean': 0x55,
    'Rinse+Spin': 0x37,
    'Spin Only': 0x4e,
    Towels: 0x54,
    'Bed Sheets': 0x81,
})

// Codes as in the modelJSON (temp, spin, dryLevel). Drying-only programmes read no temperature.
// What a programme leaves out reads Off rather than None, which HA would take for unknown.
const TEMPERATURES = Enum.of({
    Off: 0,
    Cold: 8,
    '20 °C': 1,
    '30 °C': 2,
    '40 °C': 3,
    '60 °C': 5,
    '95 °C': 6,
})

// The modelJSON's codes, labelled as VCDWL2QEUK labels the same byte. Each read back as set at the panel.
const SOIL_LEVELS = Enum.of({
    Off: 0,
    Light: 1,
    Medium: 3,
    Heavy: 5,
})

const SPINS = Enum.of({
    'No spin': 0,
    'Drain only': 12,
    '400 rpm': 1,
    '600 rpm': 2,
    '800 rpm': 4,
    '1000 rpm': 6,
    '1200 rpm': 8,
    '1400 rpm': 9,
})

// The timed levels read back as set on the panel, one by one; Cupboard is the drying programmes' default
// (DRYLEVEL_NORMAL). Cupboard+ is the manual's "energy dry" level.
const DRY_LEVELS = Enum.of({
    Off: 0,
    Low: 1,
    Iron: 2,
    Cupboard: 3,
    'Extra dry': 4,
    Eco: 7,
    'Cupboard+': 16,
    '20 min': 19,
    '30 min': 11,
    '40 min': 20,
    '50 min': 23,
    '60 min': 12,
    '80 min': 24,
    '90 min': 13,
    '100 min': 25,
    '120 min': 14,
    '150 min': 15,
    '180 min': 21,
})

// The modelJSON's state table, and 52, which it does not list. Seen on this unit: Off, Standby, Starting,
// Paused, Delayed, Detecting, Washing, Rinsing, Spinning, Drying, Cooling and End.
const STATES = Enum.of({
    Off: 0,
    Standby: 1,
    // PRODUCT_STANDBY, for the half minute between Start and the wash.
    Starting: 63,
    Paused: [2, 35, 61],
    Detecting: [3, 6, 37, 40],
    Draining: 5,
    Delayed: 7,
    Soaking: 8,
    'Pre-wash': 9,
    Washing: 11,
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    End: [16, 42, 49, 60],
    Refreshing: [19, 21],
    Error: 23,
    'Freeze protection': [27, 28, 29],
    'Smart diagnosis': 34,
    'Waiting to start': 36,
    Dispensing: [38, 39],
    'Tub cleaning': 41,
    Steam: 43,
    'Laundry care': 47,
    'Dispenser cleaning': 48,
    'Wrinkle care': 57,
    // 52 is not in the modelJSON: the last five minutes of a Timed Dry, between Drying and End, with the
    // energy count all but stopped.
    Cooling: [52, 62],
})

// Bits as on G2V7, each set and cleared at the panel: the child lock (CL on the display) and Remote Start,
// which a wash started at the panel sets too.
const FLAGS_BYTE = 37
const FLAG_CHILD_LOCK = 0x20
const FLAG_REMOTE_START = 0x10

const OPTIONS_BYTE = 34
// Set at TurboWash 39 and Quick 14, the two programmes that have it by default.
const OPT_TURBOWASH = 0x20
const OPT_PREWASH = 0x40 // as on G2V7, set and cleared at the panel
// Two more option bytes, each set and cleared at the panel. On Cotton, Steam also raised the temperature to
// 60 °C, and Wrinkle care added half an hour to the programme.
const STEAM_BYTE = 35
const OPT_STEAM = 0x10
const WRINKLE_CARE_BYTE = 36
const OPT_WRINKLE_CARE = 0x20

// Event frames: 20 0a <envelope> 03 00 <len> <event> 0e 06 02 <event> <value> ... Event 0x10 is the door:
// 01 when it opened and 02 when it shut, the panel's door test. (0x11 comes at power-on, 0x0d at power-off
// and 0x1e as the programme changes.)
const EVENT_FRAME_TYPE = 0x03
const EVENT_TYPE_OFFSET = 10
const EVENT_ID_OFFSET = 13
const EVENT_VALUE_OFFSET = 18
const DOOR_EVENT = 0x10
const DOOR_OPEN = 0x01
const DOOR_CLOSED = 0x02

// The door is locked shut through these, but its events only come when it moves: a wash started before
// rethink was would leave it unknown until the end.
const DOOR_LOCKED_STATES = new Set([3, 5, 6, 8, 9, 11, 12, 14, 15, 19, 21, 37, 38, 39, 40, 41, 43, 52])

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Unacked, the appliance repeats each frame every second or so.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer Dryer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        // as on WTL_FXU_BDV_NA_01; it hides the 6 to 7 s the appliance takes to report itself on
                        optimistic: true,
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer-water',
                        device_class: 'enum',
                        options: TEMPERATURES.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        device_class: 'enum',
                        options: SPINS.options,
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL_LEVELS.options,
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water-sync',
                        device_class: 'enum',
                        options: RINSES.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
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
                    delay_end: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_end',
                        state_topic: '$this/delay_end',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay end',
                        icon: 'mdi:timer-sand',
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
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    turbowash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
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
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // no state_class: it goes back to zero at each drum clean
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // G2V7's status request.
    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // 20 00 <command> <result>: the appliance's answer to a command, 00 taken and, as on G2V7, ff refused.
        // The F0 A1 power-on is answered 20 00 a1 00.
        if (buf.length === 4 && buf[0] === 0x20 && buf[1] === 0x00 && buf[3] !== 0x00) {
            this.log('command refused', buf.toString('hex'))
            return
        }
        // 20 e6 <the six bytes after F0 E5> <result> <status record>: the answer to the F0 E5 commands. 00 is the
        // usual result; 15 came on a power-off that went through and on a command that did not, so what it means
        // is not known. The record is not published: the status pushes that follow carry the change.
        if (buf.length === E6_RESULT_OFFSET + 1 + STATUS_LENGTH && buf[0] === 0x20 && buf[1] === 0xe6) {
            if (buf[E6_RESULT_OFFSET] !== 0x00) {
                this.log('command answered', buf.subarray(0, E6_RESULT_OFFSET + 1).toString('hex'))
            }
            return
        }
        if (this.processEnvelopedStatus(buf, 0x20, STATUS_LENGTH, this.processStatus)) return
        this.processEvent(buf)
    }

    processEvent(buf: Buffer) {
        if (buf.length <= EVENT_VALUE_OFFSET || buf[0] !== 0x20 || buf[1] !== 0x0a) return
        if (buf[EVENT_TYPE_OFFSET] !== EVENT_FRAME_TYPE || buf[EVENT_ID_OFFSET] !== DOOR_EVENT) return

        const door = buf[EVENT_VALUE_OFFSET]
        if (door === DOOR_OPEN) this.publishProperty('door', 'ON')
        else if (door === DOOR_CLOSED) this.publishProperty('door', 'OFF')
        else this.log('undecoded door event', buf.toString('hex'))
    }

    processStatus(s: Buffer) {
        const state = s[21]
        const on = state !== STATES.inverse.Off

        if (STATES.map(state) === undefined) this.log('undecoded state', state)
        this.publishProperty('power', on ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(state))
        if (DOOR_LOCKED_STATES.has(state)) this.publishProperty('door', 'OFF')

        // Powering off zeroes the settings but leaves the course and the times, which the panel no longer
        // shows: as on G2V7, nothing is published for them while the machine is off. s[20] repeats the
        // course, s[22] holds the previous state.
        const course = s[5]
        if (on && COURSES.map(course) === undefined) this.log('undecoded course', course.toString(16))
        this.publishProperty('course', on ? COURSES.map(course) : undefined)
        this.publishProperty('temp', on ? TEMPERATURES.map(s[2]) : undefined)
        this.publishProperty('spin', on ? SPINS.map(s[4]) : undefined)
        // The rinse option's number, where VCDWL2QEUK has it (its rec[26]). s[3] carries the modelJSON's code for
        // the same option; while a setting changes the two can differ for one record.
        this.publishProperty('soil', on ? SOIL_LEVELS.map(s[1]) : undefined)
        this.publishProperty('rinse', on ? RINSES.map(s[27]) : undefined)
        this.publishProperty('dry_level', on ? DRY_LEVELS.map(s[6]) : undefined)
        // Minutes, big-endian: the drying programmes run past 255 (AI Wash+Dry reads 316 at Ready). The first
        // record after power-on reads both as 0 until the programme's own record follows a second later, so a
        // record without an initial time is skipped while on.
        const initialTime = s.readUInt16BE(15)
        if (!on || initialTime !== 0) {
            this.publishProperty('remaining_time', on ? s.readUInt16BE(13) : undefined)
            this.publishProperty('initial_time', on ? initialTime : undefined)
        }
        // As on G2V7: minutes to the end of the programme, with s[39] 0x80. A Delay End of 3 h reads 180 as
        // soon as it is set, and clears when the wash begins.
        this.publishProperty('delay_end', on ? s.readUInt16BE(11) : undefined)

        const options = s[OPTIONS_BYTE]
        this.publishProperty('turbowash', on ? (options & OPT_TURBOWASH ? 'ON' : 'OFF') : undefined)
        this.publishProperty('prewash', on ? (options & OPT_PREWASH ? 'ON' : 'OFF') : undefined)
        this.publishProperty('steam', on ? (s[STEAM_BYTE] & OPT_STEAM ? 'ON' : 'OFF') : undefined)
        this.publishProperty('wrinkle_care', on ? (s[WRINKLE_CARE_BYTE] & OPT_WRINKLE_CARE ? 'ON' : 'OFF') : undefined)
        this.publishProperty('child_lock', s[FLAGS_BYTE] & FLAG_CHILD_LOCK ? 'OFF' : 'ON') // device_class: lock is inverted
        this.publishProperty('remote_start', s[FLAGS_BYTE] & FLAG_REMOTE_START ? 'ON' : 'OFF')

        // Wh, as on G2V7: restarts at power-on, holds the last cycle's total while off.
        this.publishProperty('energy', s.readUInt16BE(17))
        // 31 on this unit; as on G2V7 it is only taken from a machine that is on. The first record after
        // power-on reads it as 0, with both times, until the programme's own record follows a few seconds
        // later; a record without a programme time is skipped, so HA does not see it drop to 0 and back.
        if (on && s.readUInt16BE(15) !== 0) this.publishProperty('tub_clean_count', s[28])
    }

    // The ThinQ app's commands, captured through the bridge and each tried from here. G2V7's F0 24 commands
    // go unanswered, and its F0 2A power-on only wakes the appliance's link (20 e9 0a) without switching it
    // on. Start and Pause were tried with Remote Start on. Start also resumes a paused programme, so the app's
    // separate resume command (... 01 03 03) is not needed.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') this.send(Buffer.from('F0A10100', 'hex'))
            else if (mqttValue === 'OFF') this.send(Buffer.from('F0E5000201FF010200', 'hex'))
        }
        if (prop === 'start') this.send(Buffer.from('F0E5000201FF010301', 'hex'))
        if (prop === 'pause') this.send(Buffer.from('F0E5000201FF010302', 'hex'))
    }
}
