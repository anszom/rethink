import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG WT7300CW top-load washer — matched on modelId "T1789EFH_F". AABB frames (buf = the AABB body,
// AA+len and checksum+BB already stripped) start with 0x20 and are discriminated by buf[1]:
//   0xEC  status frame — stacked records, each led by a 0x19 marker: a 27-byte OLD state followed by
//         the 26-byte CURRENT state. The current record is always the LAST one in the frame.
//   0xEB  single-record status frame (26-byte record at buf[3:]), sent in reply to a status query and
//         right after the appliance reconnects.
//   0xE2  settings echo — NOT decoded. It has the same shape as 0xEB with a valid 0x19 record, but the
//         sibling F3L7CYK5W_US_WIFI found its equivalent replays a stale snapshot of the cycle's start;
//         decoding it would knock the machine back a phase. The frame-type gate below is what keeps it
//         out, so it must stay even though the record itself would parse.
//   0x31  one-time device-ID/serial frame at connect, 0xD8 short heartbeat — not decoded.
//
// Field offsets follow the layout shared by the other US washers and dryers in this directory (see
// F3L7CYK5W_US_WIFI.ts and RV13B6ES_D_US_WIFI.ts), and each one below is confirmed against captured
// frames from this appliance: the value read at the offset matches what the model JSON declares as the
// default for the course that was running in that capture, and the phase/preState pair walks the cycle
// in the right order across the pause/resume/spin/end captures.

const RECORD_MARKER = 0x19
const RECORD_LEN = 26
const HEADER_LEN = 3
const STATUS_FRAME_TYPES = [0xeb, 0xec]

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request — the
// fridges, the EU washers, the US dryers and the WashTower all use it, and actuating commands are
// 0xF0E5, so this only ever reads. The real LG cloud sends this same request to this washer in bridge
// mode and it answers with a 0xEB snapshot; asking ourselves is what makes the entities survive a
// rethink restart instead of staying blank until the next physical interaction.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Offsets below are relative to the record's own 0x19 marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute], the live countdown. The hour byte is not decoration: a captured 0xE2
// settings frame carries 01 02 — 62 minutes, which reading the minute byte alone reports as 2.
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute], the cycle's total estimate. It pins once a cycle starts while rec[2:4]
// counts down (43-of-52 minutes remaining mid-Bedding, 24-of-86 mid-Heavy Duty).
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
// rec[8]: soil level. Read 5 (Heavy) during the Heavy Duty capture and 3 (Normal) during the Bedding
// capture — both exactly the soilWash default the model JSON declares for that course. It drops to 0
// once the wash phase hands over to rinsing.
const SOIL_OFFSET = 8
// rec[9]: spin speed. Read 3 (High) under Heavy Duty and 1 (Low) under Bedding — again the model's own
// per-course spin defaults.
const SPIN_OFFSET = 9
// rec[10]: wash temperature. Read 4 (Warm) under both Heavy Duty and Bedding, matching the model's temp
// default for each.
const TEMP_OFFSET = 10

// rec[6]: course. Every code below was read off this appliance with the panel naming the cycle, and
// each one's soil/spin/temp matched what the model JSON declares as that course's defaults. The codes
// are LG's own and are NOT the JSON's list order — Deep Wash is 0x19 and Pre Wash+Normal 0x29, so a
// table derived from the ordering would have been wrong for most of the dial.
const COURSE_OFFSET = 6
const COURSE = Enum.of({
    'Not selected': 0x00,
    Normal: 0x01,
    'Heavy Duty': 0x02,
    Delicates: 0x04,
    Waterproof: 0x05,
    'Speed Wash': 0x07,
    Bedding: 0x08,
    'Tub Clean': 0x0c,
    'Rinse+Spin': 0x11,
    'Spin Only': 0x12,
    'Deep Wash': 0x19,
    'Pre Wash+Normal': 0x29,
})
// The Downloaded dial position has no code of its own: it reports the BASE course of whichever smart
// course is loaded (Wrinkle Stop/Gentle Wave reported 0x04 Delicates, Curtains 0x08 Bedding), which is
// also how the sibling dryers' Downloaded position behaves.

// rec[13:15] = [hour][minute], the Delay Wash clock. Confirmed by stepping it through all 19 hours and
// round to off: the byte is plain binary (16 h reads 0x10, which a BCD reading would publish as 10) and
// its top value 0x13 = 19 matches the model JSON's declared reserveTimeHour maximum. The minute byte
// never moved — delay is whole hours on this machine.
const RESERVE_HOUR_OFFSET = 13
const RESERVE_MIN_OFFSET = 14

// rec[15] and rec[16]: the option bitfields. Every bit below was isolated with a single-button press on
// the appliance, with the control panel naming the option, and in most cases nothing else in the record
// moved at all.
const FLAGS_OFFSET = 15
const FLAG_CHILD_LOCK = 0x01
// Door lock. Arming Remote Start locks the lid on its own — no separate action — and set exactly this
// bit. It is not merely a side effect of remote start, though: it reads ON with remote start OFF through
// Washing, Spinning and Complete, and OFF in an idle Paused frame. That is what justifies publishing the
// two separately rather than deriving one from the other.
const FLAG_DOOR_LOCK = 0x04
// Turbo Wash, confirmed off/on/off. Turning it off also stretched the estimate 59 -> 81 minutes.
const FLAG_TURBO_WASH = 0x40

const OPT2_OFFSET = 16
const OPT2_EXTRA_RINSE = 0x01
// Water Plus. Pressing it on Normal switches the machine to the Deep Wash course AND sets this bit, so
// it is distinguishable from simply dialling Deep Wash: that reads 0x10 here, Water Plus reads 0x12.
const OPT2_WATER_PLUS = 0x02
const OPT2_STAIN_CARE = 0x08
const OPT2_SOAK = 0x20
// Bit 0x10 is set exactly when Turbo Wash is supported by the selected course but currently off (it is
// clear on Tub Clean and on downloaded smart courses, which do not offer it). Derivable from the course
// and turbo_wash, so it is not published.

// rec[11]: the rinse setting, carried in the start command at offset 6. Not published as an entity (its
// units are unexplained — see below) but it MUST be copied into the command, or a remote start silently
// drops the user's Extra Rinse selection.
const RINSE_OFFSET = 11

// rec[21] is the smart course currently ACTIVE (non-zero only while the dial sits on Downloaded) and
// rec[24] is whatever is LOADED in the Downloaded slot, which persists wherever the dial is. Both were
// confirmed together: changing the downloaded cycle in the LG app moved both bytes, and turning the dial
// away from Downloaded cleared rec[21] alone while rec[24] held.
//
// Publishing rec[21] is what makes a smart course distinguishable at all: the course byte reports the
// smart course's BASE cycle, so a Whites run and an ordinary Normal run are both course 0x01 and cannot
// be told apart without it.
//
// Every code below was read off this appliance with the LG app naming the cycle, and each was
// cross-checked against the base course the model JSON declares for it (the course byte moved to the
// expected base at the same instant, e.g. Curtains -> Bedding, Sweat Stains -> Heavy Duty). The codes
// are LG's own and are NOT the JSON's list order: an early linear guess predicted Whites at 0x7a, which
// is actually Half Load Wash.
const SMART_COURSE_ACTIVE_OFFSET = 21
const DOWNLOADED_COURSE_OFFSET = 24
const SMART_COURSE = Enum.of({
    'Not selected': 0x00,
    'Small Load': 0x64,
    'Single Item': 0x65,
    'Wrinkle Stop/Gentle Wave': 0x67,
    'Rapid Clean': 0x68,
    'Sweat Stains': 0x69,
    Swimwear: 0x6a,
    Curtains: 0x6b,
    'Dress Shirts': 0x6d,
    'Collar Stains': 0x6e,
    'Pillow Covers': 0x6f,
    Lingerie: 0x70,
    'Baby Wear': 0x71,
    "Children's Wear": 0x73,
    'Juice & Food Stains': 0x74,
    'Baby Bibs': 0x75,
    'Pet Hair and Odor': 0x76,
    EconoWash: 0x77,
    'Collars and Cuffs': 0x78,
    'Delicate Dresses': 0x79,
    'Half Load Wash': 0x7a,
    'Full Load Wash': 0x7b,
    Whites: 0x83,
})

// The start/resume command, captured from the LG cloud in bridge mode while the appliance was started
// from the app. It is the record's own settings fields in order, followed by a verb:
//
//   f0 26 | course | soil | spin | temp | rinse | 00 x7 | flags | opt2 | verb
//            rec[6] rec[8] rec[9] rec[10] rec[11]         rec[15] rec[16]
//
// Confirmed across four captures on three different cycles. Two details are not guesses and matter:
//   * `flags` is rec[15] with the DOOR LOCK bit cleared — the appliance had 0x44 and 0x04 in two
//     captures and the cloud sent 0x40 and 0x00. Sending the lock bit back is not something the app does.
//   * `opt2` is rec[16] VERBATIM, including the 0x10 "turbo supported but off" bit (a capture with Extra
//     Rinse selected carried 0x11). Rebuilding that byte from individual option flags would drop it.
// Offsets 7-13 were zero in every capture; nothing has been observed there.
// The config fields in this command are AUTHORITATIVE, not advisory: with the dial on Delicates and
// Remote Start armed, the LG app sent course 0x12 (Spin Only) with Spin Only's own defaults, and the
// appliance switched cycle and started spinning without the dial moving. It would therefore be possible
// to expose a cycle picker in Home Assistant. Deliberately not done: arming Remote Start already
// requires standing at the machine with the door open, so the cycle is selected there anyway, and a
// picker's failure mode is HA silently running something other than what the panel displays.
// This driver always sends the appliance's CURRENT state, so pressing Start runs what is dialled in.
//
// There is no set-course-without-starting command. Changing the cycle in the app with Remote Start
// armed produced no wire traffic at all; the app stages the selection locally and only transmits it
// inside the start command, which is why that packet carries the whole settings set.
const CMD_START = [0xf0, 0x26]
const VERB_START = 0x03
// Resume is the identical packet with a different verb — captured back to back with a start, the two
// differed in this byte alone.
const VERB_RESUME = 0x01
// The 0xF024 family is "do this action", with the subcommand in byte 2. Both were captured from the LG
// app: pause on a running cycle, power-off on a paused one (which answered with phase Off, remote start
// cleared and the lid released). The model JSON declares WMStop and WMOff as separate actions, matching.
const CMD_PAUSE = [0xf0, 0x24, 0x04, 0x01, 0x00]
const CMD_POWER_OFF = [0xf0, 0x24, 0x01, 0x01, 0x00]

// rec[17]: Remote Start — whether the appliance is ARMED to accept a remote start, which can only be
// set at the control panel (it cannot be enabled from the LG app, so nothing rethink does can turn it
// on either). Useful precisely because of that: if this reads OFF, no remote start will work.
// It landed here one frame before the door lock bit appeared in rec[15], which is what separates the two. The sibling F3L7CYK5W could not separate them — its door lock and remote
// start moved in lockstep, so it publishes no remote-start entity at all.
const REMOTE_START_OFFSET = 17
const REMOTE_START_ON = 0x01

// rec[20]: the cloud's preState — the phase held before the current one. Published because this washer
// drops straight to Off when a finished cycle times out, so "the wash is done" is only visible as
// Off-with-preState-Complete; ha-smartthinq-sensors decides run-completed the same way.
const PRE_STATE_OFFSET = 20

// Not published, deliberately:
//   rec[11]  rinse count. It reads 0/2/4 and each unit is worth exactly 12 minutes of cycle time, but
//            whether it counts total or extra rinses is unresolved — a wash with zero rinses is not a
//            real thing, so 0 most likely means "course default, not overridden".
//   rec[25]  mirrors Soak. The model JSON declares both `soak` and `soakBit`; this is the second one.
//   rec[20]  preState, published below as pre_state.
//
// Confirmed ABSENT on this appliance rather than merely unfound: door position (the model JSON declares
// no doorClose at all), Steam and Fabric Softener (no panel buttons; the JSON's per-course softener
// defaults never surface as a bit), Pre Wash (it is course 0x29, not an option), and the Signal setting
// (no field for it in the JSON). Cold Wash has a panel button but the machine refused it in every
// stopped state tried, on three different courses, emitting no frame at all — left unmapped.

const PHASE_OFF = 0x00
const PHASE_PAUSED = 0x02

// Phase byte. These are the model JSON's own state indices — confirmed by walking the preState byte at
// rec[20] through three captured cycles, where every transition lands on the state this table names.
// The previous table in this file mislabelled the top half: 8 was reported as "Spin" when it is the
// completed state, so a cycle-finished automation could never fire.
const STATUS = Enum.of({
    Off: 0x00,
    Initial: 0x01,
    Paused: 0x02,
    Sensing: 0x03,
    Soaking: 0x04,
    Washing: 0x05,
    Rinsing: 0x06,
    Spinning: 0x07,
    Complete: 0x08,
    'Delay Wash': 0x09,
    'Firmware Update': 0x0a,
    'Smart Diagnosis': 0x0b,
})

// Soil / spin / temperature enumerations, taken from this model's own MonitoringValue tables.
// NOTE: the label for "nothing selected" must NOT be the string 'None'. Home Assistant's MQTT
// integration treats that exact payload as a reserved value (PAYLOAD_NONE in mqtt/const.py) and sets
// the entity state to None, which renders as "Unknown" — the state never reaches the entity at all.
const SOIL = Enum.of({
    'Not selected': 0,
    Light: 1,
    'Light-Normal': 2,
    Normal: 3,
    'Normal-Heavy': 4,
    Heavy: 5,
})

const SPIN = Enum.of({
    // no code: reported when the machine is off, where the byte reads 0 exactly as 'No Spin' does
    'Not selected': [],
    'No Spin': 0,
    Low: 1,
    Medium: 2,
    High: 3,
    'Extra High': 4,
})

const TEMP = Enum.of({
    'Not selected': 0,
    'Tap Cold': 1,
    Cold: 2,
    'Semi Warm': 3,
    Warm: 4,
    Hot: 5,
    'Extra Hot': 6,
})

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
                        // NOT device_class 'running': this byte is phase != Off, i.e. the appliance is
                        // powered on — it goes ON the moment the machine is switched on, before any
                        // cycle starts. 'running' would render "Running" for a machine sitting idle at
                        // the panel. Whether a cycle is actually running is what `status` reports.
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): an unmapped phase code publishes 'unknown',
                        // which an enum entity would reject as an invalid state.
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
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        name: 'Start',
                        icon: 'mdi:play',
                        // Unavailable unless the appliance reports Remote Start armed, mirroring
                        // ha-smartthinq-sensors' own remote-start button. List form, not
                        // availability_topic — mixing the two forms is silently rejected by HA.
                        availability: [
                            { topic: '$this/remote_start', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        icon: 'mdi:pause',
                    },
                    smart_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-smart_course',
                        state_topic: '$this/smart_course',
                        name: 'Smart course',
                        icon: 'mdi:cloud-download-outline',
                        device_class: 'enum',
                        options: SMART_COURSE.options,
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded cycle',
                        icon: 'mdi:tray-arrow-down',
                        entity_category: 'diagnostic',
                        device_class: 'enum',
                        options: SMART_COURSE.options,
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                    pre_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pre_state',
                        state_topic: '$this/pre_state',
                        name: 'Previous state',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: COURSE.options,
                    },
                    delay_wash: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay wash',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        // NOT device_class 'lock' — that class is inverted (on = unlocked), so
                        // publishing OFF for "not locked" renders as "Locked". Same choice, and the
                        // same reason, as F3L7CYK5W_US_WIFI.
                        icon: 'mdi:lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock-alert',
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'Turbo Wash',
                        icon: 'mdi:speedometer',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra Rinse',
                        icon: 'mdi:water-sync',
                    },
                    water_plus: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-water_plus',
                        state_topic: '$this/water_plus',
                        name: 'Water Plus',
                        icon: 'mdi:water-plus',
                    },
                    stain_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-stain_care',
                        state_topic: '$this/stain_care',
                        name: 'Stain Care',
                        icon: 'mdi:liquid-spot',
                    },
                    soak: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-soak',
                        state_topic: '$this/soak',
                        name: 'Soak',
                        icon: 'mdi:water-outline',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin speed',
                        icon: 'mdi:rotate-3d-variant',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    // The appliance itself is the interlock: Remote Start has to be armed at the control panel and
    // cannot be armed remotely, and arming it locks the lid for the whole session. This refuses to send
    // when the appliance reports it is not armed, so a stray MQTT publish cannot actuate the machine —
    // the button is also declared unavailable in that state, but availability is a UI hint, not a guard.
    setProperty(prop: string, value: string) {
        const rec = this.lastRecord
        if (!rec) return

        if (prop === 'pause') {
            this.send(Buffer.from(CMD_PAUSE))
            return
        }

        // Not gated on Remote Start: stopping the machine is the safe direction, and the appliance
        // refuses it itself if it will not accept it.
        if (prop === 'power_off') {
            this.send(Buffer.from(CMD_POWER_OFF))
            return
        }

        if (prop !== 'start') return

        // Start and resume are the same packet, distinguished by the trailing verb. The appliance
        // enforces its own rule — Remote Start must be armed at the panel, and cannot be armed
        // remotely — so an unarmed start is simply ignored by the washer.
        const resuming = rec[PHASE_OFFSET] === PHASE_PAUSED
        this.send(
            Buffer.from([
                ...CMD_START,
                rec[COURSE_OFFSET],
                rec[SOIL_OFFSET],
                rec[SPIN_OFFSET],
                rec[TEMP_OFFSET],
                rec[RINSE_OFFSET],
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                rec[FLAGS_OFFSET] & ~FLAG_DOOR_LOCK & 0xff,
                rec[OPT2_OFFSET],
                resuming ? VERB_RESUME : VERB_START,
            ]),
        )
    }

    private lastRecord?: Buffer

    private processRecord(rec: Buffer) {
        this.lastRecord = rec
        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(phase))
        // not cleared when the machine powers off: that is the point of it
        this.publishProperty('pre_state', STATUS.map(rec[PRE_STATE_OFFSET]))
        // powered off the record keeps the last cycle's leftovers; report 0 rather than replaying them
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('smart_course', SMART_COURSE.map(rec[SMART_COURSE_ACTIVE_OFFSET]))
        this.publishProperty('downloaded_course', SMART_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET]))
        this.publishProperty('delay_wash', rec[RESERVE_HOUR_OFFSET] * 60 + rec[RESERVE_MIN_OFFSET])
        const flags = rec[FLAGS_OFFSET]
        // Lock state is real whether or not a cycle is selected, so these are reported as they come.
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', (flags & FLAG_DOOR_LOCK) !== 0 ? 'ON' : 'OFF')
        // The cycle options below belong to a selected cycle. Powered off there is no selection, and the
        // appliance zeroes course, soil, spin and temp itself — but NOT the Turbo Wash bit, which stays
        // set from the last cycle and would otherwise leave Home Assistant showing Turbo Wash on beside a
        // machine that is off. Reported as off for the same reason the times report 0 when off.
        const opt2 = isOff ? 0 : rec[OPT2_OFFSET]
        const cycleFlags = isOff ? 0 : flags
        this.publishProperty('turbo_wash', (cycleFlags & FLAG_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('extra_rinse', (opt2 & OPT2_EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('water_plus', (opt2 & OPT2_WATER_PLUS) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('stain_care', (opt2 & OPT2_STAIN_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('soak', (opt2 & OPT2_SOAK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (rec[REMOTE_START_OFFSET] & REMOTE_START_ON) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        // 'No Spin' is a real user selection on this panel AND what the byte reads with the machine
        // off, so the two are indistinguishable from the value alone. Report the off case as unset,
        // the same way the times and the cycle options are.
        this.publishProperty('spin', isOff ? 'Not selected' : SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < HEADER_LEN + RECORD_LEN) return
        if (!STATUS_FRAME_TYPES.includes(buf[1])) return

        // The current state is the last record in the frame, whatever else precedes it: 0xEB carries one
        // record, 0xEC carries the old state and then the current one, and a power-off mid-cycle can
        // stack a third. Taking the tail decodes all three shapes; the marker check rejects anything
        // whose layout does not line up, so a frame we have not seen publishes nothing rather than junk.
        const rec = buf.subarray(buf.length - RECORD_LEN)
        if (rec[0] !== RECORD_MARKER) return

        this.processRecord(rec)
    }
}
