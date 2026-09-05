import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG slide-in induction range, marketing model LSIS6338FE, matched on modelId "WLSI_633_"
// (thinq2 deviceType 301). LG's own modelJSON calls it "Studio IH". Read-only.
//
// Frames arrive in the 0xFF-escaped AABB form:
//
//   40 EC <record: previous state> <record: current state>     236 bytes on the wire
//   40 EB <record: current state>                              121 bytes on the wire
//
// Each record is 115 bytes; both frame types share one decoder since 0xEB's record layout matches
// 0xEC's current-state half. The appliance answers start()'s status query with 0xEB.
//
// Every offset and table entry below was confirmed live, bridged to the LG cloud, matching each
// byte change against the cloud's decoded state at the same timestamp.

const STATUS_FRAME_TYPE = 0xec
const STATUS_FRAME_LEN = 232 // 2B header + 115B previous record + 115B current record
const CURRENT_RECORD_OFFSET = 117

const SINGLE_STATUS_FRAME_TYPE = 0xeb
const SINGLE_STATUS_FRAME_LEN = 117 // 2B header + 115B record, no preceding "previous state" half
const SINGLE_RECORD_OFFSET = 2

const RECORD_LEN = 115
const CLASS_BYTE = 0x40

// Status query, sent on connect, so a restarted rethink shows live state without waiting for
// somebody to touch the panel. These are the exact bytes LG's cloud sends this model, captured
// on the wire while bridged.
const STATUS_REQUEST = 'f0ed114101000000181a1017181c272e2f33505356595c00000000000000000000000000'

// rec[14]: oven state. Confirmed on a Bake run (Idle -> Preheating -> Cooking), on raising the
// setpoint mid-cycle (Cooking -> Preheating again) and on cancelling (-> Idle). State 9 accompanies
// every Self Clean frame and nothing else. State 3 matches upperState=DONE when a timed Bake ends
// on its own, and state 4 matches upperState=COOLING, which the appliance passes through for about
// 15 seconds after a cancelled Self Clean before returning to Idle.
const OVEN_STATE_OFFSET = 14
const OVEN_STATES = Enum.of({
    Idle: 0x00,
    Preheating: 0x01,
    Cooking: 0x02,
    Done: 0x03,
    Cooling: 0x04,
    Cleaning: 0x09,
})

// rec[15]: cook mode, bit 7 masked off (see COOK_MODE_MASK below). These are NOT the modelJSON
// UpperCookMode enum indices - Air Fry came through as 0x10 where that enum's index 16 is
// SPEED_ROAST - so the table is built from observed pairings against upperManualCookName only.
//
// Broil sets no temperature; its level is in rec[32] instead. Proof needs a cold oven: started
// warm it puts "Hot" on the display and sends nothing. Self Clean also locks the door, forces all
// five cooktop elements off and starts a four-hour countdown in rec[16..18].
//
// Easy Clean has a knob position but has never been made to start: rotating to it moves nothing in
// the record, so its code is unknown. Like Remote Start (see REMOTE_START_OFFSET), it may need the
// knob turned away and back rather than merely to it.
const COOK_MODE_OFFSET = 15
// The top bit is not part of the mode: it is set when the cycle was started remotely from the ThinQ
// app, matching upperRemoteStartUsing. Published separately below as 'remote_started'.
const COOK_MODE_MASK = 0x7f
const COOK_MODE_REMOTE_STARTED = 0x80

// rec[31] bit 0x01 is Remote Start being armed, the cloud's upperRemoteStart. Bit 0x02 is unrelated:
// it is upperTimerSet, which flips throughout an app conversation as well as when a cycle starts, so
// it is documented rather than published.
const REMOTE_START_OFFSET = 31
const REMOTE_START_ARMED = 0x01
const COOK_MODES = Enum.of({
    Off: 0x00,
    Bake: 0x01,
    'Convection bake': 0x03,
    'Convection roast': 0x04,
    Broil: 0x07,
    Warm: 0x08,
    Proof: 0x09,
    'Frozen meal': 0x0a,
    'Self clean': 0x0f,
    'Air fry': 0x10,
    'Air sous vide': 0x12,
})

// rec[21..22] and rec[23..24]: target and current oven temperature, big-endian 16-bit, matching
// upperTargetTemperatureValue. On the convection modes this is the temperature the oven actually
// runs at, not the one dialled in: LG's convection conversion takes 25F off a 350F setpoint.
//
// The top bit of the target's high byte, rec[21] 0x80, is set when the appliance is in Celsius (a
// 175C bake reads 0x80af). Temperatures are converted to Fahrenheit before publishing, since the
// discovery config declares a fixed unit. The Temperature Adjustment setting does NOT work this
// way: that byte is always Fahrenheit whatever unit it was entered in.
const TARGET_TEMP_OFFSET = 21
const CURRENT_TEMP_OFFSET = 23
const TEMP_VALUE_MASK = 0x7fff

// rec[27]: bit 0x04 is the oven door, matching upperDoorOpen. Bit 0x01 is the motorised door lock,
// which only a Self Clean engages, matching upperDoorLock including its flicker: the lock drops and
// re-engages several times while the cycle runs, which is the appliance's own behavior. Bit 0x20 is
// upperTargetTempShow, a display hint rather than appliance state, so it is not published.
const FLAGS_OFFSET = 27
const FLAG_DOOR_OPEN = 0x04
const FLAG_DOOR_LOCKED = 0x01

// rec[11]: bit 0x01 is the control lock. Do not confuse it with the cloud's controlLockEnable,
// which is a different bit of the same byte, 0x08: that one toggles in lockstep with three FOTA
// fields and upperOptionSet whenever the app is in conversation with the appliance, and flips while
// nobody is touching it.
const CONTROL_LOCK_OFFSET = 11
const CONTROL_LOCK_MASK = 0x01

// rec[0]: the clock format, the cloud's settingHourMode. 0 is 24-hour, 1 is 12-hour. Note the
// matching washer uses its rec[0] as a record marker instead, so the two records diverge from the
// first byte.
const CLOCK_FORMAT_OFFSET = 0
const CLOCK_FORMATS = Enum.of({
    '24-hour': 0,
    '12-hour': 1,
})

// rec[1]: Auto Conversion, the cloud's settingConvAutoConversion, 1 enabled and 0 not. The app
// describes it as "When using convection modes, the entered temperature is automatically reduced
// by 25°F (14°C)" - the setting behind the 25F offset the convection modes show. See
// TARGET_TEMP_OFFSET.
const AUTO_CONVERSION_OFFSET = 1

// rec[3]: Temperature Adjustment, the app's name for the oven thermostat trim, the cloud's
// settingAdjustUpperTempValue. A SIGNED byte in the appliance's own temperature unit: -1 arrives as
// 255. 0 is no adjustment, also what the byte reads when the setting is off entirely.
//
// The app takes the adjustment in either scale and converts before sending, so the wire always
// carries the appliance's own unit regardless of which scale it was entered in. Published here in
// Fahrenheit like the temperatures, but converted as a DIFFERENCE - 1.8 degrees F per degree C with
// no 32-degree offset, since zero is zero in both scales.
const TEMPERATURE_ADJUSTMENT_OFFSET = 3

// rec[2]: the temperature unit, the cloud's settingAdjustUnit, 0 Fahrenheit and 1 Celsius.
const TEMPERATURE_UNIT_OFFSET = 2
const TEMPERATURE_UNITS = Enum.of({
    '°F': 0,
    '°C': 1,
})

// rec[5]: the Preheating Alarm Light, one setting despite the name reading like two (the ThinQ app
// spells it that way; the cloud calls it settingPreheatAlarm). 1 on, 0 off.
const PREHEATING_ALARM_LIGHT_OFFSET = 5

// rec[10]: Auto Remote, the cloud's settingAutoRemoteSet, 1 enabled and 0 not. The app describes it
// as "Starting cooking on the product automatically turns on Remote Start" - worth knowing since
// with this on, a cycle started at the appliance itself will still show remote start enabled
// afterwards.
const AUTO_REMOTE_OFFSET = 10

// rec[6] and rec[9]: two separate beeper volumes sharing one encoding, rec[6] the oven's
// (settingBeepVolume) and rec[9] the cooktop's (settingCooktopBeepVolume). The ThinQ app labels
// both controls just "Beeper Volume", so the names here carry the section to keep them distinct.
// The oven offers Mute, Low and High; the cooktop only Mute and High.
const OVEN_BEEPER_VOLUME_OFFSET = 6
const COOKTOP_BEEPER_VOLUME_OFFSET = 9
const BEEPER_VOLUMES = Enum.of({
    Mute: 0,
    Low: 1,
    High: 2,
})

// rec[28..30]: kitchen timer seconds, minutes, hours. Confirmed on a one-hour timer that reported
// 1h, then 59m59s as it started counting down.
const TIMER_OFFSET = 28

// rec[32]: the broil level, read 1 for Lo and 3 for Hi by selecting each at the panel. Zero under
// every other mode and whenever the oven is idle, so 'Off' is what zero means rather than a missing
// reading. Whether 2 is a level this range offers has not been established.
const BROIL_LEVEL_OFFSET = 32
const BROIL_LEVELS = Enum.of({
    Off: 0x00,
    Low: 0x01,
    High: 0x03,
})

// rec[16..18]: how much of the running cycle is left, in the same seconds, minutes, hours order as
// the kitchen timer above. rec[19..20]: the length that cycle was given, minutes and hours with no
// seconds byte, held for as long as it runs. Modes that take no duration leave all five bytes at
// zero.
const REMAINING_OFFSET = 16
const COOK_TIME_OFFSET = 19

// The cooktop is five three-byte blocks at rec[60], rec[63], rec[66], rec[69] and rec[72]: an
// element state, its running time in whole minutes (matches cooktopNOperationTimeMinute, resets to
// 0 when the element goes out - not published, a minute-resolution counter that resets on every use
// is of little use in HA), then a byte that has never moved. There is no power-level byte: stepping
// one element through its whole range moved nothing else in the record.
//
// LG's cloud numbers the elements in an order that is not the record's: rec[60] is cooktop1, rec[66]
// cooktop2, rec[69] cooktop5, rec[72] cooktop3, rec[63] cooktop4. Named at the panel as lit: front
// left onto rec[60], front right onto rec[63], rear left onto rec[66], rear right onto rec[69], rear
// center onto rec[72].
//
// Lighting any element also runs the matching LG microwave's hood fan, at level 1, when that
// interaction is enabled in the ThinQ app. Documented here only because it explains a microwave
// changing state with nobody touching it; nothing of it appears in this record.
const COOKTOPS: { key: string; name: string; offset: number }[] = [
    { key: 'cooktop_front_left', name: 'Front left element', offset: 60 },
    { key: 'cooktop_front_right', name: 'Front right element', offset: 63 },
    { key: 'cooktop_rear_left', name: 'Rear left element', offset: 66 },
    { key: 'cooktop_rear_right', name: 'Rear right element', offset: 69 },
    { key: 'cooktop_center', name: 'Rear center element', offset: 72 },
]
// 1 is COOKING_IN_PROGRESS. Locking the panel, or starting a Self Clean, puts all five into state 3
// (the cloud's LOCK) at once, so that state counts as off rather than "not zero means on" - which
// would report every element lit exactly when nothing is heating.
const COOKTOP_STATE_OFF = 0x00
const COOKTOP_STATE_LOCKED = 0x03

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Range' }),
                components: {
                    oven_status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-oven_status',
                        state_topic: '$this/oven_status',
                        name: 'Oven status',
                        icon: 'mdi:stove',
                        device_class: 'enum',
                        options: OVEN_STATES.options,
                    },
                    oven_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-oven_mode',
                        state_topic: '$this/oven_mode',
                        name: 'Oven mode',
                        icon: 'mdi:chef-hat',
                        device_class: 'enum',
                        options: COOK_MODES.options,
                    },
                    broil_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-broil_level',
                        state_topic: '$this/broil_level',
                        name: 'Broil level',
                        icon: 'mdi:fire',
                        device_class: 'enum',
                        options: BROIL_LEVELS.options,
                    },
                    target_temperature: {
                        platform: 'sensor',
                        unique_id: '$deviceid-target_temperature',
                        state_topic: '$this/target_temperature',
                        name: 'Oven target temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°F',
                    },
                    current_temperature: {
                        platform: 'sensor',
                        unique_id: '$deviceid-current_temperature',
                        state_topic: '$this/current_temperature',
                        name: 'Oven temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°F',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                    remote_started: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_started',
                        state_topic: '$this/remote_started',
                        name: 'Started remotely',
                        icon: 'mdi:cellphone-check',
                        entity_category: 'diagnostic',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door', // payload ON = open, OFF = closed
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' — that class is inverted (on = unlocked)
                    },
                    clock_format: {
                        platform: 'sensor',
                        unique_id: '$deviceid-clock_format',
                        state_topic: '$this/clock_format',
                        name: 'Clock format',
                        icon: 'mdi:clock-outline',
                        device_class: 'enum',
                        options: CLOCK_FORMATS.options,
                        entity_category: 'diagnostic',
                    },
                    auto_remote: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-auto_remote',
                        state_topic: '$this/auto_remote',
                        name: 'Auto remote',
                        icon: 'mdi:cellphone-cog',
                        entity_category: 'diagnostic',
                    },
                    temperature_adjustment: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temperature_adjustment',
                        state_topic: '$this/temperature_adjustment',
                        name: 'Temperature adjustment',
                        icon: 'mdi:thermometer-plus',
                        device_class: 'temperature',
                        // Converted to Fahrenheit as a difference, not an absolute temperature. See
                        // TEMPERATURE_ADJUSTMENT_OFFSET.
                        unit_of_measurement: '°F',
                        entity_category: 'diagnostic',
                    },
                    temperature_unit: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temperature_unit',
                        state_topic: '$this/temperature_unit',
                        name: 'Temperature unit',
                        icon: 'mdi:temperature-fahrenheit',
                        device_class: 'enum',
                        options: TEMPERATURE_UNITS.options,
                        entity_category: 'diagnostic',
                    },
                    auto_conversion: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-auto_conversion',
                        state_topic: '$this/auto_conversion',
                        name: 'Auto conversion',
                        icon: 'mdi:thermometer-auto',
                        entity_category: 'diagnostic',
                    },
                    preheating_alarm_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-preheating_alarm_light',
                        state_topic: '$this/preheating_alarm_light',
                        name: 'Preheating alarm light',
                        icon: 'mdi:bell-ring-outline',
                        entity_category: 'diagnostic',
                    },
                    oven_beeper_volume: {
                        platform: 'sensor',
                        unique_id: '$deviceid-oven_beeper_volume',
                        state_topic: '$this/oven_beeper_volume',
                        name: 'Oven beeper volume',
                        icon: 'mdi:volume-high',
                        device_class: 'enum',
                        options: BEEPER_VOLUMES.options,
                        entity_category: 'diagnostic',
                    },
                    cooktop_beeper_volume: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cooktop_beeper_volume',
                        state_topic: '$this/cooktop_beeper_volume',
                        name: 'Cooktop beeper volume',
                        icon: 'mdi:volume-high',
                        device_class: 'enum',
                        options: BEEPER_VOLUMES.options,
                        entity_category: 'diagnostic',
                    },
                    control_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock', // NOT device_class 'lock' — that class is inverted (on = unlocked)
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
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
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
                    ...Object.fromEntries(
                        COOKTOPS.map((c) => [
                            c.key,
                            {
                                platform: 'binary_sensor',
                                unique_id: '$deviceid-' + c.key,
                                state_topic: '$this/' + c.key,
                                name: c.name,
                                icon: 'mdi:circle-outline',
                            },
                        ]),
                    ),
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
        // The 40/b1 burner events and 40/0a content lists carry nothing this handler has
        // confirmed, so they are ignored rather than guessed at.
    }

    processStatus(rec: Buffer) {
        if (rec.length !== RECORD_LEN) return

        this.publishProperty('oven_status', OVEN_STATES.map(rec[OVEN_STATE_OFFSET]))
        this.publishProperty('oven_mode', COOK_MODES.map(rec[COOK_MODE_OFFSET] & COOK_MODE_MASK))
        this.publishProperty('broil_level', BROIL_LEVELS.map(rec[BROIL_LEVEL_OFFSET]))

        // Both temperatures read zero when the appliance has nothing to say: with the oven off,
        // and also for the current temperature in the first frames of an Air Fry run, before the
        // cavity sensor is reported. An oven never genuinely reads 0F, so zero publishes unknown
        // rather than a number that would plot as a real reading.
        const celsius = inCelsius(rec)
        this.publishProperty('target_temperature', temperature(rec, TARGET_TEMP_OFFSET, celsius))
        this.publishProperty('current_temperature', temperature(rec, CURRENT_TEMP_OFFSET, celsius))

        this.publishProperty('remote_start', rec[REMOTE_START_OFFSET] & REMOTE_START_ARMED ? 'ON' : 'OFF')
        this.publishProperty('remote_started', rec[COOK_MODE_OFFSET] & COOK_MODE_REMOTE_STARTED ? 'ON' : 'OFF')
        this.publishProperty('door', rec[FLAGS_OFFSET] & FLAG_DOOR_OPEN ? 'ON' : 'OFF')
        this.publishProperty('door_lock', rec[FLAGS_OFFSET] & FLAG_DOOR_LOCKED ? 'ON' : 'OFF')
        this.publishProperty('timer', duration(rec, TIMER_OFFSET))
        this.publishProperty('remaining_time', duration(rec, REMAINING_OFFSET))
        this.publishProperty('cook_time', rec[COOK_TIME_OFFSET + 1] * 3600 + rec[COOK_TIME_OFFSET] * 60)

        this.publishProperty('control_lock', rec[CONTROL_LOCK_OFFSET] & CONTROL_LOCK_MASK ? 'ON' : 'OFF')
        this.publishProperty('preheating_alarm_light', rec[PREHEATING_ALARM_LIGHT_OFFSET] ? 'ON' : 'OFF')
        this.publishProperty('clock_format', CLOCK_FORMATS.map(rec[CLOCK_FORMAT_OFFSET]))
        this.publishProperty('auto_conversion', rec[AUTO_CONVERSION_OFFSET] ? 'ON' : 'OFF')
        this.publishProperty('auto_remote', rec[AUTO_REMOTE_OFFSET] ? 'ON' : 'OFF')
        const adjustment = rec.readInt8(TEMPERATURE_ADJUSTMENT_OFFSET)
        this.publishProperty('temperature_adjustment', celsius ? Math.round(adjustment * 1.8) : adjustment)
        this.publishProperty('temperature_unit', TEMPERATURE_UNITS.map(rec[TEMPERATURE_UNIT_OFFSET]))
        this.publishProperty('oven_beeper_volume', BEEPER_VOLUMES.map(rec[OVEN_BEEPER_VOLUME_OFFSET]))
        this.publishProperty('cooktop_beeper_volume', BEEPER_VOLUMES.map(rec[COOKTOP_BEEPER_VOLUME_OFFSET]))

        for (const cooktop of COOKTOPS) this.publishProperty(cooktop.key, cooktopState(rec[cooktop.offset]))
    }
}

// Whether a cooktop element is heating. Only the two states known to mean it is not are treated as
// off, so a state this appliance has not shown yet (the only other value seen is 1, COOKING) still
// reports the element as on.
function cooktopState(state: number): string {
    if (state === COOKTOP_STATE_OFF || state === COOKTOP_STATE_LOCKED) return 'OFF'
    return 'ON'
}

// A seconds, minutes, hours triple, in seconds.
function duration(rec: Buffer, offset: number): number {
    return rec[offset + 2] * 3600 + rec[offset + 1] * 60 + rec[offset]
}

// A big-endian 16-bit temperature, published in Fahrenheit whatever the appliance is set to, or
// undefined when the appliance reports zero. The top bit of the pair is the Celsius flag rather
// than part of the value, so it is masked off before anything else.
function temperature(rec: Buffer, offset: number, celsius: boolean): number | undefined {
    const value = rec.readUInt16BE(offset) & TEMP_VALUE_MASK
    if (value === 0) return undefined
    return celsius ? Math.round(value * 1.8 + 32) : value
}

// Whether the appliance is reporting temperatures in Celsius, from the unit setting at rec[2]
// rather than from the flag on the target field: that flag is only present while a setpoint is, so
// an idle oven in Celsius has a target of 0 and no flag.
function inCelsius(rec: Buffer): boolean {
    return rec[TEMPERATURE_UNIT_OFFSET] === TEMPERATURE_UNITS.unmap('°C')
}
