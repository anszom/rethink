import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PurifierHistoryJSONStore, type PurifierHistoryState } from '@/bridge/purifier-history-store'

function temporaryDirectory(t: import('node:test').TestContext) {
    const path = mkdtempSync(join(tmpdir(), 'rethink-purifier-history-'))
    t.after(() => rmSync(path, { recursive: true }))
    return path
}

function validState(): PurifierHistoryState {
    return {
        version: 1,
        collectedSince: 1000.5,
        usageComplete: true,
        usage: {
            day: '2026-01-31',
            normal: 20,
            hot: 30,
            cold: 40,
            soda: 5,
            mineral: 3,
            sterilization: 2,
        },
        sterilization: {
            active: { kind: 'pipe', startedAt: 2000.25 },
            lastPipeAt: 900,
            lastOutletAt: 800,
            countsByMonth: { '2026-01': 2, '2026-12': 3 },
        },
        schedule: {
            parts: [7, 28, 18, 30],
            instant: Date.UTC(2026, 6, 28, 18, 30),
        },
    }
}

test('purifier history store distinguishes missing files from corrupt or invalid state', (t) => {
    const directory = temporaryDirectory(t)
    const warnings: string[] = []
    const store = new PurifierHistoryJSONStore(directory, undefined, (message) => warnings.push(message))
    const path = join(directory, 'purifier_device-1.json')

    assert.equal(store.load('device-1'), undefined)

    const invalidStates: unknown[] = [
        '{not json',
        null,
        { ...validState(), version: 2 },
        { ...validState(), collectedSince: Number.POSITIVE_INFINITY },
        { ...validState(), usage: { ...validState().usage, hot: -1 } },
        { ...validState(), usage: { ...validState().usage, cold: 1.5 } },
        { ...validState(), usageComplete: 'yes' },
        { ...validState(), usage: { ...validState().usage, day: 20260101 } },
        { ...validState(), usage: { ...validState().usage, day: '2026-1-01' } },
        { ...validState(), usage: { ...validState().usage, day: '2026-00-01' } },
        { ...validState(), usage: { ...validState().usage, day: '2026-04-31' } },
        { ...validState(), usage: { ...validState().usage, day: '2026-02-29' } },
        {
            ...validState(),
            sterilization: {
                ...validState().sterilization,
                countsByMonth: { '2026-01-01': 1 },
            },
        },
        {
            ...validState(),
            sterilization: {
                ...validState().sterilization,
                countsByMonth: { '2026-13': 1 },
            },
        },
        {
            ...validState(),
            sterilization: {
                ...validState().sterilization,
                active: { kind: 'filter', startedAt: 1 },
            },
        },
        {
            ...validState(),
            schedule: {
                parts: [7, 28, 18],
                instant: Date.UTC(2026, 6, 28, 18, 30),
            },
        },
        {
            ...validState(),
            schedule: {
                parts: [7, 28, 18, 30],
                instant: Date.UTC(2026, 6, 28, 19, 30),
            },
        },
        {
            ...validState(),
            schedule: {
                parts: [7, 28, 18, 30],
                instant: Date.UTC(2026, 6, 28, 18, 30, 1),
            },
        },
        {
            ...validState(),
            schedule: {
                parts: [7, 28, 18, 30],
                instant: Date.UTC(2026, 6, 28, 18, 30, 0, 1),
            },
        },
    ]

    for (const invalid of invalidStates) {
        const serialized = typeof invalid === 'string' ? invalid : JSON.stringify(invalid)
        writeFileSync(path, serialized)
        assert.throws(() => store.load('device-1'))
        assert.equal(readFileSync(path, 'utf8'), serialized)
    }
    assert.equal(warnings.length, invalidStates.length)

    writeFileSync(path, JSON.stringify(validState()))
    assert.deepEqual(store.load('device-1'), validState())

    const legacyStateWithoutCompleteness = { ...validState() } as Record<string, unknown>
    delete legacyStateWithoutCompleteness.usageComplete
    writeFileSync(path, JSON.stringify(legacyStateWithoutCompleteness))
    assert.equal(store.load('device-1')?.usageComplete, false)

    const { schedule: _schedule, ...legacyState } = validState()
    writeFileSync(path, JSON.stringify(legacyState))
    assert.deepEqual(store.load('device-1'), legacyState)

    const leapDay = {
        ...validState(),
        usage: { ...validState().usage, day: '2024-02-29' },
    }
    writeFileSync(path, JSON.stringify(leapDay))
    assert.deepEqual(store.load('device-1'), leapDay)
})

test('purifier history store warns and surfaces non-missing read errors', () => {
    const warnings: string[] = []
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const store = new PurifierHistoryJSONStore(
        '/state',
        {
            read: () => {
                throw denied
            },
            write: () => {},
            rename: () => {},
        },
        (message) => warnings.push(message),
    )

    assert.throws(() => store.load('device-1'), denied)
    assert.match(warnings[0]!, /Unable to read purifier history/)
})

test('purifier history store validates device IDs before filesystem access', () => {
    const paths: string[] = []
    const store = new PurifierHistoryJSONStore('/state', {
        read: (path) => {
            paths.push(path)
            return JSON.stringify(validState())
        },
        write: (path) => {
            paths.push(path)
        },
        rename: (_from, to) => {
            paths.push(to)
        },
    })

    assert.equal(store.load('../escape'), undefined)
    store.save('../escape', validState())
    assert.deepEqual(paths, [])

    assert.deepEqual(store.load('device.with:scope'), validState())
    store.save('device.with:scope', validState())
    assert.equal(paths[0], '/state/purifier_device.with:scope.json')
    assert.equal(paths[2], '/state/purifier_device.with:scope.json')
})

test('purifier history store serializes canonical state to a 0600 temp file then renames it', () => {
    const calls: Array<{
        operation: string
        path: string
        data?: string
        mode?: number
        to?: string
    }> = []
    const store = new PurifierHistoryJSONStore('/state', {
        read: () => JSON.stringify(validState()),
        write: (path, data, options) => calls.push({ operation: 'write', path, data, mode: options.mode }),
        rename: (from, to) => calls.push({ operation: 'rename', path: from, to }),
    })
    const state = {
        ...validState(),
        unrelated: 'ignored',
        usage: { ...validState().usage, unrelated: 99 },
        sterilization: {
            ...validState().sterilization,
            unrelated: true,
        },
    } as PurifierHistoryState

    store.save('device-1', state)

    assert.equal(calls.length, 2)
    assert.match(calls[0]!.path, /^\/state\/purifier_device-1\.json\.\d+\.0\.tmp$/)
    assert.equal(dirname(calls[0]!.path), '/state')
    assert.equal(calls[0]!.mode, 0o600)
    assert.equal(calls[0]!.data, JSON.stringify(validState()))
    assert.deepEqual(calls[1], {
        operation: 'rename',
        path: calls[0]!.path,
        to: '/state/purifier_device-1.json',
    })
})

test('purifier history store creates the real temporary file with private permissions', (t) => {
    const directory = temporaryDirectory(t)
    let tempPath = ''
    const store = new PurifierHistoryJSONStore(directory, {
        read: () => JSON.stringify(validState()),
        write: (path, data, options) => {
            tempPath = path
            writeFileSync(path, data, options)
        },
        rename: () => {},
    })

    store.save('device-1', validState())

    assert.equal(statSync(tempPath).mode & 0o777, 0o600)
})

test('purifier history store surfaces write and rename failures', () => {
    const writeFailure = new Error('write failed')
    const renameFailure = new Error('rename failed')

    const writeStore = new PurifierHistoryJSONStore('/state', {
        read: () => JSON.stringify(validState()),
        write: () => {
            throw writeFailure
        },
        rename: () => assert.fail('rename must not follow a failed write'),
    })
    assert.throws(() => writeStore.save('device-1', validState()), writeFailure)

    const renameStore = new PurifierHistoryJSONStore('/state', {
        read: () => JSON.stringify(validState()),
        write: () => {},
        rename: () => {
            throw renameFailure
        },
    })
    assert.throws(() => renameStore.save('device-1', validState()), renameFailure)
})

test('purifier history store refuses invalid state before writing', () => {
    let writes = 0
    const store = new PurifierHistoryJSONStore('/state', {
        read: () => JSON.stringify(validState()),
        write: () => {
            writes++
        },
        rename: () => {},
    })
    const invalid = {
        ...validState(),
        sterilization: { countsByMonth: { '2026-00': 1 } },
    } as PurifierHistoryState

    assert.throws(() => store.save('device-1', invalid), /invalid schema/)
    assert.equal(writes, 0)
})

test('cloud baseline replacement preserves sterilization and schedule state atomically', (t) => {
    const directory = temporaryDirectory(t)
    const path = join(directory, 'purifier_device-1.json')
    const previous = validState()
    writeFileSync(path, JSON.stringify(previous))
    const store = new PurifierHistoryJSONStore(directory)

    store.prepareDailyUsage('device-1', '2026-07-29', 3000)
    const partial = store.load('device-1')!
    assert.equal(partial.usageComplete, false)
    assert.equal(partial.usage.cold, 0)
    assert.deepEqual(partial.sterilization, previous.sterilization)
    assert.deepEqual(partial.schedule, previous.schedule)

    store.applyDailyUsageBaseline(
        'device-1',
        '2026-07-29',
        { normal: 0, hot: 0, cold: 119, soda: 0, mineral: 0, sterilization: 0 },
        3000,
    )
    const complete = store.load('device-1')!
    assert.equal(complete.usageComplete, true)
    assert.deepEqual(complete.usage, {
        day: '2026-07-29',
        normal: 0,
        hot: 0,
        cold: 119,
        soda: 0,
        mineral: 0,
        sterilization: 0,
    })
    assert.deepEqual(complete.sterilization, previous.sterilization)
    assert.deepEqual(complete.schedule, previous.schedule)
    assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('daily usage preparation isolates corrupt purifier files and redacts their identifiers', (t) => {
    const directory = temporaryDirectory(t)
    const warnings: unknown[][] = []
    const store = new PurifierHistoryJSONStore(directory, undefined, (...args) => warnings.push(args))
    store.save('healthy-device', validState())
    writeFileSync(join(directory, 'purifier_secret-device.json'), '{not json')

    assert.doesNotThrow(() => store.markAllDailyUsageIncomplete('2026-07-29', 3000))
    assert.equal(store.load('healthy-device')?.usageComplete, false)
    const logged = JSON.stringify(warnings)
    assert.equal(logged.includes('secret-device'), false)
    assert.match(logged, /SyntaxError/)
})
