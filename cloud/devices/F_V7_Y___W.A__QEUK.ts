import HADevice from './base'
import AABBDevice from './aabb_device'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import WasherControls from './F_V7_Y___W.A__QEUK_controls'

// This A-generation model differs from the F_C and B-generation F_V handlers:
// course is rec[7], door lock is rec[17] bit 6, and spin index 3 means 600 rpm.
// Record A is previous state; record B is current. E2/BD/CD/DC have other layouts.
const STATES: Record<number, string> = {
    '0': 'Off',
    '1': 'Idle',
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
// Downloaded names and their base courses, confirmed by all 24 stored-course reports.
const SMART_COURSES: Record<number, { name: string; course: number }> = {
    71: { name: 'Baby Care', course: 1 },
    58: { name: 'Blanket', course: 5 },
    77: { name: 'Cold Wash', course: 1 },
    63: { name: 'Color Protection', course: 32 },
    121: { name: 'Drain', course: 23 },
    56: { name: 'Gym Clothes', course: 8 },
    72: { name: 'Hygiene', course: 10 },
    57: { name: 'Jeans', course: 32 },
    108: { name: 'Juice and Food Stains', course: 1 },
    52: { name: 'Kids Wear', course: 1 },
    101: { name: 'Lightly Soiled Items', course: 27 },
    74: { name: 'Lingerie', course: 32 },
    102: { name: 'Minimize Detergent Residue', course: 1 },
    64: { name: 'Noise Minimize', course: 9 },
    113: { name: 'Quick Tub Clean', course: 48 },
    55: { name: 'Rainy Season', course: 1 },
    100: { name: 'Rinse + Spin', course: 14 },
    62: { name: 'Single Garment', course: 34 },
    76: { name: 'Skin Care', course: 1 },
    107: { name: 'Sleeve Hems and Collars', course: 1 },
    73: { name: 'Small Load', course: 34 },
    122: { name: 'Spin', course: 23 },
    59: { name: 'Sweat Stain', course: 1 },
    54: { name: 'Swimming Wear', course: 27 },
}
const SPINS = [undefined, 0, 400, 600, 700, 800, 900, 1000, 1100, 1200, 1400, 1600]
const TEMPERATURES = [undefined, undefined, 20, 30, 40, 50, 60, 95]
// The bridge acknowledged these types in the capture, but not the large BD/CD dumps.
const ACK_TYPES = new Set([0x72, 0xd8, 0xe2, 0xdc])

export default class Device extends AABBDevice {
    private readonly controls: WasherControls

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, false)
        this.controls = new WasherControls(
            (inner) => this.send(inner),
            (r) => (r[22] ? SMART_COURSES[r[22]]?.course === r[7] : COURSES[r[7]] !== undefined),
        )
        const enumSensor = (name: string, icon: string, options: string[]) => ({
            platform: 'sensor',
            name,
            device_class: 'enum',
            icon,
            options: [...new Set(options)],
        })
        const flag = (name: string, icon?: string) => ({ platform: 'binary_sensor', name, icon })
        const duration = (name: string, icon: string) => ({
            platform: 'sensor',
            name,
            device_class: 'duration',
            unit_of_measurement: 'min',
            suggested_display_precision: 0,
            icon,
        })
        const definitions = {
            power: { ...flag('Power', 'mdi:washing-machine'), device_class: 'power' },
            status: enumSensor('Status', 'mdi:state-machine', Object.values(STATES)),
            completed: flag('Cycle complete', 'mdi:check-circle'),
            course: enumSensor('Course', 'mdi:pin-outline', [
                ...Object.values(COURSES),
                ...Object.values(SMART_COURSES).map((p) => p.name),
            ]),
            downloaded_course: enumSensor(
                'Downloaded cycle',
                'mdi:download',
                Object.values(SMART_COURSES).map((p) => p.name),
            ),
            spin: {
                platform: 'sensor',
                name: 'Spin',
                unit_of_measurement: 'RPM',
                icon: 'mdi:autorenew',
                suggested_display_precision: 0,
            },
            temp: {
                platform: 'sensor',
                name: 'Temperature',
                device_class: 'temperature',
                unit_of_measurement: '°C',
                suggested_display_precision: 0,
            },
            temperature_setting: enumSensor('Temperature setting', 'mdi:thermometer', TEMPERATURE_SETTINGS),
            remaining_time: duration('Remaining time', 'mdi:timer-outline'),
            initial_time: duration('Initial time', 'mdi:timer-sand'),
            delay_remaining: duration('Delay remaining', 'mdi:clock-start'),
            remote_start: flag('Remote start', 'mdi:play-circle-outline'),
            standby: flag('Standby', 'mdi:sleep'),
            door_lock: { ...flag('Door lock'), device_class: 'lock' },
            // ON means the child-lock option is enabled, not an unlocked door.
            child_lock: { ...flag('Child lock', 'mdi:lock'), entity_category: 'diagnostic' },
            pre_wash: flag('Pre-wash', 'mdi:water-sync'),
            steam: flag('Steam', 'mdi:kettle-steam'),
            medic_rinse: flag('Medic rinse', 'mdi:water-thermometer'),
            rinse: enumSensor('Rinse', 'mdi:water-sync', RINSES),
            wash_mode: enumSensor('Wash mode', 'mdi:washing-machine', WASH_MODES),
            tub_clean_count: {
                platform: 'sensor',
                name: 'Washes since Tub Clean',
                icon: 'mdi:washing-machine-alert',
                entity_category: 'diagnostic',
                suggested_display_precision: 0,
            },
        }
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    ...Object.fromEntries(
                        Object.entries(definitions).map(([key, definition]) => [
                            key,
                            {
                                ...definition,
                                unique_id: `$deviceid-${key}`,
                                state_topic: `$this/${key}`,
                            },
                        ]),
                    ),
                    ...this.controls.components,
                },
            }),
        )
    }

    override drop() {
        this.controls.drop()
        super.drop()
    }

    override setProperty(key: string, value: string) {
        this.controls.setProperty(key, value)
    }

    override processData(frame: Buffer) {
        if (frame.length < 6 || frame[0] !== 0xaa || frame[frame.length - 1] !== 0xbb) return
        if (frame.length <= 255 && frame[1] !== frame.length) return
        const sum = frame.subarray(0, -2).reduce((total, b) => total + b, 0)
        if (((sum & 255) ^ 0x55) !== frame[frame.length - 2]) return
        super.processData(frame)
    }

    override processAABB(buf: Buffer) {
        if (buf[0] !== 0x20) return
        if (buf.length === 4 && buf[1] === 0 && [0x24, 0x25, 0x26, 0x2a].includes(buf[2]) && buf[3] !== 0) {
            console.warn(`WV5-1275W: command ${buf[2].toString(16)} returned ${buf[3].toString(16)}`)
        }
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
        this.controls.setRecord(rec)
        const state = STATES[rec[2]]
        const binary = (key: string, value: boolean) => this.publishProperty(key, value ? 'ON' : 'OFF')
        this.publishProperty('status', state)
        this.publishProperty('power', state === undefined ? undefined : rec[2] === 0 ? 'OFF' : 'ON')
        this.publishProperty('completed', state === undefined ? undefined : rec[2] === 10 ? 'ON' : 'OFF')
        // A selected downloaded cycle overrides its base course, which remains in rec[7].
        this.publishProperty('course', rec[22] ? SMART_COURSES[rec[22]]?.name : COURSES[rec[7]])
        this.publishProperty('downloaded_course', SMART_COURSES[rec[25]]?.name)
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
        // Bit 0 marks standby and clears when the washer wakes.
        // INITIAL (state 1) occurs both asleep and awake; it is not the standby flag.
        binary('standby', Boolean(rec[29] & 1))
        binary('child_lock', Boolean(rec[17] & 0x80))
        // HA's lock class uses ON=unlocked and OFF=locked.
        binary('door_lock', !(rec[17] & 0x40))
        this.publishProperty('tub_clean_count', rec[23] <= 60 ? rec[23] : undefined)
    }
}
