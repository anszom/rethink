import HADevice from './base'
import AABBDevice from './aabb_device'
import crc16 from '@/util/crc16'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { COURSES, parseSideKickFrame } from './MI2U7B_status'

// MI2U7B setters and downloaded-course defaults captured through the LG bridge.
const SET_PROPERTY = [0xf0, 0xe5, 0, 2, 1, 0xff]
const BUZZER = ['Off', 'Low', 'Medium', 'Loud', 'Very Loud']
const MELODIES = {
    Normal: 0,
    'Vivaldi Winter': 1,
    'Verdi La Traviata Drinking Song': 6,
    Bubble: 7,
    'Beethoven Symphony No. 5': 8,
    Arirang: 9,
    "Pachelbel's Canon": 10,
    'Beethoven Symphony No. 9': 11,
} as const
const COURSE_SETTINGS: Record<string, readonly number[]> = Object.fromEntries(
    Object.entries(COURSES)
        .filter(([code]) => Number(code) !== 255)
        .map(([code, label]) => [label, [0x0a, Number(code)]]),
)
COURSE_SETTINGS['Spin Only'] = [0x0b, 0x81, 0x0a, 0xff, 0x0c, 0x37, 0x20, 0, 0x21, 0x13, 0x1f, 0, 0x46, 0]
COURSE_SETTINGS['Active Wear'] = [0x0b, 0xee, 0x0a, 0xff, 0x0c, 0x63, 0x20, 2, 0x21, 0x13, 0x1f, 0, 0x46, 0]

function acceptedResult(id: number, result: number, command: Buffer): boolean {
    if (result === 0) return true
    if ([2, 3].includes(id) && result === 0x15) return true
    // The app's downloaded-course bundles apply successfully with 01 for Warm Water off.
    return (
        id === 0x46 &&
        result === 1 &&
        ['Spin Only', 'Active Wear'].some((course) =>
            command.equals(Buffer.from([...SET_PROPERTY, 7, ...COURSE_SETTINGS[course]])),
        )
    )
}

function propertyIds(inner: Buffer): number[] | undefined {
    if (inner.length < 9 || !inner.subarray(0, 5).equals(Buffer.from(SET_PROPERTY.slice(0, 5))) || inner[5] !== 0xff)
        return
    if (!inner[6] || inner.length !== 7 + inner[6] * 2) return
    const ids = Array.from({ length: inner[6] }, (_, i) => inner[7 + i * 2])
    if (new Set(ids).size !== ids.length) return
    return ids
}

// Exact-model reports; explicit commands only, never polls or startup writes.
export default class Device extends AABBDevice {
    protected override readonly ackAfterProcessing = true
    protected override readonly strictWriteTracking = true
    private record?: Buffer
    private generation = 0
    private problem?: string
    private readonly sentGenerations: { inner: string; generation: number }[] = []
    private readonly trackGeneration = (type: string, frame: Buffer) => {
        if (type === 'packet' && this.writeType(frame.subarray(2, -2)) !== undefined)
            this.sentGenerations.push({ inner: frame.subarray(2, -2).toString('hex'), generation: this.generation })
    }
    // A finish retry at startup is not a new completion. No lifecycle is persisted.
    private completionState: 'unarmed' | 'armed' | 'completed' = 'unarmed'

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        thinq.on('sendData', this.trackGeneration)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG SideKick' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:power',
                        device_class: 'switch',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        name: 'Start',
                        icon: 'mdi:play',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        name: 'Pause',
                        icon: 'mdi:pause',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    rinse: {
                        platform: 'number',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        command_topic: '$this/rinse/set',
                        name: 'Rinse count',
                        icon: 'mdi:water-sync',
                        min: 0,
                        max: 6,
                        step: 1,
                        mode: 'box',
                    },
                    buzzer: {
                        platform: 'select',
                        unique_id: '$deviceid-buzzer',
                        state_topic: '$this/buzzer',
                        command_topic: '$this/buzzer/set',
                        name: 'Buzzer',
                        icon: 'mdi:volume-high',
                        options: BUZZER,
                        entity_category: 'config',
                    },
                    warm_water: {
                        platform: 'switch',
                        unique_id: '$deviceid-warm_water',
                        state_topic: '$this/warm_water',
                        command_topic: '$this/warm_water/set',
                        name: 'Warm Water',
                        icon: 'mdi:thermometer',
                    },
                    melody: {
                        platform: 'select',
                        unique_id: '$deviceid-melody',
                        state_topic: '$this/melody',
                        command_topic: '$this/melody/set',
                        name: 'Ending melody',
                        options: Object.keys(MELODIES),
                        entity_category: 'config',
                    },
                    keep_remote_start: {
                        platform: 'switch',
                        unique_id: '$deviceid-keep_remote_start',
                        state_topic: '$this/keep_remote_start',
                        command_topic: '$this/keep_remote_start/set',
                        name: 'Keep Remote Start On',
                        icon: 'mdi:remote',
                        entity_category: 'config',
                    },
                    problem: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-problem',
                        state_topic: '$this/problem',
                        name: 'Command problem',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    problem_reason: {
                        platform: 'sensor',
                        unique_id: '$deviceid-problem_reason',
                        state_topic: '$this/problem_reason',
                        name: 'Command problem reason',
                        entity_category: 'diagnostic',
                    },

                    cycle_finished: {
                        platform: 'event',
                        unique_id: '$deviceid-cycle_finished',
                        state_topic: '$this/cycle_finished',
                        name: 'Cycle finished',
                        event_types: ['finished'],
                        enabled_by_default: true,
                    },
                    total_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-total_time',
                        state_topic: '$this/total_time',
                        name: 'Total Time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    course: {
                        platform: 'select',
                        command_topic: '$this/course/set',
                        options: [...Object.keys(COURSE_SETTINGS), 'Downloaded'],
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
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
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        icon: 'mdi:lightning-bolt',
                        device_class: 'energy',
                        unit_of_measurement: 'Wh',
                        state_class: 'total_increasing',
                    },
                    drawer: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drawer',
                        state_topic: '$this/drawer',
                        name: 'Drawer',
                        device_class: 'opening',
                    },
                },
            }),
        )
    }

    override drop() {
        this.thinq.off('sendData', this.trackGeneration)
        super.drop()
    }

    override start() {
        this.setProblem(this.problem)
    }

    private setProblem(reason?: string) {
        this.problem = reason
        this.publishProperty('problem', reason ? 'ON' : 'OFF')
        this.publishProperty('problem_reason', reason ?? 'OK')
    }

    // Validate both the established long reports and washer-style short write replies.
    override processData(frame: Buffer) {
        if (frame.length < 6 || frame[0] !== 0xaa || frame[frame.length - 1] !== 0xbb) return
        if (frame[1] === 0xff) {
            if (
                frame.length < 18 ||
                frame[2] !== 0x20 ||
                frame[3] !== 0x0a ||
                frame.readUInt16BE(4) !== frame.length ||
                frame.readUInt16BE(13) + 18 !== frame.length ||
                crc16(frame.subarray(0, -3)) !== frame.readUInt16BE(frame.length - 3)
            )
                return
            this.processReport(frame)
        } else {
            if (frame[1] !== frame.length || frame[2] !== 0x20) return
            const sum = frame.subarray(0, -2).reduce((a, b) => a + b, 0)
            if (((sum & 0xff) ^ 0x55) !== frame[frame.length - 2]) return
        }
        super.processData(frame)
    }

    protected override writeType(inner: Buffer) {
        if (propertyIds(inner)) return 0xe5
        if (inner.length === 5 && inner.subarray(0, 4).equals(Buffer.from([0xf0, 0x24, 0x10, 1])) && inner[4] <= 1)
            return 0x24
        return undefined
    }

    protected override writeTimedOut() {
        this.record = undefined
        this.sentGenerations.length = 0
        this.setProblem('Command timed out; reconnect required before further commands')
    }

    override processAABB(buf: Buffer) {
        if (buf.length === 4 && buf.subarray(0, 3).equals(Buffer.from([0x20, 0, 0x24]))) {
            const write = this.writeAnswered(0x24)
            if (write) {
                const index = this.sentGenerations.findIndex(({ inner }) => inner === write.inner.toString('hex'))
                if (index >= 0) this.sentGenerations.splice(index, 1)
                if (write.own) this.setProblem(buf[3] === 0 ? undefined : 'Command refused by appliance')
            }
            return
        }
        if (buf.length < 9 || !buf.subarray(0, 6).equals(Buffer.from([0x20, 0xe6, 0, 2, 1, 0xff]))) return
        const count = buf[6]
        const offset = 7 + 2 * count
        if (!count || buf.length !== offset + 49 || buf[offset] !== 0) return
        const ids = Array.from({ length: count }, (_, i) => buf[7 + i * 2])
        if (new Set(ids).size !== count) return
        const write = this.writeAnswered(0xe5, (write) => {
            const expected = propertyIds(write.inner)
            return expected !== undefined && expected.length === count && expected.every((id) => ids.includes(id))
        })
        if (!write) return
        const index = this.sentGenerations.findIndex(({ inner }) => inner === write.inner.toString('hex'))
        const generation = index < 0 ? undefined : this.sentGenerations.splice(index, 1)[0].generation
        if (generation !== this.generation) return
        const failed = ids.some((id, i) => !acceptedResult(id, buf[8 + i * 2], write.inner))
        if (write.own) this.setProblem(failed ? 'Command refused by appliance' : undefined)
        // Reply records may be stale or reflect refused settings. Only reports publish state.
        if (!failed && (ids.includes(2) || ids.includes(10))) {
            this.generation++
            this.record = undefined
        }
    }

    private processReport(frame: Buffer) {
        const update = parseSideKickFrame(frame)
        if (!update) return
        if (update.kind === 'completion') {
            if (this.completionState !== 'armed') return
            this.completionState = 'completed'
            this.HA.publishProperty(this.id, 'cycle_finished', JSON.stringify({ event_type: 'finished' }), {
                retain: false,
            })
        } else if (update.kind === 'drawer') {
            this.publishProperty('drawer', update.drawer)
        } else {
            const rec = Buffer.from(update.record)
            if (!this.record || rec[5] !== this.record[5] || rec[23] !== this.record[23] || rec[21] === 0)
                this.generation++
            this.record = rec
            this.publishProperty('power', rec[21] === 0 ? 'OFF' : 'ON')
            this.publishProperty('rinse', rec[3] <= 6 ? rec[3] : undefined)
            this.publishProperty('buzzer', BUZZER[rec[29]])
            this.publishProperty('warm_water', rec[36] & 0x08 ? 'ON' : 'OFF')
            this.publishProperty('keep_remote_start', rec[40] & 0x04 ? 'ON' : 'OFF')
            this.publishProperty('melody', Object.entries(MELODIES).find(([, code]) => code === rec[45])?.[0])
            if ([0, 1].includes(update.state_code)) this.completionState = 'unarmed'
            else if (this.completionState === 'unarmed' && [11, 12, 14].includes(update.state_code))
                this.completionState = 'armed'
            this.publishProperty('status', update.status)
            this.publishProperty('total_time', update.total_time)
            this.publishProperty('course', update.course)
            this.publishProperty('remaining_time', update.remaining_time)
            this.publishProperty('energy', update.energy)
        }
    }

    override setProperty(prop: string, value: string) {
        if (this.writesBlocked) return
        let pairs: readonly number[]
        if (prop === 'power' && ['ON', 'OFF'].includes(value)) pairs = [2, value === 'ON' ? 1 : 0]
        else if (prop === 'course' && Object.prototype.hasOwnProperty.call(COURSE_SETTINGS, value))
            pairs = COURSE_SETTINGS[value]
        else if (['start', 'pause', 'resume'].includes(prop)) pairs = [3, { start: 1, pause: 2, resume: 3 }[prop]!]
        else if (
            prop === 'rinse' &&
            value.trim() !== '' &&
            Number.isInteger(Number(value)) &&
            Number(value) >= 0 &&
            Number(value) <= 6
        )
            pairs = [0x20, Number(value)]
        else if (prop === 'buzzer' && BUZZER.includes(value)) pairs = [0x13, BUZZER.indexOf(value)]
        else if (prop === 'melody' && Object.prototype.hasOwnProperty.call(MELODIES, value))
            pairs = [0x50, MELODIES[value as keyof typeof MELODIES]]
        else if (prop === 'warm_water' && ['ON', 'OFF'].includes(value)) pairs = [0x46, value === 'ON' ? 1 : 0]
        else if (prop === 'keep_remote_start' && ['ON', 'OFF'].includes(value)) pairs = []
        else return
        const generation = this.generation
        this.queueWrite(
            () => {
                if (prop !== 'power' && (!this.record || this.record[21] === 0)) {
                    this.setProblem('Fresh powered-on status required')
                    return
                }
                if (prop !== 'power' && generation !== this.generation) {
                    this.setProblem('Course or power changed; submit command again')
                    return
                }
                this.setProblem(undefined)
                if (prop === 'keep_remote_start') return Buffer.from([0xf0, 0x24, 0x10, 1, value === 'ON' ? 1 : 0])
                return Buffer.from([...SET_PROPERTY, pairs.length / 2, ...pairs])
            },
            ['rinse', 'buzzer', 'warm_water', 'melody', 'keep_remote_start'].includes(prop) ? prop : undefined,
        )
    }
}
