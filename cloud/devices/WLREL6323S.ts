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
// Writes remain disabled until their complete command shapes and appliance interlocks are captured.

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

export default class Device extends AABBDevice {
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
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_QUERY, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length >= 2 && buf[0] === CLASS_BYTE) {
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
