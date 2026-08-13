import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { ERRORS, STATES, COURSES, TEMPERATURES, SPINS } from './washer_common'

// F_C__Y___W.A__QEUK — LG front-loading washer, A-generation UK
// 62-byte AABB status packet (0x20 0xEC subtype).
// Offsets confirmed from live captures against known settings:
//   Cotton/40°C/1400RPM/Normal-rinse, delayed-start 4h, tub-clean-counter=9, remote-start=off.
export default class Device extends AABBDevice {
    // Tracks the last status byte from 0xEC/0xEB so the 0xD8 handler can
    // suppress spurious door_lock=OFF messages during active-cycle states.
    private lastStatus = -1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
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
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:weather-fog',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:iron-outline',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                        device_class: 'lock',
                        entity_category: 'diagnostic',
                    },
                    active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-active',
                        state_topic: '$this/active',
                        name: 'Active',
                        icon: 'mdi:washing-machine',
                    },
                    pre_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pre_state',
                        state_topic: '$this/pre_state',
                        name: 'Pre state',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATES.filter((a) => a !== undefined),
                    },
                    tub_clean: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub-clean',
                        state_topic: '$this/tub_clean',
                        name: 'Tub clean counter',
                        icon: 'mdi:washing-machine-alert',
                        entity_category: 'diagnostic',
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
                    delay_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay_remaining',
                        state_topic: '$this/delay_remaining',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay remaining',
                        icon: 'mdi:clock-start',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        // Log every packet — remove once error/energy offsets are confirmed
        console.log(`[F_C__Y___W.A__QEUK] AABB packet (${buf.length} bytes): ${buf.toString('hex')}`)

        // 0xEC = 62-byte dual-section status packet (normal polling response)
        // 0xEB = 32-byte single-section compact packet (sent after commands/reconnect)
        // Both share the same field layout in their first section.
        // 0xE2 = 32-byte end-of-cycle alert packet: floods at ~2s intervals during End
        //        state. Has different field layout ([4]≠status, [5][6]≠time); [12][13][14]
        //        and [25] coincidentally sit at the same offsets but [4]=0x04='Measuring'
        //        would be wrong to publish. Silently ignored.
        // 0xD8 = 3-byte door-state packet: floods at ~2s intervals during door interaction
        //        and cycle startup. buf[2]=0x00=door not machine-locked (accessible);
        //        non-zero=door machine-locked (0x30 observed at cycle start, 0x0B also seen).
        //        This is the sole source of door_lock state — buf[9] bit6 is unused on
        //        this model and never changes.
        const isEC = buf.length === 62 && buf[0] === 0x20 && buf[1] === 0xec
        const isEB = buf.length === 32 && buf[0] === 0x20 && buf[1] === 0xeb
        const isE2 = buf.length === 32 && buf[0] === 0x20 && buf[1] === 0xe2
        const isD8 = buf.length === 3 && buf[0] === 0x20 && buf[1] === 0xd8
        if (isE2) return

        if (isD8) {
            // Non-zero = door machine-locked; 0x00 = not machine-locked.
            // HA binary_sensor device_class='lock': OFF=Locked (Vergrendeld), ON=Unlocked (Ontgrendeld).
            // Only authoritative during Off (0) and Ready (1); ignored once an active-cycle
            // state is established because the machine can send 0xD8 buf[2]=0x00 spuriously
            // during washing/rinsing (e.g. on child-lock toggle), which would otherwise
            // incorrectly override the status-derived door_lock=OFF.
            if (this.lastStatus <= 1) this.publishProperty('door_lock', buf[2] ? 'OFF' : 'ON')
            return
        }

        if (isEC || isEB) {
            // Confirmed offsets (A-gen status packet — both 0xEC and 0xEB):
            //   [4]     status           — STATES[3]='Delayed' confirmed
            //   [5][6]  remaining_time   — counts down during wash; equals initial when delayed
            //                            NOTE: shows 0 briefly at wash start (load-measuring phase)
            //   [7][8]  initial_time     — fixed total program duration (72 min confirmed, stays constant)
            //   [9]     lock_status      — bit1=remote_start confirmed (0x32 seen with remote start ON);
            //                            other bits vary by program/state; bit6 always 0 — door is via 0xD8
            //   [12]    spin index       — SPINS[10]=1400 RPM confirmed
            //   [13]    temp index       — TEMPERATURES[4]=40°C confirmed
            //   [14]    course           — COURSES[0x01]='Cotton' confirmed
            //   [16]    delay hours      — 4 confirmed
            //   [17]    delay minutes    — counts down 1/min confirmed
            //   [18]    bit7=steam       — 0x80=steam ON; confirmed via steam-toggle experiment
            //           bit5=wrinkle_care — 0x20=wrinkle care ON; confirmed via toggle (+31 min to duration)
            //   [19]    bit6=active      — set once start is pressed; through Measuring/Delayed/Washing/Rinsing/Spinning/End
            //           bit7=child_lock  — confirmed via live capture 2026-07-15 (0xC0=active+child_lock ON, 0x40=active only)
            //   [10]    error_code       — ERRORS index; 0=OK; 0x01=DE2 (door lock error) confirmed via
            //                            live dE2 capture 2026-08-02: buf[10]=0x01 in all Error packets,
            //                            buf[10]=0x00 in all non-error states (Off/Ready/Delayed/Measuring).
            //   [22]    unknown          — varies; 0x03 in Off/Washing, 0x06 in Delayed/Spinning/End
            //   [23]    pre_state        — last run state; mirrors buf[4] during active cycle;
            //                            retains last state after power-off (e.g. End→Off transition shows End)
            //   [25]    tub_clean        — 9 during wash; increments to 10 on End packet confirmed (NOTE: NOT buf[26])
            // The 62-byte 0xEC packet has a second section [32..61] that during option
            // selection holds the alternative configuration (the two sections alternate
            // between current and previous settings as the user scrolls). Only [0..31]
            // (first section) is read here; the second section is ignored.
            // End state: status=0x0A, spin/temp/course all go to 0x00 → 'unknown', remaining=0, tub_clean++.
            // Power stays ON during End (status>0); goes OFF only when status=0x00 ('Off').
            const status = buf[4]
            this.lastStatus = status
            const remain_h = buf[5] // remaining_time hours (counts down; 0 briefly during load-measuring)
            const remain_m = buf[6] // remaining_time minutes
            const initial_h = buf[7] // initial_time hours (fixed for the lifetime of the program)
            const initial_m = buf[8] // initial_time minutes
            const lock_status = buf[9]
            const error_code = buf[10]
            const spin = buf[12]
            const temp = buf[13] // 0x00 during rinse (cold water) → publishes 'unknown', expected
            const course = buf[14]
            const delay_h = buf[16]
            const delay_m = buf[17]
            const steam = buf[18] & 0x80 // bit7: 0x80=steam ON
            const wrinkle_care = buf[18] & 0x20 // bit5: 0x20=wrinkle care ON
            const active = buf[19] & 0x40 // bit6: program active (set once start pressed, through End)
            const child_lock = buf[19] & 0x80 // bit7: child lock engaged
            const pre_state = buf[23]
            const tub_clean = buf[25] // confirmed at buf[25], not buf[26]

            this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[status] ?? 'unknown')
            this.publishProperty('error', error_code ? 'ON' : 'OFF')
            this.publishProperty('error_message', ERRORS[error_code] ?? 'unknown')
            this.publishProperty('course', COURSES[course] ?? 'unknown')
            this.publishProperty('spin', SPINS[spin] ?? 'unknown')
            this.publishProperty('temp', TEMPERATURES[temp] ?? 'unknown')
            this.publishProperty('remaining_time', remain_h * 60 + remain_m)
            this.publishProperty('initial_time', initial_h * 60 + initial_m)
            this.publishProperty('delay_remaining', delay_h * 60 + delay_m)
            this.publishProperty('remote_start', lock_status & 2 ? 'ON' : 'OFF')
            this.publishProperty('steam', steam ? 'ON' : 'OFF')
            this.publishProperty('wrinkle_care', wrinkle_care ? 'ON' : 'OFF')
            this.publishProperty('active', active ? 'ON' : 'OFF')
            this.publishProperty('child_lock', child_lock ? 'OFF' : 'ON')
            this.publishProperty('pre_state', STATES[pre_state] ?? 'unknown')
            this.publishProperty('tub_clean', tub_clean)

            // Derive door_lock from status for Delayed and active-cycle states where
            // 0xD8 packets are not emitted. HA device_class='lock': OFF=Locked, ON=Unlocked.
            // Off(0) → unlocked → ON; Ready(1) → 0xD8 authoritative; everything else → locked → OFF.
            if (status === 0) this.publishProperty('door_lock', 'ON')
            else if (status !== 1) this.publishProperty('door_lock', 'OFF')
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
