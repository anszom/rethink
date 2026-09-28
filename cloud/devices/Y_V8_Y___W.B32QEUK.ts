import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES, TEMPERATURES, SPINS, RINSES, EXTRA_RINSE_CODES, SMART_COURSES } from './washer_common'
import { Enum } from '@/util/enum'

// The thirteen dial positions of an FSR7A04PG, each confirmed by turning the dial through every
// position and reading the code it reported; the names are LG's own, from modelJson for this model.
//
// This deliberately does not use washer_common's COURSES. That table is shared across washer models
// and disagrees here: it reads 0x3a as "Bedding", where on this machine 0x3a is AI Wash - which the
// dial sweep gives by elimination, and which upstream's own wiki confirms independently, its
// "start ai wash" command being F0 26 3A ... Sharing the table would mean one model's labels
// silently mislabelling another's.
//
// Courses outside this list do occur: a downloaded course whose base is not a dial position - Rinse
// + Spin, Spin, Drain, Silent Wash, Microplastic Care, Quick Tub Clean - reports that base here.
// Those codes have not been observed yet and fall through to the raw-code fallback, which is what
// makes them identifiable when they do.
const COURSES = Enum.of({
    // LG's enums all define 0 as nothing selected, which is what the appliance reports when it is
    // idle. Naming it keeps the select entities in a state Home Assistant will accept, and sending
    // it back is a legitimate "use this course's default".
    'Not selected': 0,
    'AI Wash': 0x3a,
    Cotton: 0x01,
    'Easy Care': 0x02,
    'Eco 40-60': 0x04,
    Duvet: 0x05,
    Mix: 0x07,
    'Sports Wear': 0x08,
    'Speed 14': 0x0c,
    'Tub Clean': 0x12,
    Wool: 0x1b,
    Delicate: 0x20,
    'Allergy SpaSteam': 0x2d,
    'Turbo Wash 39': 0x31,

    // Not dial positions. These are the base courses of downloadable programmes that have no dial
    // equivalent, and the course field reports them whenever such a programme is selected. Each was
    // identified from the downloadable course sitting on it; the old shared table names the first
    // two the same way, which corroborates them.
    'Rinse + Spin': 0x0e,
    'Spin only': 0x17, // old table: Spin + Drain. Both the Drain and Spin courses sit on it.
    'Silent Wash': 0x09,
    'Quick Tub Clean': 0x30,
    'MicroPlastic Care': 0x3b,
})

// Writable settings. Labels rather than bare numbers so HA's option lists read properly, and
// because Enum.of hands ordering to JavaScript's key order, which puts integer-like keys first.
const SET_SPINS = Enum.of({
    'Not selected': 0,
    'No spin': 1,
    '400 rpm': 2,
    '600 rpm': 3,
    '700 rpm': 4,
    '800 rpm': 5,
    '900 rpm': 6,
    '1000 rpm': 7,
    '1100 rpm': 8,
    '1200 rpm': 9,
    '1400 rpm': 10,
    '1600 rpm': 11,
    // The appliance resolves Max to the selected course's own maximum - a start sent with 0xff for
    // Allergy SpaSteam came back reported as 1400.
    Max: 255,
})

const SET_TEMPS = Enum.of({
    'Not selected': 0,
    Cold: 1,
    '20 °C': 2,
    '30 °C': 3,
    '40 °C': 4,
    '50 °C': 5,
    '60 °C': 6,
    '95 °C': 7,
})

const SET_SOIL_WASH = Enum.of({ 'Not selected': 0, TurboWash: 1, 'Time save': 2, Normal: 3, Intensive: 4 })

// Bit positions in the F026 options byte, and in the status record's own options field.
const OPTION_BITS: Record<string, number> = {
    turbowash: 0x01,
    crease_care: 0x02,
    steam_softener: 0x04,
    medic_rinse: 0x10,
    prewash: 0x40,
    steam: 0x80,
}

// F026 is "run this programme", not "configure": there is no way to set a field without starting a
// wash. So the settings below are held here until the start button is pressed, each defaulting to
// whatever the appliance last reported - press start without touching anything and it runs what the
// dial already says. This is the one piece of state this class keeps, and it exists because Home
// Assistant has no way to express a compound command otherwise.
const SETTINGS = ['course', 'temp', 'spin', 'rinse', 'soil_wash', 'delay_end', ...Object.keys(OPTION_BITS)] as const

export default class Device extends AABBDevice {
    /** Settings the user has chosen but not yet run, as wire codes. Cleared once a programme runs. */
    private pending = new Map<string, number>()
    /** The last configuration the appliance reported, which is what an untouched start sends. */
    private reported = { course: 0, soil_wash: 0, spin: 0, temp: 0, rinse: 0, delay_end: 0, options: 0 }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Ack every frame. Unacked, this appliance retransmits an envelope ten times and then stops
        // talking altogether: observed on an FSR7A04PG, which sent its serial record and one status
        // block, then repeated a single 20-byte envelope (seq 0x000c) ten times at ~1.4 s intervals
        // and went silent for the rest of the session. AABBDevice's ack format was verified against
        // the real cloud for Y_VB_Y___W.B32QEUK, which is this model's immediate sibling.
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
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.options,
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
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycle count',
                        icon: 'mdi:counter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
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
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        device_class: 'duration',
                        // minutes, not the sibling's hours: this block carries HH:MM, and the two
                        // other durations here are already minutes.
                        unit_of_measurement: 'min',
                        name: 'Reserve time',
                        icon: 'mdi:timer-sand',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew',
                    },
                    intensive_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-intensive_wash',
                        state_topic: '$this/intensive_wash',
                        name: 'Intensive wash',
                        icon: 'mdi:washing-machine-alert',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-plus',
                    },
                    set_course: {
                        platform: 'select',
                        unique_id: '$deviceid-set_course',
                        state_topic: '$this/set_course',
                        command_topic: '$this/set_course/set',
                        name: 'Set course',
                        icon: 'mdi:tune-vertical',
                        options: COURSES.options,
                    },
                    set_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-set_temp',
                        state_topic: '$this/set_temp',
                        command_topic: '$this/set_temp/set',
                        name: 'Set temperature',
                        icon: 'mdi:thermometer',
                        options: SET_TEMPS.options,
                    },
                    set_spin: {
                        platform: 'select',
                        unique_id: '$deviceid-set_spin',
                        state_topic: '$this/set_spin',
                        command_topic: '$this/set_spin/set',
                        name: 'Set spin',
                        icon: 'mdi:autorenew',
                        options: SET_SPINS.options,
                    },
                    set_rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-set_rinse',
                        state_topic: '$this/set_rinse',
                        command_topic: '$this/set_rinse/set',
                        name: 'Set rinse',
                        icon: 'mdi:water',
                        options: RINSES.options,
                    },
                    set_soil_wash: {
                        platform: 'select',
                        unique_id: '$deviceid-set_soil_wash',
                        state_topic: '$this/set_soil_wash',
                        command_topic: '$this/set_soil_wash/set',
                        name: 'Set wash level',
                        icon: 'mdi:washing-machine',
                        options: SET_SOIL_WASH.options,
                    },
                    set_delay_end: {
                        platform: 'number',
                        unique_id: '$deviceid-set_delay_end',
                        state_topic: '$this/set_delay_end',
                        command_topic: '$this/set_delay_end/set',
                        name: 'Set delayed end',
                        icon: 'mdi:timer-sand',
                        unit_of_measurement: 'h',
                        // 0 is off; the appliance accepts 3..19 per modelJson's reserveTimeHour.
                        min: 0,
                        max: 19,
                        step: 1,
                    },
                    run_programme: {
                        platform: 'button',
                        unique_id: '$deviceid-run_programme',
                        command_topic: '$this/run_programme/set',
                        payload_press: '',
                        name: 'Run programme',
                        icon: 'mdi:play-box-outline',
                    },
                    set_steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_steam',
                        state_topic: '$this/set_steam',
                        command_topic: '$this/set_steam/set',
                        name: 'Set steam',
                        icon: 'mdi:kettle-steam',
                    },
                    set_prewash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_prewash',
                        state_topic: '$this/set_prewash',
                        command_topic: '$this/set_prewash/set',
                        name: 'Set pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    set_turbowash: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_turbowash',
                        state_topic: '$this/set_turbowash',
                        command_topic: '$this/set_turbowash/set',
                        name: 'Set TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    set_crease_care: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_crease_care',
                        state_topic: '$this/set_crease_care',
                        command_topic: '$this/set_crease_care/set',
                        name: 'Set crease care',
                        icon: 'mdi:iron-outline',
                    },
                    set_steam_softener: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_steam_softener',
                        state_topic: '$this/set_steam_softener',
                        command_topic: '$this/set_steam_softener/set',
                        name: 'Set steam softener',
                        icon: 'mdi:kettle-steam-outline',
                    },
                    set_medic_rinse: {
                        platform: 'switch',
                        unique_id: '$deviceid-set_medic_rinse',
                        state_topic: '$this/set_medic_rinse',
                        command_topic: '$this/set_medic_rinse/set',
                        name: 'Set medic rinse',
                        icon: 'mdi:water-check',
                    },
                    smart_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-smart_course',
                        state_topic: '$this/smart_course',
                        name: 'Downloaded course',
                        icon: 'mdi:cloud-download-outline',
                        // Deliberately not device_class enum: an unmapped code is published as its
                        // raw value, and a fixed options list would make HA reject it.
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water',
                        device_class: 'enum',
                        options: RINSES.options,
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
                    steam_softener: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam_softener',
                        state_topic: '$this/steam_softener',
                        name: 'Steam softener',
                        icon: 'mdi:kettle-steam-outline',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    crease_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-crease_care',
                        state_topic: '$this/crease_care',
                        name: 'Crease care',
                        icon: 'mdi:iron-outline',
                    },
                    medic_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-medic_rinse',
                        state_topic: '$this/medic_rinse',
                        name: 'Medic rinse',
                        icon: 'mdi:water-check',
                    },
                    ai_dd: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-ai_dd',
                        state_topic: '$this/ai_dd',
                        name: 'AI DD',
                        icon: 'mdi:brain',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    // The appliance wraps its state in an envelope: 20 0a 00 <frame len> 00 <seq16> 00 01 <record16>
    // <payload len16> then the payload. Two record ids carry state, and both carry the same 39-byte
    // record:
    //
    //   0x00eb  one record - the current state
    //   0x00ec  two records - the state being replaced, then the state replacing it
    //
    // The pair is what this appliance actually sends whenever anything is touched on the panel; the
    // single record shows up rarely, and only ever reported "off" here. Matching on `length === 53`,
    // as this file used to, therefore ignored every setting change the machine made - which is why
    // turning it on from Home Assistant left the switch snapping back to off, and why selecting
    // steam or a different temperature showed up nowhere.
    //
    // The wiki's byte map (Appliance:Y_V8_Y___W.B32QEUK) describes the 0xeb framing, so its offsets
    // are these record offsets plus the 13-byte header.
    static readonly HEADER_LEN = 13
    static readonly STATE_LEN = 39
    static readonly RECORD_STATE = 0x00eb
    static readonly RECORD_STATE_PAIR = 0x00ec

    processAABB(buf: Buffer) {
        if (buf.length < Device.HEADER_LEN || buf[0] !== 0x20 || buf[1] !== 0x0a) return

        const record = buf.readUInt16BE(9)
        const payloadLength = buf.readUInt16BE(11)
        if (buf.length < Device.HEADER_LEN + payloadLength) return
        const payload = buf.subarray(Device.HEADER_LEN, Device.HEADER_LEN + payloadLength)

        if (record === Device.RECORD_STATE && payload.length === Device.STATE_LEN) {
            this.processState(payload)
        } else if (record === Device.RECORD_STATE_PAIR && payload.length === 2 * Device.STATE_LEN) {
            // Only the second half matters: the first is the state this one supersedes.
            this.processState(payload.subarray(Device.STATE_LEN))
        }
    }

    // Offsets into the 39-byte state record. Each one is the wiki map's offset less the 13-byte
    // header, and also the sibling F_V8_Y___W.B_2QEUK's offset less 41 - the two models share this
    // record, so every field below has two independent sources.
    processState(s: Buffer) {
        const status = s[2]
        const time_remain = s[3] * 60 + s[4]
        const time_initial = s[5] * 60 + s[6]
        const course = s[7]
        const error = s[8]
        const soil_wash = s[9]
        const spin = s[10]
        const temp = s[11]
        const rinse = s[12]
        // s[13] is dryLevel, which this washer has no drum heater for and never sets.
        const time_reserve = s[14] * 60 + s[15]
        const options = s[16]
        const lock_status = s[17]
        const aidd = s[18]
        // s[21] is preState, the status this record supersedes.
        // s[22] is the downloaded course actually selected, s[25] the one loaded in the download
        // slot. They read identically across a full cycle on this unit - the machine holds one
        // downloaded course at a time (modelJson: maxDownloadCourseNum 1) - so only s[22] is
        // published; s[25] is worth exposing separately if a unit is ever seen where they differ.
        const smart_course = s[22]
        const cycles = s[23]
        // The wiki leaves 30/31 unnamed, but the sibling's energy counter sits at the same place in
        // its own record, and it is the only value here that climbs monotonically through a cycle and
        // then holds. s[34]/s[35] - where this file used to read energy - are the auto-dispenser's
        // detergent and softener amounts, which is why energy always read 0 on a machine with no
        // such hardware.
        const energy = s[30] * 256 + s[31]

        this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', STATES.map(status))
        // Both course fields fall back to the raw code. COURSES is a table shared across washer
        // models and this one has dial positions it does not cover; dropping those to undefined
        // published them as "None", indistinguishable from no course at all, which also made them
        // impossible to identify from a capture. The raw value is what lets the table be completed.
        this.publishProperty('course', COURSES.map(course) ?? `Unknown (0x${course.toString(16)})`)
        this.publishProperty(
            'smart_course',
            SMART_COURSES.map(smart_course) ?? `Unknown (0x${smart_course.toString(16)})`,
        )
        this.publishProperty('spin', SPINS[spin])
        this.publishProperty('temp', TEMPERATURES[temp])
        this.publishProperty('cycles', cycles)
        this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
        this.publishProperty('child_lock', !(lock_status & 0x80) ? 'ON' : 'OFF') // inverted, as door_lock
        this.publishProperty('wrinkle_care', lock_status & 0x20 ? 'ON' : 'OFF')
        this.publishProperty('initial_time', time_initial)
        this.publishProperty('remaining_time', time_remain)
        this.publishProperty('reserve_time', time_reserve)
        this.publishProperty('energy', energy)
        this.publishProperty('intensive_wash', soil_wash >= 4 ? 'ON' : 'OFF') // 3=normal, 4=intensive
        this.publishProperty('rinse', RINSES.map(rinse))
        this.publishProperty('extra_rinse', EXTRA_RINSE_CODES.includes(rinse) ? 'ON' : 'OFF')
        this.publishProperty('turbowash', options & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('crease_care', options & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('steam_softener', options & 0x04 ? 'ON' : 'OFF')
        // options & 0x08 is ecoHybrid, a heat-pump dryer option this washer does not have, and
        // options & 0x20 is rinseSpin, which duplicates the Rinse + Spin course. Neither is
        // published until a unit is seen setting them.
        this.publishProperty('medic_rinse', options & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('prewash', options & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('steam', options & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('ai_dd', aidd & 0x01 ? 'ON' : 'OFF')

        this.reported = { course, soil_wash, spin, temp, rinse, delay_end: s[14], options }
        this.publishSettings()
    }

    /** A setting's effective value: what the user chose, or failing that what the appliance reports. */
    private setting(prop: keyof typeof this.reported) {
        return this.pending.get(prop) ?? this.reported[prop]
    }

    /** Republish every set_* entity. Called on each state record and after each write. */
    private publishSettings() {
        this.publishProperty('set_course', COURSES.map(this.setting('course')))
        this.publishProperty('set_temp', SET_TEMPS.map(this.setting('temp')))
        this.publishProperty('set_spin', SET_SPINS.map(this.setting('spin')))
        this.publishProperty('set_rinse', RINSES.map(this.setting('rinse')))
        this.publishProperty('set_soil_wash', SET_SOIL_WASH.map(this.setting('soil_wash')))
        this.publishProperty('set_delay_end', this.setting('delay_end'))
        const options = this.setting('options')
        for (const [name, bit] of Object.entries(OPTION_BITS)) {
            this.publishProperty(`set_${name}`, options & bit ? 'ON' : 'OFF')
        }
    }

    /**
     * F0 26 <course> <soilWash> <spin> <temp> <rinse> <dryLevel> <reserveH> <reserveM> <loadItem>
     *       <options> <flags> and five trailing zeroes.
     *
     * Confirmed against a start issued from the LG app - Allergy SpaSteam at 60 C with steam came
     * over the bridge as F0262D03FF06010000000080030000000000 - and against the three examples on
     * the project wiki, whose course, soilWash, spin, temp and rinse bytes each match modelJson's
     * documented defaults for the course they name.
     *
     * The trailing 0x03 is initialBit | remoteStart. Every observed start carries it, and upstream
     * records elsewhere that a washer's initialBit has to be set even though a bare 0 looks equally
     * off on paper, so it is sent rather than left clear.
     */
    private programmeCommand() {
        return Buffer.from([
            0xf0,
            0x26,
            this.setting('course'),
            this.setting('soil_wash'),
            this.setting('spin'),
            this.setting('temp'),
            this.setting('rinse'),
            0, // dryLevel: this washer has no drum heater
            this.setting('delay_end'),
            0, // reserveTimeMinute: the panel only offers whole hours
            0, // loadItemWasher
            this.setting('options'),
            0x03, // initialBit | remoteStart
            0,
            0,
            0,
            0,
            0,
        ])
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
        }

        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        // `start` resumes what the appliance already has - F024 05 - and still takes raw hex, which
        // is how the protocol was reachable before any of the settings below existed.
        if (prop === 'start') this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))

        if (prop === 'run_programme') {
            this.send(this.programmeCommand())
            // The appliance is now the authority on what is running; drop the pending choices so the
            // entities follow it again rather than showing a selection that has already been used.
            this.pending.clear()
            return
        }

        const table: Record<string, Enum<string>> = {
            set_course: COURSES,
            set_temp: SET_TEMPS,
            set_spin: SET_SPINS,
            set_rinse: RINSES,
            set_soil_wash: SET_SOIL_WASH,
        }
        if (prop in table) {
            const code = table[prop].unmap(mqttValue)
            if (code !== undefined) this.pending.set(prop.slice(4), code)
            this.publishSettings()
            return
        }

        if (prop === 'set_delay_end') {
            const hours = Number(mqttValue)
            // modelJson allows 3..19; 0 is how the panel expresses "no delayed end".
            if (Number.isFinite(hours) && (hours === 0 || (hours >= 3 && hours <= 19))) {
                this.pending.set('delay_end', hours)
            }
            this.publishSettings()
            return
        }

        const bit = OPTION_BITS[prop.slice(4)]
        if (prop.startsWith('set_') && bit !== undefined) {
            const options = this.setting('options')
            this.pending.set('options', mqttValue === 'ON' ? options | bit : options & ~bit)
            this.publishSettings()
        }
    }
}
