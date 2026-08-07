import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'

/**
 * LG heat-pump dryer — SoftAP model RH10V9_CH (deviceType 202, e.g. RH10V9 family).
 *
 * AABB frames (inner body after AA/len, before checksum/BB):
 *   0x30 0xEB + 27-byte record   — single status (poll reply / reconnect)
 *   0x30 0xEC + 27B prev + 27B curr — dual status (unsolicited updates)
 *
 * Same dryer family byte 0x30 as US RV13* units, but records are 27B (not 28/29)
 * and omit the 0x1b marker used on some NA models.
 *
 * Record layout (from live polls):
 *   rec[0]  remaining hours
 *   rec[1]  remaining minutes
 *   rec[2]  phase/status (0=off, 1=initial, … — drying codes not yet seen live)
 *   rec[17] options bitfield (seen 0x00 / 0x08)
 *   rec[21] unknown (seen 0x00 idle-awake, 0x03 while module reported off)
 *   rec[25] constant 0x75 in all captures so far
 *
 * 0x30 0x31 — identity/serial frame (SAA…), ignored for state.
 *
 * Monitor enable F0ED1121… is required; without it the module only MQTT-pings.
 * Note: polls often return a frozen MCU snapshot. If the panel is used only
 * locally without remote/smart features, running-state bytes may never update.
 */

const RECORD_LEN = 27

const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x03: 'Pause',
    0x32: 'Drying',
    0x33: 'Cooling',
    0x04: 'End',
}

export default class Device extends AABBDevice {
    private monitorTimer: ReturnType<typeof setInterval> | undefined

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
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    // Diagnostic raw fields until course/temp/dry-level are mapped
                    flags: {
                        platform: 'sensor',
                        unique_id: '$deviceid-flags',
                        state_topic: '$this/flags',
                        name: 'Flags (raw)',
                        icon: 'mdi:flag',
                        entity_category: 'diagnostic',
                    },
                    raw_b21: {
                        platform: 'sensor',
                        unique_id: '$deviceid-raw_b21',
                        state_topic: '$this/raw_b21',
                        name: 'Raw byte 21',
                        icon: 'mdi:numeric',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    start() {
        this.sendMonitorEnable()
        // A few retries while the dryer MCU wakes; then stop spamming.
        let n = 0
        this.monitorTimer = setInterval(() => {
            this.sendMonitorEnable()
            if (++n >= 8 && this.monitorTimer) {
                clearInterval(this.monitorTimer)
                this.monitorTimer = undefined
            }
        }, 15_000)
    }

    drop() {
        if (this.monitorTimer) {
            clearInterval(this.monitorTimer)
            this.monitorTimer = undefined
        }
        super.drop()
    }

    private sendMonitorEnable() {
        // Laundry-style unsolicited-status enable (required on this model).
        log('status', this.id, 'RH10V9: monitor enable')
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    private processRecord(rec: Buffer) {
        if (rec.length < RECORD_LEN) return

        const phase = rec[2]
        const remaining = rec[0] * 60 + rec[1]
        const flags = rec[17]
        const b21 = rec[21]

        this.publishProperty('status', STATUS[phase] ?? `0x${phase.toString(16)}`)
        this.publishProperty('remaining_time', remaining)
        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('flags', flags)
        this.publishProperty('raw_b21', b21)
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30) return

        // Device identity / serial (SAA…) — no cycle state
        if (buf[1] === 0x31) return

        if (buf[1] === 0xeb && buf.length === 2 + RECORD_LEN) {
            // Single 27-byte status record
            this.processRecord(buf.subarray(2, 2 + RECORD_LEN))
        } else if (buf[1] === 0xec && buf.length === 2 + 2 * RECORD_LEN) {
            // Dual records: previous then current (use current = second half)
            this.processRecord(buf.subarray(2 + RECORD_LEN, 2 + 2 * RECORD_LEN))
        } else {
            log('status', this.id, 'RH10V9 unhandled AABB', buf.toString('hex'))
        }
    }

    setProperty(_prop: string, _mqttValue: string) {
        // Read-only for now
    }
}
