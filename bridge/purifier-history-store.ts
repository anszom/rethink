import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validDeviceId } from '@/util/device-id'

export type PurifierUsage = {
    day: string
    normal: number
    hot: number
    cold: number
    soda: number
    mineral: number
    sterilization: number
}

export type PurifierDailyUsage = Omit<PurifierUsage, 'day'>

export type PurifierSterilizationHistory = {
    active?: {
        kind: 'pipe' | 'outlet'
        startedAt: number
    }
    lastPipeAt?: number
    lastOutletAt?: number
    countsByMonth: Record<string, number>
}

export type PurifierScheduleAnchor = {
    parts: [number, number, number, number]
    instant: number
}

export type PurifierHistoryState = {
    version: 1
    collectedSince: number
    usageComplete: boolean
    usage: PurifierUsage
    sterilization: PurifierSterilizationHistory
    schedule?: PurifierScheduleAnchor
}

export type PurifierHistoryStore = {
    load(id: string): PurifierHistoryState | undefined
    save(id: string, state: PurifierHistoryState): void
}

type PurifierHistoryFileOps = {
    read(path: string): string
    write(path: string, data: string, options: { mode: number }): void
    rename(from: string, to: string): void
}

type PurifierHistoryWarning = (message: string, error: unknown) => void

const fileOps: PurifierHistoryFileOps = {
    read: (path) => readFileSync(path, 'utf-8'),
    write: (path, data, options) => writeFileSync(path, data, options),
    rename: (from, to) => renameSync(from, to),
}

const usageFields = ['normal', 'hot', 'cold', 'soda', 'mineral', 'sterilization'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validDay(day: unknown): day is string {
    if (typeof day !== 'string') return false
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
    if (!match) return false

    const year = Number(match[1])
    const month = Number(match[2])
    const dayOfMonth = Number(match[3])
    if (month < 1 || month > 12) return false

    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return dayOfMonth >= 1 && dayOfMonth <= daysInMonth[month - 1]!
}

function validMonth(month: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(month)
    if (!match) return false
    const monthNumber = Number(match[2])
    return monthNumber >= 1 && monthNumber <= 12
}

function canonicalSchedule(value: unknown): PurifierScheduleAnchor | undefined {
    if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length !== 4 || !isTimestamp(value.instant))
        return undefined

    const parts = value.parts
    if (parts.some((part) => typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0 || part > 0xff))
        return undefined

    const [month, day, hour, minute] = parts as [number, number, number, number]
    const date = new Date(value.instant)
    if (
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day ||
        date.getUTCHours() !== hour ||
        date.getUTCMinutes() !== minute ||
        date.getUTCSeconds() !== 0 ||
        date.getUTCMilliseconds() !== 0
    )
        return undefined

    return { parts: [month, day, hour, minute], instant: value.instant }
}

function canonicalState(value: unknown): PurifierHistoryState | undefined {
    if (!isRecord(value) || value.version !== 1 || !isTimestamp(value.collectedSince)) return undefined
    if (!isRecord(value.usage) || !isRecord(value.sterilization)) return undefined

    if (!validDay(value.usage.day)) return undefined
    const usage = {
        day: value.usage.day,
    } as PurifierUsage
    if (value.usageComplete !== undefined && typeof value.usageComplete !== 'boolean') return undefined
    for (const field of usageFields) {
        const amount = value.usage[field]
        if (!isNonnegativeSafeInteger(amount)) return undefined
        usage[field] = amount
    }

    const storedSterilization = value.sterilization
    if (!isRecord(storedSterilization.countsByMonth)) return undefined

    const countsByMonth: Record<string, number> = {}
    for (const [month, count] of Object.entries(storedSterilization.countsByMonth)) {
        if (!validMonth(month) || !isNonnegativeSafeInteger(count)) return undefined
        countsByMonth[month] = count
    }

    const sterilization = {} as PurifierSterilizationHistory
    if (storedSterilization.active !== undefined) {
        if (
            !isRecord(storedSterilization.active) ||
            (storedSterilization.active.kind !== 'pipe' && storedSterilization.active.kind !== 'outlet') ||
            !isTimestamp(storedSterilization.active.startedAt)
        )
            return undefined
        sterilization.active = {
            kind: storedSterilization.active.kind,
            startedAt: storedSterilization.active.startedAt,
        }
    }
    if (storedSterilization.lastPipeAt !== undefined) {
        if (!isTimestamp(storedSterilization.lastPipeAt)) return undefined
        sterilization.lastPipeAt = storedSterilization.lastPipeAt
    }
    if (storedSterilization.lastOutletAt !== undefined) {
        if (!isTimestamp(storedSterilization.lastOutletAt)) return undefined
        sterilization.lastOutletAt = storedSterilization.lastOutletAt
    }
    sterilization.countsByMonth = countsByMonth

    const state: PurifierHistoryState = {
        version: 1,
        collectedSince: value.collectedSince,
        // Version 1 files written before cloud baselining cannot prove that the bridge
        // observed the whole KST day. Treat them as partial instead of publishing a false zero.
        usageComplete: value.usageComplete === true,
        usage,
        sterilization,
    }
    if (value.schedule !== undefined) {
        const schedule = canonicalSchedule(value.schedule)
        if (!schedule) return undefined
        state.schedule = schedule
    }
    return state
}

export class PurifierHistoryJSONStore implements PurifierHistoryStore {
    private tempSequence = 0

    constructor(
        readonly basePath: string,
        private readonly files: PurifierHistoryFileOps = fileOps,
        private readonly warn: PurifierHistoryWarning = console.warn,
    ) {}

    private path(id: string) {
        if (!validDeviceId(id)) return undefined
        return join(this.basePath, `purifier_${id}.json`)
    }

    private stateForDay(id: string, day: string, now: number, reportLoadFailure = true) {
        const existing = reportLoadFailure ? this.load(id) : this.loadWithoutWarning(id)
        if (existing) {
            return {
                ...existing,
                usage:
                    existing.usage.day === day
                        ? { ...existing.usage }
                        : {
                              day,
                              normal: 0,
                              hot: 0,
                              cold: 0,
                              soda: 0,
                              mineral: 0,
                              sterilization: 0,
                          },
            }
        }
        return {
            version: 1 as const,
            collectedSince: now,
            usageComplete: false,
            usage: {
                day,
                normal: 0,
                hot: 0,
                cold: 0,
                soda: 0,
                mineral: 0,
                sterilization: 0,
            },
            sterilization: { countsByMonth: {} },
        }
    }

    markAllDailyUsageIncomplete(day: string, now: number) {
        let filenames: string[]
        try {
            filenames = readdirSync(this.basePath)
        } catch (error) {
            this.warn('Unable to enumerate purifier history for daily usage preparation', this.safeError(error))
            return []
        }
        const deviceIds: string[] = []
        for (const filename of filenames) {
            const match = /^purifier_(.+)\.json$/.exec(filename)
            if (!match || !validDeviceId(match[1]!)) continue
            deviceIds.push(match[1]!)
            try {
                const state = this.stateForDay(match[1]!, day, now, false)
                state.usageComplete = false
                this.save(match[1]!, state)
            } catch (error) {
                this.warn('Unable to prepare one purifier history for daily usage', this.safeError(error))
            }
        }
        return deviceIds
    }

    private safeError(error: unknown) {
        return { error: error instanceof Error ? error.name : 'UnknownError' }
    }

    private loadWithoutWarning(id: string) {
        const path = this.path(id)
        if (!path) return undefined
        let serialized: string
        try {
            serialized = this.files.read(path)
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
            throw error
        }
        const state = canonicalState(JSON.parse(serialized) as unknown)
        if (!state) throw new Error('purifier history has an invalid schema')
        return state
    }

    prepareDailyUsage(id: string, day: string, now: number) {
        const state = this.stateForDay(id, day, now, false)
        state.usageComplete = false
        this.save(id, state)
    }

    applyDailyUsageBaseline(id: string, day: string, usage: PurifierDailyUsage, now: number) {
        const state = this.stateForDay(id, day, now, false)
        state.usageComplete = true
        state.usage = { day, ...usage }
        this.save(id, state)
    }

    load(id: string): PurifierHistoryState | undefined {
        const path = this.path(id)
        if (!path) return undefined

        let serialized: string
        try {
            serialized = this.files.read(path)
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
            this.warn(`Unable to read purifier history ${path}`, error)
            throw error
        }

        try {
            const state = canonicalState(JSON.parse(serialized) as unknown)
            if (!state) throw new Error('purifier history has an invalid schema')
            return state
        } catch (error) {
            this.warn(`Unable to load corrupt purifier history ${path}`, error)
            throw error
        }
    }

    save(id: string, state: PurifierHistoryState): void {
        const path = this.path(id)
        if (!path) return

        const canonical = canonicalState(state)
        if (!canonical) throw new TypeError('purifier history has an invalid schema')

        const tempPath = `${path}.${process.pid}.${this.tempSequence++}.tmp`
        this.files.write(tempPath, JSON.stringify(canonical), { mode: 0o600 })
        this.files.rename(tempPath, path)
    }
}
