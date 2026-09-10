import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'

// LG LREL6323S electric range, reporting modelName "WLREL6323S" (deviceType 301).
//
// Captures from the physical panel establish the single-cavity oven fields, door-open bit,
// and aggregate cooktop state. Normal elements and the warming zone use different bytes, but
// individual normal elements report the same transition, so no individual entities are exposed.
// The only writes are the Preferences frame shared with the WFV474PGV oven (clock, clock format and
// beeper), verified on a live range. Cooking writes remain disabled until their complete command
// shapes and appliance interlocks are captured.

const CLASS_BYTE = 0x40
const SINGLE_STATUS_FRAME_TYPE = 0xeb
const STATUS_FRAME_TYPE = 0xec
const STATUS_RECORD_LENGTH = 62

const OVEN_STATE_OFFSET = 0
const OVEN_MODE_OFFSET = 1
const OVEN_SET_TEMPERATURE_OFFSET = 5
const OVEN_DOOR_FLAGS_OFFSET = 11
const OVEN_DOOR_OPEN_MASK = 0x08
// Normal surface elements set bytes 36 and 38 together; the warming zone sets
// bytes 37 and 39 together. Treat all four as one read-only cooktop status.
const COOKTOP_STATE_OFFSETS = [36, 37, 38, 39]

const OVEN_STATES = Enum.of({
    Idle: 0x00,
    Preheating: 0x01,
    Cooking: 0x02,
    Cooling: 0x04,
    Cleaning: 0x09,
})
const OVEN_MODES = Enum.of({
    None: 0x00,
    Bake: 0x01,
    'Convection Bake': 0x03,
    'Convection Roast': 0x04,
    Broil: 0x07,
    Warm: 0x08,
    EasyClean: 0x0d,
    'Self Clean': 0x0f,
    'Air Fry': 0x10,
})

// Observed from LG's cloud and confirmed against the WLREL6323S: the reply is a 40 EB status frame.
const STATUS_QUERY = 'f0ed114101000000181a0207080c14191a1e262b30353a00000000000000000000000000'

// Preference write: the same F0 43 21 frame and 13-byte payload as the WFV474PGV oven's, where every
// field the write does not set goes out as the 0x80 "no change" sentinel and index 11 as 0xFF.
// Verified on a live WLREL6323S on 2026-09-10, each write acknowledged 40 00 43 00:
//   0, 1   clock hour and minute
//   2      clock format. 0x00 with a 0-23 hour switched the display to 24-hour; 0x01 with a 1-12
//          hour put it back to 12-hour. The format travels with every clock write, so the time cannot
//          be set without also choosing the format.
//   11     beeper. 0x00 silenced the panel keys, 0x02 brought them back. The double oven keeps a
//          0xFF sentinel here; on this range it lines up with the cooktop beeper the LSIS6338FE
//          reports, which offers only Mute and High.
// Index 8 is the double oven's beeper volume. Writing 0x00 there was acknowledged but left the keys
// beeping, so it is not exposed.
const PREFERENCE_COMMAND_PREFIX = [0xf0, 0x43, 0x21, 0x0e]
const PREFERENCE_PAYLOAD_LENGTH = 13
const PREFERENCE_NO_CHANGE = 0x80
const PREFERENCE_FF_INDEX = 11
const PREFERENCE_FF_NO_CHANGE = 0xff
const CLOCK_HOURS_INDEX = 0
const CLOCK_MINUTES_INDEX = 1
const CLOCK_FORMAT_INDEX = 2
const CLOCK_FORMATS = Enum.of({ '12-hour': 0x01, '24-hour': 0x00 })
const BEEPER_VOLUME_INDEX = 11
const BEEPER_VOLUMES = Enum.of({ High: 0x02, Mute: 0x00 })

// Write acknowledgement: 40 00 <command family> <result>, result 0x00 on success.
const ACK_FRAME_TYPE = 0x00
const PREFERENCE_COMMAND_FAMILY = 0x43

export default class Device extends AABBDevice {
    // The range cannot be asked for its format. Assume 12-hour (the US default and the tested unit's
    // setting) until HA selects otherwise.
    clockFormat = 0x01

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Electric Range' }),
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
                    oven_status: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:stove',
                        unique_id: '$deviceid-oven_status',
                        state_topic: '$this/oven_status',
                        name: 'Oven Status',
                        options: OVEN_STATES.options,
                    },
                    oven_mode: {
                        platform: 'sensor',
                        device_class: 'enum',
                        icon: 'mdi:chef-hat',
                        unique_id: '$deviceid-oven_mode',
                        state_topic: '$this/oven_mode',
                        name: 'Oven Mode',
                        options: OVEN_MODES.options,
                    },
                    oven_set_temperature: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        icon: 'mdi:thermometer-chevron-up',
                        unique_id: '$deviceid-oven_set_temperature',
                        state_topic: '$this/oven_set_temperature',
                        name: 'Oven Set Temperature',
                        unit_of_measurement: '°F',
                    },
                    oven_door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-oven_door',
                        state_topic: '$this/oven_door',
                        name: 'Oven Door',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                    // No status record carries the clock, so this is write-only, like the oven's.
                    clock_sync: {
                        platform: 'button',
                        icon: 'mdi:clock-check-outline',
                        unique_id: '$deviceid-clock_sync',
                        command_topic: '$this/clock_sync/set',
                        payload_press: 'PRESS',
                        name: 'Sync Clock',
                    },
                    // The range never reports its clock format, so HA tracks the selection itself.
                    // Choosing one re-sends the current time in that format, since the two always
                    // travel together.
                    clock_format: {
                        platform: 'select',
                        icon: 'mdi:clock-outline',
                        unique_id: '$deviceid-clock_format',
                        command_topic: '$this/clock_format/set',
                        options: CLOCK_FORMATS.options,
                        optimistic: true,
                        name: 'Clock Format',
                    },
                    // Write-only for the same reason as the clock format.
                    beeper_volume: {
                        platform: 'select',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-beeper_volume',
                        command_topic: '$this/beeper_volume/set',
                        options: BEEPER_VOLUMES.options,
                        optimistic: true,
                        name: 'Beeper Volume',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_QUERY, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length >= 2 && buf[0] === CLASS_BYTE) {
            if (buf.length === 4 && buf[1] === ACK_FRAME_TYPE && buf[2] === PREFERENCE_COMMAND_FAMILY) {
                if (buf[3] !== 0x00) log('WLREL6323S', 'command rejected by the range', buf.toString('hex'))
                return
            }

            if (buf[1] === SINGLE_STATUS_FRAME_TYPE && buf.length === 2 + STATUS_RECORD_LENGTH) {
                this.publishStatus(buf.subarray(2))
                return
            }

            // EC contains equal-sized previous and current records; publish only the current one.
            if (buf[1] === STATUS_FRAME_TYPE && buf.length === 2 + STATUS_RECORD_LENGTH * 2) {
                this.publishStatus(buf.subarray(2 + STATUS_RECORD_LENGTH))
                return
            }
        }

        log('WLREL6323S', 'undecoded frame', buf.toString('hex'))
    }

    publishStatus(current: Buffer) {
        this.publishProperty('oven_status', Device.formatOvenState(current[OVEN_STATE_OFFSET]))
        this.publishProperty('oven_mode', Device.formatOvenMode(current[OVEN_MODE_OFFSET]))

        const setTemperature = current.readUInt16BE(OVEN_SET_TEMPERATURE_OFFSET)
        // Zero is the range declining to report rather than a reading: the setpoint reads 0 whenever
        // no cook is programmed, and for modes that carry no setpoint at all.
        this.publishProperty('oven_set_temperature', setTemperature === 0 ? undefined : setTemperature)

        const doorOpen = (current[OVEN_DOOR_FLAGS_OFFSET] & OVEN_DOOR_OPEN_MASK) !== 0
        this.publishProperty('oven_door', doorOpen ? 'ON' : 'OFF')

        const cooktopOn = COOKTOP_STATE_OFFSETS.some((offset) => current[offset] !== 0)
        this.publishProperty('cooktop_status', cooktopOn ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'clock_sync') {
            if (mqttValue === 'PRESS') this.syncClock()
            return
        }

        if (prop === 'clock_format') {
            const format = CLOCK_FORMATS.unmap(mqttValue)
            if (format === undefined) return
            this.clockFormat = format
            this.syncClock()
            return
        }

        if (prop === 'beeper_volume') {
            const volume = BEEPER_VOLUMES.unmap(mqttValue)
            if (volume !== undefined) this.sendBeeperVolume(volume)
            return
        }

        super.setProperty(prop, mqttValue)
    }

    // Starts from an all-sentinel payload so anything the write does not set goes out as "no change".
    static preferencePayload() {
        const payload = Buffer.alloc(PREFERENCE_PAYLOAD_LENGTH, PREFERENCE_NO_CHANGE)
        payload[PREFERENCE_FF_INDEX] = PREFERENCE_FF_NO_CHANGE
        return payload
    }

    sendPreference(payload: Buffer) {
        this.send(Buffer.concat([Buffer.from(PREFERENCE_COMMAND_PREFIX), payload]))
    }

    syncClock() {
        const now = new Date()
        this.sendClock(now.getHours(), now.getMinutes(), this.clockFormat)
    }

    // hours is always 0-23; the 12-hour format carries it as 1-12.
    sendClock(hours: number, minutes: number, format: number) {
        const payload = Device.preferencePayload()
        payload[CLOCK_HOURS_INDEX] = format === CLOCK_FORMATS.unmap('12-hour') ? hours % 12 || 12 : hours
        payload[CLOCK_MINUTES_INDEX] = minutes
        payload[CLOCK_FORMAT_INDEX] = format
        this.sendPreference(payload)
    }

    sendBeeperVolume(volume: number) {
        const payload = Device.preferencePayload()
        payload[BEEPER_VOLUME_INDEX] = volume
        this.sendPreference(payload)
    }

    // HA rejects any value outside the declared options, so an undecoded byte is published as
    // undefined — which reaches HA as 'None' — rather than as a raw number.
    static formatOvenState(value: number) {
        const state = OVEN_STATES.map(value)
        if (state === undefined) log('WLREL6323S', 'undecoded oven state', value.toString(16))
        return state
    }

    static formatOvenMode(value: number) {
        const mode = OVEN_MODES.map(value)
        if (mode === undefined) log('WLREL6323S', 'undecoded oven mode', value.toString(16))
        return mode
    }
}
