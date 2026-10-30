import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// LG LRGL5825F gas range, reporting modelName "WLRGL5825F" (deviceType 301).
//
// Same AABB framing and 62-byte status record as the electric range WLREL6323S
// (class byte 0x40), with the same offsets for state, mode, door and cooktop.
// Differences: a current-temperature byte (offset 8), and a gas-specific mode table.
//
// Confirmed live on a real unit while cooking:
//   [0] oven state       (1=Preheat, 2=Cooking)
//   [1] cook mode        (1=Bake, 8=Warm)
//   [5] 0x80 cook-active flag
//   [6] target temp      (175 == 175C, single byte)
//   [8] current temp     (32 -> 113 while preheating, single byte)
//   [11] door (bit 0x08)
//   [36,38] cooktop burners (0x01 = on)

const CLASS_BYTE = 0x40
const STATUS_RECORD_LENGTH = 62

const OVEN_STATE_OFFSET = 0
const OVEN_MODE_OFFSET = 1
const OVEN_SET_TEMPERATURE_OFFSET = 6
const OVEN_CURRENT_TEMPERATURE_OFFSET = 8
const OVEN_DOOR_FLAGS_OFFSET = 11
const OVEN_DOOR_OPEN_MASK = 0x08
const COOKTOP_STATE_OFFSETS = [36, 37, 38, 39]

const OVEN_STATES = Enum.of({
    Initial: 0x00,
    Preheating: 0x01,
    Cooking: 0x02,
    Done: 0x03,
    Cooling: 0x04,
    Cleaning: 0x05,
    'Cleaning Done': 0x06,
})

// Gas-range mode table (from the modelJson UpperCookMode enum, index-ordered).
const OVEN_MODES = Enum.of({
    None: 0x00,
    Bake: 0x01,
    Roast: 0x02,
    'Convection Bake': 0x03,
    'Convection Roast': 0x04,
    'Crisp Convection': 0x05,
    Favorite: 0x06,
    Broil: 0x07,
    Warm: 0x08,
    Proof: 0x09,
    Pizza: 0x0a,
    'Slow Cook': 0x0b,
    Probe: 0x0c,
    'Easy Clean': 0x0d,
    'Speed Broil': 0x0e,
    'Self Clean': 0x0f,
    'Speed Roast': 0x10,
    'Air Fry': 0x11,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Gas Range' }),
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
                        unit_of_measurement: '°C',
                    },
                    oven_current_temperature: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        icon: 'mdi:thermometer',
                        unique_id: '$deviceid-oven_current_temperature',
                        state_topic: '$this/oven_current_temperature',
                        name: 'Oven Current Temperature',
                        unit_of_measurement: '°C',
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
        // Reuse the electric range's status query (best effort); the gas range may
        // answer with the same EB status frame.
        this.send(Buffer.from('f0ed114101000000181a0207080c14191a1e262b30353a00000000000000000000000000', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (this.processCommonStatus(buf, CLASS_BYTE, STATUS_RECORD_LENGTH, this.publishStatus)) return

        this.log('undecoded frame', buf.toString('hex'))
    }

    publishStatus(current: Buffer) {
        this.publishProperty('oven_status', this.formatEnum(OVEN_STATES, current[OVEN_STATE_OFFSET]))
        this.publishProperty('oven_mode', this.formatEnum(OVEN_MODES, current[OVEN_MODE_OFFSET]))

        const setTemperature = current[OVEN_SET_TEMPERATURE_OFFSET]
        // Zero is the range declining to report rather than a reading.
        this.publishProperty('oven_set_temperature', setTemperature === 0 ? undefined : setTemperature)

        const currentTemperature = current[OVEN_CURRENT_TEMPERATURE_OFFSET]
        this.publishProperty('oven_current_temperature', currentTemperature === 0 ? undefined : currentTemperature)

        const doorOpen = (current[OVEN_DOOR_FLAGS_OFFSET] & OVEN_DOOR_OPEN_MASK) !== 0
        this.publishProperty('oven_door', doorOpen ? 'ON' : 'OFF')

        const cooktopOn = COOKTOP_STATE_OFFSETS.some((offset) => current[offset] !== 0)
        this.publishProperty('cooktop_status', cooktopOn ? 'ON' : 'OFF')
    }

    formatEnum(table: ReturnType<typeof Enum.of>, value: number) {
        const mapped = table.map(value)
        if (mapped === undefined) this.log('undecoded value', value.toString(16))
        return mapped
    }
}
