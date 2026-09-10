import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

/*
 * LG RH16_T_KR heat-pump dryer, deviceType 202.
 *
 * This intentionally exposes only the state fields grounded by this exact
 * appliance. Its real AABB traffic uses a 0x30 device byte, a 0x19 record
 * marker, a 29-byte EB body and a 56-byte EC body. The current record begins
 * at body offset 30 in EC frames. Owner traffic captured both state 0 while
 * powered off and state 1 while the appliance was in Initial; those values
 * match this model JSON's MonitoringValue.state table. Other model fields are
 * not exposed until a labelled non-zero transition isolates their offsets.
 */
const DEVICE_TYPE = 0x30
const SINGLE_STATUS = 0xeb
const DOUBLE_STATUS = 0xec
const SINGLE_BODY_LEN = 29
const DOUBLE_BODY_LEN = 56
const SINGLE_RECORD_OFFSET = 3
const DOUBLE_CURRENT_RECORD_OFFSET = 30
const RECORD_MARKER = 0x19
const STATE_OFFSET = 1
// Owner-labelled ON→OFF transition isolated rec[15] bit 0x08:
// ON current record ...00 08 08..., OFF ...00 00 08.... The adjacent
// rec[16] bit remained set across the lock transition and power cycle.
const CHILD_LOCK_OFFSET = 15
const CHILD_LOCK_FLAG = 0x08
const STATE_POWEROFF = 0
const STATE_ERROR = 5
const STATE_DIAGNOSIS = 8
const STATUS_REQUEST = 'F0ED1121010000001800'

const STATE = Enum.of({
    'Power off': 0,
    Standby: 1,
    Drying: 2,
    Pause: 3,
    Complete: 4,
    Error: 5,
    'Smart diagnosis': 8,
    Reserved: 100,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:power',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        device_class: 'enum',
                        options: STATE.options,
                        icon: 'mdi:tumble-dryer',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'lock',
                        icon: 'mdi:lock-outline',
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'problem',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    smart_diagnosis: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-smart_diagnosis',
                        state_topic: '$this/smart_diagnosis',
                        name: 'Smart diagnosis',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'problem',
                        icon: 'mdi:stethoscope',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== DEVICE_TYPE) return

        let recordOffset: number
        if (buf[1] === SINGLE_STATUS && buf.length === SINGLE_BODY_LEN) recordOffset = SINGLE_RECORD_OFFSET
        else if (buf[1] === DOUBLE_STATUS && buf.length === DOUBLE_BODY_LEN) recordOffset = DOUBLE_CURRENT_RECORD_OFFSET
        else return

        if (buf[recordOffset] !== RECORD_MARKER) return
        const state = buf[recordOffset + STATE_OFFSET]
        this.publishProperty('power', state === STATE_POWEROFF ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state) ?? 'None')
        this.publishProperty(
            'child_lock',
            (buf[recordOffset + CHILD_LOCK_OFFSET] & CHILD_LOCK_FLAG) !== 0 ? 'ON' : 'OFF',
        )
        this.publishProperty('error', state === STATE_ERROR ? 'ON' : 'OFF')
        this.publishProperty('smart_diagnosis', state === STATE_DIAGNOSIS ? 'ON' : 'OFF')
    }
}
