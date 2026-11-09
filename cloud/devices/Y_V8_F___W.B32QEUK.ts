import { type ComponentInfo, type Tombstone } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import { DRYING_MODES } from './washer_common'
import Y_V8_Y___W_B32QEUK from './Y_V8_Y___W.B32QEUK'

// LG FWY916WBTN1 washer-dryer. Its 39-byte status record and its F026 command are those of
// Y_V8_Y___W.B32QEUK, checked against this unit's records and against commands the LG app sent it through
// the bridge. On top of that it has a drum heater: the drying level at s[13] and F026 byte 5, the Air
// condensing option (options bit 0x08) and drying courses. Observed on this unit:
// - F0 25 03 15 <16-byte body> selects a programme while the washer is in Standby. It is what the LG app
//   sends to download a programme; dial courses are accepted the same way. The body has the F026 layout,
//   and the washer switches its panel to that programme. set_course therefore takes effect at once, while
//   the other set_* entities are held until run_programme, as on Y_V8_Y___W.B32QEUK.
// - The F026 flags byte is 0x03 with a delayed end and 0x02 without. Resuming a paused programme is F026
//   with FF FF for the delay and 0x02, as the LG app sends it. The inherited start (F024 05 01) is refused
//   while paused, so it is not offered.
// - F02A 01 00 toggles the power: sent to a washer that is already on, it switches it off. Once on, the
//   washer stays silent until a programme starts, unless asked for its status.
// - With no programme selected (switched off, and after some downloads) the record reads 0 for both the
//   cycle count and the energy. Those zeros are not published: energy is total_increasing, so HA would
//   count the last programme a second time when it came back.
// - Every command is answered with 20 00 <command> <00 accepted | FF refused>.
// - Child lock, wrinkle care, crease care and steam softener have never been set on this unit, so they
//   are left out.
// - Programme names are this washer's own: the panel's for the dial, the LG app's for the downloads. The
//   course shows the downloaded programme while one is selected, as the panel and the LG app do; the base
//   course it runs on (Cotton for Baby Care) appears in neither.

// The dial, clockwise, under the panel's names, then the base courses of downloaded programmes that have
// no dial position, each named after the programme built on it
const COURSES = new Enum<string>([
    ['Not selected', 0],
    ['AI Wash', 0x3a],
    ['Cotton', 0x01],
    ['Eco 40-60', 0x04],
    ['TurboWash 39', 0x31],
    ['Mixed Fabric', 0x07],
    ['Easy Care', 0x02],
    ['Allergy Care', 0x2d],
    ['Delicates', 0x20],
    ['Hand/Wool', 0x1b],
    ['Speed 14', 0x0c],
    ['Dry Only', 0x18],
    ['Wash+Dry', 0x13],
    ['Tub Clean', 0x12],
    ['Duvet', 0x05],
    ['Sports Wear', 0x08],
    ['Steam Refresh', 0x0d],
    ['Rinse + Spin', 0x0e],
    ['Spin + Drain', 0x17], // Drain and Spin
    ['Quick Wash + Dry', 0x24],
    ['Quick Tub Clean', 0x30],
    ['Microplastic Care', 0x3b],
])

// F025 bodies for the dial courses: the settings each dial position reported when turned to on the panel
const DIAL_BODIES: [string, string][] = [
    ['AI Wash', '3A030A04010000000000020000000000'],
    ['Cotton', '01030A04010000000000020000000000'],
    ['Eco 40-60', '04030A04010000000000020000000000'],
    ['TurboWash 39', '31030904010000000001020000000000'],
    ['Mixed Fabric', '07030704010000000000020000000000'],
    ['Easy Care', '02030A04010000000000020000000000'],
    ['Allergy Care', '2D030A06010000000080020000000000'],
    ['Delicates', '20030502010000000000020000000000'],
    ['Hand/Wool', '1B030503010000000000020000000000'],
    ['Speed 14', '0C030202010000000001020000000000'],
    ['Dry Only', '18000000000200000000020000000000'],
    ['Wash+Dry', '13030A04010200000000020000000000'],
    ['Tub Clean', '12030106010000000000020000000000'],
]

// The downloaded programmes, under the LG app's names, with the F025 bodies the app sends for them.
// [12] is the programme's code.
const DOWNLOAD_BODIES: [string, string][] = [
    ['Baby Care', '01030706020000000050020047000000'],
    ['Cold Wash', '0103FF0101000000000002004D000000'],
    ['Colour Protection', '2003050201000000000002003F000000'],
    ['Drain', '17000100000000000000020079000000'],
    ['Dry 30', '18000000000300000000020043000000'],
    ['Dry 60', '18000000000400000000020044000000'],
    ['Duvet', '05030701010000000000020081000000'],
    ['Hygiene', '2D03FF06010000000080020048000000'],
    ['Jeans', '2003FF02010000000000020039000000'],
    ['Juice and Food Stains', '0103070401000000004002006C000000'],
    ['Kids Wear', '01030906010000000040020034000000'],
    ['Lightly Soiled Items', '1B030202010000000000020065000000'],
    ['Lingerie', '2003050201000000000002004A000000'],
    ['Microplastic Care', '3B030704010000000000020086000000'],
    ['Minimize Detergent Residue', '0103FF04020000000000020066000000'],
    ['Minimize Wrinkles', '0103FF0401000000000002006F000000'],
    ['Quick Tub Clean', '30030201000000000000020071000000'],
    ['Quick Wash + Dry', '2403FF01010300000000020042000000'],
    ['Rainy Season', '0103FF04010000000000020037000000'],
    ['Rinse + Spin', '0E03FF00010000000000020064000000'],
    ['Shirt Dry', '18000000000A00000000020046000000'],
    ['Single Garment', '0C03020201000000000002003E000000'],
    ['Sleeve Hems and Collars', '0103070601000000004002006B000000'],
    ['Small Load', '0C030202010000000000020049000000'],
    ['Spin', '1700FF0000000000000002007A000000'],
    ['Sports Wear', '08030504010000000000020082000000'],
    ['Steam Refresh', '0D000000000000000380020085000000'],
    ['Sweat Stain', '0103FF0401000000000002003B000000'],
    ['Swimming Wear', '1B030202010000000000020036000000'],
    ['Turbo Dry', '18000000000200000000020045000000'],
]
const DOWNLOADS = new Map(DOWNLOAD_BODIES.map(([, hex]) => Buffer.from(hex, 'hex')).map((body) => [body[12], body]))
const DOWNLOAD_NAMES = new Enum(
    DOWNLOAD_BODIES.map(([name, hex]): [string, number] => [name, parseInt(hex.slice(24, 26), 16)]),
)

// What set_course offers: the dial, then the downloads
const PROGRAMMES = new Map<string, Buffer>([
    ...DIAL_BODIES.map(([name, hex]): [string, Buffer] => [name, Buffer.from(hex, 'hex')]),
    ...DOWNLOAD_BODIES.map(([name, hex]): [string, Buffer] => [name, Buffer.from(hex, 'hex')]),
])

const SELECT_PROGRAMME = Buffer.from('F0250315', 'hex')
const STATUS_REQUEST = Buffer.from('F0ED1121010000001800', 'hex')
const STANDBY = 1
const PAUSED = 2

const COMMANDS = ['Power on', 'Power off', 'Pause', 'Resume', 'Set course', 'Run programme']
const COMMAND_RESULTS = COMMANDS.flatMap((command) => [`${command}: accepted`, `${command}: refused`])

const NOT_SEEN = ['child_lock', 'wrinkle_care', 'crease_care', 'steam_softener']
const NOT_SEEN_PROPS = new Set([...NOT_SEEN, ...NOT_SEEN.map((key) => `set_${key}`)])

export default class Device extends Y_V8_Y___W_B32QEUK {
    /** The last status record */
    private state?: Buffer
    /** The command the washer's next answer refers to */
    private lastCommand?: string

    protected courses() {
        return COURSES
    }

    // Called from the base constructor, so only module-level constants here
    protected components(): Record<string, ComponentInfo | Tombstone> {
        const components: Record<string, ComponentInfo | Tombstone> = allowExtendedType({
            ...super.components(),
            drying_mode: {
                platform: 'sensor',
                unique_id: '$deviceid-drying-mode',
                state_topic: '$this/drying_mode',
                name: 'Drying mode',
                icon: 'mdi:tumble-dryer',
                device_class: 'enum',
                options: DRYING_MODES.options,
            },
            air_condensing: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-air_condensing',
                state_topic: '$this/air_condensing',
                name: 'Air condensing',
                icon: 'mdi:weather-windy',
            },
            downloaded_program: {
                platform: 'sensor',
                unique_id: '$deviceid-downloaded_program',
                state_topic: '$this/downloaded_program',
                name: 'Downloaded program',
                icon: 'mdi:download',
                device_class: 'enum',
                options: DOWNLOAD_NAMES.options,
            },
            resume: {
                platform: 'button',
                unique_id: '$deviceid-resume',
                command_topic: '$this/resume/set',
                payload_press: '',
                name: 'Resume',
                icon: 'mdi:play-pause',
            },
            last_command: {
                platform: 'sensor',
                unique_id: '$deviceid-last_command',
                state_topic: '$this/last_command',
                name: 'Last command',
                icon: 'mdi:message-reply-text-outline',
                device_class: 'enum',
                options: COMMAND_RESULTS,
            },
        })
        components.set_course = allowExtendedType({ ...components.set_course, options: [...PROGRAMMES.keys()] })
        components.smart_course = allowExtendedType({ ...components.smart_course, options: DOWNLOAD_NAMES.options })
        delete components.start
        for (const key of NOT_SEEN_PROPS) delete components[key]
        return components
    }

    processState(s: Buffer) {
        this.state = Buffer.from(s)
        super.processState(s)

        // s[25] is the programme in the download slot, which s[22] only shows while it is selected
        this.publishProperty('downloaded_program', DOWNLOAD_NAMES.map(s[25]))
        this.publishProperty('drying_mode', DRYING_MODES.map(s[13]))
        this.publishProperty('air_condensing', s[16] & 0x08 ? 'ON' : 'OFF')
    }

    publishProperty(prop: string, value: string | number | undefined) {
        if (NOT_SEEN_PROPS.has(prop)) return
        if ((prop === 'cycles' || prop === 'energy') && value === 0 && this.state?.[7] === 0) return
        if (prop === 'set_course') value = this.programme()
        if (prop === 'smart_course') value = this.state && DOWNLOAD_NAMES.map(this.state[22])
        if (prop === 'course' && this.state?.[22]) value = DOWNLOAD_NAMES.map(this.state[22])
        super.publishProperty(prop, value)
    }

    /** The selected programme, as set_course names it */
    private programme() {
        if (!this.state) return undefined
        const name = this.state[22] ? DOWNLOAD_NAMES.map(this.state[22]) : COURSES.map(this.state[7])
        return name && PROGRAMMES.has(name) ? name : undefined
    }

    processAABB(buf: Buffer) {
        // 20 00 <command> <00 accepted | FF refused>
        if (buf.length === 4 && buf[0] === 0x20 && buf[1] === 0x00) {
            // an answer to the LG app, through the bridge, is not ours to report
            if (this.lastCommand)
                this.publishProperty('last_command', `${this.lastCommand}: ${buf[3] ? 'refused' : 'accepted'}`)
            this.lastCommand = undefined
            return
        }
        super.processAABB(buf)
    }

    protected programmeCommand() {
        const command = super.programmeCommand()
        if (!this.state) return command

        // F0 26, then the body: [5] dryLevel, [8] loadItem, [10] flags, [12] downloaded course
        const download = this.state[22]
        command[2 + 5] = this.state[13]
        command[2 + 8] = DOWNLOADS.get(download)?.[8] ?? 0
        command[2 + 10] = this.setting('delay_end') ? 0x03 : 0x02
        command[2 + 12] = download
        return command
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'start') return

        if (prop === 'power' && mqttValue === 'ON') {
            if (this.state && this.state[2] !== 0) {
                this.log('power on ignored, already on')
                return
            }
            this.lastCommand = 'Power on'
            super.setProperty(prop, mqttValue)
            // it takes a few seconds to wake before it answers
            for (const ms of [5000, 15000]) setTimeout(() => this.send(STATUS_REQUEST), ms).unref?.()
            return
        }

        if (prop === 'set_course') {
            const body = PROGRAMMES.get(mqttValue)
            if (body && this.state?.[2] === STANDBY) {
                this.lastCommand = 'Set course'
                this.send(Buffer.concat([SELECT_PROGRAMME, body]))
            } else {
                this.log('set_course ignored', mqttValue, 'status', this.state?.[2])
            }
            this.publishSettings()
            return
        }

        if (prop === 'resume') {
            // in Standby the same command would start a programme
            if (this.state?.[2] !== PAUSED) {
                this.log('resume ignored, not paused')
                return
            }
            this.pending.clear()
            const command = this.programmeCommand()
            command[2 + 6] = 0xff // reserve hours and minutes: keep
            command[2 + 7] = 0xff
            command[2 + 10] = 0x02
            this.lastCommand = 'Resume'
            this.send(command)
            return
        }

        if (prop === 'power') this.lastCommand = 'Power off'
        if (prop === 'pause') this.lastCommand = 'Pause'
        if (prop === 'run_programme') this.lastCommand = 'Run programme'
        super.setProperty(prop, mqttValue)
    }
}
