import { tombstone, type ComponentInfo, type Tombstone } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { DRYING_MODES } from './washer_common'
import { COURSES as V8_COURSES } from './Y_V8_Y___W.B32QEUK'
import Y_VB_Y___W_B32QEUK from './Y_VB_Y___W.B32QEUK'

// LG F4DR711S2BA washer-dryer: Y_VB_Y___W.B32QEUK plus the drying mode at s[13] and the courses
// Wash+Dry (0x13) and Dry Only (0x18).

// Panel labels that differ from the V8 table
const PANEL_NAMES: Record<number, string> = {
    0x31: 'TurboWash 39',
    0x07: 'Mixed Fabric',
    0x2d: 'Allergy Care',
    0x1b: 'Hand/Wool',
    0x20: 'Delicates',
}
const COURSES = new Enum<string>([
    ...V8_COURSES.entries.map(([label, code]): [string, number] => [
        PANEL_NAMES[code as number] ?? label,
        code as number,
    ]),
    ['Wash+Dry (6kg)', 0x13],
    ['Dry Only', 0x18],
])

// The appliance accepts codes its panel does not offer (1600 rpm, 50 C), so the selects are limited
// to the panel's own values.
const SELECTABLE: Record<string, string[]> = {
    set_course: [
        'Not selected',
        'AI Wash',
        'Cotton',
        'Eco 40-60',
        'TurboWash 39',
        'Mixed Fabric',
        'Easy Care',
        'Allergy Care',
        'Delicates',
        'Hand/Wool',
        'Speed 14',
        'Dry Only',
        'Wash+Dry (6kg)',
        'Tub Clean',
    ],
    set_spin: ['Not selected', 'No spin', '400 rpm', '800 rpm', '1000 rpm', '1200 rpm', '1400 rpm'],
    set_temp: ['Not selected', 'Cold', '20 °C', '30 °C', '40 °C', '60 °C', '95 °C'],
    set_rinse: ['Not selected', 'Normal', 'Rinse+'],
}

// Panel defaults per course: soil, spin, temp, rinse, drying mode, options, detergent, softener.
// This model does not take zero as "course default" in F026: Turbo Wash 39 sent with zeros ran Cotton.
type Defaults = [number, number, number, number, number, number, number, number]
const COURSE_DEFAULTS: Record<number, Defaults> = {
    0x3a: [3, 10, 4, 1, 0, 0x00, 2, 2], // AI Wash
    0x01: [3, 10, 4, 1, 0, 0x00, 2, 2], // Cotton
    0x04: [3, 10, 4, 1, 0, 0x00, 2, 2], // Eco 40-60
    0x31: [3, 9, 4, 1, 0, 0x01, 2, 2], // TurboWash 39: 1200 rpm, TurboWash on
    0x07: [3, 7, 4, 1, 0, 0x00, 2, 2], // Mixed Fabric: 1000 rpm
    0x02: [3, 10, 4, 1, 0, 0x00, 2, 2], // Easy Care
    0x2d: [3, 10, 6, 1, 0, 0x80, 3, 3], // Allergy Care: 60 C, steam on, both doses High
    0x20: [3, 5, 2, 1, 0, 0x00, 1, 1], // Delicates: 800 rpm, 20 C, both doses Low
    0x1b: [3, 5, 3, 1, 0, 0x00, 1, 1], // Hand/Wool: 800 rpm, 30 C, both doses Low
    0x0c: [3, 2, 2, 1, 0, 0x01, 2, 2], // Speed 14: 400 rpm, 20 C, TurboWash on
    0x18: [0, 0, 0, 0, 2, 0x00, 0, 0], // Dry Only: drying on Auto, nothing else
    0x13: [3, 10, 4, 1, 2, 0x00, 2, 2], // Wash+Dry: drying on Auto
    0x12: [3, 1, 6, 1, 0, 0x00, 0, 0], // Tub Clean: no spin, 60 C, no dosing
}

// Measurement records share the 0x20 envelope, typed 01 02 or 01 03. Each starts (after an optional
// count byte) with 0d 01 02 <kind> <run:16> <sequence:16>, then the body. Not in modelJson; read from
// two recorded cycles.
const ENVELOPE = 0x0a
const RECORD_MARKER = Buffer.from([0x0d, 0x01, 0x02])

// Sent every five minutes: five one-minute samples of each measurement
const KIND_LOG = 0x65
const LOG_TUB = 15 // deg C
const LOG_DRYING = 56 // deg C
const LOG_LENGTH = 61
const SAMPLES = 5
const NO_SAMPLE = 0xff

// The samples form a ring with no start marker. The largest step is where it wraps, so the sample
// before it is the newest.
function newest(samples: number[]) {
    let at = 0
    let step = -1
    for (let i = 0; i < samples.length; i++) {
        const next = samples[(i + 1) % samples.length]
        if (Math.abs(next - samples[i]) > step) {
            step = Math.abs(next - samples[i])
            at = i
        }
    }
    return samples[at]
}

export default class Device extends Y_VB_Y___W_B32QEUK {
    private poweredOn = false
    private reportedDry = 0
    private pendingDry: number | undefined
    // staged until the programme is run
    private pendingDose: [number, number] | undefined

    protected courses() {
        return COURSES
    }

    // Called from the base constructor, so only module-level constants here
    protected components(): Record<string, ComponentInfo | Tombstone> {
        const base = super.components()
        const limited = Object.fromEntries(
            Object.entries(SELECTABLE).map(([name, options]) => [name, { ...base[name], options }]),
        )

        return allowExtendedType({
            ...base,
            ...limited,
            // F024 04 (pause) is acknowledged but ignored, F024 05 (start) is refused
            pause: tombstone('button'),
            start: tombstone('button'),
            drying_mode: {
                platform: 'sensor',
                unique_id: '$deviceid-drying_mode',
                state_topic: '$this/drying_mode',
                name: 'Drying mode',
                icon: 'mdi:tumble-dryer',
                device_class: 'enum',
                options: DRYING_MODES.options,
            },
            tub_temperature: {
                platform: 'sensor',
                unique_id: '$deviceid-tub_temperature',
                state_topic: '$this/tub_temperature',
                name: 'Tub temperature',
                device_class: 'temperature',
                state_class: 'measurement',
                unit_of_measurement: '°C',
            },
            drying_temperature: {
                platform: 'sensor',
                unique_id: '$deviceid-drying_temperature',
                state_topic: '$this/drying_temperature',
                name: 'Drying air temperature',
                device_class: 'temperature',
                state_class: 'measurement',
                unit_of_measurement: '°C',
            },
            detergent_empty: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-detergent_empty',
                state_topic: '$this/detergent_empty',
                name: 'Detergent empty',
                device_class: 'problem',
            },
            set_drying_mode: {
                platform: 'select',
                unique_id: '$deviceid-set_drying_mode',
                state_topic: '$this/set_drying_mode',
                command_topic: '$this/set_drying_mode/set',
                name: 'Set drying mode',
                icon: 'mdi:tumble-dryer',
                options: DRYING_MODES.options,
                entity_category: 'config',
            },
        })
    }

    processState(s: Buffer) {
        this.poweredOn = s[2] > 0
        this.reportedDry = s[13]

        super.processState(s)

        this.publishProperty('drying_mode', DRYING_MODES.map(s[13]))

        // set while the panel shows its low-detergent warning
        this.publishProperty('detergent_empty', s[37] & 0x01 ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        super.processAABB(buf)
        this.processMeasurements(buf)
    }

    private processMeasurements(buf: Buffer) {
        // 20 0a <length:16> .. <sequence:16> .. 01 <02|03> <inner length:16> <records>
        if (buf.length < 13 || buf[0] !== 0x20 || buf[1] !== ENVELOPE || buf[9] !== 0x01) return
        if (buf[10] !== 0x02 && buf[10] !== 0x03) return

        const records = buf.subarray(13, 13 + buf.readUInt16BE(11))
        const marker = records.indexOf(RECORD_MARKER)
        if (marker !== 0 && marker !== 1) return

        const kind = records[marker + 3]
        const body = records.subarray(marker + 8)

        if (kind === KIND_LOG && body.length >= LOG_LENGTH) {
            const series = (at: number) => [...body.subarray(at, at + SAMPLES)].filter((v) => v !== NO_SAMPLE)

            const tub = series(LOG_TUB)
            if (tub.length === SAMPLES) this.publishProperty('tub_temperature', newest(tub))

            const drying = series(LOG_DRYING)
            if (drying.length === SAMPLES) this.publishProperty('drying_temperature', newest(drying))
        }
    }

    protected publishSettings() {
        super.publishSettings()
        this.publishProperty('set_drying_mode', DRYING_MODES.map(this.pendingDry ?? this.reportedDry))
    }

    protected programmeCommand() {
        const command = super.programmeCommand()

        // soil, spin, temp and rinse at [3]..[6]: fill zeros from the course defaults
        const defaults = COURSE_DEFAULTS[command[2]]
        if (defaults) {
            for (let i = 0; i < 4; i++) if (command[3 + i] === 0) command[3 + i] = defaults[i]
        }
        command[7] = this.pendingDry ?? this.reportedDry

        // dose levels at [15] and [16] follow the course, as on the panel
        if (this.pendingDose) [command[15], command[16]] = this.pendingDose

        return command
    }

    setProperty(prop: string, mqttValue: string) {
        // F02A switches a running panel off on this model
        if (prop === 'power' && mqttValue === 'ON' && this.poweredOn) return

        // A start carrying a zero in soil, spin, temp or rinse runs a different programme, so it is
        // not sent unless the course's defaults are known.
        if (prop === 'run_programme') {
            const command = this.programmeCommand()
            if (!COURSE_DEFAULTS[command[2]] && command.subarray(2, 7).includes(0)) return
        }

        if (prop in SELECTABLE && !SELECTABLE[prop].includes(mqttValue)) return

        if (prop === 'set_drying_mode') {
            const code = DRYING_MODES.unmap(mqttValue)
            if (code !== undefined) this.pendingDry = code
            this.publishSettings()
            return
        }

        if (prop === 'set_course') {
            // as on the dial, choosing a course resets the settings to its defaults
            const defaults = COURSE_DEFAULTS[COURSES.unmap(mqttValue) ?? -1]
            if (defaults) {
                const [soil, spin, temp, rinse, dry, options, detergent, softener] = defaults
                for (const [name, code] of Object.entries({ soil, spin, temp, rinse, options })) {
                    this.pending.set(name, code)
                }
                this.pendingDry = dry
                this.pendingDose = [detergent, softener]
            }
        }

        super.setProperty(prop, mqttValue)

        if (prop === 'run_programme') {
            this.pendingDry = undefined
            this.pendingDose = undefined
        }
    }
}
