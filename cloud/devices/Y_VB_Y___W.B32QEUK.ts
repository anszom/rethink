import { tombstone, type ComponentInfo, type Tombstone } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { DOSES, SMART_COURSES } from './washer_common'
import Y_V8_Y___W_B32QEUK, { COURSES as V8_COURSES } from './Y_V8_Y___W.B32QEUK'

// The ezDispense ("auto dosing") variant of Y_V8_Y___W.B32QEUK. The LG cloud decodes the two models'
// status records with one parser - frames sent to both as simulated appliances came back identical,
// ezDispense fields included - so everything but the dispenser is inherited.

// The V8 dial plus the dispenser nozzle clean, which only this model has. 0x37 is what the cloud
// decodes as DISPENSER_CLEAN, from a sweep of the course byte; not yet seen from a real washer.
const COURSES = new Enum<string>([...V8_COURSES.entries, ['Dispenser Clean', 0x37]])

// The LG app's F0 25 load per downloadable programme. Detergent and softener default to the reported doses.
type Download = [
    course: number,
    soil: number,
    spin: number,
    temp: number,
    rinse: number,
    options: number,
    detergent?: number,
    softener?: number,
]
const DOWNLOADS = new Map<number, Download>([
    [0x47, [0x01, 0x03, 0x07, 0x06, 0x02, 0x50]], // Baby Care
    [0x3a, [0x05, 0x03, 0x02, 0x01, 0x01, 0x00]], // Blanket
    [0x4d, [0x01, 0x03, 0xff, 0x01, 0x01, 0x00]], // Cold Wash
    [0x3f, [0x20, 0x03, 0x05, 0x02, 0x01, 0x00]], // Colour Protection
    [0x79, [0x17, 0x00, 0x01, 0x00, 0x00, 0x00, 0, 0]], // Drain
    [0x38, [0x08, 0x03, 0x05, 0x01, 0x01, 0x00]], // Gym Clothes
    [0x48, [0x2d, 0x03, 0xff, 0x06, 0x01, 0x80]], // Hygiene
    [0x39, [0x20, 0x03, 0xff, 0x02, 0x01, 0x00]], // Jeans
    [0x6c, [0x01, 0x03, 0x07, 0x04, 0x01, 0x40]], // Juice and Food Stains
    [0x34, [0x01, 0x03, 0x09, 0x06, 0x01, 0x40]], // Kids Wear
    [0x65, [0x1b, 0x03, 0x02, 0x02, 0x01, 0x00]], // Lightly Soiled Items
    [0x4a, [0x20, 0x03, 0x05, 0x02, 0x01, 0x00]], // Lingerie
    [0x86, [0x3b, 0x03, 0x07, 0x04, 0x01, 0x00]], // MicroPlastic Care
    [0x66, [0x01, 0x03, 0xff, 0x04, 0x02, 0x00]], // Minimize Detergent Residue
    [0x6f, [0x01, 0x03, 0xff, 0x04, 0x01, 0x00]], // Minimize Wrinkles
    [0x71, [0x30, 0x03, 0x02, 0x01, 0x00, 0x00, 0, 0]], // Quick Tub Clean
    [0x37, [0x01, 0x03, 0xff, 0x04, 0x01, 0x00]], // Rainy Season
    [0x64, [0x0e, 0x03, 0xff, 0x00, 0x01, 0x00, 0]], // Rinse + Spin
    [0x84, [0x09, 0x03, 0x07, 0x04, 0x01, 0x00]], // Silent Wash
    [0x3e, [0x0c, 0x03, 0x02, 0x02, 0x01, 0x01]], // Single Garment
    [0x4c, [0x01, 0x03, 0xff, 0x04, 0x02, 0x10]], // Skin Care
    [0x6b, [0x01, 0x03, 0x07, 0x06, 0x01, 0x40]], // Sleeve Hems and Collars
    [0x49, [0x0c, 0x03, 0x02, 0x02, 0x01, 0x01]], // Small Load
    [0x7a, [0x17, 0x00, 0xff, 0x00, 0x00, 0x00, 0, 0]], // Spin
    [0x3b, [0x01, 0x03, 0xff, 0x04, 0x01, 0x00]], // Sweat Stain
    [0x36, [0x1b, 0x03, 0x02, 0x02, 0x01, 0x00]], // Swimming Wear
])
const DOWNLOAD_SLOT = new Enum<string>(
    SMART_COURSES.entries.filter(([, code]) => typeof code === 'number' && DOWNLOADS.has(code)),
)

// Set course adds the dial's download position: run whatever programme sits in the slot
const DOWNLOADED_PROGRAM = 'Downloaded program'
const SET_COURSES = new Enum<string>([...COURSES.entries, [DOWNLOADED_PROGRAM, []]])

// The range the LG app allows for both ezDispense amounts
const EZDISPENSE_MIN = 9
const EZDISPENSE_MAX = 150

function parseEzDispense(value: string) {
    if (value.trim() === '') return undefined

    const ml = Number(value)
    return Number.isInteger(ml) && ml >= EZDISPENSE_MIN && ml <= EZDISPENSE_MAX ? ml : undefined
}

export default class Device extends Y_V8_Y___W_B32QEUK {
    /** The dispenser settings last reported, which a programme start has to repeat. */
    private dispense = { detergent: 0, softener: 0, type: 0 }
    /** The programme in the download slot, and whether Set course points at it. */
    private slot = 0
    private runSlot = false

    protected courses() {
        return COURSES
    }

    // Called from the base constructor: this.dispense does not exist yet, so only constants here
    protected components(): Record<string, ComponentInfo | Tombstone> {
        const base = super.components()
        return allowExtendedType({
            ...base,
            set_course: {
                ...base.set_course,
                options: SET_COURSES.options,
            },
            downloaded_program: {
                platform: 'sensor',
                unique_id: '$deviceid-downloaded_program',
                state_topic: '$this/downloaded_program',
                name: 'Downloaded program',
                icon: 'mdi:download',
            },
            set_downloaded_program: {
                platform: 'select',
                unique_id: '$deviceid-set_downloaded_program',
                state_topic: '$this/set_downloaded_program',
                command_topic: '$this/set_downloaded_program/set',
                name: 'Set downloaded program',
                icon: 'mdi:download',
                options: DOWNLOAD_SLOT.options,
                entity_category: 'config',
            },
            detergent: {
                platform: 'sensor',
                unique_id: '$deviceid-detergent',
                state_topic: '$this/detergent',
                name: 'Detergent dose',
                icon: 'mdi:cup',
                device_class: 'enum',
                options: DOSES.options,
            },
            softener: {
                platform: 'sensor',
                unique_id: '$deviceid-softener',
                state_topic: '$this/softener',
                name: 'Softener dose',
                icon: 'mdi:cup-outline',
                device_class: 'enum',
                options: DOSES.options,
            },
            ezdispense_detergent: {
                platform: 'number',
                unique_id: '$deviceid-ezdispense_detergent',
                state_topic: '$this/ezdispense_detergent',
                command_topic: '$this/ezdispense_detergent/set',
                name: 'ezDispense detergent amount',
                icon: 'mdi:cup',
                unit_of_measurement: 'mL',
                min: EZDISPENSE_MIN,
                max: EZDISPENSE_MAX,
                step: 1,
                mode: 'box',
                entity_category: 'config',
            },
            ezdispense_softener: {
                platform: 'number',
                unique_id: '$deviceid-ezdispense_softener',
                state_topic: '$this/ezdispense_softener',
                command_topic: '$this/ezdispense_softener/set',
                name: 'ezDispense softener amount',
                icon: 'mdi:cup-outline',
                unit_of_measurement: 'mL',
                min: EZDISPENSE_MIN,
                max: EZDISPENSE_MAX,
                step: 1,
                mode: 'box',
                entity_category: 'config',
            },
            door: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-door',
                state_topic: '$this/door',
                name: 'Door',
                device_class: 'door',
            },
            dispenser_drawer: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-dispenser_drawer',
                state_topic: '$this/dispenser_drawer',
                name: 'Dispenser drawer',
                device_class: 'opening',
            },
            // hours only; superseded by the inherited reserve_time, which carries the minutes too
            delay_end: tombstone('sensor'),
        })
    }

    processAABB(buf: Buffer) {
        super.processAABB(buf)
        this.processDoorRecord(buf)
    }

    // 20 0a [len16] [seq16] .. .. .. 03 00 06 [6-byte record], pushed on every door open/close.
    // The record's last byte is the door: 00 open, 01 closed. 04 shows up once after power-on, meaning unknown.
    processDoorRecord(buf: Buffer) {
        if (buf.length < 19 || buf[0] !== 0x20 || buf[1] !== 0x0a || buf[10] !== 0x03) return
        if (buf.readUInt16BE(11) !== 6) return

        const door = buf[18]
        if (door === 0x00) this.publishProperty('door', 'ON') // binary_sensor door: ON = open
        if (door === 0x01) this.publishProperty('door', 'OFF')
    }

    processState(s: Buffer) {
        super.processState(s)

        // s[25] is the course in the download slot, which s[22] only shows while it is selected
        this.publishProperty('downloaded_program', SMART_COURSES.map(s[25]))
        this.publishProperty('set_downloaded_program', DOWNLOAD_SLOT.map(s[25]))
        // dose levels, the cloud's ezCSDetergentSetVal / ezCSSoftenerSetVal
        this.publishProperty('detergent', DOSES.map(s[32]))
        this.publishProperty('softener', DOSES.map(s[33]))
        // ml per 5 kg of laundry
        this.publishProperty('ezdispense_detergent', s[34])
        this.publishProperty('ezdispense_softener', s[35])
        // s[36] is the cloud's ezDispenseType. In s[37], bit 2 stays set while the drawer is open
        // and bit 6 pulses on and off meanwhile, meaning unknown.
        this.publishProperty('dispenser_drawer', s[37] & 0x04 ? 'ON' : 'OFF')

        this.dispense = { detergent: s[32], softener: s[33], type: s[36] }
        this.slot = s[25]
    }

    // The V8 command with the dispenser fields filled in, from a Cotton start the LG app sent to a
    // simulated washer reporting detergent MORE and softener LESS:
    // F026 01 03 FF 04 02 0000000000 03 00 00 03 01 00 - the last three bytes being the detergent
    // level, the softener level and ezDispenseType. Left at zero, a wash would start undosed.
    protected programmeCommand() {
        const command = super.programmeCommand()
        command[15] = this.dispense.detergent
        command[16] = this.dispense.softener
        command[17] = this.dispense.type

        // The slot's programme runs on the settings it was loaded with, unless changed since
        const dl = DOWNLOADS.get(this.slot)
        if (this.runSlot && dl) {
            const [course, soil, spin, temp, rinse, options, detergent, softener] = dl
            command[2] = course
            command[3] = this.pending.get('soil') ?? soil
            command[4] = this.pending.get('spin') ?? spin
            command[5] = this.pending.get('temp') ?? temp
            command[6] = this.pending.get('rinse') ?? rinse
            command[11] = this.pending.get('options') ?? options
            command[14] = this.slot
            command[15] = detergent ?? command[15]
            command[16] = softener ?? command[16]
        }
        return command
    }

    protected courseSetting() {
        // also when the washer reports the downloaded programme selected at its own dial
        const selected = !this.pending.has('course') && this.reported.smart_course !== 0
        return this.runSlot || selected ? DOWNLOADED_PROGRAM : super.courseSetting()
    }

    // F0 25 03 15, then the F0 26 body with its flags byte left at 00
    private downloadCommand(id: number, dl: Download) {
        const [course, soil, spin, temp, rinse, options, detergent, softener] = dl
        return Buffer.from([
            0xf0,
            0x25,
            0x03,
            0x15,
            course,
            soil,
            spin,
            temp,
            rinse,
            0,
            0,
            0,
            0,
            options,
            0,
            0,
            id,
            detergent ?? this.dispense.detergent,
            softener ?? this.dispense.softener,
            0,
        ])
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'set_downloaded_program') {
            const id = DOWNLOAD_SLOT.unmap(mqttValue)
            const dl = id === undefined ? undefined : DOWNLOADS.get(id)
            if (id !== undefined && dl) {
                this.send(this.downloadCommand(id, dl))
                // loading a programme is picking it to run, as the LG app does
                this.runSlot = true
                this.pending.delete('course')
                this.publishSettings()
            }
            return
        }

        // Parameters set with F0 24 <parameter> 01 <value>, in ml per 5 kg of laundry
        if (prop === 'ezdispense_detergent' || prop === 'ezdispense_softener') {
            const ml = parseEzDispense(mqttValue)
            const parameter = prop === 'ezdispense_detergent' ? 0x0d : 0x0e
            if (ml !== undefined) this.send(Buffer.from([0xf0, 0x24, parameter, 0x01, ml]))
            return
        }

        if (prop === 'set_course') {
            this.runSlot = mqttValue === DOWNLOADED_PROGRAM
            if (this.runSlot) {
                this.pending.delete('course')
                this.publishSettings()
                return
            }
        }

        if (prop === 'run_programme') {
            // nothing known to run in the slot
            if (this.runSlot && !DOWNLOADS.has(this.slot)) return
            super.setProperty(prop, mqttValue)
            this.runSlot = false
            this.publishSettings()
            return
        }

        super.setProperty(prop, mqttValue)
    }
}
