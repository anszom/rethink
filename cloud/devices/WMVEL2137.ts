import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG over-the-range microwave/hood, marketing model MVEL2033F, matched on modelId "WMVEL2137"
// (thinq2 deviceType 302).
//
// A different appliance from WMVEM1825 and not aliasable to it: that model has two fan levels
// against this one's four plus off. Both pack the vent/lamp status nibbles the same way (see
// VENT_LAMP_OFFSET) - it is issue #93's claim for this modelId that is reversed, not WMVEM1825.
//
// Frames arrive 0xFF-escaped AABB. The AABB body seen by processAABB is:
//
//   41 EC <record: previous state> <record: current state>     94 bytes
//   41 EB <record: current state>                               48 bytes
//
// Each record is 46 bytes. 0xEB answers the status query sent from start(); 0xEC is the
// unsolicited delta report, whose first record repeats the previous frame's current state. Both
// frame types share one decoder over the current-state record.
//
// Every offset and table entry was confirmed live: the appliance was driven by hand at the panel
// while rethink bridged to the LG cloud, matching each byte change to the cloud's own ovenState
// at the same timestamp.
//
// Credit: the protocol, the AABB checksum and the fan/light command shape were first documented
// by XanderLuciano in anszom/rethink issue #93. Two of that issue's claims do not hold here: the
// vent/lamp nibble order is reversed (VENT_LAMP_OFFSET), and the level byte is absolute rather
// than an advance count (SET_COMMAND). The state and cook-mode codes also are not the modelJSON
// enum indices.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 94 // 2B header + 46B previous record + 46B current record
const CURRENT_RECORD_OFFSET = 48

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 48 // 2B header + 46B record, no preceding "previous state" half
const SINGLE_RECORD_OFFSET = 2

const RECORD_LEN = 46
const CLASS_BYTE = 0x41

// Status query, sent on connect. Without it the appliance pushes nothing until the panel is
// touched. Bytes as sent by LG's own cloud while bridged, so known to be read-only and understood.
const STATUS_REQUEST = 'f0ed114101000000180e111718191a1a1b00000000000000'

// rec[0]: appliance state, matched against the cloud's LWOState. Not the modelJSON UpperOvenState
// enum index (5 is DONE here, CLEANING there; 4 is PAUSED here, COOLING there).
const STATE_OFFSET = 0
const STATES = Enum.of({
    Idle: 0x00,
    Cooking: 0x02,
    Paused: 0x04,
    Done: 0x05,
    Settings: 0x07,
})

// rec[5]: cook mode family, matched against LWOManualCookName. Not the enum index either (SENSOR_
// COOK is 0x18 here, index 17 there). 0x18 covers every Sensor Cook item, 0x1f every preset menu
// item (Kids Meal, Steam Cook, Melt, Soften all report it) - these name the family, not the dish.
const COOK_MODE_OFFSET = 5
const COOK_MODES = Enum.of({
    Off: 0x00,
    Microwave: 0x01,
    'Inverter defrost': 0x15,
    'Sensor cook': 0x18,
    'Auto cook': 0x1f,
})

// rec[6..7]: big-endian 16-bit dish id, which the cook mode above only names the family of. The
// cloud reports the same number verbatim as LWOSubCookName (Kids Meal: 0x0d12 here, 3346 there),
// which confirms both offset and endianness.
//
// LG's modelJSON carries no name table for this field, just a bare 0-5000 range, so every name
// below is read off the panel. Three blocks are alphabetical and contiguous, which cross-checks
// those: Sensor Cook 245-256, Melt 3359-3363, Steam Cook 3364-3370. That ordering does not extend
// further - Defrost follows menu position, and the Kids Menu (3338, 3346, 3378) is neither
// alphabetical nor contiguous - so those rest on the panel reading alone.
//
// Ids are sparse, so an unlisted one reports unknown rather than a guess. Menus repeat names
// (all four Melt > Butter portions report 3359), hence the menu prefixes HA needs for a distinct
// enum. Defrost is the exception where food type is part of the id, since there the weight is a
// separate field.
const COOK_ITEM_OFFSET = 6
// Code 0 is "no dish chosen". It cannot be published as the string 'None': that is the payload
// publishProperty sends for an undefined value, which HA renders as unknown - so an unlisted id and
// an idle appliance would be indistinguishable.
const COOK_ITEM_NONE = 'Not selected'
const COOK_ITEMS = Enum.of({
    [COOK_ITEM_NONE]: 0,
    'Defrost meat': 211,
    'Defrost poultry': 212,
    'Defrost fish': 213,
    'Defrost bread': 214,
    Potato: 243,
    'Boiling water': 245,
    'Canned vegetables': 246,
    Casserole: 247,
    'Chicken pieces': 248,
    'Fish fillets': 249,
    'Fresh vegetables hard': 250,
    'Fresh vegetables soft': 251,
    'Frozen lasagna': 252,
    'Frozen vegetables': 253,
    Popcorn: 254,
    Rice: 255,
    Shrimp: 256,
    'Reheat baked goods': 258,
    Beverage: 259,
    'Reheat casserole': 260,
    'Reheat dinner plate': 261,
    'Reheat pizza': 263,
    'Reheat soup or sauce': 264,
    'Kids corn dog': 3338,
    'Kids mac and cheese': 3346,
    'Soften butter': 3354,
    'Soften cream cheese': 3355,
    'Soften frozen juice': 3357,
    'Soften ice cream': 3358,
    'Melt butter': 3359,
    'Melt cheese': 3361,
    'Melt chocolate': 3362,
    'Melt marshmallow': 3363,
    'Steam asparagus': 3364,
    'Steam broccoli': 3365,
    'Steam brussels sprouts': 3366,
    'Steam carrots': 3367,
    'Steam chicken breast': 3368,
    'Steam fish': 3369,
    'Steam zucchini': 3370,
    'Kids chicken nuggets': 3378,
})

// rec[10]: power level 0-10, matching LWOMGTPowerLevel exactly.
const POWER_LEVEL_OFFSET = 10

// Durations are a minutes byte then a seconds byte: rec[16..17] remaining time (LWORemainTimeMinute
// /Second), rec[22..23] the kitchen timer (LWOTimerMinute/Second). Neither minutes byte is
// minutes-within-an-hour: a 90-minute timer reads 90 and ticks to 60:59 without borrowing, matching
// the cloud's LWOTimerMinute:90 rather than an hour and thirty. rec[15] and rec[21], the bytes
// ahead of each pair, are always 0 and deliberately not read as hours: guessing wrong there would
// silently add whole hours to a duration.
const REMAIN_TIME_OFFSET = 16
const TIMER_OFFSET = 22

// rec[18..20]: the length the running cook was given, as hours/minutes/seconds, matching the
// cloud's LWOTargetTimeHour/Minute plus a seconds byte confirmed on a 30-second half-power run
// (rec[20]=30 with no minutes given). It holds steady while the remaining time ticks and clears
// when the cook is cancelled - that stability is what tells the two fields apart, since a 90-minute
// cook reads 1:30 here while the remaining time counts a flat 90 down.
const COOK_TIME_OFFSET = 18

// rec[36]: vent speed in the low nibble, lamp level in the high nibble. Confirmed by nine
// consecutive single-variable transitions each way: 0x20->0x24 as the cloud stepped
// mwoVentSpeedLevel 0..4 with the lamp untouched, and 0x20->0x00->0x10->0x20 as it stepped
// mwoLampLevel 2,0,1,2 with the vent off.
//
// The vent also runs itself: with range-hood interaction enabled in the ThinQ app, lighting any
// cooktop element on the matching LG range brings the fan to level 1 with no command from here, and
// the last element going out returns it to 0. So this handler's fan entity can change state on its
// own.
const VENT_LAMP_OFFSET = 36

// rec[35]: constant 0x53 field marker preceding the vent/lamp byte, used as a sanity check that the
// record is aligned the way we think it is.
const FIELD_MARKER_OFFSET = 35
const FIELD_MARKER = 0x53

// Vent/lamp set command, 10-byte inner body:
//
//   F0 43 22 04 [fanCmd][fanLevel] [lightCmd][lightLevel] [trailer][trailer]
//     cmd:   0x01 set this control to the level that follows
//            0x00 turn this control off
//            0x80 leave this control exactly as it is
//     level: ABSOLUTE - fan 0-4, lamp 0-2. Issue #93 describes this byte as a count of presses to
//            advance by; on this appliance it is not - fan level 2 sent while running at 4 gave 2,
//            not the 4->off wraparound "advance 4" would produce. The advance reading only agrees
//            when starting from off.
//     trailer: 0x80, "no change", covering the motor/time fields issue #93 documents.
//
// Bytes as the ThinQ app sends them, watched live while driving all four fan speeds and both lamp
// levels: always the absolute level, which is the strongest confirmation the level is not a count.
// Unlike this handler, the app sends 0x00 (not 0x80) for the control it isn't touching, which only
// happens not to matter because that control was already off; sending 0x80 here means one control
// provably cannot disturb the other, so there is no need to track a combined desired state the way
// STUDIO_HOOD.ts does.
const SET_COMMAND = 'f0432204'
const CMD_SET = 0x01
const CMD_OFF = 0x00
const CMD_NO_CHANGE = 0x80
const TRAILER_NO_CHANGE = 0x80
const TRAILER_LENGTH = 2

const MAX_VENT_SPEED = 4
const MAX_LAMP_LEVEL = 2

function clamp(value: number, max: number): number {
    return Math.min(max, Math.max(0, Math.round(value)))
}

export default class Device extends AABBDevice {
    // The last non-zero level each control reported, so HA's plain on/off restores what the user
    // had rather than always jumping to the lowest setting.
    lastVentSpeed = 1
    lastLampLevel = 1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Microwave' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:microwave',
                        device_class: 'enum',
                        options: STATES.options,
                    },
                    cook_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cook_mode',
                        state_topic: '$this/cook_mode',
                        name: 'Cook mode',
                        icon: 'mdi:chef-hat',
                        device_class: 'enum',
                        options: COOK_MODES.options,
                    },
                    cook_item: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cook_item',
                        state_topic: '$this/cook_item',
                        name: 'Cook item',
                        icon: 'mdi:silverware-fork-knife',
                        device_class: 'enum',
                        options: COOK_ITEMS.options,
                    },
                    power_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-power_level',
                        state_topic: '$this/power_level',
                        name: 'Power level',
                        icon: 'mdi:gauge',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 's',
                    },
                    cook_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cook_time',
                        state_topic: '$this/cook_time',
                        name: 'Cook time',
                        icon: 'mdi:timelapse',
                        device_class: 'duration',
                        unit_of_measurement: 's',
                    },
                    timer: {
                        platform: 'sensor',
                        unique_id: '$deviceid-timer',
                        state_topic: '$this/timer',
                        name: 'Kitchen timer',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 's',
                    },
                    fan_power: {
                        platform: 'fan',
                        unique_id: '$deviceid-fan',
                        state_topic: '$this/fan_power',
                        command_topic: '$this/fan_power/set',
                        // Despite the "percentage" naming, HA's MQTT fan integration publishes
                        // and expects raw device-native speeds here once speed_range_min/max are
                        // declared, and converts to and from the percentage slider itself.
                        percentage_state_topic: '$this/fan_speed',
                        percentage_command_topic: '$this/fan_speed/set',
                        speed_range_min: 1,
                        speed_range_max: MAX_VENT_SPEED,
                        name: 'Vent fan',
                        icon: 'mdi:fan',
                    },
                    light_power: {
                        platform: 'light',
                        unique_id: '$deviceid-light',
                        state_topic: '$this/light_power',
                        command_topic: '$this/light_power/set',
                        brightness_state_topic: '$this/light_level',
                        brightness_command_topic: '$this/light_level/set',
                        brightness_scale: MAX_LAMP_LEVEL,
                        name: 'Cooktop light',
                        icon: 'mdi:lightbulb',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== CLASS_BYTE) return

        if (buf[1] === SINGLE_STATUS_FRAME_TYPE && buf.length === SINGLE_STATUS_FRAME_LEN) {
            this.processStatus(buf.subarray(SINGLE_RECORD_OFFSET, SINGLE_RECORD_OFFSET + RECORD_LEN))
        } else if (buf[1] === STATUS_FRAME_TYPE && buf.length === STATUS_FRAME_LEN) {
            this.processStatus(buf.subarray(CURRENT_RECORD_OFFSET, CURRENT_RECORD_OFFSET + RECORD_LEN))
        }
        // Anything else - the 41/3e and 41/72 frames, command acks - carries no state we decode.
    }

    processStatus(rec: Buffer) {
        // Refuse to publish from a record that is not laid out the way every captured one was.
        if (rec.length !== RECORD_LEN || rec[FIELD_MARKER_OFFSET] !== FIELD_MARKER) return

        this.publishProperty('status', STATES.map(rec[STATE_OFFSET]))
        this.publishProperty('cook_mode', COOK_MODES.map(rec[COOK_MODE_OFFSET]))
        this.publishProperty('cook_item', COOK_ITEMS.map(rec.readUInt16BE(COOK_ITEM_OFFSET)))
        this.publishProperty('power_level', rec[POWER_LEVEL_OFFSET])
        this.publishProperty('remaining_time', seconds(rec, REMAIN_TIME_OFFSET))
        this.publishProperty('timer', seconds(rec, TIMER_OFFSET))
        this.publishProperty(
            'cook_time',
            rec[COOK_TIME_OFFSET] * 3600 + rec[COOK_TIME_OFFSET + 1] * 60 + rec[COOK_TIME_OFFSET + 2],
        )

        const ventSpeed = rec[VENT_LAMP_OFFSET] & 0x0f
        const lampLevel = rec[VENT_LAMP_OFFSET] >> 4

        // Remember the last level each control ran at, so a bare "on" from HA restores it.
        if (ventSpeed) this.lastVentSpeed = ventSpeed
        if (lampLevel) this.lastLampLevel = lampLevel

        this.publishProperty('fan_speed', ventSpeed)
        this.publishProperty('fan_power', ventSpeed ? 'ON' : 'OFF')
        this.publishProperty('light_level', lampLevel)
        this.publishProperty('light_power', lampLevel ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fan_power') {
            this.setVent(mqttValue === 'ON' ? this.lastVentSpeed : 0)
        } else if (prop === 'fan_speed') {
            const value = Number(mqttValue)
            if (!Number.isFinite(value)) return
            this.setVent(clamp(value, MAX_VENT_SPEED))
        } else if (prop === 'light_power') {
            this.setLamp(mqttValue === 'ON' ? this.lastLampLevel : 0)
        } else if (prop === 'light_level') {
            const value = Number(mqttValue)
            if (!Number.isFinite(value)) return
            this.setLamp(clamp(value, MAX_LAMP_LEVEL))
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }

    // Each setter touches one control and leaves the other explicitly alone.
    setVent(speed: number) {
        this.sendCommand(speed ? CMD_SET : CMD_OFF, speed, CMD_NO_CHANGE, CMD_NO_CHANGE)
    }

    setLamp(level: number) {
        this.sendCommand(CMD_NO_CHANGE, CMD_NO_CHANGE, level ? CMD_SET : CMD_OFF, level)
    }

    sendCommand(fanCmd: number, fanLevel: number, lightCmd: number, lightLevel: number) {
        this.send(
            Buffer.concat([
                Buffer.from(SET_COMMAND, 'hex'),
                Buffer.from([fanCmd, fanLevel, lightCmd, lightLevel]),
                Buffer.alloc(TRAILER_LENGTH, TRAILER_NO_CHANGE),
            ]),
        )
    }
}

// A minutes/seconds pair, as a duration in seconds. See REMAIN_TIME_OFFSET for why the byte ahead
// of each pair is not treated as hours.
function seconds(rec: Buffer, offset: number): number {
    return rec[offset] * 60 + rec[offset + 1]
}
