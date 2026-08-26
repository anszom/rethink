import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG RHX5009NHB heat-pump dryer (EU) — matched on modelId "SDH_GVX5_6211" (DeviceType 202,
// protocolVer 7, RTK_RTL8720cm). Framing differs from both the EU washers (0x20-family,
// 39-byte blocks) and the US RV13* dryers (0x1b-marked 28-byte records):
//   inner[0] = 0x30, inner[10] = record kind, inner[11..12] = payload length (big-endian),
//   payload at inner[13] = one or two 50-byte status blocks, each led by a 0x0a marker.
//   0xEC carries previous + current (current LAST — the opposite order to the EU washers),
//   0xEB carries a single block as the reply to the F0ED status request.
//
// Every offset below was confirmed live on the physical dryer: one panel change at a time
// (~20 s apart, the appliance withholds status while retransmitting unanswered records),
// each finding cross-checked against what the panel displayed, usually via a second signal
// such as the effect on the estimated cycle time.

const HEADER_LENGTH = 13
const BLOCK_LENGTH = 50
const BLOCK_MARKER = 0x0a

// Family-wide "report your state" request, same as the EU washers and US dryers.
const STATUS_REQUEST = 'F0ED1121010000001800'

// rec[1]: dry level. Confirmed by stepping the panel's poziom suszenia on Cotton — the cycle
// estimate moved 150 -> 180 -> 110 min in lockstep. 0 on courses without a dry level.
const DRY_LEVEL_OFFSET = 1
const DRY_LEVELS: Record<number, string> = {
    0x01: 'Iron',
    0x03: 'Cupboard',
    0x05: 'Extra',
}

// rec[2]: drying mode (tryb suszenia). Confirmed on Mixed Fabric: Turbo showed the 65-minute
// estimate, Efficiency doubled it to 120. Each course remembers its own mode.
const DRY_MODE_OFFSET = 2
const DRY_MODES: Record<number, string> = {
    0x02: 'Efficiency',
    0x03: 'Turbo',
}

// rec[7..8]: delay start in minutes, big-endian (armed flag is FLAG2_DELAY below). Confirmed
// across the full 3 h -> 19 h panel sweep.
const DELAY_OFFSET = 7
// rec[9..10] / rec[11..12]: remaining / initial estimate in minutes, big-endian. Confirmed
// against the panel times of all 12 courses and a live countdown.
const REMAIN_TIME_OFFSET = 9
const INITIAL_TIME_OFFSET = 11

// rec[13]: phase; rec[14] holds the phase this one replaced, rec[15] the error code.
// 01/03/05/07 observed live (Error via a deliberate dE1); 0x00 is the powered-off block.
const PHASE_OFFSET = 13
const PREV_PHASE_OFFSET = 14
const ERROR_OFFSET = 15
const PHASE_OFF = 0x00
const PHASE_ERROR = 0x05
const STATUS: Record<number, string> = {
    0x00: 'Off',
    0x01: 'Initial',
    0x03: 'Pause',
    0x05: 'Error',
    0x04: 'End',
    0x07: 'Drying',
    0x08: 'Finishing',
    0x11: 'Cooling',
}

// rec[15]: error code. 0x10 was forced live by arming remote start with the door ajar; the
// panel showed dE1 in parallel.
const ERRORS: Record<number, string> = {
    0x10: 'dE1 (door)',
}

// rec[20]: course id. Mapped by sweeping the dial twice and matching the panel order.
// Condenser Cleaning and Drum Cleaning are maintenance courses entered via button holds.
const COURSE_OFFSET = 20
const COURSES: Record<number, string> = {
    0x02: 'Towels',
    0x05: 'Synthetics',
    0x06: 'Mixed Fabric',
    0x07: 'Cotton',
    0x08: 'Sportswear',
    0x0a: 'My Program',
    0x0b: 'Wool',
    0x10: 'Allergy Care',
    0x12: 'Condenser Cleaning',
    0x13: 'Drum Cleaning',
    0x15: 'Time Dry',
    0x19: 'Eco',
    0x1c: 'AI Dry',
    0x26: 'Turbo Dry',
}

// rec[19]: bit 0x04 is the beeper (dźwięk) setting, default ON — it is set even in the
// powered-off block. Confirmed with an isolated toggle.
const FLAGS0_OFFSET = 19
const FLAG0_SOUND = 0x04

// rec[24]: options bitfield, each bit isolated via a single toggle on the panel.
// 0x20 is the drum light: it also comes on by itself at power-on, pause and cycle end, and
// auto-times-out after ~1.5 min, which is genuine lamp behaviour, not reporting noise.
const FLAGS_OFFSET = 24
const FLAG_ANTI_CREASE = 0x08
const FLAG_DRUM_LIGHT = 0x20
const FLAG_MOISTURE_ALERT = 0x40

// rec[26]: a second bitfield. 0x04 marks the auto-sensing courses (AI Dry, Towels, Eco — the
// ones whose time shows "---" on the panel). 0x20 is set during the Cooling phase. 0x40 is
// set by arming remote start AND for the whole time the drum is running (it drops on pause),
// so it is only published as remote_start while the appliance is idle.
const FLAGS2_OFFSET = 26
const FLAG2_AUTO_COURSE = 0x04
const FLAG2_DELAY = 0x08
const FLAG2_CHILD_LOCK = 0x10
const FLAG2_ACTIVE = 0x40

// rec[27]: bit 0x80 latches on at the first power-on after module boot and does NOT clear on
// power-off (confirmed live: a powered-off block still carried it). Conversely the phase byte
// reads 0x01 even in the freshly-booted powered-off block. Only the conjunction works:
// powered = bit set AND phase nonzero.
const POWER_OFFSET = 27
const POWER_BIT = 0x80

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
                        icon: 'mdi:power',
                    },
                    // A button, not a switch: F02A0100 is a power-button press (see setProperty).
                    power_button: {
                        platform: 'button',
                        unique_id: '$deviceid-power_button',
                        command_topic: '$this/power_button/set',
                        payload_press: '',
                        name: 'Power',
                        icon: 'mdi:power',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): unmapped phase codes emit 'Running'.
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                    },
                    dry_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_mode',
                        state_topic: '$this/dry_mode',
                        name: 'Drying mode',
                        icon: 'mdi:fan',
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
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:clock-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    delay: {
                        platform: 'sensor',
                        unique_id: '$deviceid-delay',
                        state_topic: '$this/delay',
                        name: 'Delay start',
                        icon: 'mdi:clock-start',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    anti_crease: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-anti_crease',
                        state_topic: '$this/anti_crease',
                        name: 'Anti-crease',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    moisture_alert: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-moisture_alert',
                        state_topic: '$this/moisture_alert',
                        name: 'Moisture alert',
                        icon: 'mdi:water-alert-outline',
                    },
                    drum_light: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_light',
                        state_topic: '$this/drum_light',
                        name: 'Drum light',
                        device_class: 'light',
                    },
                    sound: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-sound',
                        state_topic: '$this/sound',
                        name: 'Sound',
                        icon: 'mdi:volume-high',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                        entity_category: 'diagnostic',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:cellphone-wireless',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    // Same rationale as the US dryers: without asking once per connect, the entities stay
    // blank until the next physical interaction, and an unanswered appliance keeps
    // retransmitting its 0x03 records instead of streaming status.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30 || buf.length < HEADER_LENGTH + BLOCK_LENGTH) return

        const payloadLength = buf.readUInt16BE(11)
        if (buf.length < HEADER_LENGTH + payloadLength) return

        if (buf[10] === 0xec && payloadLength === BLOCK_LENGTH * 2) {
            // previous + current; current is the LAST block
            this.processStatus(buf.subarray(HEADER_LENGTH + BLOCK_LENGTH, HEADER_LENGTH + BLOCK_LENGTH * 2))
        } else if (buf[10] === 0xeb && payloadLength === BLOCK_LENGTH) {
            this.processStatus(buf.subarray(HEADER_LENGTH, HEADER_LENGTH + BLOCK_LENGTH))
        }
    }

    processStatus(rec: Buffer) {
        if (rec[0] !== BLOCK_MARKER) return

        const phase = rec[PHASE_OFFSET]
        const isOff = (rec[POWER_OFFSET] & POWER_BIT) === 0 || phase === PHASE_OFF
        const error = phase === PHASE_ERROR ? rec[ERROR_OFFSET] : 0

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('error_message', error ? (ERRORS[error] ?? `unknown (0x${error.toString(16)})`) : 'none')
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('status', isOff ? 'Off' : (STATUS[phase] ?? 'Running'))
        this.publishProperty('course', COURSES[rec[COURSE_OFFSET]] ?? 'unknown')
        this.publishProperty('dry_level', DRY_LEVELS[rec[DRY_LEVEL_OFFSET]] ?? 'unknown')
        this.publishProperty('dry_mode', DRY_MODES[rec[DRY_MODE_OFFSET]] ?? 'unknown')
        this.publishProperty('remaining_time', isOff ? 0 : rec.readUInt16BE(REMAIN_TIME_OFFSET))
        this.publishProperty('initial_time', isOff ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))

        const flags2 = rec[FLAGS2_OFFSET]
        this.publishProperty('delay', (flags2 & FLAG2_DELAY) !== 0 ? rec.readUInt16BE(DELAY_OFFSET) : 0)
        // 0x40 also stays on for the whole run, so only report it as remote start while idle
        if (phase === 0x01 || isOff) {
            this.publishProperty('remote_start', (flags2 & FLAG2_ACTIVE) !== 0 ? 'ON' : 'OFF')
        }

        const flags = rec[FLAGS_OFFSET]
        this.publishProperty('anti_crease', (flags & FLAG_ANTI_CREASE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('moisture_alert', (flags & FLAG_MOISTURE_ALERT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_light', (flags & FLAG_DRUM_LIGHT) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('sound', (rec[FLAGS0_OFFSET] & FLAG0_SOUND) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (flags2 & FLAG2_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
    }

    // Only the power press is wired up. F02A0100 was confirmed live (it switched the appliance
    // off); the washer's F024 start/pause commands are silently ignored by this model, and the
    // F0E5 write channel (F0E5 00 02 01 30 01 <field> <value>, field 0x02 = power on/off) has no
    // known start field yet — a wrong value beeps and returns status 0x0c. Power is a button,
    // not a switch: F02A0100 is a power-button press, so two presses toggle on then off.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power_button') this.send(Buffer.from('F02A0100', 'hex'))
    }
}
