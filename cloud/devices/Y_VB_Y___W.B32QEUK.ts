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

    protected courses() {
        return COURSES
    }

    // Called from the base constructor: this.dispense does not exist yet, so only constants here
    protected components(): Record<string, ComponentInfo | Tombstone> {
        return allowExtendedType({
            ...super.components(),
            downloaded_program: {
                platform: 'sensor',
                unique_id: '$deviceid-downloaded_program',
                state_topic: '$this/downloaded_program',
                name: 'Downloaded program',
                icon: 'mdi:download',
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

    processState(s: Buffer) {
        super.processState(s)

        // s[25] is the course in the download slot, which s[22] only shows while it is selected
        this.publishProperty('downloaded_program', SMART_COURSES.map(s[25]))
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
        return command
    }

    setProperty(prop: string, mqttValue: string) {
        // Parameters set with F0 24 <parameter> 01 <value>, in ml per 5 kg of laundry
        if (prop === 'ezdispense_detergent' || prop === 'ezdispense_softener') {
            const ml = parseEzDispense(mqttValue)
            const parameter = prop === 'ezdispense_detergent' ? 0x0d : 0x0e
            if (ml !== undefined) this.send(Buffer.from([0xf0, 0x24, parameter, 0x01, ml]))
            return
        }

        super.setProperty(prop, mqttValue)
    }
}
