import HADevice from './base'
import AABBDevice from './aabb_device'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { TEMPERATURES, SPINS } from './washer_common'

// W4X1085NWH, clip_ble_v1.9.215: enveloped 39-byte records.
// Locally captured: [2] state, [7] course, [10] spin, [11] temperature.
// Verified on the panel: Cotton=1, 60 C=6, no spin=1, 400 rpm=2.
const STATUS_LENGTH = 39
// States captured on this unit; other models disagree on some phase codes.
const STATES = Enum.of({ Off: 0, Ready: 1, Paused: 2, Washing: 6, Rinsing: 7, Spinning: 8, End: 10 })
const COURSES = Enum.of({
    'Not selected': 0,
    Cotton: 1,
    'Eco 40-60': 4,
    Mix: 7,
    'Quick 30': 0x22,
    Synthetic: 2,
    'Tub Clean': 0x12,
    'Hand wash/Wool': 0x1b,
    'Dry only': 0x18,
    'Wash + Dry': 0x13,
})
const DOWNLOADED_PROGRAMME = 'Downloaded programme'
const DRYING = Enum.of({ Off: 0, 'Cupboard dry': 2, 'Low temperature': 11 })

export default class Device extends AABBDevice {
    // Later phases clear temperature/rinse/spin fields; retain the selected
    // configuration so Run programme cannot replay those cleared values.
    private programme: Buffer | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        const enumeration = (name: string, key: string, options: string[]) => ({
            platform: 'sensor' as const,
            device_class: 'enum' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
            options,
        })
        const duration = (name: string, key: string) => ({
            platform: 'sensor' as const,
            device_class: 'duration' as const,
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            unit_of_measurement: 'min',
            name,
        })
        const button = (name: string, key: string, icon: string) => ({
            platform: 'button' as const,
            unique_id: `$deviceid-${key}`,
            command_topic: `$this/${key}/set`,
            payload_press: 'PRESS',
            name,
            icon,
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer', model: 'W4X1085NWH' }),
                components: {
                    status: enumeration('Status', 'status', STATES.options),
                    course: enumeration('Programme', 'course', [...COURSES.options, DOWNLOADED_PROGRAMME]),
                    temp: enumeration('Selected temperature', 'temp', TEMPERATURES.options),
                    spin: enumeration('Selected spin speed', 'spin', SPINS.options),
                    drying: enumeration('Drying mode', 'drying', DRYING.options),
                    remaining_time: duration('Remaining time', 'remaining_time'),
                    initial_time: duration('Initial time', 'initial_time'),
                    reserve_time: duration('Delayed finish', 'reserve_time'),
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:remote',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        device_class: 'lock',
                        unique_id: '$deviceid-door_lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                    },
                    power: {
                        platform: 'binary_sensor',
                        device_class: 'power',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                    },
                    power_control: {
                        platform: 'switch',
                        unique_id: '$deviceid-power_control',
                        state_topic: '$this/power',
                        command_topic: '$this/power_control/set',
                        name: 'Power control',
                        icon: 'mdi:power',
                    },
                    run_programme: button('Run programme', 'run_programme', 'mdi:play-box-outline'),
                    pause: button('Pause', 'pause', 'mdi:pause-circle-outline'),
                },
            }),
        )
    }

    start() {
        // Existing washer status request, verified against this physical unit.
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processEnvelopedStatus(buf, 0x20, STATUS_LENGTH, this.processStatus)
    }

    processStatus(status: Buffer) {
        if (status[2] === 1) this.programme = Buffer.from(status)
        else if (status[2] === 0) this.programme = undefined
        const state = STATES.map(status[2])
        this.publishProperty('status', state)
        this.publishProperty('power', state === undefined ? undefined : status[2] === 0 ? 'OFF' : 'ON')
        // The Download selector activates [22], while [25] holds the slot's
        // contents even on ordinary courses. Captured with the factory download.
        this.publishProperty(
            'course',
            status[22] > 0 && status[22] < 0xff ? DOWNLOADED_PROGRAMME : COURSES.map(status[7]),
        )
        this.publishProperty('temp', TEMPERATURES.map(status[11]))
        this.publishProperty('spin', SPINS.map(status[10]))
        this.publishProperty('drying', DRYING.map(status[13]))
        // Dry-only and an unselected idle programme report a duration while
        // the panel shows dashes. It becomes an estimate once a cycle starts.
        const durationKnown = status[7] !== 0 && !(status[2] === 1 && status[13] !== 0)
        this.publishProperty('remaining_time', durationKnown ? status[3] * 60 + status[4] : undefined)
        this.publishProperty('initial_time', durationKnown ? status[5] * 60 + status[6] : undefined)
        this.publishProperty('reserve_time', status[14] * 60 + status[15])
        this.publishProperty('remote_start', status[17] & 0x02 ? 'ON' : 'OFF')
        // HA's lock binary-sensor class uses OFF for locked, ON for unlocked.
        this.publishProperty('door_lock', status[17] & 0x40 ? 'OFF' : 'ON')
        this.publishProperty('child_lock', status[17] & 0x80 ? 'ON' : 'OFF')
    }

    setProperty(prop: string, value: string) {
        if (prop === 'power_control') {
            if (value === 'ON') this.send(Buffer.from('F02A0100', 'hex'))
            else if (value === 'OFF') this.send(Buffer.from('F024010100', 'hex'))
            return
        }
        if (value !== 'PRESS') return
        if (prop === 'pause') this.send(Buffer.from('F024040100', 'hex'))
        if (prop !== 'run_programme') return
        const s = this.programme
        // Downloaded programmes have a separate configuration path, unverified
        // on this model. Never substitute a guessed or zeroed programme.
        if (!s || s[7] === 0 || COURSES.map(s[7]) === undefined || s[22] !== 0) return
        // F026 starts (or restarts) the selected programme. F02405 was rejected
        // by this washer; it must not be advertised as a working Resume command.
        this.send(
            Buffer.from([
                0xf0,
                0x26,
                s[7],
                s[9],
                s[10],
                s[11],
                s[12],
                s[13],
                s[14],
                s[15],
                0,
                s[16],
                0x03,
                0,
                0,
                0,
                0,
                0,
            ]),
        )
    }
}
