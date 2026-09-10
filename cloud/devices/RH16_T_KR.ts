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
// RH16 uses the same dryer record layout as the captured RV13 family and the
// same relative error position as F24VDD: rec[7]. The owner's normal RH16
// snapshots all report 0 here; non-zero labels come from this model's own
// MonitoringValue.error table.
const ERROR_OFFSET = 7
// This run isolated rec[10] as MonitoringValue.processState: it changed
// 0 (Detecting) -> 2 (Drying) while the top-level state stayed Running.
const PROCESS_STATE_OFFSET = 10
// Owner-labelled ON→OFF transition isolated rec[15] bit 0x08:
// ON current record ...00 08 08..., OFF ...00 00 08.... The adjacent
// rec[16] bit remained set across the lock transition and power cycle.
const CHILD_LOCK_OFFSET = 15
const CHILD_LOCK_FLAG = 0x08
// Owner-labelled remote-control ON→OFF transition isolated rec[16] bit
// 0x01: 0x19→0x18 while the unrelated 0x18 bits remained set.
const REMOTE_START_OFFSET = 16
const REMOTE_START_FLAG = 0x01
const STATE_POWEROFF = 0
const STATE_RUNNING = 2
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

const PROCESS_STATE = Enum.of({
    Detecting: 0,
    Steam: 1,
    Drying: [2, 3, 4],
    Cooling: 5,
    'Anti crease': 6,
    Complete: 7,
})
const STATUS_OPTIONS = [...new Set([...STATE.options, ...PROCESS_STATE.options])]

const ERROR_MESSAGE = Enum.of({
    None: -1,
    Normal: 0,
    tE1: 1,
    tE2: 2,
    tE4: 4,
    tE5: 5,
    tE6: 6,
    CE1: 7,
    'OE Drain motor': 13,
    'Empty water': 14,
    'dE Door': 15,
    'Filter clogging': 16,
    'No filter': 17,
    F1: 19,
    LE2: 20,
    AE: 21,
    LE1: 30,
    dE4: 37,
    LE3: 39,
    dE2: 42,
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
                        options: STATUS_OPTIONS,
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
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: 'mdi:cellphone-check',
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error_message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        device_class: 'enum',
                        options: ERROR_MESSAGE.options,
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
        const processState = buf[recordOffset + PROCESS_STATE_OFFSET]
        const errorCode = buf[recordOffset + ERROR_OFFSET]
        this.publishProperty('power', state === STATE_POWEROFF ? 'OFF' : 'ON')
        this.publishProperty(
            'status',
            state === STATE_RUNNING ? (PROCESS_STATE.map(processState) ?? 'Drying') : (STATE.map(state) ?? 'None'),
        )
        this.publishProperty(
            'child_lock',
            (buf[recordOffset + CHILD_LOCK_OFFSET] & CHILD_LOCK_FLAG) !== 0 ? 'ON' : 'OFF',
        )
        this.publishProperty(
            'remote_start',
            (buf[recordOffset + REMOTE_START_OFFSET] & REMOTE_START_FLAG) !== 0 ? 'ON' : 'OFF',
        )
        this.publishProperty('error', errorCode === 0 ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERROR_MESSAGE.map(errorCode) ?? 'None')
        this.publishProperty('smart_diagnosis', state === STATE_DIAGNOSIS ? 'ON' : 'OFF')
    }
}
