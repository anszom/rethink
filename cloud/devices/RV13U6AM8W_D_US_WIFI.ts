import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG 27" dryer — matched on modelId "RV13U6AM8W_D_US_WIFI". That modelId is the control board, not the
// appliance: it is confirmed on both a DLE7300WE (electric) and a DLG7301WE (gas), whose frames decode
// identically at every offset used below. Nothing here is fuel-specific and nothing should become so —
// the one place the difference matters is the model JSON's EnergyMonitoring powertable (2600-13000 W),
// which models a resistive element and is meaningless on the gas variant, so it is not used here.
//
// AABB frames (buf = the AABB body, AA+len and checksum+BB already stripped) start with 0x30 and
// are discriminated by buf[1]:
//   0xEC  status frame — stacked records, each led by a 0x1b marker: a 29-byte OLD state followed by
//         the 28-byte CURRENT state. Powering off mid-cycle stacks a third record. The current state is
//         always the LAST record in the frame.
//   0xEB  single-record status frame (28-byte record at buf[3:]), sent in reply to a status query and
//         right after the appliance reconnects.
//   0x31 serial, 0xE2 idle snapshot, 0xD8/0x72 heartbeats — not decoded.
//
// That record A holds the OLD state and record B the current one is not a naming preference, it is
// visible in the traffic: across three consecutive one-minute status frames captured from this dryer,
// each frame's record A was byte-identical to the previous frame's record B (57/56, then 56/55, then
// 55/54 minutes remaining). Reading record A publishes every value one update late. The sibling
// F3L7CYK5W_US_WIFI confirms the same relationship over 171 consecutive frame pairs.
//
// The offsets match the two closely related US dryers in this directory (RV13B6BSD_D_US_WIFI and
// RV13B6ES_D_US_WIFI), and each field published below is additionally confirmed on THIS model against
// captured frames whose course was known: the value read at the offset is the default that this model's
// own JSON declares for the course that was running.

const RECORD_MARKER = 0x1b
const RECORD_LEN = 28
const HEADER_LEN = 3
const STATUS_FRAME_TYPES = [0xeb, 0xec]

// Status query, sent on every connect. 0xF0ED is the family-wide "report your state" request — the
// fridges, the EU washers, the other US dryers and the WashTower all use it, and actuating commands are
// 0xF0E5, so this only ever reads. Without it a rethink restart leaves every entity pinned at its last
// value until the appliance next changes something on its own.
const STATUS_REQUEST = 'F0ED1121010000001800'

// Offsets below are relative to the record's own 0x1b marker (rec[0]).
const PHASE_OFFSET = 1
// rec[2:4] = [hour][minute], the live countdown. The hour byte matters: a captured frame carries 01 00
// while the panel showed one hour remaining, which reading the minute byte alone reports as 0.
const TIME_HOUR_OFFSET = 2
const TIME_MIN_OFFSET = 3
// rec[4:6] = [hour][minute], a separate total-time estimate that pins once the cycle is running while
// rec[2:4] counts down.
const INITIAL_TIME_HOUR_OFFSET = 4
const INITIAL_TIME_MIN_OFFSET = 5
const COURSE_OFFSET = 6
// rec[8]/rec[9]: read 3 (Normal) and 5 (High) during a Heavy Duty capture — exactly the dryLevel and
// temp defaults this model's JSON declares for HEAVYDUTY. Both read 0/varying under Time Dry, which the
// same JSON declares as NO_DRYLEVEL.
const DRY_LEVEL_OFFSET = 8
const TEMP_OFFSET = 9
// rec[11]: the end-of-cycle Signal volume. All three values confirmed by pressing the panel button:
// 0x00 Off, 0x01 Low, 0x04 High. Neither this model's JSON nor LG's cloud declares a signal field at
// all, so this exists only on the wire — the sibling RV13B6ES derived the same three values the same
// way, and this is an independent reproduction of them on a second appliance.
const SIGNAL_OFFSET = 11
const SIGNAL = Enum.of({
    Off: 0x00,
    Low: 0x01,
    High: 0x04,
})

// rec[12]: the More/Less Time adjustment, a SIGNED minute offset from the course default. Confirmed on
// Speed Dry (25 min default): +5 -> 0x05 / 30 min, 0 -> 0x00 / 25 min, -5 -> 0xfb / 20 min. Read
// unsigned, 0xfb is 251, so a shortened cycle would publish as four hours.
const MORE_LESS_TIME_OFFSET = 12

// rec[10]: the Time Dry duration, matching the model JSON's timeDry enum indices exactly. All five
// values plus the wrap were stepped through on the panel; 0 is what non-timed courses report.
const TIME_DRY_OFFSET = 10
const TIME_DRY = Enum.of({
    // 0 is what non-timed cycles and a powered-off dryer report — a real state, not an unknown code.
    // Without this entry it would map to undefined and render in HA as "Unknown".
    'Not selected': 0x00,
    '20 min': 0x01,
    '30 min': 0x02,
    '40 min': 0x03,
    '50 min': 0x04,
    '60 min': 0x05,
})

// rec[15]: options bitfield. Every bit below was isolated by a single button press on this appliance
// with the panel naming it, and in most cases nothing else in the record moved.
const FLAGS_OFFSET = 15
const FLAG_CHILD_LOCK = 0x01
const FLAG_DAMP_DRY_SIGNAL = 0x08
// The two sibling US dryers DISAGREE about where Wrinkle Care lives — RV13B6ES has it here, RV13B6BSD
// at rec[16] bit 0x10. This appliance matches RV13B6ES, confirmed by a clean single-bit toggle.
// Inheriting the other sibling's position would have published it as permanently OFF.
const FLAG_WRINKLE_CARE = 0x10
// Custom PGM, the panel's stored-program button. Absent from this model's JSON and from both sibling
// dryers, so it has no upstream precedent.
const FLAG_CUSTOM_PGM = 0x20
// The drum light, not a panel-state artifact: pressing Drum Light sets it, pressing again clears it,
// and it clears on its own when the lamp times out. RV13B6BSD reads the same bit as "present while
// Initial/Selecting/Pause, clear while actively drying", which is also how a drum light behaves.
const FLAG_DRUM_LIGHT = 0x40
// Anti-Bacterial. Neither sibling has this button, so this bit has no upstream precedent. Selecting it
// also forces dry level Very and temp High, and it blocks Damp Dry Signal while engaged.
const FLAG_ANTI_BACTERIAL = 0x80

const OPT2_OFFSET = 16
// Remote Start standby. Holding Anti-Bacterial arms it — four clean 0->1 transitions while the dryer sat
// idle in Initial, which is what rules out the drum. But the appliance ALSO sets it by itself for the
// length of a run: a cycle started at the panel and never armed by hand reports it ON through every
// Drying frame, which is the real reason it correlates with Drying in the captures. What it tracks is
// the remote-control SESSION, not the cycle: one load was paused from the app and then, ten minutes
// later, at the panel — the app pause held the bit, the panel pause cleared it, and it returned when the
// panel resumed the run. Phase changes do not touch it: the same load carried it straight through
// Drying into Cooling, where an older capture (EC_COOLING_TRUNCATED) reads it clear only because that
// run had been handled at the panel. Remote pause and resume both work with it clear, so only remote
// STARTING is gated on it.
// The panel has no indicator for it either, arming being a long press on another key, so the wire is the
// only place it is visible — there is no light to cross-check against.
const OPT2_REMOTE_START = 0x01
const OPT2_ENERGY_SAVER = 0x02

// rec[19] is elapsed run time in 15-second units: it advanced by 4 a minute through a live 60-minute
// Time Dry, froze the instant the cycle was paused, and read 176 (44 minutes) with 16 of 60 remaining.
// Not published: a single byte caps at 63.75 minutes and a captured Cooling frame already reads 253, so
// a longer cycle would wrap and report a fresh load as nearly finished.
//
// rec[20]: the cloud's preState — the phase held before the current one. Published because the dryer
// drops to Off once a finished cycle times out, so "the load is done" is only visible as
// Off-with-preState-End.
const PRE_STATE_OFFSET = 20

// Bits 0x08/0x20/0x80 of rec[16] are set in every frame ever captured and have no known meaning.
// rec[23] (loadItem) never moves: this model has no load-size button. Reduce Static and Easy Iron are
// declared by the platform JSON but absent from this SKU's panel, so no bit is claimed for them.

// Commands, all captured from the LG cloud in bridge mode while the dryer was driven from the app.
//
// The 0xF024 action family is BYTE-IDENTICAL to the washer's — same subcommands, same frames. The
// 0xF026 start packet is not: 23 payload bytes to the washer's 17 and different field positions. It
// carries no trailing verb byte; start and resume are separated by a BIT inside offset 10 instead.
//
//   f0 26 <course> 00 00 <temp> 00 00 <timeDry> <flags> <verb+opts> 00 <course> 00 x4 <dryLevel> 00 <moreLess> 00 x3
//     0 1     2     3  4    5    6  7     8        9        10       11    12            17        18   19
//
// The course appears TWICE, at 2 and 12. Both captured commands carry it in both places.
//
// The settings in this command are AUTHORITATIVE and need not match the panel: with the panel showing
// a 60-minute Time Dry and the LG app showing 40, the app's start carried -20 at offset 19 and the
// cycle ran 40 minutes. Whichever side issues the start decides. This driver therefore builds the
// command from the appliance's own reported state, so Home Assistant starts what is set on the machine
// rather than what some other client happens to be displaying.
//
// Pinning this layout needs starts captured on at least two different cycles: on Normal the course,
// the dry level and offset 17 all read 0x03, leaving three distinct fields indistinguishable.
const CMD_START = [0xf0, 0x26]
const CMD_PAUSE = [0xf0, 0x24, 0x04, 0x01, 0x00]
const CMD_POWER_OFF = [0xf0, 0x24, 0x01, 0x01, 0x00]
// Offset 10 is verb plus options. 0x41 in every captured start; 0x01 in the resume the LG app sent into
// a live pause — so the 0x40 bit is "begin a new cycle" and clearing it resumes, which is this model's
// equivalent of the washer's trailing verb byte. The low 0x01 bit is set in both and stays unexplained.
// Energy Saver adds 0x02. Where the panel's OTHER options live in this command is NOT known — no start
// has been captured with wrinkle care, damp dry or anti-bacterial engaged.
const START_OPTS_BASE = 0x01
const START_OPTS_NEW_CYCLE = 0x40
const START_OPTS_ENERGY_SAVER = 0x02
// Option bits in rec[15] that cannot be encoded into the start command yet. Drum light (0x40) is
// excluded: it is a lamp, not a cycle setting, and it is not carried in the command.
;FLAG_CHILD_LOCK | FLAG_DAMP_DRY_SIGNAL | FLAG_WRINKLE_CARE | FLAG_CUSTOM_PGM | FLAG_ANTI_BACTERIAL

const PHASE_OFF = 0x00
const PHASE_PAUSED = 0x03

// Phase byte, using this model's own state indices from its JSON. 0x04 is the completed state, which
// is what a laundry-done automation needs to trigger on.
const STATUS = Enum.of({
    Off: 0x00,
    Initial: 0x01,
    Drying: [0x02, 0x32],
    Paused: 0x03,
    End: 0x04,
    Error: 0x05,
    'Smart Diagnosis': 0x08,
    Cooling: 0x33,
    'Wrinkle Care': 0x38,
})

// Course identifier -> name. All eight dial positions plus Time Dry (its own button) were confirmed on
// this appliance by turning the dial one stop at a time, each cross-checked against the dry-level and
// temperature defaults the model JSON declares for that cycle. The nine remaining entries are base
// cycles that exist ONLY behind a smart course and cannot be reached from the panel at all; each was
// observed when the matching smart course was loaded into the Downloaded slot.
//
// 0x1a is Super Dry's own hidden base cycle, not the Downloaded dial position — that position reports
// whatever base cycle its loaded smart course uses (observed as Normal, Bedding, Time Dry and others).
const CYCLE = Enum.of({
    'Not selected': 0x00,
    'Heavy Duty': 0x01,
    Normal: 0x03,
    'Perm. Press': 0x04,
    Delicates: 0x05,
    'Ultra Delicates': 0x06,
    Bedding: 0x07,
    'Khaki/Jean': 0x0a,
    Sportswear: 0x0b,
    'Kids Wear': 0x0c,
    'Low Temp Dry': 0x0d,
    'Jumbo Dry': 0x0e,
    Wool: 0x0f,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': 0x12,
    'Freshen Up': 0x17,
    'Super Dry': 0x1a,
})

// rec[21] is the smart course currently ACTIVE (non-zero only while the dial sits on Downloaded) and
// rec[24] is whatever is LOADED in the Downloaded slot, which persists wherever the dial is. Same two
// offsets and the same split as the washer.
//
//
// All twenty codes were read off this appliance with the LG app naming the cycle, and each was
// cross-checked against the base cycle, dry level and temperature the model JSON declares for it. Note
// the codes overlap the WASHER's numeric range while meaning entirely different cycles (0x64 is Super
// Dry here and Small Load there), so these tables can never be shared between the two appliances.
const SMART_COURSE_ACTIVE_OFFSET = 21
const DOWNLOADED_COURSE_OFFSET = 24
const SMART_COURSE = Enum.of({
    'Not selected': 0x00,
    'Super Dry': 0x64,
    Denim: 0x65,
    "Kids' Clothes": 0x66,
    'Ultra Delicates': 0x68,
    'Low Temp Dry': 0x69,
    'Freshen Up': 0x6a,
    'Gym Clothes': 0x6b,
    Blankets: 0x6c,
    'Blanket Refresh': 0x6d,
    'Rainy Day': 0x6e,
    Lingerie: 0x70,
    Socks: 0x71,
    'Overnight Dry': 0x72,
    'Bedding/Curtains': 0x73,
    "Kids' Gym Clothes": 0xc8,
    'Easy Ironing': 0xc9,
    'Wrinkle Prevention': 0xca,
    'EconoDry Small Load': 0xcb,
    'Half Load Dry': 0xcd,
    'Full Load Dry': 0xce,
})

const TEMPS = Enum.of({
    Off: 0x00,
    'Ultra Low': 0x01,
    Low: 0x02,
    Medium: 0x03,
    'Med High': 0x04,
    High: 0x05,
})

// NOTE: the label for "nothing selected" must NOT be the string 'None'. Home Assistant's MQTT
// integration treats that exact payload as a reserved value (PAYLOAD_NONE in mqtt/const.py) and sets
// the entity state to None, which renders as "Unknown" — the state never reaches the entity at all.
const DRY_LEVELS = Enum.of({
    'Not selected': 0x00,
    Damp: 0x01,
    Less: 0x02,
    Normal: 0x03,
    More: 0x04,
    Very: 0x05,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): an unmapped phase code publishes 'unknown',
                        // which an enum entity would reject as an invalid state.
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
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        // NOT device_class 'running': this byte is phase != Off, i.e. the appliance is
                        // powered on — it goes ON the moment the machine is switched on, before any
                        // cycle starts. 'running' would render "Running" for a machine sitting idle at
                        // the panel. Whether a cycle is actually running is what `status` reports.
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock-alert',
                        entity_category: 'diagnostic',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    anti_bacterial: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_bacterial',
                        state_topic: '$this/anti_bacterial',
                        name: 'Anti-Bacterial',
                        icon: 'mdi:bacteria-outline',
                    },
                    damp_dry_signal: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-damp_dry_signal',
                        state_topic: '$this/damp_dry_signal',
                        name: 'Damp Dry Signal',
                        icon: 'mdi:water-alert-outline',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy Saver',
                        icon: 'mdi:leaf',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        icon: 'mdi:lightbulb-on-outline',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        name: 'Start',
                        icon: 'mdi:play',
                        // Deliberately NOT declared unavailable when Remote Start is unarmed. The dryer
                        // already refuses an unarmed start on its own, and CONTRIBUTING's safety-interlock
                        // rule says not to stack a second lockout on top of the appliance's. It also
                        // misfires: the bit is clear for a cycle paused AT THE PANEL, which is exactly
                        // when resume is wanted. Pressing it unarmed sends a command the dryer ignores.
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        icon: 'mdi:pause',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        name: 'Power off',
                        icon: 'mdi:power',
                    },
                    custom_pgm: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-custom_pgm',
                        state_topic: '$this/custom_pgm',
                        name: 'Custom program',
                        icon: 'mdi:content-save-cog-outline',
                    },
                    signal: {
                        platform: 'sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell-outline',
                        device_class: 'enum',
                        options: SIGNAL.options,
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
                    time_dry: {
                        platform: 'sensor',
                        unique_id: '$deviceid-time_dry',
                        state_topic: '$this/time_dry',
                        name: 'Time Dry',
                        icon: 'mdi:timer-cog-outline',
                        device_class: 'enum',
                        options: TIME_DRY.options,
                    },
                    more_less_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-more_less_time',
                        state_topic: '$this/more_less_time',
                        name: 'More/Less time',
                        icon: 'mdi:plus-minus-variant',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    cycle: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        name: 'Cycle',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: CYCLE.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMPS.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    // The appliance is the interlock and the only one: Remote Start must be armed at the panel and
    // cannot be armed remotely, and an unarmed start is simply ignored. Nothing here re-checks that.
    setProperty(prop: string, value: string) {
        const rec = this.lastRecord
        if (!rec) return

        if (prop === 'pause') {
            this.send(Buffer.from(CMD_PAUSE))
            return
        }
        if (prop === 'power_off') {
            this.send(Buffer.from(CMD_POWER_OFF))
            return
        }
        if (prop !== 'start') return

        // Start and resume are the same packet; only the 0x40 bit at offset 10 separates them.
        const opts =
            START_OPTS_BASE |
            (rec[PHASE_OFFSET] === PHASE_PAUSED ? 0 : START_OPTS_NEW_CYCLE) |
            ((rec[OPT2_OFFSET] & OPT2_ENERGY_SAVER) !== 0 ? START_OPTS_ENERGY_SAVER : 0)
        this.send(
            Buffer.from([
                ...CMD_START,
                rec[COURSE_OFFSET],
                0,
                0,
                rec[TEMP_OFFSET],
                0,
                0,
                rec[TIME_DRY_OFFSET],
                rec[FLAGS_OFFSET] & ~FLAG_DRUM_LIGHT & 0xff,
                opts,
                0,
                rec[COURSE_OFFSET],
                0,
                0,
                0,
                0,
                rec[DRY_LEVEL_OFFSET],
                0,
                rec[MORE_LESS_TIME_OFFSET],
                0,
                0,
                0,
            ]),
        )
    }

    private lastRecord?: Buffer

    private processRecord(rec: Buffer) {
        this.lastRecord = rec
        const phase = rec[PHASE_OFFSET]
        const isOff = phase === PHASE_OFF

        this.publishProperty('status', STATUS.map(phase))
        // not cleared when the machine powers off: that is the point of it
        this.publishProperty('pre_state', STATUS.map(rec[PRE_STATE_OFFSET]))
        // powered off the record keeps the last cycle's leftovers; report 0 rather than replaying them
        this.publishProperty('remaining_time', isOff ? 0 : rec[TIME_HOUR_OFFSET] * 60 + rec[TIME_MIN_OFFSET])
        this.publishProperty(
            'initial_time',
            isOff ? 0 : rec[INITIAL_TIME_HOUR_OFFSET] * 60 + rec[INITIAL_TIME_MIN_OFFSET],
        )
        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        const flags = rec[FLAGS_OFFSET]
        const opt2 = rec[OPT2_OFFSET]
        this.publishProperty('remote_start', (opt2 & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('energy_saver', (opt2 & OPT2_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (flags & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('damp_dry_signal', (flags & FLAG_DAMP_DRY_SIGNAL) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (flags & FLAG_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (flags & FLAG_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('custom_pgm', (flags & FLAG_CUSTOM_PGM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('anti_bacterial', (flags & FLAG_ANTI_BACTERIAL) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('signal', SIGNAL.map(rec[SIGNAL_OFFSET]))
        this.publishProperty('time_dry', TIME_DRY.map(rec[TIME_DRY_OFFSET]))
        // signed: negative trims the course default, positive extends it
        this.publishProperty('more_less_time', isOff ? 0 : rec.readInt8(MORE_LESS_TIME_OFFSET))
        this.publishProperty('cycle', CYCLE.map(rec[COURSE_OFFSET]))
        this.publishProperty('smart_course', SMART_COURSE.map(rec[SMART_COURSE_ACTIVE_OFFSET]))
        this.publishProperty('downloaded_course', SMART_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET]))
        this.publishProperty('temp', TEMPS.map(rec[TEMP_OFFSET]))
        this.publishProperty('dry_level', DRY_LEVELS.map(rec[DRY_LEVEL_OFFSET]))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30 || buf.length < HEADER_LEN + RECORD_LEN) return
        if (!STATUS_FRAME_TYPES.includes(buf[1])) return

        // The current state is the last record in the frame, whatever else precedes it: 0xEB carries one
        // record, 0xEC the old state then the current one, and a power-off mid-cycle stacks a third. The
        // previous exact-length checks dropped that three-record frame entirely, which is why turning
        // the dryer off mid-cycle left Home Assistant reporting Drying until the next reconnect. Taking
        // the tail decodes all three shapes; the marker check rejects anything whose layout does not
        // line up, so a frame we have not seen publishes nothing rather than junk.
        const rec = buf.subarray(buf.length - RECORD_LEN)
        if (rec[0] !== RECORD_MARKER) return

        this.processRecord(rec)
    }
}
