import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'

// LG D30 ThinQ dishwasher (deviceType 204), sold as the LDT54788D (US).
//
// Based on the D0211 handler by @Stinocon (github.com/Stinocon/rethink-dishwasher): same
// record layout and status-push request, with the fields re-verified against captures and
// panel photos of an LDT54788D. See the processAABB comment for the field layout.
//
// Every component carries an explicit `default_entity_id` so the entity_id is deterministic
// (`sensor.lg_dishwasher_*` / `binary_sensor.lg_dishwasher_*`) instead of being slugified
// from the English name.

// 0x32 0xec + 26-byte prior record + 26-byte current record
const EC_FRAME_LEN = 54

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
                    control_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-control_lock',
                        default_entity_id: 'binary_sensor.lg_dishwasher_control_lock',
                        state_topic: '$this/control_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        default_entity_id: 'binary_sensor.lg_dishwasher_energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy saver',
                        icon: 'mdi:leaf',
                    },
                    half_load: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-half_load',
                        default_entity_id: 'binary_sensor.lg_dishwasher_half_load',
                        state_topic: '$this/half_load',
                        name: 'Half load',
                        icon: 'mdi:tray-alert',
                    },
                    extra_dry: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_dry',
                        default_entity_id: 'binary_sensor.lg_dishwasher_extra_dry',
                        state_topic: '$this/extra_dry',
                        name: 'Extra dry',
                        icon: 'mdi:heat-wave',
                    },
                    high_temp: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-high_temp',
                        default_entity_id: 'binary_sensor.lg_dishwasher_high_temp',
                        state_topic: '$this/high_temp',
                        name: 'High temp',
                        icon: 'mdi:thermometer-high',
                    },
                    tub_clean_counter: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_counter',
                        default_entity_id: 'sensor.lg_dishwasher_tub_clean_counter',
                        state_topic: '$this/tub_clean_counter',
                        name: 'Cycles since Machine Clean',
                        icon: 'mdi:counter',
                        state_class: 'measurement',
                    },
                    delay_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_start',
                        default_entity_id: 'binary_sensor.lg_dishwasher_delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay start',
                        icon: 'mdi:clock-plus-outline',
                    },
                    delay_start_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_start_time',
                        default_entity_id: 'sensor.lg_dishwasher_delay_start_time',
                        state_topic: '$this/delay_start_time',
                        name: 'Delay start time remaining',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    night_dry: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-night_dry',
                        default_entity_id: 'binary_sensor.lg_dishwasher_night_dry',
                        state_topic: '$this/night_dry',
                        name: 'Night dry',
                        icon: 'mdi:weather-night',
                    },
                    dual_zone: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dual_zone',
                        default_entity_id: 'binary_sensor.lg_dishwasher_dual_zone',
                        state_topic: '$this/dual_zone',
                        name: 'Dual zone',
                        icon: 'mdi:view-split-horizontal',
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
    //   [2]      state    0x01=Selecting, 0x02=Running, 0x03=Paused, 0x04=Done, 0x05=Complete
    //                     (transient), 0x00=Off/standby (after Done, before the device stops
    //                     reporting). 0x03 seen once, 2026-09-23: for 24 s just after a Normal cycle
    //                     started, with the door-open bit set, then back to 0x02.
    //   [3]      process  0x02=Washing, 0x03=Rinsing, 0x04=Drying, 0x05=Complete, 0x06=Night
    //                     Dry (post-cycle; state stays 0x02/Running for ~8.5h — treated as not
    //                     running), 0x01=Delayed (waiting out Delay Start; state 0x02 — also treated
    //                     as not running), 0x00=none
    //   [5]/[6]  initial time   (hour, minute)   e.g. 03 05 = 3:05 (Intensive)
    //   [7]      course  0x05=Normal, 0x01=Auto, 0x02=Heavy (clears to 0x00 at cycle end) —
    //                    verified 2026-09-18/19 across Eco, Auto and Intensive washes (the fork's
    //                    names for 0x05/0x02); the LDT54788D's panel labels them Normal and Heavy
    //                    (panel photos 2026-09-21 and 2026-09-23). 0x03=Delicate — verified
    //                    2026-09-23 on an LDT54788D (panel photo). 0x04=Turbo, 0:59 (2026-09-24,
    //                    panel photo).
    //                    0x08=Express, 0:34 (2026-09-24, a hidden course on the LDT54788D panel).
    //                    0x09=Machine Clean, 1:22 (2026-09-24, selected with the long press; Night
    //                    Dry bit clear).
    //                    0x06=Rinse, 0:12 (2026-09-24, hidden course; goes to process 0x03 Rinsing
    //                    within a minute).
    //   [9]/[10] remaining time (hour, minute)   e.g. 02 35 = 2:53, 1/min countdown
    //   [11]/[12] Delay Start time remaining (hour, minute): 01 00 -> 00 3b -> 00 3a, 1/min, on a
    //            Turbo run with a 1-hour Delay Start (2026-09-24); 00 00 otherwise.
    //   [13]     status bitfield: bit 3 (0x08) = rinse aid refill (most likely; the fork this
    //            was adapted from called it "salt refill" — unlikely on a US model), bit 1
    //            (0x02) = door open (Auto Open Dry; the cloud does NOT report this — our
    //            superset), bit 7 (0x80) = Night Dry enabled — verified 2026-09-23 against three
    //            panel photos on an LDT54788D: set on the 2026-09-21 Heavy and 2026-09-23 Delicate
    //            runs (Night Dry lamp lit, both followed by the process 0x06 phase), clear on a
    //            2026-09-23 Normal run with the lamp off (no 0x06 phase followed), and set again on
    //            a 2026-09-24 Turbo run with the lamp lit. Set only while a course is selected or
    //            running and in the Complete state that precedes the Night Dry phase; clear in
    //            every Off/Done/idle record captured, so it's published without the active gate.
    //            bit 0 (0x01) = Control Lock — set in the one record inside a ~16 s lock the user
    //            confirmed (2026-09-24 20:15:58Z, Express selected), again in a second confirmed lock (21:19:54Z,
    //            Rinse selected), and in no other record captured.
    //   [14]     options bitfield: bit 1 (0x02) = energy saver — verified 2026-09-18, and on an
    //            LDT54788D 2026-09-24 (Normal course, the only option set).
    //            bit 6 (0x40) = half load, bit 2 (0x04) = extra dry — verified 2026-09-23: on a
    //            Delicate course, selecting Half Load set 0x40 and cut the estimate 1:54 -> 1:43,
    //            then Extra Dry set 0x04 and raised it to 2:03 (both lamps lit in the panel photo).
    //            bit 3 (0x08) = high temp, bit 4 (0x10) = dual zone — verified 2026-09-23: a
    //            Normal course with only the High Temp lamp lit read 0x08, and the Heavy course
    //            from 2026-09-21, with the Dual Zone and High Temp lamps lit, read 0x18.
    //            bit 0 (0x01) = Delay Start — set when Delay Start was pressed on a Turbo run
    //            (2026-09-24, lamp lit in the panel photo).
    //            bit 7 (0x80) = steam on the EU D0211 (verified by @Stinocon); the LDT54788D
    //            has no Steam option and never set it, so it isn't published here.
    //            Like the course byte, it clears to 0x00 at cycle end (state 0x04/0x05).
    // Still TODO: error codes.
    processAABB(buf: Buffer) {
        // 0xd8 (3 bytes: 32 D8 XX): the wash counter the fork exposed as tub_clean_counter. On an
        // LDT54788D it went 0x28 -> 0x2e over 2026-09-22..24, up by one each time a wash reached its
        // drying stage (Heavy, Delicate, Normal, Turbo, Auto, Express, Rinse), and is resent unchanged
        // at power-on. A completed Machine Clean reset it to 0 (2026-09-25: 0x2e -> 0x00 three seconds
        // after the cycle ended), so it counts washes since the last Machine Clean.
        if (buf[0] === 0x32 && buf[1] === 0xd8 && buf.length > 2) {
            this.publishProperty('tub_clean_counter', buf[2])
            return
        }
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
        // A 194-byte 0xec was seen once, at cycle end, next to the 0xe1 summary; it doesn't follow
        // the two-record layout (reading it as one briefly reported Off with a zero initial time).
        if (buf[1] === 0xec && buf.length !== EC_FRAME_LEN) {
            log('D30', 'unexpected 0xec length', buf.toString('hex'))
            return
        }
        const state = buf[base + 2]
        const process = buf[base + 3]
        const initialH = buf[base + 5]
        const initialM = buf[base + 6]
        const course = buf[base + 7]
        const remainingH = buf[base + 9]
        const remainingM = buf[base + 10]
        const delayH = buf[base + 11]
        const delayM = buf[base + 12]
        const statusBits = buf[base + 13]
        const optionBits = buf[base + 14]

        // Sanity: minutes must be 0..59.
        if (initialM > 59 || remainingM > 59 || delayM > 59 || initialH > 99 || remainingH > 99) {
            log('D30', 'suspect time fields', buf.toString('hex'))
            return
        }

        // Plain minutes (device_class duration + unit_of_measurement 'min'); the previous
        // H:MM:SS strings left the entities Unavailable since they weren't valid durations.
        this.publishProperty('initial_time', initialH * 60 + initialM)
        this.publishProperty('remaining_time', remainingH * 60 + remainingM)
        this.publishProperty('delay_start_time', delayH * 60 + delayM)

        const STATES: Record<number, string> = {
            0x00: 'Off',
            0x01: 'Selecting',
            0x02: 'Running',
            0x03: 'Paused',
            0x04: 'Done',
            0x05: 'Complete',
        }
        const PROCESS: Record<number, string> = {
            0x02: 'Washing',
            0x03: 'Rinsing',
            0x04: 'Drying',
            0x05: 'Complete',
            0x06: 'Night Dry',
            0x01: 'Delayed',
            0x00: '-',
        }
        const COURSES: Record<number, string> = {
            0x05: 'Normal',
            0x06: 'Rinse',
            0x01: 'Auto',
            0x02: 'Heavy',
            0x03: 'Delicate',
            0x04: 'Turbo',
            0x08: 'Express',
            0x09: 'Machine Clean',
        }
        // run_state = granular machine state; process_state = phase.
        this.publishProperty('run_state', STATES[state] ?? String(state))
        this.publishProperty('process_state', PROCESS[process] ?? String(process))

        // `running` binary (on/off) mirrors the cloud's main on/off sensor — the entity the
        // Live Activity automation keys on (to:on / from:on to:off).
        // 0x01 (Selecting) is the panel on with a course picked and the door open, before
        // Start: it shows the selected course and options, but nothing is washing yet.
        const active = state === 0x01 || state === 0x02 || state === 0x03
        const cycle = state === 0x02 || state === 0x03
        // The state byte stays 0x02 (Running) for ~8.5h of post-cycle Night Dry (process
        // 0x06); treat that phase as not running so `running` reflects the actual cycle.
        this.publishProperty('running', cycle && process !== 0x06 && process !== 0x01 ? 'ON' : 'OFF')

        // Course clears to 0x00 once the cycle ends (state 0x04/0x05); only publish
        // a course while the cycle is active, otherwise '-'.
        this.publishProperty('current_course', active ? (COURSES[course] ?? String(course)) : '-')

        // Options bitfield clears at cycle end like the course byte; gate on
        // active state so the entity reads OFF once the cycle finishes.
        this.publishProperty('energy_saver', active && optionBits & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('half_load', active && optionBits & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('extra_dry', active && optionBits & 0x04 ? 'ON' : 'OFF')
        this.publishProperty('high_temp', active && optionBits & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('dual_zone', active && optionBits & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('delay_start', active && optionBits & 0x01 ? 'ON' : 'OFF')
        this.publishProperty('night_dry', statusBits & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('rinse_refill', statusBits & 0x08 ? 'ON' : 'OFF')
        this.publishProperty('door_open', statusBits & 0x02 ? 'ON' : 'OFF')
        this.publishProperty('control_lock', statusBits & 0x01 ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        // Dishwasher is read-mostly; any command surface (remote start, etc.)
        // is TODO until the captures show what the device accepts.
        console.warn(`D30: unsupported property ${prop} (value ${mqttValue})`)
    }
}
