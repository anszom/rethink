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
const STATUS_REQUEST = 'F0ED1121010000001800'

const STATE = Enum.of({
    'Power off': 0,
    Initial: 1,
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
                        device_class: 'running',
                        icon: 'mdi:tumble-dryer',
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
        this.publishProperty('power', state === 0 ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(state) ?? 'None')
    }
}
