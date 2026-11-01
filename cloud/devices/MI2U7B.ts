import HADevice from './base'
import AABBDevice from './aabb_device'
import crc16 from '@/util/crc16'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { COURSES, parseSideKickFrame } from './MI2U7B_status'

// Setter IDs/encoding follow FAFXU22007 by user-approved analogy, not live write proof.
const SET_PROPERTY = [0xf0, 0xe5, 0, 2, 1, 0xff]
const BUZZER = ['Off', 'Low', 'Medium', 'High', 'Very High']
const SELECTABLE_COURSES = Object.entries(COURSES).filter(([code]) => Number(code) !== 255)
const ACCEPTED = new Set([0, 0x10, 0x11])

function propertyIds(inner: Buffer): number[] | undefined {
    if (
        inner.length < 9 ||
        !inner.subarray(0, 5).equals(Buffer.from(SET_PROPERTY.slice(0, 5))) ||
        ![0xff, 0x33].includes(inner[5])
    )
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
    private readonly accepted = new Map<number, { value: number; until: number }>()
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
                        options: SELECTABLE_COURSES.map(([, label]) => label),
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
        return propertyIds(inner) ? 0xe5 : undefined
    }

    protected override writeTimedOut() {
        this.record = undefined
        this.accepted.clear()
        this.sentGenerations.length = 0
        this.setProblem('Command timed out; reconnect required before further commands')
    }

    override processAABB(buf: Buffer) {
        if (
            buf.length < 9 ||
            !buf.subarray(0, 5).equals(Buffer.from([0x20, 0xe6, 0, 2, 1])) ||
            ![0xff, 0x33].includes(buf[5])
        )
            return
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
        const failed = ids.some((_, i) => !ACCEPTED.has(buf[8 + i * 2]))
        if (write.own) this.setProblem(failed ? 'Command refused by appliance' : undefined)
        // Replies may contain stale unrelated settings. Never publish them as a full report.
        const rec = buf.subarray(offset)
        if (ids.includes(2) || ids.includes(10)) {
            this.generation++
            this.accepted.clear()
            this.record = undefined
            return
        }
        if (!this.record || rec[5] !== this.record[5] || rec[21] === 0) return
        for (let i = 0; i < count; i++) {
            if (!ACCEPTED.has(buf[8 + i * 2])) continue
            const field = { 0x1e: 1, 0x1f: 2, 0x20: 3, 0x21: 4, 0x13: 29 }[ids[i]]
            if (field !== undefined) this.accepted.set(field, { value: rec[field], until: Date.now() + 30_000 })
        }
        // Accepted values only seed the next write; state remains report-driven.
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
            const rec = Buffer.from(frame.subarray(15, -3))
            if (!this.record || rec[5] !== this.record[5] || rec[21] === 0) {
                this.generation++
                this.accepted.clear()
            }
            for (const [offset, accepted] of this.accepted)
                if (rec[offset] === accepted.value || Date.now() >= accepted.until) this.accepted.delete(offset)
            this.record = rec
            this.publishProperty('power', rec[21] === 0 ? 'OFF' : 'ON')
            this.publishProperty('rinse', rec[3] <= 6 ? rec[3] : undefined)
            this.publishProperty('buzzer', BUZZER[rec[29]])
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
        let pairs: number[]
        if (prop === 'power' && ['ON', 'OFF'].includes(value)) pairs = [2, value === 'ON' ? 1 : 0]
        else if (prop === 'course') {
            const course = SELECTABLE_COURSES.find(([, label]) => label === value)
            if (!course) return
            pairs = [10, Number(course[0])]
        } else if (['start', 'pause', 'resume'].includes(prop)) {
            pairs = [3, { start: 1, pause: 2, resume: 3 }[prop]!]
        } else if (
            prop === 'rinse' &&
            value.trim() !== '' &&
            Number.isInteger(Number(value)) &&
            Number(value) >= 0 &&
            Number(value) <= 6
        )
            pairs = [0x20, Number(value)]
        else if (prop === 'buzzer' && BUZZER.includes(value)) pairs = [0x13, BUZZER.indexOf(value)]
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
                if (prop === 'start') {
                    if (!SELECTABLE_COURSES.some(([code]) => Number(code) === this.record![5])) {
                        this.setProblem('Select a supported course before Start; downloaded Start is unsupported')
                        return
                    }
                    pairs = [10, this.record![5], 3, 1]
                }
                if (prop === 'rinse') {
                    // Preserve the raw soil/temperature/spin values, including unknown codes (e.g. spin19).
                    // SideKick uses a four-setting bundle by analogy; no front-loader-only options are sent.
                    const current = (offset: number) => {
                        const accepted = this.accepted.get(offset)
                        return accepted && Date.now() < accepted.until ? accepted.value : this.record![offset]
                    }
                    pairs = [0x1f, current(2), 0x21, current(4), 0x1e, current(1), 0x20, pairs[1]]
                }
                this.setProblem(undefined)
                const inner = Buffer.from([...SET_PROPERTY, pairs.length / 2, ...pairs])
                if (prop === 'buzzer') inner[5] = 0x33
                return inner
            },
            ['rinse', 'buzzer'].includes(prop) ? prop : undefined,
        )
    }
}
