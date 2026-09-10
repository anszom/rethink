import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG front-load washer, matched on modelId "FAFXU25006" (thinq2 deviceType 201), sold as WM5800HVA.
//
// This model uses the long, length-escaped AABB framing (aa ff <class> <envelope> <len16> ... <inner
// type> <inner len> <payload> <chk16> bb) rather than the short one every other AABB handler here
// reads. AABBDevice.processData strips AA/length and the trailing BB, so buf[0] is the class byte and
// the inner type sits at buf[10]. The checksum is 16-bit here, so buf still carries one checksum byte
// past the payload, which is why the expected buf lengths below are one more than header + inner len.
//
// Inner types:
//   0xEC  two stacked 72-byte records, previous state at buf[13] and current state at buf[85]
//   0xEB  a single current-state record at buf[13], same layout, sent in reply to a status query
//   0x03  a 69-byte event frame sent when the door opens or shuts — not a status record
//   0x00/0x02/0x04/0x4d/0xe2  not status records and not decoded
//
// Record length is 72 bytes here against 42 on the LG dryers and 28 on the RV13* reference, at
// completely different offsets, so this cannot be aliased to any existing handler.
//
// Every offset below is live-verified: real wire traffic captured while the washer was driven by hand
// at the panel, with rethink bridged to the LG cloud so each byte change could be matched against the
// cloud's own decoded washerDryer state at the same timestamp.

const CLASS_BYTE = 0x20
const ENVELOPE_TYPE = 0x0a
const INNER_TYPE_OFFSET = 10
const INNER_LEN_OFFSET = 11

const RECORD_LEN = 72
const RECORD_MARKER = 0x0a // the current-state record's own marker byte, rec[0]

const STATUS_FRAME_TYPE = 0xec
const STATUS_INNER_LEN = 2 * RECORD_LEN
const STATUS_RECORD_OFFSET = 13 + RECORD_LEN // skip the "previous state" record
const STATUS_BUF_LEN = 13 + STATUS_INNER_LEN + 1

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_INNER_LEN = RECORD_LEN
const SINGLE_RECORD_OFFSET = 13
const SINGLE_BUF_LEN = 13 + SINGLE_INNER_LEN + 1

// The door does not live in the status record: opening or shutting it moves nothing in the 72 bytes.
// It is announced in its own frame, inner type 0x03, with buf[22] reading 1 for open and 2 for shut.
// LG's cloud doorClose field is never sent in a change notification and reads DOORCLOSE_OFF even while
// open in the periodic dumps, so this is the one published field here with no cloud pairing behind it —
// the wire is the only source that reports this door.
const DOOR_EVENT_TYPE = 0x03
const DOOR_EVENT_INNER_LEN = 14
const DOOR_EVENT_BUF_LEN = 69
const DOOR_EVENT_OFFSET = 22
const DOOR_OPEN = 1
const DOOR_SHUT = 2

// Status query, lifted verbatim from the cloud while bridging: LG sends it to this washer on connect,
// and the appliance answers within a second with a 0xEB snapshot followed by a 0xEC update. 0xF0ED is
// the family-wide "report your state" request; actuating commands are 0xF0E5, so this only ever reads.
const STATUS_REQUEST = 'F0ED112101000000180411120000'

// Offsets are relative to the record's own marker at rec[0].
const SOIL_OFFSET = 1
const TEMP_OFFSET = 2
const RINSE_OFFSET = 3
const SPIN_OFFSET = 4
const COURSE_OFFSET = 5
// rec[12:14], little-endian: minutes left on a Delay Wash, matching the cloud's reserveTimeMinute. It
// holds the value set while the machine sits in INITIAL with the delay armed, and starts ticking on the
// move into RESERVED.
const RESERVE_TIME_OFFSET = 12
// rec[14:16] and rec[16:18], little-endian 16-bit minute counts (opposite byte order from the dryers).
// rec[14:16] counts down while running; rec[16:18] stays pinned at the length the cycle was given.
const REMAIN_TIME_OFFSET = 14
const INITIAL_TIME_OFFSET = 16
// rec[18:20], little-endian: energy used so far by the running cycle in Wh, matching courseSpendPower.
const SPENT_POWER_OFFSET = 18
const STATE_OFFSET = 21
// rec[24]: the load the machine weighed, matching loadLevel. 100 is the not-yet-measured sentinel the
// cloud reports as NOT_DEFINE_VALUE.
const LOAD_LEVEL_OFFSET = 24
// rec[22]: the state the appliance was in before the current one, same codes as rec[21]. This also pins
// down the door lock: the one frame where the cloud reported preState:"RUNNING" and doorLock:"ON" and
// nothing else had rec[22] take the RUNNING code while rec[38] went 0 -> 1.
const PRE_STATE_OFFSET = 22
// rec[28]: the cloud's TCLCount, washes since the last Tub Clean.
const TUB_CLEAN_COUNT_OFFSET = 28
const BUZZER_OFFSET = 29 // matching the cloud's buzzer, 0-4
// rec[30]/rec[31]: the two EZDispense settings. Both sit at LG's 0xff dash sentinel while idle. Which is
// which was settled by the cycle itself: rec[30] returns to the dash on RUNNING -> RINSING (no more
// detergent to draw) and rec[31] on RINSING -> SPINNING (no more softener to draw), matching
// ezCSDetergentSetVal and ezCSSoftenerSetVal respectively.
const EZ_DETERGENT_OFFSET = 30
const EZ_SOFTENER_OFFSET = 31
const OPT1_OFFSET = 34 // options bitfield, each bit isolated against the cloud by toggling one control
const OPT1_TURBO_WASH = 0x20
const OPT1_PRE_WASH = 0x40
const OPT1_AUTO_SOAK = 0x80
const OPT2_OFFSET = 35
const OPT2_STEAM = 0x10
const OPT5_OFFSET = 36
const OPT5_FRESH_CARE = 0x40
// rec[37]: bit 0x20 is child lock, bit 0x40 is drum light (matching drumLight). The remaining bits don't
// match a cloud field: 0x02 tracks the panel being awake, 0x10 is set for the whole of a live cycle.
const OPT3_OFFSET = 37
const OPT3_CHILD_LOCK = 0x20
const OPT3_DRUM_LIGHT = 0x40
// rec[38]: door lock, matching doorLock. See PRE_STATE_OFFSET for how it was separated from the state.
const DOOR_LOCK_OFFSET = 38
const OPT4_OFFSET = 39 // bit 0x80 is Delay Wash, matching delay:"DELAY_ON"
const OPT4_DELAY = 0x80
const OPT6_OFFSET = 40 // bit 0x04 is Remote Maintain, matching remoteMaintain
const OPT6_REMOTE_MAINTAIN = 0x04
// rec[69]: end-of-cycle melody, matching endMelodyOnOff. Every observation so far moved in lockstep with
// the buzzer at rec[29] going to or from 0, so the two have not been separated.
const END_MELODY_OFFSET = 69

const STATE_POWEROFF = 0
const LOAD_LEVEL_UNSET = 100 // the cloud reports this as NOT_DEFINE_VALUE

// State codes. Unlike the LG range and microwave, this washer's wire codes follow the modelJSON enum
// indices directly, and so do soilWash, spin, temp and rinse below. Nine states were seen live against
// the cloud's own state field (Off, Initial, Detecting, Reserved, Running, Rinsing, Spinning, End), plus
// Pause on the wire alone from a run whose cloud feed had lapsed. RESERVED is where a Delay Wash counts
// down; DETECTING is where the machine weighs a load it hasn't already weighed. The rest of the table is
// LG's indices for the same field, kept because that mapping held everywhere it could be checked.
// Anything outside the table is left unknown rather than guessed.
const STATE = Enum.of({
    Off: 0,
    Initial: 1,
    Pause: 2,
    Detecting: 3,
    'Add drain': 5,
    'Detergent amount': 6,
    Reserved: 7,
    Soak: 8,
    'Pre-wash': 9,
    Running: 11,
    Rinsing: 12,
    'Rinse hold': 13,
    Spinning: 14,
    Drying: 15,
    End: 16,
    Refreshing: 21,
    'Error auto off': 23,
    'Frozen prevent initial': 27,
    'Frozen prevent pause': 28,
    'Frozen prevent running': 29,
    'Audible diagnosis': 34,
    'Auto DT open pause': 35,
    'Confirm start for control': 36,
    'Clothing recognition': 37,
    'Detergent input': 38,
    'Softener input': 39,
    'Pollution detecting': 40,
    'Tub cleaning': 41,
    'End remote maintain on': 42,
    Steam: 43,
    'Laundry care': 47,
    'EZDispense cleaning': 48,
    'Dry cooling': 52,
})

// Course codes, all 29 observed by selecting each cycle and reading the byte — the modelJSON Course
// table carries no indices for this model. The cloud's panelCrsList is NOT the catalogue: it is the ten
// slots currently assigned to the panel, which changes as the owner reassigns them, so expect this table
// to be incomplete. The names are what the panel calls each cycle, not the cloud identifiers, which
// disagree on several dial positions (kept as trailing comments since that's what a capture will show).
const COURSE = Enum.of({
    Allergiene: 5, // ALLERGYCARE
    ColdWash: 6, // ANSIMCOLD
    'Color Care': 18, // COLORCARE
    Delicates: 22, // DELICATES
    Bedding: 27, // DUVET
    'Heavy Duty': 35, // HEAVYDUTY
    Jeans: 38, // JEAN
    'Kids Wear': 39, // KIDS_WEARS
    Normal: 46, // NORMAL
    'Overnight Wash': 47, // OVERNIGHT
    'Perm. Press': 48, // PERM_PRESS
    'Rinse & Spin': 55, // RINSE_SPIN
    Sanitary: 60, // SANITARY
    'Small Load': 68, // SMALL_LOAD
    'Quick Wash': 74, // SPEEDWASH
    'Spin Only': 78, // SPIN_ONLY
    Towels: 84, // TOWELS
    'Tub Clean': 85, // TUB_CLEAN
    BrightWhites: 90, // WHITE
    'Hand/Wool': 94, // WOOL
    Activewear: 99, // ACTIVE_WEAR
    'Sweat Stains': 113, // SWEAT_STAIN
    'AI Wash': 114, // AI_COURSE
    'Pet Care': 119, // PET_CARE
    Swimwear: 130, // SWIM_WEAR
    Dresses: 131, // COCKTAIL_DRESSES
    'Large Load': 132, // LARGE_LOAD
    'XL Load': 133, // X_LARGE_LOAD
    'Microplastics Care': 136, // MICROPLASTIC_CARE
})

// Soil level, confirmed against the cloud's soilWash by stepping the button. 255 is the "not applicable"
// sentinel the courses without a soil setting use (Tub Clean, Spin Only, Rinse + Spin).
const SOIL = Enum.of({
    Light: 1,
    'Light/Normal': 2,
    Normal: 3,
    'Normal/Heavy': 4,
    Heavy: 5,
})

// Confirmed the same way against the cloud's spin.
const SPIN = Enum.of({
    'Drain only': 12,
    Low: 13,
    Medium: 14,
    High: 15,
    'Extra High': 16,
})

// Confirmed against the cloud's temp. 0 (NO_TEMP) is what courses with no temperature setting report.
const TEMP = Enum.of({
    'Tap Cold': 7,
    Cold: 8,
    Warm: 9,
    Hot: 10,
    'Extra Hot': 11,
})

// LG's own enum for both EZDispense dispensers. 255 is the not-applicable sentinel.
const EZ_DISPENSE = Enum.of({
    Off: 0,
    Less: 1,
    Normal: 2,
    More: 3,
})

const BUZZER = Enum.of({
    Off: 0,
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
})

// Confirmed against the cloud's rinse. 255 is the not-applicable sentinel.
const RINSE = Enum.of({
    Normal: 14,
    Plus: 15,
    'Plus 2': 16,
    'Plus 3': 17,
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
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
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
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve_time',
                        state_topic: '$this/reserve_time',
                        name: 'Delay Wash time remaining',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    delay_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_wash',
                        state_topic: '$this/delay_wash',
                        name: 'Delay Wash',
                        icon: 'mdi:clock-plus-outline',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    load_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_level',
                        state_topic: '$this/load_level',
                        name: 'Load level',
                        icon: 'mdi:weight',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // No state_class: the counter resets at each Tub Clean, so total_increasing
                        // would accumulate across the reset.
                        entity_category: 'diagnostic',
                    },
                    buzzer: {
                        platform: 'sensor',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        entity_category: 'diagnostic',
                    },
                    end_melody: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-end_melody',
                        state_topic: '$this/end_melody',
                        name: 'End melody',
                        icon: 'mdi:music-note',
                        entity_category: 'diagnostic',
                    },
                    auto_soak: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-auto_soak',
                        state_topic: '$this/auto_soak',
                        name: 'Auto soak',
                        icon: 'mdi:water-outline',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh_care',
                        state_topic: '$this/fresh_care',
                        name: 'FreshCare',
                        icon: 'mdi:air-filter',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:lock',
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
                    ez_dispense_detergent: {
                        platform: 'sensor',
                        unique_id: '$deviceid-ez_dispense_detergent',
                        state_topic: '$this/ez_dispense_detergent',
                        name: 'EZDispense detergent',
                        icon: 'mdi:cup-water',
                    },
                    ez_dispense_softener: {
                        platform: 'sensor',
                        unique_id: '$deviceid-ez_dispense_softener',
                        state_topic: '$this/ez_dispense_softener',
                        name: 'EZDispense softener',
                        icon: 'mdi:cup-water',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        icon: 'mdi:lightbulb',
                        entity_category: 'diagnostic',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                    },
                    rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        name: 'Rinse',
                        icon: 'mdi:water-sync',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
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
                    pre_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pre_state',
                        state_topic: '$this/pre_state',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock', that class is inverted (on = unlocked)
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // This washer only volunteers a status frame when something changes, so asking once per connect is
    // what makes the entities survive a restart rather than staying pinned at unknown. LG's own cloud
    // does exactly this.
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
            case DOOR_EVENT_TYPE:
                if (innerLen !== DOOR_EVENT_INNER_LEN || buf.length !== DOOR_EVENT_BUF_LEN) return
                return this.processDoorEvent(buf)
            // 0x00/0x02/0x04/0x4d/0xe2 are not status records and are not decoded.
        }
    }

    // The door is only ever announced, never included in a status snapshot, so it stays unknown until
    // next moved. A value other than the two known ones is left alone rather than guessed at.
    private processDoorEvent(buf: Buffer) {
        const door = buf[DOOR_EVENT_OFFSET]
        if (door !== DOOR_OPEN && door !== DOOR_SHUT) return
        this.publishProperty('door', door === DOOR_OPEN ? 'ON' : 'OFF')
    }

    private processStatus(buf: Buffer, recordOffset: number, expectedLen: number) {
        if (buf.length !== expectedLen) return // reject header/layout drift
        const rec = buf.subarray(recordOffset, recordOffset + RECORD_LEN)
        if (rec[0] !== RECORD_MARKER) return // the current-state record should always lead with its marker

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_POWEROFF

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state))
        this.publishProperty('pre_state', STATE.map(rec[PRE_STATE_OFFSET]))
        this.publishProperty('course', COURSE.map(rec[COURSE_OFFSET]))
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('rinse', RINSE.map(rec[RINSE_OFFSET]))
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16LE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16LE(INITIAL_TIME_OFFSET))
        this.publishProperty('spent_power', rec.readUInt16LE(SPENT_POWER_OFFSET))
        this.publishProperty('reserve_time', rec.readUInt16LE(RESERVE_TIME_OFFSET))
        this.publishProperty('delay_wash', (rec[OPT4_OFFSET] & OPT4_DELAY) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (rec[OPT3_OFFSET] & OPT3_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')
        // 100 is the sentinel for "not weighed yet", which HA should see as unknown rather than a load.
        const load = rec[LOAD_LEVEL_OFFSET]
        this.publishProperty('load_level', load === LOAD_LEVEL_UNSET ? undefined : load)

        this.publishProperty('tub_clean_count', rec[TUB_CLEAN_COUNT_OFFSET])
        this.publishProperty('buzzer', BUZZER.map(rec[BUZZER_OFFSET]))
        this.publishProperty('ez_dispense_detergent', EZ_DISPENSE.map(rec[EZ_DETERGENT_OFFSET]))
        this.publishProperty('ez_dispense_softener', EZ_DISPENSE.map(rec[EZ_SOFTENER_OFFSET]))
        this.publishProperty('end_melody', rec[END_MELODY_OFFSET] !== 0 ? 'ON' : 'OFF')

        const opt1 = rec[OPT1_OFFSET]
        this.publishProperty('turbo_wash', (opt1 & OPT1_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (opt1 & OPT1_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('auto_soak', (opt1 & OPT1_AUTO_SOAK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPT5_OFFSET] & OPT5_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPT3_OFFSET] & OPT3_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_maintain', (rec[OPT6_OFFSET] & OPT6_REMOTE_MAINTAIN) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPT2_OFFSET] & OPT2_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('door_lock', rec[DOOR_LOCK_OFFSET] !== 0 ? 'ON' : 'OFF')
        // Still not located: the error code, and a cycle-progress step like the LG dryers keep.
    }
}
