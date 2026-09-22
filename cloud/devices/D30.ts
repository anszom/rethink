import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'

// LG D30 ThinQ dishwasher (deviceType 204) — DB365TXS / DBC435TSL.AASQEIS.
//
// Registers the model and exposes the target entity set. The TLV decode covers the core
// status fields (validated against three full captures of a real appliance — Eco, Auto +
// Energy Saver, Auto without); the remaining option bits / error / rinse_refill are still
// TODO. See the processAABB comment for the field layout, and the companion
// lg-dishwasher-local project (research/notes/raw-tlv-decode.md) for the full schema.
//
// The entity set mirrors the official ha-smartthinq-sensors integration (the
// `lg_lavastoviglie_*` entities) so existing automations keep working, plus the
// cloud fields that integration drops (superset). Every component carries an explicit
// `default_entity_id` so the entity_id is deterministic (`sensor.lg_dishwasher_*` /
// `binary_sensor.lg_dishwasher_*`) instead of being slugified from the English name.

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dishwasher' }),
                components: {
                    run_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-run_state',
                        default_entity_id: 'sensor.lg_dishwasher_run_state',
                        state_topic: '$this/run_state',
                        name: 'Run state',
                        icon: 'mdi:dishwasher',
                        device_class: 'enum',
                    },
                    running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-running',
                        default_entity_id: 'binary_sensor.lg_dishwasher_running',
                        state_topic: '$this/running',
                        name: 'Running',
                        icon: 'mdi:play-circle',
                    },
                    current_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-current_course',
                        default_entity_id: 'sensor.lg_dishwasher_current_course',
                        state_topic: '$this/current_course',
                        name: 'Current course',
                        icon: 'mdi:playlist-play',
                        device_class: 'enum',
                    },
                    process_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-process_state',
                        default_entity_id: 'sensor.lg_dishwasher_process_state',
                        state_topic: '$this/process_state',
                        name: 'Process state',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        default_entity_id: 'sensor.lg_dishwasher_remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        default_entity_id: 'sensor.lg_dishwasher_initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    rinse_refill: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_refill',
                        default_entity_id: 'binary_sensor.lg_dishwasher_rinse_refill',
                        state_topic: '$this/rinse_refill',
                        name: 'Rinse aid refill',
                        icon: 'mdi:water-plus',
                    },
                    door_open: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door_open',
                        default_entity_id: 'binary_sensor.lg_dishwasher_door_open',
                        state_topic: '$this/door_open',
                        name: 'Door open',
                        icon: 'mdi:door-open',
                        device_class: 'door',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        default_entity_id: 'binary_sensor.lg_dishwasher_energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy saver',
                        icon: 'mdi:leaf',
                    },
                },
            }),
        )
    }

    // Status query on connect, verified 2026-09-17 via bridge capture: the LG
    // cloud sends `f0ed1121010000001800` (identical to the washers) to make the
    // device push its current status.
    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    // Status frame (AABB inner type 0x32). Layout verified 2026-09-17 from a full ECO-cycle
    // bridge capture and 2026-09-19 (record ordering + Intensive course). Body =
    // [0x32][flag 0xeb|0xec] record1 [record2]. For 0xec (two records) record1 is the PRIOR
    // minute and record2 is the CURRENT reading (remaining time is always smaller in record2);
    // for 0xeb (single record) the record at body[2..27] is the current reading. The handshake
    // hello also starts 0x32 but its second byte is 0x31 ("21" ASCII) — excluded by the flag
    // check. Offsets below are relative to the current record (base = 2 for 0xeb, 28 for 0xec):
    //   [2]      state    0x01=Starting, 0x02=Running, 0x04=Done, 0x05=Complete (transient),
    //                     0x00=Off/standby (after Done, before the device stops reporting)
    //   [3]      process  0x02=Washing, 0x03=Rinsing, 0x04=Drying, 0x05=Complete, 0x06=Night
    //                     Dry (post-cycle; state stays 0x02/Running for ~8.5h — treated as not
    //                     running), 0x00=none
    //   [5]/[6]  initial time   (hour, minute)   e.g. 03 05 = 3:05 (Intensive)
    //   [7]      course  0x05=Eco, 0x01=Auto, 0x02=Intensive (clears to 0x00 at cycle end) —
    //                    verified 2026-09-18/19 across Eco, Auto and Intensive washes.
    //   [9]/[10] remaining time (hour, minute)   e.g. 02 35 = 2:53, 1/min countdown
    //   [13]     status bitfield: bit 3 (0x08) = rinse aid refill (most likely; the fork this
    //            was adapted from called it "salt refill" — unlikely on a US model), bit 1
    //            (0x02) = door open (Auto Open Dry; the cloud does NOT report this — our
    //            superset).
    //   [14]     options bitfield: bit 1 (0x02) = energy saver — verified 2026-09-18.
    //            Like the course byte, it clears to 0x00 at cycle end (state 0x04/0x05).
    // Still TODO (need more washes/options): other option bits (dual_zone/half_load/steam/
    // high_temp/extra_dry/...), error codes.
    processAABB(buf: Buffer) {
        if (buf[0] !== 0x32 || (buf[1] !== 0xeb && buf[1] !== 0xec)) {
            log('D30', 'unrecognized frame', buf.toString('hex'))
            return
        }
        // 0xec carries two records: record1 = prior minute, record2 = current. Read the
        // current one (skip record1 on 0xec). 0xeb carries a single (current) record.
        const base = buf[1] === 0xec ? 28 : 2
        if (buf.length < base + 26) {
            log('D30', 'short frame', buf.toString('hex'))
            return
        }
        const state = buf[base + 2]
        const process = buf[base + 3]
        const initialH = buf[base + 5]
        const initialM = buf[base + 6]
        const course = buf[base + 7]
        const remainingH = buf[base + 9]
        const remainingM = buf[base + 10]
        const statusBits = buf[base + 13]
        const optionBits = buf[base + 14]

        // Sanity: minutes must be 0..59.
        if (initialM > 59 || remainingM > 59 || initialH > 99 || remainingH > 99) {
            log('D30', 'suspect time fields', buf.toString('hex'))
            return
        }

        // Plain minutes (device_class duration + unit_of_measurement 'min'); the previous
        // H:MM:SS strings left the entities Unavailable since they weren't valid durations.
        this.publishProperty('initial_time', initialH * 60 + initialM)
        this.publishProperty('remaining_time', remainingH * 60 + remainingM)

        const STATES: Record<number, string> = {
            0x00: 'Off',
            0x01: 'Starting',
            0x02: 'Running',
            0x04: 'Done',
            0x05: 'Complete',
        }
        const PROCESS: Record<number, string> = {
            0x02: 'Washing',
            0x03: 'Rinsing',
            0x04: 'Drying',
            0x05: 'Complete',
            0x06: 'Night Dry',
            0x00: '-',
        }
        const COURSES: Record<number, string> = { 0x05: 'Eco', 0x01: 'Auto', 0x02: 'Intensive' }
        // run_state = granular machine state; process_state = phase.
        this.publishProperty('run_state', STATES[state] ?? String(state))
        this.publishProperty('process_state', PROCESS[process] ?? String(process))

        // `running` binary (on/off) mirrors the cloud's main on/off sensor — the entity the
        // Live Activity automation keys on (to:on / from:on to:off).
        const active = state === 0x01 || state === 0x02
        // The state byte stays 0x02 (Running) for ~8.5h of post-cycle Night Dry (process
        // 0x06); treat that phase as not running so `running` reflects the actual cycle.
        this.publishProperty('running', active && process !== 0x06 ? 'ON' : 'OFF')

        // Course clears to 0x00 once the cycle ends (state 0x04/0x05); only publish
        // a course while the cycle is active, otherwise '-'.
        this.publishProperty('current_course', active ? (COURSES[course] ?? String(course)) : '-')

        // Options bitfield clears at cycle end like the course byte; gate on
        // active state so the entity reads OFF once the cycle finishes.
        this.publishProperty('energy_saver', active && optionBits & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('rinse_refill', statusBits & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('door_open', statusBits & 0x02 ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        // Dishwasher is read-mostly; any command surface (remote start, etc.)
        // is TODO until the captures show what the device accepts.
        console.warn(`D30: unsupported property ${prop} (value ${mqttValue})`)
    }
}
