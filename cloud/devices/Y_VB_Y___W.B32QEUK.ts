import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES, COURSES, TEMPERATURES, SPINS, DOSES } from './washer_common'

export default class Device extends HADevice {
    publishCache: Record<string, string | number> = {}

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (data) => this.processData(data))

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.filter((a) => a !== undefined),
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: ERRORS.filter((a) => a !== undefined),
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°C',
                        suggested_display_precision: 0,
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        unit_of_measurement: 'RPM',
                        value_template: "{{ value if value | is_number else 'None' }}",
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycle count',
                        icon: 'mdi:counter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:play-circle-outline',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                    delay_end: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_end',
                        state_topic: '$this/delay_end',
                        name: 'Delay end',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'h',
                        suggested_display_precision: 0,
                    },
                    detergent: {
                        platform: 'sensor',
                        unique_id: '$deviceid-detergent',
                        state_topic: '$this/detergent',
                        name: 'Detergent dose',
                        icon: 'mdi:cup',
                        device_class: 'enum',
                        options: DOSES,
                    },
                    softener: {
                        platform: 'sensor',
                        unique_id: '$deviceid-softener',
                        state_topic: '$this/softener',
                        name: 'Softener dose',
                        icon: 'mdi:cup-outline',
                        device_class: 'enum',
                        options: DOSES,
                    },
                    turbowash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        name: 'TurboWash',
                        icon: 'mdi:rocket-launch',
                    },
                    eco_hybrid: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-eco_hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'EcoHybrid',
                        icon: 'mdi:leaf',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
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
                },
            }),
        )
    }

    send(inner: Buffer) {
        const packet = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0x00, 0x00])])
        const sum = packet.reduce((pv, cv) => pv + cv, 0)
        packet[packet.length - 2] = (sum & 0xff) ^ 0x55
        packet[packet.length - 1] = 0xbb
        this.thinq.send_packet(packet)
    }

    processData(buf: Buffer) {
        if (this.verify_frame_valid(buf)) {
            this.processAABB(buf.subarray(1, buf.length - 3))
        }
    }

    // to be called by processAABB
    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    checkSum(data: Uint8Array): number {
        let crc = 0x0000

        for (const byte of data) {
            crc ^= byte << 8
            for (let i = 0; i < 8; i++) {
                if (crc & 0x8000) {
                    crc = ((crc << 1) ^ 0x1021) & 0xffff
                } else {
                    crc = (crc << 1) & 0xffff
                }
            }
        }

        return crc & 0xffff
    }

    verify_frame_valid(buf: Buffer) {
        const computed_check_sum = this.checkSum(buf.subarray(0, buf.length - 3))
        const received_check_sum = (buf[buf.length - 3] << 8) | buf[buf.length - 2]
        return received_check_sum == computed_check_sum
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        const payload_length = buf[0]
        const payload_type = buf[1]
        const actual_length = (buf[3] << 8) | buf[4]
        const session = (buf[5] << 8) | buf[6]
        const sequence = buf[7]
        const message_type = buf[10]
        if (payload_length == 0xff && payload_type == 0x20 && message_type == 0x00) {
            const payload_a = buf.subarray(14, 53)
            const payload_b = buf.subarray(53, 93)

            const status = payload_b[2]
            const time_remain_hours = payload_b[3]
            const time_remain_minutes = payload_b[4]
            const time_start_hours = payload_b[5]
            const time_start_minutes = payload_b[6]
            const course = payload_b[7]
            const error = payload_b[8]
            const spin = payload_b[10]
            const temp = payload_b[11]
            // const extra_rinse = payload_b[12];
            // const drying = payload_b[13];
            const delay_end = payload_b[14]
            const options = payload_b[16]
            const lock_status = payload_b[17]
            const cycles = payload_b[23]
            const energy = payload_b[30]
            const detergent = payload_b[32]
            const softener = payload_b[33]

            this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
            this.publishProperty('error_message', ERRORS[error] ?? 'unknown') // publish message before set error state
            this.publishProperty('error', error ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[status] ?? 'unknown')
            this.publishProperty('course', COURSES[course] ?? 'unknown')
            this.publishProperty('spin', SPINS[spin] ?? 'unknown')
            this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown')
            // this.publishProperty('drying_mode', DRYING_MODES[drying_mode] ?? 'unknown')
            this.publishProperty('cycles', cycles)
            this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
            this.publishProperty('door_lock', !(lock_status & 0x40) ? 'ON' : 'OFF') // inverted logic, off=locked
            this.publishProperty('child_lock', lock_status & 0x80 ? 'ON' : 'OFF')
            this.publishProperty('initial_time', time_start_hours * 60 + time_start_minutes)
            this.publishProperty('remaining_time', time_remain_hours * 60 + time_remain_minutes)
            this.publishProperty('energy', energy)
            this.publishProperty('delay_end', delay_end)
            this.publishProperty('detergent', DOSES[detergent] ?? 'unknown')
            this.publishProperty('softener', DOSES[softener] ?? 'unknown')
            // this.publishProperty('extra_rinse', extra_rinse >= 2 ? 'ON' : 'OFF') // 0/1=off, 2+=one or more extra rinses
            this.publishProperty('turbowash', options & 0x01 ? 'ON' : 'OFF')
            this.publishProperty('eco_hybrid', options & 0x08 ? 'ON' : 'OFF')
            this.publishProperty('prewash', options & 0x40 ? 'ON' : 'OFF')
            this.publishProperty('steam', options & 0x80 ? 'ON' : 'OFF')
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
        }

        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        if (prop === 'start') this.send(Buffer.from(mqttValue || 'F024050100', 'hex'))
    }
}
