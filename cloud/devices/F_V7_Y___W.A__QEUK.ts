import HADevice from './base'
import AABBDevice from './aabb_device'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'

// This A-generation model differs from the F_C and B-generation F_V handlers:
// course is rec[7], door lock is rec[17] bit 6, and spin index 3 means 600 rpm.
// Record A is previous state; record B is current. E2/BD/CD/DC have other layouts.
const STATES: Record<number, string> = {
    '0': 'Off',
    '1': 'Standby',
    '2': 'Paused',
    '3': 'Delayed',
    '4': 'Measuring',
    '6': 'Washing',
    '7': 'Rinsing',
    '8': 'Spinning',
    '9': 'Drying',
    '10': 'Finished',
    '11': 'Cooling',
    '12': 'Rinse hold',
    '14': 'Refreshing',
    '15': 'Steam softening',
    '16': 'Demo',
    '18': 'Error',
}
const COURSES: Record<number, string> = {
    '1': 'Cotton',
    '2': 'Easy Care',
    '4': 'Cotton+',
    '5': 'Duvet',
    '7': 'Mixed Fabric',
    '8': 'Sportswear',
    '9': 'Silent Wash',
    '14': 'Rinse + Spin',
    '18': 'Tub Clean',
    '27': 'Wool',
    '32': 'Delicates',
    '34': 'Quick 30',
    '44': 'Baby Steam Care',
    '45': 'Allergy Care',
}
const RINSES: string[] = ['Not selected', 'Normal', 'Rinse+', 'Rinse++', 'Normal + hold', 'Rinse+ + hold']
const WASH_MODES: string[] = ['Not selected', 'TurboWash', 'Time save', 'Normal', 'Intensive']
const TEMPERATURE_SETTINGS: string[] = ['Not selected', 'Cold', '20 °C', '30 °C', '40 °C', '50 °C', '60 °C', '95 °C']
const SMART_COURSES: Record<number, string> = {
    64: 'Noise Minimize',
    71: 'Baby Care',
    72: 'Hygiene',
    73: 'Small Load',
    100: 'Rinse + Spin',
    102: 'Minimize Detergent Residue',
    122: 'Spin',
}
const SPINS = [undefined, 0, 400, 600, 700, 800, 900, 1000, 1100, 1200, 1400, 1600]
const TEMPERATURES = [undefined, undefined, 20, 30, 40, 50, 60, 95]
// The bridge acknowledged these types in the capture, but not the large BD/CD dumps.
const ACK_TYPES = new Set([0x72, 0xd8, 0xe2, 0xdc])

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        const enumSensor = (name: string, options: string[]) => ({
            platform: 'sensor',
            name,
            device_class: 'enum',
            options: [...new Set(options)],
        })
        const flag = (name: string, icon: string) => ({ platform: 'binary_sensor', name, icon })
        const duration = (name: string) => ({
            platform: 'sensor',
            name,
            device_class: 'duration',
            unit_of_measurement: 'min',
        })
        const definitions = {
            power: { ...flag('Power', 'mdi:power'), device_class: 'power' },
            status: enumSensor('Status', Object.values(STATES)),
            completed: flag('Cycle complete', 'mdi:check-circle'),
            course: enumSensor('Course', [...Object.values(COURSES), ...Object.values(SMART_COURSES)]),
            downloaded_course: enumSensor('Downloaded cycle', Object.values(SMART_COURSES)),
            spin: { platform: 'sensor', name: 'Spin speed', unit_of_measurement: 'rpm', icon: 'mdi:autorenew' },
            temp: {
                platform: 'sensor',
                name: 'Selected temperature',
                device_class: 'temperature',
                unit_of_measurement: '°C',
            },
            temperature_setting: enumSensor('Temperature setting', TEMPERATURE_SETTINGS),
            remaining_time: duration('Remaining time'),
            initial_time: duration('Initial time'),
            delay_remaining: duration('Delay end remaining'),
            remote_start: flag('Remote Start', 'mdi:remote'),
            door_lock: { ...flag('Door lock', 'mdi:door-closed-lock'), device_class: 'lock' },
            child_lock: flag('Child lock', 'mdi:account-lock'),
            pre_wash: flag('Pre-wash', 'mdi:water-sync'),
            steam: flag('Steam', 'mdi:kettle-steam'),
            medic_rinse: flag('Medic rinse', 'mdi:water-thermometer'),
            rinse: enumSensor('Rinse setting', RINSES),
            wash_mode: enumSensor('Wash mode', WASH_MODES),
            tub_clean_count: { platform: 'sensor', name: 'Washes since Tub Clean', icon: 'mdi:counter' },
        }
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: Object.fromEntries(
                    Object.entries(definitions).map(([key, definition]) => [
                        key,
                        {
                            ...definition,
                            unique_id: `$deviceid-${key}`,
                            state_topic: `$this/${key}`,
                        },
                    ]),
                ),
            }),
        )
    }

    // Passive monitoring: no unverified status-query or actuating command on connect.
    override processData(frame: Buffer) {
        if (frame.length < 6 || frame[0] !== 0xaa || frame[frame.length - 1] !== 0xbb) return
        if (frame.length <= 255 && frame[1] !== frame.length) return
        const sum = frame.subarray(0, -2).reduce((total, b) => total + b, 0)
        if (((sum & 255) ^ 0x55) !== frame[frame.length - 2]) return
        super.processData(frame)
    }

    override processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return
        if (ACK_TYPES.has(buf[1])) this.thinq.send_ack(AABBDevice.frame(Buffer.from([0xf0, 0, buf[1], 4])))
        // On this model D8 carries TCLCount, not the F_C sibling's door-lock state.
        // The cloud reports this value before the following EC snapshot arrives.
        if (buf.length === 3 && buf[1] === 0xd8) {
            this.publishProperty('tub_clean_count', buf[2] <= 60 ? buf[2] : undefined)
            return
        }
        if (buf.length !== 62 || buf[1] !== 0xec) return
        if (buf[2] !== 0 || buf[3] !== 28 || buf[32] !== 0 || buf[33] !== 28) return
        const rec = buf.subarray(32)
        if (rec[3] > 30 || rec[4] > 59 || rec[5] > 30 || rec[6] > 59) return
        const state = STATES[rec[2]]
        const binary = (key: string, value: boolean) => this.publishProperty(key, value ? 'ON' : 'OFF')
        this.publishProperty('status', state)
        this.publishProperty('power', state === undefined ? undefined : rec[2] === 0 ? 'OFF' : 'ON')
        this.publishProperty('completed', state === undefined ? undefined : rec[2] === 10 ? 'ON' : 'OFF')
        // A selected downloaded cycle overrides its base course, which remains in rec[7].
        this.publishProperty('course', rec[22] ? SMART_COURSES[rec[22]] : COURSES[rec[7]])
        this.publishProperty('downloaded_course', SMART_COURSES[rec[25]])
        this.publishProperty('spin', SPINS[rec[10]])
        this.publishProperty('temp', TEMPERATURES[rec[11]])
        this.publishProperty('temperature_setting', TEMPERATURE_SETTINGS[rec[11]])
        this.publishProperty('rinse', RINSES[rec[12]])
        this.publishProperty('wash_mode', WASH_MODES[rec[9]])
        this.publishProperty('remaining_time', rec[3] * 60 + rec[4])
        this.publishProperty('initial_time', rec[5] * 60 + rec[6])
        const delayValid = (rec[14] === 0 || (rec[14] >= 1 && rec[14] <= 19)) && rec[15] <= 59
        this.publishProperty('delay_remaining', delayValid ? rec[14] * 60 + rec[15] : undefined)
        binary('pre_wash', Boolean(rec[16] & 0x40))
        binary('steam', Boolean(rec[16] & 0x80))
        binary('medic_rinse', Boolean(rec[16] & 0x10))
        binary('remote_start', Boolean(rec[17] & 2))
        binary('child_lock', Boolean(rec[17] & 0x80))
        // HA's lock class uses ON=unlocked and OFF=locked.
        binary('door_lock', !(rec[17] & 0x40))
        this.publishProperty('tub_clean_count', rec[23] <= 60 ? rec[23] : undefined)
    }
}
