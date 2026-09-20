import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'

// LG oven reporting modelName "WFV474PGV" (deviceType 301, QCOM_QCA4010).
//
// Live captures establish the transport framing, status fields, timer commands, cavity cancel
// selectors, and four remote-start operation profiles. Observed frame types:
//
//   0x40 0xEB  single current-status block, sent in reply to the status query in start()
//   0x40 0xEC  previous and current status blocks, concatenated in that order
//   0x40 0x31  component manifest (observed serial SAA39155903)
//   0x40 0x72  one-shot event (timer expiry: 03 F5 0A; upper cook completion: 00 04 0A)
//
// Cloud-to-device writes seen so far are the F0 43 family (0x20 cavity start, 0x21 preference /
// clock write, 0x23 timer) and the F0 44 cavity cancel.
//
// The known EB frame is 0x44 bytes on the wire and the EC frame is 0x82 bytes, making each status
// block 62 bytes. Bytes that are not decoded stay out of Home Assistant; frames that are not
// understood are logged only.
//
// The LG app presents three tabs: Cooktop, Upper Oven, and Lower Oven. Both oven tabs expose
// temperature and cook time, and the app also has a settable timer. Writes are limited to captured
// command shapes. The Upper operation exposed by the LG app is Bake; command operation 0x01 reports
// as mode 0x81.
//
// The oven enforces the Remote Start arming lockout itself: a start sent to an unarmed cavity is
// answered with the rejection acknowledgement below and nothing happens. The Start buttons are
// gated in Home Assistant through the readiness topic's availability, and no further check is made
// here — see the "Safety interlocks" rule in CONTRIBUTING.md.

const CLASS_BYTE = 0x40
const SINGLE_STATUS_FRAME_TYPE = 0xeb
const STATUS_FRAME_TYPE = 0xec
const STATUS_RECORD_LENGTH = 62

// The status record contains five repeated 5-byte cooktop slots beginning at offset 36. Their leading
// bytes all changed 0x00 -> 0x01 in one EC frame when the cooktop was turned on, remained 0x01 while
// it stayed on, and returned 0x01 -> 0x00 together in the turn-off EC frame. These are redundant copies
// of a global cooktop state/run time rather than independent burner states. Treat the cooktop as active
// when any copy is active.
const COOKTOP_SLOT_STATE_OFFSETS = [36, 41, 46, 51, 56]

// Confirmed by setting the app timer to 09:01:13 and observing both the initial status and the
// 09:01:01 -> 09:00:59 rollover. Values are ordinary binary integers, not BCD.
const TIMER_SECONDS_OFFSET = 30
const TIMER_MINUTES_OFFSET = 31
const TIMER_HOURS_OFFSET = 32

// Preference write, subcommand 0x21. The app's Preference screen defaults every row to "No Change"
// and cannot read any of these values back from the appliance, so one frame carries the whole set and
// marks each untouched field 0x80. That is also what the three 0x80 bytes in the timer command are.
// Payload layout, zero-based:
//
//   0      clock hours
//   1      clock minutes
//   2      hour format / meridiem — see CLOCK_HOUR_FORMAT_24H
//   3      auto conversion
//   4      temperature adjustment unit
//   5      upper temperature adjustment, signed
//   6      lower temperature adjustment, signed
//   7      preheating alarm light
//   8      beeper volume
//   9      temperature unit shown on the oven's own display
//   11     0xFF when untouched, a distinct sentinel from the 0x80 used everywhere else
//   others not yet identified; every capture so far left them at 0x80
//
// The 0x0E length byte does not match the 13-byte payload, unlike the 0x20 start and 0x23 timer
// subcommands where the equivalent byte does, so it is reproduced from the captures rather than
// computed from the payload.
const PREFERENCE_COMMAND_PREFIX = [0xf0, 0x43, 0x21, 0x0e]
const PREFERENCE_PAYLOAD_LENGTH = 13
const PREFERENCE_NO_CHANGE = 0x80
const PREFERENCE_FF_INDEX = 11
const PREFERENCE_FF_NO_CHANGE = 0xff
const CLOCK_HOURS_INDEX = 0
const CLOCK_MINUTES_INDEX = 1
const CLOCK_HOUR_FORMAT_INDEX = 2
// Byte 2 was 0x01 with the hour sent as 11, and 0x00 with the same wall-clock time sent as 23. That
// fits both "hour format selector" and "meridiem flag", and the wire alone cannot separate them.
// The handler writes the 0x00 shape, which carries the full 0-23 hour and is therefore unambiguous
// under either reading; the 0x01 shape is not exposed until its meaning is confirmed.
const CLOCK_HOUR_FORMAT_24H = 0x00

// Listed in the order the LG app's Beeper Volume screen presents them.
const BEEPER_VOLUME_INDEX = 8
const BEEPER_VOLUMES = Enum.of({ High: 0x02, Low: 0x01, Mute: 0x00 })

// The light blinks when a cavity reaches its setpoint and keeps blinking until the door is opened.
const PREHEAT_ALARM_LIGHT_INDEX = 7
const PREHEAT_ALARM_LIGHT_OFF = 0x00
const PREHEAT_ALARM_LIGHT_ON = 0x01

// This is the unit the appliance displays; it does NOT change the status record, which kept reporting
// Fahrenheit ambient temperatures across the switch. Status decoding is therefore unaffected by this setting.
const TEMPERATURE_UNIT_INDEX = 9
const TEMPERATURE_UNITS = Enum.of({ '°F': 0x00, '°C': 0x01 })

// This is almost certainly the appliance behaviour already seen in status: a convection start reports
// a setpoint 25°F below what was commanded (300°F Convection Bake reported 275°F, 350°F Convection Roast
// reported 325°F). That link is untested, so nothing in status decoding depends on this setting.
const AUTO_CONVERSION_INDEX = 3
const AUTO_CONVERSION_OFF = 0x00
const AUTO_CONVERSION_ON = 0x01

// The app's own picker allows ±35°F, or ±19°C for the same span. Since the handler always writes °F
// these are the exact bounds the LG app enforces, not an assumed range.
const TEMPERATURE_ADJUSTMENT_UNIT_INDEX = 4
const TEMPERATURE_ADJUSTMENT_INDEXES: Record<CavityId, number> = { upper: 5, lower: 6 }
const MIN_TEMPERATURE_ADJUSTMENT = -35
const MAX_TEMPERATURE_ADJUSTMENT = 35

// The cavity blocks are 18 bytes apart. An app command explicitly labelled Upper populated only the
// first block, confirming the order. The three-minute run then counted 00:03:00 -> 00:02:59 at these
// offsets. Set temperatures are unsigned 16-bit big-endian values at 5-6 and 23-24; this was proven
// when Lower Convection Roast requested 350°F (01 5E) and reported an auto-converted 325°F (01 45).
const UPPER_CAVITY_OFFSET = 0
const LOWER_CAVITY_OFFSET = 18
const CAVITY_STATE_OFFSET = 0
const CAVITY_MODE_OFFSET = 1
const CAVITY_COOK_SECONDS_OFFSET = 2
const CAVITY_COOK_MINUTES_OFFSET = 3
const CAVITY_COOK_HOURS_OFFSET = 4
const CAVITY_SET_TEMPERATURE_OFFSET = 5
const CAVITY_CURRENT_TEMPERATURE_OFFSET = 7
const CAVITY_REMOTE_START_OFFSET = 15
// Captures show this byte taking several values that don't decompose into independent bits:
// 0x0E idle, 0x08 while being armed, 0x01 once armed, 0x02 while the other cavity is active, and
// 0x06 after the completion alarm is cleared. It reads as a small status enum rather than a
// bitfield, and 0x01 is the only value ever observed while Start was actually accepted.
const REMOTE_START_READY = 0x01
const UPPER_BAKE_OPERATION = 0x01
const LOWER_BAKE_OPERATION = 0x15
const LOWER_CONVECTION_BAKE_OPERATION = 0x17
const LOWER_CONVECTION_ROAST_OPERATION = 0x18
const LOWER_REMOTE_MODES = Enum.of({
    Bake: LOWER_BAKE_OPERATION,
    'Convection Bake': LOWER_CONVECTION_BAKE_OPERATION,
    'Convection Roast': LOWER_CONVECTION_ROAST_OPERATION,
})
type LowerRemoteMode = (typeof LOWER_REMOTE_MODES)['options'][number]

const OVEN_STATES = Enum.of({
    Idle: 0x00,
    Preheating: 0x01,
    Active: 0x02,
    Complete: 0x03,
})
// Every captured remote start reports mode = operation | 0x80 (0x01 -> 0x81, 0x15 -> 0x95,
// 0x17 -> 0x97, 0x18 -> 0x98), while the one captured panel-started cook (Broil) reported a bare
// 0x07 — consistent with 0x80 flagging a remotely started cook. The flag is masked off before the
// lookup so panel-started cooks decode too; a panel-started Bake capture would confirm the theory.
//
// Bake carries both cavities' codes: the upper cavity reports 0x01 and the lower 0x15.
const OVEN_MODES = Enum.of({
    None: 0x00,
    Bake: [LOWER_BAKE_OPERATION, UPPER_BAKE_OPERATION],
    Broil: 0x07,
    'Convection Bake': LOWER_CONVECTION_BAKE_OPERATION,
    'Convection Roast': LOWER_CONVECTION_ROAST_OPERATION,
})

// Home Assistant bounds the user-facing inputs to the appliance's normal Fahrenheit range. The
// command itself carries an unsigned 16-bit value; 170°F and 350°F were confirmed on the wire.
const MIN_REMOTE_TEMPERATURE = 170
const MAX_REMOTE_TEMPERATURE = 550
const REMOTE_TEMPERATURE_STEP = 5
const MAX_REMOTE_COOK_TIME_MINUTES = 24 * 60

type CavityId = 'upper' | 'lower'
const CAVITY_IDS: CavityId[] = ['upper', 'lower']
const CAVITY_TITLES: Record<CavityId, string> = { upper: 'Upper', lower: 'Lower' }
// The app cancel command explicitly labelled Upper carried selector 0x00; Lower carried 0x01.
const CAVITY_CANCEL_SELECTORS: Record<CavityId, number> = { upper: 0x00, lower: 0x01 }

type CavityRemoteParams = { temperature: number; cookTime: number }
type RemoteParams = {
    upper: CavityRemoteParams
    lower: CavityRemoteParams
    lowerMode: LowerRemoteMode
}

// OBSERVED from LG's cloud, not inferred. The complete packet on the wire is:
//   aa28f0ed114101000000181a0207080c14191a1e262b30353a00000000000000000000000000f3bb
const STATUS_QUERY = 'f0ed114101000000181a0207080c14191a1e262b30353a00000000000000000000000000'

function cavitySensorComponents(cavity: CavityId) {
    const oven = `${cavity}_oven`
    const title = CAVITY_TITLES[cavity]
    return {
        [`${oven}_temperature`]: {
            platform: 'sensor',
            device_class: 'temperature',
            icon: 'mdi:thermometer',
            unique_id: `$deviceid-${oven}_temperature`,
            state_topic: `$this/${oven}_temperature`,
            name: `${title} Oven Current Temperature`,
            unit_of_measurement: '°F',
        },
        [`${oven}_status`]: {
            platform: 'sensor',
            device_class: 'enum',
            icon: 'mdi:stove',
            unique_id: `$deviceid-${oven}_status`,
            state_topic: `$this/${oven}_status`,
            name: `${title} Oven State`,
            options: OVEN_STATES.options,
        },
        [`${oven}_mode`]: {
            platform: 'sensor',
            device_class: 'enum',
            icon: 'mdi:chef-hat',
            unique_id: `$deviceid-${oven}_mode`,
            state_topic: `$this/${oven}_mode`,
            name: `${title} Oven Mode`,
            options: OVEN_MODES.options,
        },
        [`${oven}_set_temperature`]: {
            platform: 'sensor',
            device_class: 'temperature',
            icon: 'mdi:thermometer-chevron-up',
            unique_id: `$deviceid-${oven}_set_temperature`,
            state_topic: `$this/${oven}_set_temperature`,
            name: `${title} Oven Set Temperature`,
            unit_of_measurement: '°F',
        },
        [`${oven}_cook_time`]: {
            platform: 'sensor',
            device_class: 'duration',
            icon: 'mdi:timer-outline',
            unique_id: `$deviceid-${oven}_cook_time`,
            state_topic: `$this/${oven}_cook_time`,
            name: `${title} Oven Cook Time`,
            // The record counts down once a second, so seconds is the unit that loses nothing.
            unit_of_measurement: 's',
        },
        [`${oven}_remote_start`]: {
            platform: 'binary_sensor',
            icon: 'mdi:remote',
            unique_id: `$deviceid-${oven}_remote_start`,
            state_topic: `$this/${oven}_remote_start`,
            name: `${title} Oven Remote Start Ready`,
            payload_on: 'ON',
            payload_off: 'OFF',
        },
    }
}

// Write-only, like every other Preference row: the oven reports no trim and the LG app cannot read
// one back, so Home Assistant tracks the value itself.
function cavityTemperatureAdjustmentComponents(cavity: CavityId) {
    const title = CAVITY_TITLES[cavity]
    return {
        [`${cavity}_temperature_adjustment`]: {
            platform: 'number',
            device_class: 'temperature',
            icon: 'mdi:thermometer-plus',
            unique_id: `$deviceid-${cavity}_temperature_adjustment`,
            command_topic: `$this/${cavity}_temperature_adjustment/set`,
            unit_of_measurement: '°F',
            min: MIN_TEMPERATURE_ADJUSTMENT,
            max: MAX_TEMPERATURE_ADJUSTMENT,
            step: 1,
            mode: 'box',
            optimistic: true,
            name: `${title} Temperature Adjustment`,
        },
    }
}

function cavityRemoteComponents(cavity: CavityId) {
    const title = CAVITY_TITLES[cavity]
    return {
        [`${cavity}_remote_temperature`]: {
            platform: 'number',
            device_class: 'temperature',
            icon: 'mdi:thermometer-chevron-up',
            unique_id: `$deviceid-${cavity}_remote_temperature`,
            state_topic: `$this/${cavity}_remote_temperature`,
            command_topic: `$this/${cavity}_remote_temperature/set`,
            unit_of_measurement: '°F',
            min: MIN_REMOTE_TEMPERATURE,
            max: MAX_REMOTE_TEMPERATURE,
            step: REMOTE_TEMPERATURE_STEP,
            mode: 'box',
            name: `${title} Remote Temperature`,
        },
        [`${cavity}_remote_cook_time`]: {
            platform: 'number',
            device_class: 'duration',
            icon: 'mdi:timer-outline',
            unique_id: `$deviceid-${cavity}_remote_cook_time`,
            state_topic: `$this/${cavity}_remote_cook_time`,
            command_topic: `$this/${cavity}_remote_cook_time/set`,
            unit_of_measurement: 'min',
            min: 0,
            max: MAX_REMOTE_COOK_TIME_MINUTES,
            step: 1,
            mode: 'box',
            name: `${title} Remote Cook Time`,
        },
        [`${cavity}_start`]: {
            platform: 'button',
            icon: 'mdi:play-circle-outline',
            unique_id: `$deviceid-${cavity}_start`,
            command_topic: `$this/${cavity}_start/set`,
            payload_press: 'PRESS',
            name: cavity === 'upper' ? 'Start Upper Bake' : 'Start Lower',
            availability: [
                { topic: '$this/availability' },
                { topic: '$rethink/availability' },
                {
                    topic: `$this/${cavity}_oven_remote_start`,
                    payload_available: 'ON',
                    payload_not_available: 'OFF',
                },
            ],
            availability_mode: 'all',
        },
        [`${cavity}_cancel`]: {
            platform: 'button',
            icon: 'mdi:stop-circle-outline',
            unique_id: `$deviceid-${cavity}_cancel`,
            command_topic: `$this/${cavity}_cancel/set`,
            payload_press: 'PRESS',
            name: `Cancel ${title}`,
        },
    }
}

export default class Device extends AABBDevice {
    remote: RemoteParams = {
        upper: { temperature: 350, cookTime: 10 },
        lower: { temperature: 350, cookTime: 10 },
        lowerMode: 'Bake',
    }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Oven' }),
                components: {
                    cooktop_status: {
                        platform: 'binary_sensor',
                        icon: 'mdi:stove',
                        unique_id: '$deviceid-cooktop_status',
                        state_topic: '$this/cooktop_status',
                        name: 'Cooktop',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    ...cavitySensorComponents('upper'),
                    ...cavitySensorComponents('lower'),
                    timer: {
                        platform: 'text',
                        icon: 'mdi:timer',
                        unique_id: '$deviceid-timer',
                        state_topic: '$this/timer',
                        command_topic: '$this/timer/set',
                        pattern: '^\\d{2}:[0-5]\\d:[0-5]\\d$',
                        name: 'Timer',
                    },
                    timer_stop: {
                        platform: 'button',
                        icon: 'mdi:timer-stop-outline',
                        unique_id: '$deviceid-timer_stop',
                        command_topic: '$this/timer_stop/set',
                        payload_press: 'PRESS',
                        name: 'Stop / Acknowledge Timer',
                    },
                    clock_sync: {
                        platform: 'button',
                        icon: 'mdi:clock-check-outline',
                        unique_id: '$deviceid-clock_sync',
                        command_topic: '$this/clock_sync/set',
                        payload_press: 'PRESS',
                        name: 'Sync Clock',
                    },
                    // The appliance never reports its beeper volume and the LG app cannot read it
                    // back either, so there is no state to publish: HA tracks the selection itself.
                    beeper_volume: {
                        platform: 'select',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-beeper_volume',
                        command_topic: '$this/beeper_volume/set',
                        options: BEEPER_VOLUMES.options,
                        optimistic: true,
                        name: 'Beeper Volume',
                    },
                    // Write-only for the same reason as the beeper volume above.
                    preheat_alarm_light: {
                        platform: 'switch',
                        icon: 'mdi:lightbulb-on-outline',
                        unique_id: '$deviceid-preheat_alarm_light',
                        command_topic: '$this/preheat_alarm_light/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                        name: 'Preheating Alarm Light',
                    },
                    // Display-only, and write-only like its neighbours. Home Assistant keeps
                    // reporting this device's temperatures in °F whatever is selected here.
                    temperature_unit: {
                        platform: 'select',
                        icon: 'mdi:thermometer',
                        unique_id: '$deviceid-temperature_unit',
                        command_topic: '$this/temperature_unit/set',
                        options: TEMPERATURE_UNITS.options,
                        optimistic: true,
                        name: 'Temperature Unit',
                    },
                    // Write-only like its neighbours.
                    auto_conversion: {
                        platform: 'switch',
                        icon: 'mdi:thermometer-auto',
                        unique_id: '$deviceid-auto_conversion',
                        command_topic: '$this/auto_conversion/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                        name: 'Auto Conversion',
                    },
                    ...cavityTemperatureAdjustmentComponents('upper'),
                    ...cavityTemperatureAdjustmentComponents('lower'),
                    ...cavityRemoteComponents('upper'),
                    ...cavityRemoteComponents('lower'),
                    lower_remote_mode: {
                        platform: 'select',
                        icon: 'mdi:chef-hat',
                        unique_id: '$deviceid-lower_remote_mode',
                        state_topic: '$this/lower_remote_mode',
                        command_topic: '$this/lower_remote_mode/set',
                        options: LOWER_REMOTE_MODES.options,
                        name: 'Lower Remote Mode',
                    },
                },
            }),
        )
        for (const cavity of CAVITY_IDS) {
            this.publishProperty(`${cavity}_remote_temperature`, this.remote[cavity].temperature)
            this.publishProperty(`${cavity}_remote_cook_time`, this.remote[cavity].cookTime)
            // Readiness is trusted only from live status. Force the retained topic to OFF so a
            // stale retained ON from a previous run cannot enable the Start button before the first
            // status reply arrives.
            this.publishProperty(`${cavity}_oven_remote_start`, 'OFF')
        }
        this.publishProperty('lower_remote_mode', this.remote.lowerMode)
    }

    start() {
        this.send(Buffer.from(STATUS_QUERY, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length >= 2 && buf[0] === CLASS_BYTE) {
            // Generic acknowledgements echo the app command family in byte 2 and a result in byte 3.
            // Observed families are 0x43 for set/start and 0x44 for oven cancel. Result 0x00 is
            // success; 0x40 came back from a remote start aimed at a cavity whose Remote Start was
            // not armed, so a rejection is reported rather than silently dropped.
            if (buf.length === 4 && buf[1] === 0x00 && (buf[2] === 0x43 || buf[2] === 0x44)) {
                if (buf[3] !== 0x00) log('WFV474PGV', 'command rejected by the oven', buf.toString('hex'))
                return
            }

            if (buf[1] === SINGLE_STATUS_FRAME_TYPE && buf.length === 2 + STATUS_RECORD_LENGTH) {
                this.publishStatus(buf.subarray(2))
                return
            }

            // EC carries equal-sized previous/current blocks. Only current state should be published.
            if (buf[1] === STATUS_FRAME_TYPE && buf.length === 2 + STATUS_RECORD_LENGTH * 2) {
                this.publishStatus(buf.subarray(2 + STATUS_RECORD_LENGTH))
                return
            }
        }

        // Everything else — unknown opcodes, foreign class bytes, unexpected record lengths. None of
        // it is decoded, so it is logged for further reverse engineering rather than published.
        log('WFV474PGV', 'undecoded frame', buf.toString('hex'))
    }

    publishStatus(current: Buffer) {
        this.publishProperty(
            'timer',
            Device.formatTime(
                current[TIMER_HOURS_OFFSET],
                current[TIMER_MINUTES_OFFSET],
                current[TIMER_SECONDS_OFFSET],
            ),
        )
        this.publishCavity('upper', current.subarray(UPPER_CAVITY_OFFSET, UPPER_CAVITY_OFFSET + 18))
        this.publishCavity('lower', current.subarray(LOWER_CAVITY_OFFSET, LOWER_CAVITY_OFFSET + 18))

        const cooktopOn = COOKTOP_SLOT_STATE_OFFSETS.some((offset) => current[offset] !== 0)
        this.publishProperty('cooktop_status', cooktopOn ? 'ON' : 'OFF')
    }

    publishCavity(cavity: CavityId, current: Buffer) {
        const oven = `${cavity}_oven`
        this.publishProperty(`${oven}_status`, Device.formatOvenState(current[CAVITY_STATE_OFFSET]))
        this.publishProperty(`${oven}_mode`, Device.formatOvenMode(current[CAVITY_MODE_OFFSET]))
        this.publishProperty(
            `${oven}_temperature`,
            Device.temperature(current.readUInt16BE(CAVITY_CURRENT_TEMPERATURE_OFFSET)),
        )
        this.publishProperty(
            `${oven}_set_temperature`,
            Device.temperature(current.readUInt16BE(CAVITY_SET_TEMPERATURE_OFFSET)),
        )
        this.publishProperty(
            `${oven}_cook_time`,
            Device.totalSeconds(
                current[CAVITY_COOK_HOURS_OFFSET],
                current[CAVITY_COOK_MINUTES_OFFSET],
                current[CAVITY_COOK_SECONDS_OFFSET],
            ),
        )
        const remoteStartReady = current[CAVITY_REMOTE_START_OFFSET] === REMOTE_START_READY
        this.publishProperty(`${oven}_remote_start`, remoteStartReady ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'timer') {
            const time = Device.parseTime(mqttValue)
            if (time) this.sendTimer(time)
            return
        }

        if (prop === 'timer_stop' && mqttValue === 'PRESS') {
            this.sendTimer({ hours: 0, minutes: 0, seconds: 0 })
            return
        }

        if (prop === 'clock_sync' && mqttValue === 'PRESS') {
            const now = new Date()
            this.sendClock(now.getHours(), now.getMinutes())
            return
        }

        if (prop === 'beeper_volume') {
            // HA only ever sends one of the declared options; anything else has no code and is
            // dropped rather than guessed at.
            const volume = BEEPER_VOLUMES.unmap(mqttValue)
            if (volume !== undefined) this.sendBeeperVolume(volume)
            return
        }

        if (prop === 'preheat_alarm_light') {
            if (mqttValue === 'ON' || mqttValue === 'OFF') this.sendPreheatAlarmLight(mqttValue === 'ON')
            return
        }

        if (prop === 'temperature_unit') {
            const unit = TEMPERATURE_UNITS.unmap(mqttValue)
            if (unit !== undefined) this.sendTemperatureUnit(unit)
            return
        }

        if (prop === 'auto_conversion') {
            if (mqttValue === 'ON' || mqttValue === 'OFF') this.sendAutoConversion(mqttValue === 'ON')
            return
        }

        const adjustment = /^(upper|lower)_temperature_adjustment$/.exec(prop)
        if (adjustment) {
            const degrees = Device.parseTemperatureAdjustment(mqttValue)
            if (degrees !== undefined) this.sendTemperatureAdjustment({ [adjustment[1] as CavityId]: degrees })
            return
        }

        if (prop === 'lower_remote_mode') {
            // Only a declared option has an operation code, and only such a mode is staged: the
            // start command below reads the staged mode back through the same table.
            if (LOWER_REMOTE_MODES.unmap(mqttValue) !== undefined) {
                this.remote.lowerMode = mqttValue as LowerRemoteMode
                this.publishProperty(prop, mqttValue)
            }
            return
        }

        const match = /^(upper|lower)_(remote_temperature|remote_cook_time|start|cancel)$/.exec(prop)
        if (!match) return
        const cavity = match[1] as CavityId
        const action = match[2]

        if (action === 'remote_temperature') {
            this.remote[cavity].temperature = this.stageNumber(prop, mqttValue, this.remote[cavity].temperature)
            return
        }

        if (action === 'remote_cook_time') {
            this.remote[cavity].cookTime = this.stageNumber(prop, mqttValue, this.remote[cavity].cookTime)
            return
        }

        if (mqttValue !== 'PRESS') return

        if (action === 'cancel') {
            this.send(Buffer.from([0xf0, 0x44, CAVITY_CANCEL_SELECTORS[cavity]]))
            return
        }

        // action === 'start'
        const operation = cavity === 'upper' ? UPPER_BAKE_OPERATION : LOWER_REMOTE_MODES.unmap(this.remote.lowerMode)
        if (operation === undefined) return
        this.sendRemoteStart(operation, this.remote[cavity].temperature, this.remote[cavity].cookTime)
    }

    sendTimer(time: { hours: number; minutes: number; seconds: number }) {
        this.send(Buffer.from([0xf0, 0x43, 0x23, 0x06, 0x80, 0x80, 0x80, time.seconds, time.minutes, time.hours]))
    }

    // The app writes the whole Preference screen in one frame, marking every row the user did not
    // touch. Each write here starts from an all-sentinel payload for the same reason: anything left
    // alone must go out as "no change" rather than as a value we would only be guessing at.
    static preferencePayload() {
        const payload = Buffer.alloc(PREFERENCE_PAYLOAD_LENGTH, PREFERENCE_NO_CHANGE)
        payload[PREFERENCE_FF_INDEX] = PREFERENCE_FF_NO_CHANGE
        return payload
    }

    sendPreference(payload: Buffer) {
        this.send(Buffer.concat([Buffer.from(PREFERENCE_COMMAND_PREFIX), payload]))
    }

    // No status record carries a clock field, so this is write-only: the button is stateless and
    // nothing is published back, matching the app's one-shot "Sync with smartphone".
    sendClock(hours: number, minutes: number) {
        const payload = Device.preferencePayload()
        payload[CLOCK_HOURS_INDEX] = hours
        payload[CLOCK_MINUTES_INDEX] = minutes
        payload[CLOCK_HOUR_FORMAT_INDEX] = CLOCK_HOUR_FORMAT_24H
        this.sendPreference(payload)
    }

    sendBeeperVolume(volume: number) {
        const payload = Device.preferencePayload()
        payload[BEEPER_VOLUME_INDEX] = volume
        this.sendPreference(payload)
    }

    sendPreheatAlarmLight(on: boolean) {
        const payload = Device.preferencePayload()
        payload[PREHEAT_ALARM_LIGHT_INDEX] = on ? PREHEAT_ALARM_LIGHT_ON : PREHEAT_ALARM_LIGHT_OFF
        this.sendPreference(payload)
    }

    sendTemperatureUnit(unit: number) {
        const payload = Device.preferencePayload()
        payload[TEMPERATURE_UNIT_INDEX] = unit
        this.sendPreference(payload)
    }

    sendAutoConversion(on: boolean) {
        const payload = Device.preferencePayload()
        payload[AUTO_CONVERSION_INDEX] = on ? AUTO_CONVERSION_ON : AUTO_CONVERSION_OFF
        this.sendPreference(payload)
    }

    // Takes both cavities so that the captured frame, which carried Upper and Lower together, can be
    // reproduced exactly. Home Assistant writes one cavity at a time and leaves the other unchanged.
    sendTemperatureAdjustment(adjustments: Partial<Record<CavityId, number>>) {
        const payload = Device.preferencePayload()
        payload[TEMPERATURE_ADJUSTMENT_UNIT_INDEX] = 0 // Fahrenheit
        for (const cavity of CAVITY_IDS) {
            const degrees = adjustments[cavity]
            if (degrees !== undefined) payload[TEMPERATURE_ADJUSTMENT_INDEXES[cavity]] = degrees & 0xff
        }
        this.sendPreference(payload)
    }

    sendRemoteStart(operation: number, temperature: number, cookTimeMinutes: number) {
        const hours = Math.floor(cookTimeMinutes / 60)
        const minutes = cookTimeMinutes % 60
        // Unlike status records (seconds/minutes/hours), the command carries hours/minutes/seconds.
        // The 01:03:00 Bake capture is the first non-symmetric value that proves this ordering.
        this.send(
            Buffer.from([
                0xf0,
                0x43,
                0x20,
                0x0b,
                operation,
                0x00,
                0x00,
                0x00,
                0x00,
                temperature >> 8,
                temperature & 0xff,
                hours,
                minutes,
                0x00,
                0x00,
            ]),
        )
    }

    // The number components declare min/max/step, so HA already constrains what it sends; range is
    // not re-checked here. The digit test only keeps a non-numeric payload off the wire, since
    // Number('') is 0 and a cook time of 0 means "no time limit" on this oven.
    stageNumber(prop: string, mqttValue: string, previous: number) {
        if (!/^\d+$/.test(mqttValue.trim())) return previous

        const value = Number(mqttValue.trim())
        this.publishProperty(prop, value)
        return value
    }

    // Zero is the oven declining to report, not a reading: the current-temperature field reads 0
    // for the whole of an active cycle even though it reports ambient and residual heat outside
    // one, and the setpoint reads 0 whenever no cook is programmed.
    static temperature(value: number) {
        return value === 0 ? undefined : value
    }

    static totalSeconds(hours: number, minutes: number, seconds: number) {
        return hours * 3600 + minutes * 60 + seconds
    }

    static formatTime(hours: number, minutes: number, seconds: number) {
        return [hours, minutes, seconds].map((value) => value.toString().padStart(2, '0')).join(':')
    }

    static parseTime(value: string) {
        const match = /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(value)
        if (!match) return undefined

        const hours = Number(match[1])
        if (hours > 0xff) return undefined
        return { hours, minutes: Number(match[2]), seconds: Number(match[3]) }
    }

    // Unlike the staged remote-start numbers, this one is signed, so it needs its own parse. The
    // range check keeps a payload that bypassed the HA component's own bounds off the wire.
    static parseTemperatureAdjustment(value: string) {
        const trimmed = value.trim()
        if (!/^-?\d+$/.test(trimmed)) return undefined

        const degrees = Number(trimmed)
        if (degrees < MIN_TEMPERATURE_ADJUSTMENT || degrees > MAX_TEMPERATURE_ADJUSTMENT) return undefined
        return degrees
    }

    // HA rejects any value outside the declared options, so an undecoded byte is published as
    // undefined — which reaches HA as 'unknown' — rather than as a raw number.
    static formatOvenState(value: number) {
        const state = OVEN_STATES.map(value)
        if (state === undefined) log('WFV474PGV', 'undecoded oven state', value.toString(16))
        return state
    }

    static formatOvenMode(value: number) {
        const mode = OVEN_MODES.map(value & 0x7f)
        if (mode === undefined) log('WFV474PGV', 'undecoded oven mode', value.toString(16))
        return mode
    }
}
