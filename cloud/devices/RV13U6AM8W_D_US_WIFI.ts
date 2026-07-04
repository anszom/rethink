import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const PHASES: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Starting',
    0x03: 'Paused',
    0x32: 'Drying',
    0x33: 'Cooldown',
    0x04: 'Finishing',
}

const CYCLES: Record<number, string> = {
    0x01: 'Heavy Duty',
    0x03: 'Normal',
    0x04: 'Perm. Press',
    0x05: 'Delicates',
    0x07: 'Bedding',
    0x10: 'Speed Dry',
    0x11: 'Air Dry',
    0x12: 'Manual',
}

const TEMPS: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Ultra Low',
    0x02: 'Low',
    0x03: 'Medium',
    0x04: 'Med High',
    0x05: 'High',
}

const DRY_LEVELS: Record<number, string> = {
    0x00: 'None',
    0x01: 'Damp',
    0x02: 'Less',
    0x03: 'Normal',
    0x04: 'More',
    0x05: 'Very',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    phase: {
                        platform: 'sensor',
                        unique_id: '$deviceid-phase',
                        state_topic: '$this/phase',
                        name: 'Phase',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: [...new Set(Object.values(PHASES))],
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    drum_running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_running',
                        state_topic: '$this/drum_running',
                        name: 'Drum running',
                        icon: 'mdi:rotate-3d-variant',
                    },
                    cycle: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        name: 'Cycle',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: Object.values(CYCLES),
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: Object.values(TEMPS),
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: Object.values(DRY_LEVELS),
                    },
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        const mins = rec[4]

        this.publishProperty('phase', PHASES[phase] ?? `Unknown (0x${phase.toString(16)})`)
        this.publishProperty('remaining_time', mins)
        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_running', rec[17] === 0xa9 ? 'ON' : 'OFF')
        this.publishProperty('cycle', CYCLES[rec[7]] ?? `Unknown (0x${rec[7].toString(16)})`)
        this.publishProperty('temp', TEMPS[rec[10]] ?? `Unknown (0x${rec[10].toString(16)})`)
        this.publishProperty('dry_level', DRY_LEVELS[rec[9]] ?? `Unknown (0x${rec[9].toString(16)})`)
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30) return

        if (buf[1] === 0xec && buf.length === 60) {
            // 0xEC: two back-to-back 29-byte records (current + previous); use current
            this.processRecord(buf.subarray(2, 31))
        } else if (buf[1] === 0xeb && buf.length === 31) {
            // 0xEB: single record sent after reconnect
            this.processRecord(buf.subarray(2, 31))
        }
    }
}
