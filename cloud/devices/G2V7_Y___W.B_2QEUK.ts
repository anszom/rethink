import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG F2NX50S9TKC (2025 slim front-loader, EU). The F2X50S9THB of #85 reports the same model id. Wi-Fi
// module RTK_RTL8720cm, appInfo protocolVer 7.
//
// The appliance wraps its state in the 0x20 envelope (AABBDevice.processEnvelopedStatus): a single
// 0xeb record answers the status request, and every later change - a knob turn, the door, each minute
// of the countdown - is pushed unprompted as a 0xec pair. So, as with Y_V8_Y___W.B32QEUK, the status
// is requested once on connect and never polled.
//
// The 67-byte record is VCDWL2QEUK's status record B with one extra byte in front: every field below
// sits at that model's offset + 1, and the codes that both models offer agree. The offsets were each
// confirmed on this unit, one panel setting at a time, and across a month of real washes.

const STATUS_LENGTH = 67

// Course codes read off the dial one position at a time. Names as the manual (MFL72111252) prints
// them. 0xff is the Download Cycle slot, which runs Rinse + Spin until another course is downloaded.
const COURSES = Enum.of({
    Cotton: 0x2e,
    'Eco 40-60': 0x13,
    'Mixed Fabric': 0x2b,
    'Easy Care': 0x1d,
    'Hand/Wool': 0x5e,
    Activewear: 0x4f,
    'AI Wash': 0x72,
    'TurboWash 39': 0x7a,
    'Quick 14': 0x4b,
    'Allergy Care': 0x04,
    'Microplastic Care': 0x88,
    'Download Cycle': 0xff,
})

// The temperature and spin indices are those of VCDWL2QEUK, which publishes them through the shared
// tables shifted by one; the labels here are the shared ones. 50 °C is not offered on this model.
// Cold reads 8 where VCDWL2QEUK has 0, with the panel parked on Co.
const TEMPERATURES = Enum.of({
    Cold: 8,
    '20 °C': 1,
    '30 °C': 2,
    '40 °C': 3,
    '60 °C': 5,
    '95 °C': 6,
})

// Each read back as a course's default (Quick 14 400, Hand/Wool 800, Mixed Fabric 1000, Cotton 1200)
// or with the panel set to it. 1200 is this model's top speed. No spin (the panel's 0, drain only)
// reads 0x0c where VCDWL2QEUK has 0 - like Cold, the zero setting sits past the top of the scale.
const SPINS = Enum.of({
    'No spin': 0x0c,
    '400 rpm': 1,
    '800 rpm': 4,
    '1000 rpm': 6,
    '1200 rpm': 8,
})

const STATES = Enum.of({
    Off: 0x00,
    Standby: 0x01,
    Paused: 0x02,
    Detecting: 0x03,
    Delayed: 0x07,
    Washing: 0x0b,
    Rinsing: 0x0c,
    Spinning: 0x0e,
    End: 0x10,
})

const FLAGS_BYTE = 37
// Cleared the moment the door opens and set again when it shuts, with nothing else in the record
// moving. The neighbouring 0x40 is the drum light, which comes on with the door and goes out by itself
// about 45 s after it closes; it is not published.
const FLAG_DOOR_CLOSED = 0x01
// Set and cleared by holding Timer for 3 s (CL on the display), mid-wash, with nothing else moving.
// VCDWL2QEUK has it at the same place.
const FLAG_CHILD_LOCK = 0x20
// Remote Start on the panel sets and clears it, idle or mid-wash, and the appliance echoes each change
// in a 20 72 frame (00 c9 on, 00 c8 off). Starting a wash at the panel sets it too, so a wash started
// by hand can be paused from here unless Remote Start is switched off on the panel.
const FLAG_REMOTE_START = 0x10

// The option buttons, each pressed on and off with nothing else selected (Cotton at its defaults).
// Pre Wash and TurboWash sit where VCDWL2QEUK has them.
const OPTIONS_BYTE = 34
const OPT_INTENSIVE = 0x08 // also raises s[1], the soil level, from 3 to 0x0a
const OPT_TURBOWASH = 0x20 // also on by default for TurboWash 39 and Quick 14
const OPT_PREWASH = 0x40
const FLAGS2_BYTE = 39
const FLAG2_RINSE_PLUS = 0x40 // also steps s[3] from 0x0e to 0x0f
// s[39] 0x80 is set with a Delay End; 0x20 is set at power-on until a course is chosen.

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Unacked, the appliance repeats its own reports (the 0x03 records) up to twenty times each.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
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
                    delay_end: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_end',
                        state_topic: '$this/delay_end',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay end',
                        icon: 'mdi:timer-sand',
                    },
                    rinse_plus: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_plus',
                        state_topic: '$this/rinse_plus',
                        name: 'Rinse+',
                        icon: 'mdi:water-plus',
                    },
                    intensive: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-intensive',
                        state_topic: '$this/intensive',
                        name: 'Intensive',
                        icon: 'mdi:washing-machine',
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

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // 20 00 <command> <result>: the appliance's answer to a command, 00 taken and ff refused.
        if (buf.length === 4 && buf[0] === 0x20 && buf[1] === 0x00 && buf[3] !== 0x00) {
            this.log('command refused', buf.toString('hex'))
            return
        }
        this.processEnvelopedStatus(buf, 0x20, STATUS_LENGTH, this.processStatus)
    }

    processStatus(s: Buffer) {
        const state = s[21]
        const on = state !== STATES.inverse.Off

        this.publishProperty('power', on ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(state))

        // Powering off zeroes the temperature and spin but leaves the course and both times at their
        // last values, which the panel no longer shows. So no settings are published while the machine
        // is off, as its own display does.
        // s[20] repeats the course.
        const course = s[5]
        if (on && COURSES.map(course) === undefined) this.log('undecoded course', course.toString(16))
        this.publishProperty('course', on ? COURSES.map(course) : undefined)
        this.publishProperty('temp', on ? TEMPERATURES.map(s[2]) : undefined)
        this.publishProperty('spin', on ? SPINS.map(s[4]) : undefined)
        // Minutes. At Ready these are LG's estimate for the selected settings, recalculated once the
        // load has been weighed; s[14] then counts down.
        this.publishProperty('initial_time', on ? s[16] : undefined)
        this.publishProperty('remaining_time', on ? s[14] : undefined)
        // Minutes, as LG counts a Delay End: to the end of the programme, not to its start. 3 h read 180,
        // 5 h read 0x012c; it counts down once the delayed wash has been started.
        this.publishProperty('delay_end', on ? s.readUInt16BE(11) : undefined)
        const options = s[OPTIONS_BYTE]
        this.publishProperty('rinse_plus', on ? (s[FLAGS2_BYTE] & FLAG2_RINSE_PLUS ? 'ON' : 'OFF') : undefined)
        this.publishProperty('intensive', on ? (options & OPT_INTENSIVE ? 'ON' : 'OFF') : undefined)
        this.publishProperty('prewash', on ? (options & OPT_PREWASH ? 'ON' : 'OFF') : undefined)
        this.publishProperty('turbowash', on ? (options & OPT_TURBOWASH ? 'ON' : 'OFF') : undefined)

        // Wh, big-endian. It restarts from zero at power-on and holds the last cycle's total while off.
        // Confirmed on the scale as well as the shape: it climbs ~30 Wh a minute while the water heats
        // (a ~1.8 kW element) and 1-2 Wh a minute otherwise, and the high byte steps as the low wraps.
        this.publishProperty('energy', s[17] * 256 + s[18])
        this.publishProperty('door', s[FLAGS_BYTE] & FLAG_DOOR_CLOSED ? 'OFF' : 'ON')
        this.publishProperty('child_lock', s[FLAGS_BYTE] & FLAG_CHILD_LOCK ? 'OFF' : 'ON') // device_class: lock is inverted
        this.publishProperty('remote_start', s[FLAGS_BYTE] & FLAG_REMOTE_START ? 'ON' : 'OFF')
        // Steps by one at the End of every wash and holds across power-offs - except a power cut, after
        // which it reads 0 until the machine is next switched on. So it is only taken from a machine
        // that is on, and HA keeps the last value in between.
        if (on) this.publishProperty('tub_clean_count', s[28])
    }

    // The F0 24 / F0 2A commands of Y_V8_Y___W.B32QEUK, each tried on the washer. Power on and off work
    // from idle. Start runs whatever the panel is set to, and only while Remote Start is on: without it
    // the appliance refuses (20 00 24 ff), as the manual says, and that interlock is left to it. Pause
    // also needs Remote Start; without it the appliance acks the command (20 00 24 00) and carries on.
    // A wash paused from here cannot be resumed from here - Start is refused until it is resumed on
    // the panel.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') this.send(Buffer.from('F02A0100', 'hex'))
            else if (mqttValue === 'OFF') this.send(Buffer.from('F024010100', 'hex'))
        }
        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        if (prop === 'start') this.send(Buffer.from('F024050100', 'hex'))
    }
}
