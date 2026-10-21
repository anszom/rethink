import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import AABBDevice from './aabb_device'
import { ERRORS, TEMPERATURES, SPINS, RINSES, SOIL_LEVELS, SMART_COURSES } from './washer_common'

// F_V__Y___W.A__QEUK: LG WV9-1409W front-load washer (Australia).
//
// 20 EC carries the previous and current 30-byte records; 20 EB carries one, the answer to the status
// request sent on connecting. The layout is the one found for the WV5-1275W in PR #222, not F_C's: the
// course is rec[7] and rec[12] is the rinse. Each field was checked against the LG cloud's labels, and
// the commands are the ones the LG app sends.

// rec[2], as this model's modelJson numbers its states, with F_C's labels for the same codes.
const STATUS = Enum.of({
    Off: 0,
    Standby: 1,
    Paused: 2,
    Delayed: 3,
    Detecting: 4,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    Drying: 9,
    End: 10,
    'Cool down': 11,
    'Rinse hold': 12,
    Refreshing: [14, 15], // WASH_REFRESHING & REFRESHING
    Demo: 16,
    Error: 18,
})

// Course codes (rec[7]), named as on the panel and in the LG app. On Download Cycle, rec[22] holds the
// downloaded course.
export const COURSES = Enum.of({
    Cotton: 0x01,
    'Easy Care': 0x02,
    'Cotton Eco': 0x04,
    Duvet: 0x05,
    'Mixed Fabric': 0x07,
    Sportswear: 0x08,
    'Quiet Wash': 0x09,
    'Quick 14': 0x0c,
    'Tub Clean': 0x12,
    'Hand/Wool': 0x1b,
    Delicates: 0x20,
    'Allergy Care': 0x2d,
    'TurboClean 39': 0x31,
})

// A setting's default, and the values LG's app lets you choose instead (none: shown, not changeable).
type Setting = readonly [initial: number, choices?: readonly number[]]
type Programme = { soil: number; temp: Setting; spin: Setting; rinse: Setting; options: number; delay: boolean }
// The fields of an F0 26 command, as wire codes.
type Run = {
    course: number
    soil: number
    spin: number
    temp: number
    rinse: number
    delay: readonly [hours: number, minutes: number]
    options: number
    wrinkleCare: number
}

// Each course's defaults and the choices the LG app offers, from this model's modelJson (Course). Spin
// 255 is the app's "Max", which the washer reports as its top speed.
export const PROGRAMMES: Record<string, Programme> = {
    Cotton: {
        soil: 3,
        temp: [4, [1, 2, 3, 4, 6, 7]],
        spin: [255, [1, 2, 5, 7, 255]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    'Easy Care': {
        soil: 3,
        temp: [4, [1, 2, 3, 4, 6]],
        spin: [255, [1, 2, 5, 7, 255]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    'Cotton Eco': {
        soil: 3,
        temp: [6, [1, 2, 3, 4, 6]],
        spin: [255, [1, 2, 5, 7, 255]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    Duvet: {
        soil: 3,
        temp: [1, [1, 2, 3, 4]],
        spin: [7, [1, 2, 5, 7]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    'Mixed Fabric': {
        soil: 3,
        temp: [4, [1, 2, 3, 4, 6]],
        spin: [7, [1, 2, 5, 7, 255]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    Sportswear: {
        soil: 3,
        temp: [4, [1, 2, 3, 4]],
        spin: [5, [1, 2, 5]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    'Quiet Wash': {
        soil: 3,
        temp: [4, [1, 2, 3, 4, 6]],
        spin: [5, [1, 2, 5, 7]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    'Quick 14': {
        soil: 3,
        temp: [2, [2, 3, 4]],
        spin: [2, [1, 2, 5, 7, 255]],
        rinse: [1, [1, 2]],
        options: 0x01,
        delay: true,
    },
    'Tub Clean': { soil: 3, temp: [6], spin: [1], rinse: [1], options: 0x00, delay: false },
    'Hand/Wool': {
        soil: 3,
        temp: [3, [1, 2, 3, 4]],
        spin: [5, [1, 2, 5]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    Delicates: {
        soil: 3,
        temp: [2, [1, 2, 3, 4]],
        spin: [5, [1, 2, 5]],
        rinse: [1, [1, 2]],
        options: 0x00,
        delay: true,
    },
    'Allergy Care': {
        soil: 3,
        temp: [6],
        spin: [255, [1, 2, 5, 7, 255]],
        rinse: [1, [1, 2]],
        options: 0x80,
        delay: true,
    },
    'TurboClean 39': {
        soil: 3,
        temp: [4, [1, 2, 3, 4, 6]],
        spin: [9, [2, 5, 7, 9, 255]],
        rinse: [1, [1, 2]],
        options: 0x01,
        delay: true,
    },
}

// The frames the LG cloud acks, as F0 00 <type> 04: pushes (72), the drum-clean count (D8), end of
// cycle (E2), the wake response (2B) and the hello (31). Not the status records, command results or
// BD/CD dumps.
const ACKED_TYPES = new Set([0x72, 0xd8, 0xe2, 0x2b, 0x31])

const CLASS_BYTE = 0x20
const RECORD_LEN = 30

// The status request the LG cloud sends on every connection; answered with 20 EB.
const STATUS_REQUEST = 'F0ED1121010000001800'
const PAUSE = 'F024040100'
const POWER_OFF = 'F024010100'
const WAKE_UP = 'F02A0100'
// F0 26's flags byte: 03 starts, 02 resumes a paused programme; Wrinkle care adds 0x20, as in rec[17].
const START = 0x03
const RESUME = 0x02
const WRINKLE_CARE = 0x20
const PAUSED = STATUS.inverse.Paused

// The set_* selects' options: every choice above, plus 1400 rpm, which the washer reports for "Max".
const choices = (key: 'temp' | 'spin' | 'rinse') =>
    new Set(Object.values(PROGRAMMES).flatMap((p) => [p[key][0], ...(p[key][1] ?? [])]))
const options = (table: Enum<string>, codes: Iterable<number>) =>
    [...codes].sort((a, b) => a - b).map((c) => table.map(c)!)
const TEMP_OPTIONS = options(TEMPERATURES, choices('temp'))
const SPIN_OPTIONS = options(SPINS, new Set([...choices('spin'), 10]))
const RINSE_OPTIONS = options(RINSES, choices('rinse'))

export default class Device extends AABBDevice {
    // The latest status record from this connection; Start builds its command from it.
    private record?: Buffer
    // Choices made in HA and not yet sent; the F0 26 command carries them all at once.
    private pending: { course?: number; temp?: number; spin?: number; rinse?: number; delay?: number } = {}

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        // Not autoAck: that would also ack BD and CD, which the LG cloud never does for this washer.
        super(HA, thinq, false)
        const binary = (key: string, name: string, icon?: string) => ({
            platform: 'binary_sensor',
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
            icon,
        })
        const enumSensor = (key: string, name: string, icon: string, options: string[]) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
            icon,
            device_class: 'enum',
            options,
        })
        const duration = (key: string, name: string, icon: string) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            name,
            icon,
            device_class: 'duration',
            unit_of_measurement: 'min',
        })
        const select = (key: string, name: string, icon: string, options: string[]) => ({
            platform: 'select',
            unique_id: `$deviceid-${key}`,
            state_topic: `$this/${key}`,
            command_topic: `$this/${key}/set`,
            name,
            icon,
            options,
        })
        // Greyed out in HA unless the washer reports `availableWhen` ON, as the LG app hides the command.
        // No interlock of rethink's own (CONTRIBUTING), as WFV474PGV and N17 gate their Start buttons.
        const button = (key: string, name: string, icon: string, availableWhen?: string) => ({
            platform: 'button',
            unique_id: `$deviceid-${key}`,
            command_topic: `$this/${key}/set`,
            payload_press: '',
            name,
            icon,
            ...(availableWhen && {
                availability: [
                    { topic: '$this/availability' },
                    { topic: '$rethink/availability' },
                    { topic: `$this/${availableWhen}`, payload_available: 'ON', payload_not_available: 'OFF' },
                ],
                availability_mode: 'all',
            }),
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: { ...binary('power', 'Power', 'mdi:washing-machine'), device_class: 'power' },
                    status: enumSensor('status', 'Status', 'mdi:state-machine', STATUS.options),
                    error: {
                        ...binary('error', 'Error', 'mdi:check-circle'),
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        ...enumSensor('error_message', 'Error message', 'mdi:alert-circle-outline', ERRORS.options),
                        entity_category: 'diagnostic',
                    },
                    course: enumSensor('course', 'Course', 'mdi:pin-outline', [
                        ...new Set([...COURSES.options, ...SMART_COURSES.options]),
                    ]),
                    downloaded_course: enumSensor(
                        'downloaded_course',
                        'Downloaded course',
                        'mdi:download',
                        SMART_COURSES.options,
                    ),
                    temp: enumSensor('temp', 'Temperature', 'mdi:thermometer', TEMPERATURES.options),
                    spin: enumSensor('spin', 'Spin', 'mdi:autorenew', SPINS.options),
                    rinse: enumSensor('rinse', 'Rinse', 'mdi:water-sync', RINSES.options),
                    soil: enumSensor('soil', 'Soil level', 'mdi:liquid-spot', SOIL_LEVELS.options),
                    remaining_time: duration('remaining_time', 'Remaining time', 'mdi:timer-outline'),
                    initial_time: duration('initial_time', 'Initial time', 'mdi:timer-sand'),
                    delay_end: duration('delay_end', 'Delay end', 'mdi:timer-sand'),
                    steam: binary('steam', 'Steam', 'mdi:kettle-steam'),
                    turbo_wash: binary('turbo_wash', 'TurboWash', 'mdi:rocket-launch'),
                    pre_wash: binary('pre_wash', 'Pre-wash', 'mdi:water-sync'),
                    wrinkle_care: binary('wrinkle_care', 'Wrinkle care', 'mdi:tshirt-crew-outline'),
                    remote_start: binary('remote_start', 'Remote start', 'mdi:play-circle-outline'),
                    standby: binary('standby', 'Standby', 'mdi:sleep'),
                    // Plain on/off, ON = locked, as the LG cloud reports them. Not HA's lock class, where ON = unlocked.
                    door_lock: binary('door_lock', 'Door lock', 'mdi:lock'),
                    child_lock: { ...binary('child_lock', 'Child lock', 'mdi:lock'), entity_category: 'diagnostic' },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since drum clean',
                        icon: 'mdi:washing-machine-alert',
                        // No state_class: Tub Clean resets the count.
                        entity_category: 'diagnostic',
                    },
                    // What the LG app can set before Start.
                    set_course: select('set_course', 'Set course', 'mdi:tune-vertical', Object.keys(PROGRAMMES)),
                    set_temp: select('set_temp', 'Set temperature', 'mdi:thermometer', TEMP_OPTIONS),
                    set_spin: select('set_spin', 'Set spin', 'mdi:autorenew', SPIN_OPTIONS),
                    set_rinse: select('set_rinse', 'Set rinse', 'mdi:water-sync', RINSE_OPTIONS),
                    set_delay_end: {
                        platform: 'number',
                        unique_id: '$deviceid-set_delay_end',
                        state_topic: '$this/set_delay_end',
                        command_topic: '$this/set_delay_end/set',
                        name: 'Set delayed end',
                        icon: 'mdi:timer-sand',
                        unit_of_measurement: 'h',
                        // 0 is none; modelJson's reserveTimeHour allows 3..19.
                        min: 0,
                        max: 19,
                        step: 1,
                    },
                    // Start also resumes a paused programme, as on rethink's other washers.
                    start: button('start', 'Start', 'mdi:play-circle-outline', 'remote_start'),
                    pause: button('pause', 'Pause', 'mdi:pause-circle-outline'),
                    // A washer that is off can't be powered on remotely, nor off again.
                    power_off: button('power_off', 'Power off', 'mdi:power-off', 'power'),
                    // Wake up is for a sleeping washer only, as the app's "Sleep Mode OFF".
                    wake_up: button('wake_up', 'Wake up', 'mdi:sleep-off', 'standby'),
                },
            }),
        )
    }

    // Ask for the state on connecting, as the LG cloud does, so a reconnect shows the washer at once.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== CLASS_BYTE) return
        if (ACKED_TYPES.has(buf[1])) this.thinq.send_ack(AABBDevice.frame(Buffer.from([0xf0, 0x00, buf[1], 0x04])))

        // 20 00 <command> <result>: the washer's answer to a command, 00 meaning done.
        if (buf[1] === 0x00 && buf.length === 4) {
            if (buf[3] !== 0) this.log(`command ${buf[2].toString(16)} refused: ${buf[3].toString(16)}`)
            return
        }

        // 20 D8 nn: washes since the last Tub Clean (LG's TCLCount). At some power-ons it comes as 00, then
        // the count.
        if (buf[1] === 0xd8 && buf.length === 3) {
            this.publishProperty('tub_clean_count', buf[2])
            return
        }

        this.processCommonStatus(buf, CLASS_BYTE, RECORD_LEN, this.processRecord)
    }

    private processRecord(rec: Buffer) {
        if (rec[0] !== 0x00 || rec[1] !== 0x1c) return
        const state = rec[2]
        const flag = (value: number | boolean) => (value ? 'ON' : 'OFF')

        this.publishProperty('power', flag(state))
        this.publishProperty('status', STATUS.map(state))
        this.publishProperty('error_message', ERRORS.map(rec[8]))
        this.publishProperty('error', flag(rec[8]))
        // rec[22] is the downloaded course while Download Cycle is selected, else 0.
        this.publishProperty('course', rec[22] ? SMART_COURSES.map(rec[22]) : COURSES.map(rec[7]))
        this.publishProperty('downloaded_course', SMART_COURSES.map(rec[25]))
        this.publishProperty('soil', SOIL_LEVELS.map(rec[9]))
        this.publishProperty('spin', SPINS.map(rec[10]))
        this.publishProperty('temp', TEMPERATURES.map(rec[11]))
        this.publishProperty('rinse', RINSES.map(rec[12]))
        this.publishProperty('remaining_time', rec[3] * 60 + rec[4])
        this.publishProperty('initial_time', rec[5] * 60 + rec[6])
        this.publishProperty('delay_end', rec[14] * 60 + rec[15])
        this.publishProperty('steam', flag(rec[16] & 0x80))
        this.publishProperty('pre_wash', flag(rec[16] & 0x40))
        this.publishProperty('turbo_wash', flag(rec[16] & 0x01))
        this.publishProperty('child_lock', flag(rec[17] & 0x80))
        this.publishProperty('door_lock', flag(rec[17] & 0x40))
        this.publishProperty('wrinkle_care', flag(rec[17] & WRINKLE_CARE))
        // Also ON for the whole of a running wash, as the LG cloud reports it.
        this.publishProperty('remote_start', flag(rec[17] & 0x02))
        this.publishProperty('standby', flag(rec[29] & 0x01))
        this.publishProperty('tub_clean_count', rec[23])

        this.record = Buffer.from(rec)
        this.publishSettings()
    }

    // The washer's current settings, as an F0 26 would carry them.
    private static current(r: Buffer): Run {
        return {
            course: r[7],
            soil: r[9],
            spin: r[10],
            temp: r[11],
            rinse: r[12],
            delay: [r[14], r[15]],
            options: r[16],
            wrinkleCare: r[17] & WRINKLE_CARE,
        }
    }

    // What Start would send: a course picked in HA starts from that course's defaults, as in the LG app;
    // otherwise the washer's own settings. Undefined while there is no course to start.
    private settings(): (Run & { programme: Programme }) | undefined {
        const r = this.record
        if (!r || r[22]) return undefined // no record yet, or a downloaded course (not startable here)
        const course = this.pending.course ?? r[7]
        const name = COURSES.map(course)
        const programme = name === undefined ? undefined : PROGRAMMES[name]
        if (!programme) return undefined
        const base: Run =
            course === r[7]
                ? Device.current(r)
                : {
                      course,
                      soil: programme.soil,
                      spin: programme.spin[0],
                      temp: programme.temp[0],
                      rinse: programme.rinse[0],
                      delay: [0, 0],
                      options: programme.options,
                      wrinkleCare: 0,
                  }
        return {
            ...base,
            programme,
            temp: this.pending.temp ?? base.temp,
            spin: this.pending.spin ?? base.spin,
            rinse: this.pending.rinse ?? base.rinse,
            delay: this.pending.delay === undefined ? base.delay : [this.pending.delay, 0],
        }
    }

    private publishSettings() {
        const s = this.settings()
        this.publishProperty('set_course', s && COURSES.map(s.course))
        this.publishProperty('set_temp', s && TEMPERATURES.map(s.temp))
        this.publishProperty('set_spin', s && SPINS.map(s.spin))
        this.publishProperty('set_rinse', s && RINSES.map(s.rinse))
        this.publishProperty('set_delay_end', s ? s.delay[0] : undefined)
    }

    // F0 26 <course> <soil> <spin> <temp> <rinse> 00 <delay h> <delay min> 00 <options> <flags> 00 00 00 00 00,
    // as the LG app sends it (modelJson's WMStart in the same order).
    private static programmeCommand(flags: number, s: Run) {
        const [hours, minutes] = s.delay
        return Buffer.from([
            0xf0,
            0x26,
            ...[s.course, s.soil, s.spin, s.temp, s.rinse, 0, hours, minutes, 0, s.options, flags | s.wrinkleCare],
            ...[0, 0, 0, 0, 0],
        ])
    }

    setProperty(prop: string, value: string) {
        const s = this.settings()
        const allowed = (setting?: Setting) => setting?.[1] ?? []

        if (prop === 'set_course') {
            const code = COURSES.unmap(value)
            if (code !== undefined && PROGRAMMES[value]) {
                // A new course brings its own defaults.
                this.pending =
                    this.pending.delay && PROGRAMMES[value].delay
                        ? { course: code, delay: this.pending.delay }
                        : { course: code }
            }
        } else if (prop === 'set_temp' || prop === 'set_spin' || prop === 'set_rinse') {
            const key = prop.slice(4) as 'temp' | 'spin' | 'rinse'
            const table = { temp: TEMPERATURES, spin: SPINS, rinse: RINSES }[key]
            const code = table.unmap(value)
            // Only what the app offers for this course.
            if (s && code !== undefined && allowed(s.programme[key]).includes(code)) this.pending[key] = code
        } else if (prop === 'set_delay_end') {
            const hours = Number(value)
            if (
                Number.isInteger(hours) &&
                (hours === 0 || (hours >= 3 && hours <= 19)) &&
                (hours === 0 || s?.programme.delay)
            )
                this.pending.delay = hours
        } else {
            this.command(prop)
            return
        }
        this.publishSettings()
    }

    // Sent whatever the washer's state: it accepts or refuses (logged in processAABB). Only a command
    // that can't be built isn't sent.
    private command(prop: string) {
        const r = this.record
        if (prop === 'start') {
            if (r && r[2] === PAUSED) {
                // Resume with the washer's own settings. A downloaded course's resume was never captured, so
                // its bytes aren't known.
                if (r[22]) return this.log('start not sent: resuming a downloaded course')
                this.send(Device.programmeCommand(RESUME, Device.current(r)))
            } else {
                const s = this.settings()
                if (!s) return this.log('start not sent: no course on the washer or chosen')
                this.send(Device.programmeCommand(START, s))
            }
            // HA's choices are used up; the settings follow the washer again.
            this.pending = {}
            this.publishSettings()
        } else if (prop === 'pause') {
            this.send(Buffer.from(PAUSE, 'hex'))
        } else if (prop === 'power_off') {
            this.send(Buffer.from(POWER_OFF, 'hex'))
        } else if (prop === 'wake_up') {
            this.send(Buffer.from(WAKE_UP, 'hex'))
        }
    }
}
