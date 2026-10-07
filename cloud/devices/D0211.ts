import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { Enum } from '@/util/enum'
import {
    FLAG1_DOOR_OPEN,
    OPTION_EXTRA_DRY,
    OPTION_HIGH_TEMP,
    PROCESS_STATES,
    APPLIANCE_STATES,
    unpackStatus,
} from './dishwasher_common'

// LG D0211 ThinQ dishwasher (deviceType 204) — DB365TXS / DBC435TSL.AASQEIS.
//
//
// Still undecoded and therefore absent: the error codes, the auto-door status, remote start and
// the completed-cycle flag. The field layout and the provenance of every bit are in the
// processAABB comment.
//

const CLASS_BYTE = 0x32
// [flag][0x18 length] + 24-byte status body
const STATUS_RECORD_LENGTH = 26

const COURSES = Enum.of({
    Off: 0x00,
    Eco: 0x05,
    Auto: 0x01,
    Intensive: 0x02,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // `true`, as the constructor recommends for new devices: the real cloud acks these
        // frames, and this model reported a steady ~1/min cadence even while unacked.
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dishwasher' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:dishwasher',
                        device_class: 'enum',
                        options: APPLIANCE_STATES.options,
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:playlist-play',
                        device_class: 'enum',
                        options: COURSES.options,
                    },
                    process: {
                        platform: 'sensor',
                        unique_id: '$deviceid-process',
                        state_topic: '$this/process',
                        name: 'Process',
                        icon: 'mdi:progress-clock',
                        device_class: 'enum',
                        options: PROCESS_STATES.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    salt_refill: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-salt_refill',
                        state_topic: '$this/salt_refill',
                        name: 'Salt refill',
                        icon: 'mdi:water',
                    },
                    rinse_refill: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-rinse_refill',
                        state_topic: '$this/rinse_refill',
                        name: 'Rinse refill',
                        icon: 'mdi:cup-water',
                    },
                    door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                        device_class: 'door',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                    },
                    dual_zone: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dual_zone',
                        state_topic: '$this/dual_zone',
                        name: 'Dual zone',
                        icon: 'mdi:view-split-horizontal',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Energy saver',
                        icon: 'mdi:leaf',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    delay_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-delay_start',
                        state_topic: '$this/delay_start',
                        name: 'Delay start',
                        icon: 'mdi:clock-plus-outline',
                    },
                    extra_dry: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_dry',
                        state_topic: '$this/extra_dry',
                        name: 'Extra dry',
                        icon: 'mdi:weather-sunny',
                    },
                    high_temp: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-high_temp',
                        state_topic: '$this/high_temp',
                        name: 'High temp',
                        icon: 'mdi:thermometer-high',
                    },
                    half_load: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-half_load',
                        state_topic: '$this/half_load',
                        name: 'Half load',
                        icon: 'mdi:package-variant-closed-minus',
                    },
                    tub_clean_counter: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_counter',
                        state_topic: '$this/tub_clean_counter',
                        name: 'Tub clean counter',
                        icon: 'mdi:counter',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    // HA rejects any value outside the declared options, so an undecoded byte is published as
    // undefined — which reaches HA as 'None' — rather than as a raw code. The code goes to the
    // log, where it is useful for extending the table.
    static formatStatus(value: number) {
        const name = APPLIANCE_STATES.map(value)
        if (name === undefined) log('D0211', 'undecoded status', value.toString(16))
        return name
    }

    static formatProcess(value: number) {
        const name = PROCESS_STATES.map(value)
        if (name === undefined) log('D0211', 'undecoded process', value.toString(16))
        return name
    }

    static formatCourse(value: number) {
        const name = COURSES.map(value)
        if (name === undefined) log('D0211', 'undecoded course', value.toString(16))
        return name
    }

    // Standard 0xeb/0xec framing.Each record is [flag][0x18 length] followed by the status body;
    // offsets below are relative to that body:
    //   [0]      state    machine state,
    //   [1]      process  phase within the cycle
    //   [3]/[4]  initial time   (hour, minute)   e.g. 03 05 = 3:05 (Intensive)
    //   [5]      course
    //   [7]/[8]  remaining time (hour, minute)   e.g. 02 35 = 2:53, 1/min countdown
    //   [11]     status bitfield, see below
    //   [12]     options bitfield, see below
    //
    //   [12] options, gated on the active state (the byte clears to 0x00 at cycle end — one
    //        record BEFORE the course byte, i.e. already at state 0x05 while [5] still holds
    //        the course):
    //          0x01 delay start   means "a delay is pending"
    //          0x02 energy saver
    //          0x04 extra dry     NOTE: the appliance can enable it by itself when the rinse aid is empty
    //          0x08 high temp
    //          0x10 dual zone
    //          0x40 half load
    //          0x80 steam
    //
    //   [11] status, not gated (these are persistent flags, not cycle state):
    //          0x01 child lock
    //          0x02 door open
    //          0x04 rinse refill  matches the panel's rinse-aid lamp
    //          0x08 salt refill
    //
    //        The delay-start countdown is a third thing again: at state 0x02 the appliance runs
    //        process 0x01 for the whole reservation (measured 2026-09-26, 59m36s of it, in 61
    //        records). It is a phase like the others, published as `Delayed Start`.
    //
    processAABB(buf: Buffer) {
        // Exact lengths: the sibling D30 handler met a 194-byte 0xec once, so this platform can
        // drift, and a longer frame read as the two-record layout would publish the wrong record as
        // the current one.
        if (this.processCommonStatus(buf, CLASS_BYTE, STATUS_RECORD_LENGTH, this.processStatus)) return

        // Transition frame 0x32 0xd8 <n>: a single byte carrying the cycle counter. Emitted once per
        // cycle within a couple of seconds of the process byte moving 0x03 -> 0x04, the rinse->dry
        // transition.
        if (buf[0] === CLASS_BYTE && buf[1] === 0xd8 && buf.length === 3) {
            this.publishProperty('tub_clean_counter', buf[2])
        }
    }

    processStatus(curStatus: Buffer) {
        // this includes a flag/length prefix
        if (curStatus[1] != STATUS_RECORD_LENGTH - 2) return

        const data = curStatus.subarray(2)
        const s = unpackStatus(data)

        // Sanity: minutes must be 0..59.
        if (
            s.initialTimeMinute > 59 ||
            s.remainingTimeMinute > 59 ||
            s.initialTimeHour > 99 ||
            s.remainingTimeHour > 99
        ) {
            log('D0211', 'suspect time fields', curStatus.toString('hex'))
            return
        }

        // Durations in whole minutes, like the other rethink handlers.
        this.publishProperty('initial_time', s.initialTimeHour * 60 + s.initialTimeMinute)
        this.publishProperty('remaining_time', s.remainingTimeHour * 60 + s.remainingTimeMinute)

        // status = granular machine state; process = phase. The phase comes from the
        // same record as the state, so an idle record (process 0x00) publishes 'None' for it.
        // Process 0x01 is the delay-start reservation, a phase the appliance really reports — it
        // is in the table, so it publishes 'Delayed Start' instead of logging itself as undecoded.
        this.publishProperty('status', Device.formatStatus(s.state))
        this.publishProperty('process', Device.formatProcess(s.process))

        // `cycleState` asks whether the byte carries a selection at all: the option and course
        // bytes clear at the 0x05 completing record, so outside state 0x02 they hold leftovers
        // rather than a choice. It is what the options and the course gate on — including during
        // the delay-start countdown, where the selection is real and the option byte is set.
        const cycleState = s.state === 0x02

        // Course clears to 0x00 once the cycle ends (state 0x04/0x05), and that byte survives for
        // one record after END; only publish a course while the cycle is active, otherwise
        // 'Off'.
        this.publishProperty('course', cycleState ? Device.formatCourse(s.course) : 'Off')

        // The measured option bits share the [12] byte, which clears at cycle end; gate on the
        // active state so the entities read OFF once the cycle finishes.
        const option = (bit: number) => (cycleState && s.options & bit ? 'ON' : 'OFF')
        this.publishProperty('delay_start', option(0x01))
        this.publishProperty('energy_saver', option(0x02))
        this.publishProperty('extra_dry', option(OPTION_EXTRA_DRY))
        this.publishProperty('high_temp', option(OPTION_HIGH_TEMP))
        this.publishProperty('dual_zone', option(0x10))
        this.publishProperty('half_load', option(0x40))
        this.publishProperty('steam', option(0x80))

        // Status bits are persistent flags, not cycle state, so they are not gated.
        // device_class 'lock' reads ON as unlocked, so the lock bit is inverted.
        this.publishProperty('child_lock', s.flags1 & 0x01 ? 'OFF' : 'ON')
        this.publishProperty('door', s.flags1 & FLAG1_DOOR_OPEN ? 'ON' : 'OFF')
        this.publishProperty('rinse_refill', s.flags1 & 0x04 ? 'ON' : 'OFF')
        this.publishProperty('salt_refill', s.flags1 & 0x08 ? 'ON' : 'OFF')
    }

    setProperty(prop: string, mqttValue: string) {
        // Dishwasher is read-mostly; any command surface (remote start, etc.)
        // is TODO until the captures show what the device accepts.
        console.warn(`D0211: unsupported property ${prop} (value ${mqttValue})`)
    }
}
