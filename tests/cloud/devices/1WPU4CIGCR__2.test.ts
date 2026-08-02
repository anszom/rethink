import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DUT from '@/cloud/devices/1WPU4CIGCR__2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import {
    PurifierHistoryJSONStore,
    type PurifierHistoryState,
    type PurifierHistoryStore,
    type PurifierUsage,
} from '@/bridge/purifier-history-store'

const DEVICE_ID = 'test-id'
const MODEL_ID = '1WPU4CIGCR__2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '' }
const FIXED_NOW = Date.parse('2026-07-28T12:00:00Z')

/*
 * Fixtures.
 *
 * STATE is a REAL frame captured from the appliance on 2026-07-28. The rest are that frame with
 * ONE byte changed and the checksum recomputed; each was injected into LG's cloud that day, so
 * the expected value is LG's own decode of that exact frame, not a restatement of this driver.
 */

// Real. LG read this frame as monStatus NORMAL, waterSelection NORMAL_WATER, waterAmountMode 1,
// tempUnit CELSIUS, amountUnit M_LITTER, hotWaterTemp 255 (IGNORE), defaultWaterSet RECENT_WATER,
// defaultWaterAmountMode 1, buttonSoundOnOff ON, raw sterilizeInit 7/28 18:30 UTC, autoCareOnOff ON,
// monDataRefresh 3, highSterilizeState OFF, filterFlushingState OFF, appVersion 1.
const STATE = buf(
    'aa3a12ec020102010101ffff00ff010101ffff071c121eff01ff03000001020002010101ffff00ff010101ffff071c121eff01ff03000001ccbb',
)

// Real, and the form this appliance actually sends most of the time: 32 bytes, ONE record,
// captured live 2026-07-28 09:46. Its 26 payload bytes are the 58-byte frame's trailing record,
// differing only in the record index byte. A decoder keyed on "58 bytes" ignores this and leaves
// every entity unknown — which is exactly what the first live rebuild showed.
const STATE_SHORT = buf('aa2012eb020002010101ffff00ff010101ffff071c121eff01ff0300000177bb')

const COLD_WATER = buf(
    'aa3a12ec020102010101ffff00ff010101ffff071c121eff01ff03000001020003010101ffff00ff010101ffff071c121eff01ff03000001cfbb',
) // byte[32]=3 -> waterSelection COLD_WATER
const FAHRENHEIT = buf(
    'aa3a12ec020102010101ffff00ff010101ffff071c121eff01ff03000001020002010001ffff00ff010101ffff071c121eff01ff03000001cdbb',
) // byte[34]=0 -> tempUnit FAHRENHEIT
const DEFAULT_COLD = buf(
    'aa3a12ec020102010101ffff00ff010101ffff071c121eff01ff03000001020002010101ffff00ff030101ffff071c121eff01ff03000001cebb',
) // byte[40]=3 -> defaultWaterSet COLD_WATER
const STERILIZING = buf(
    'aa3a12ec020102010101ffff00ff010101ffff071c121eff01ff03000001020002010101ffff00ff010101ffff071c121eff01ff03030001c9bb',
) // byte[53]=3 -> highSterilizeState MANUAL_DWP_A_TYPE
const HOT_85 = buf(
    'aa3a12ec020102010101ffff00ff010101ffff071c121eff01ff0300000102000201010103ff00ff010101ffff071c121eff01ff03000001c8bb',
) // byte[36]=3 -> hotWaterTemp code 3 (= 85 °C per hotWaterTemp_C)

function withAABBChecksum(frame: Buffer) {
    const packet = Buffer.from(frame)
    let sum = 0
    for (let i = 0; i < packet.length - 2; i++) sum += packet[i]
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

function stateWithSterilizationPhase(phase: number) {
    const frame = Buffer.from(STATE)
    frame[53] = phase
    return withAABBChecksum(frame)
}

function makeDevice(now = FIXED_NOW) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const clock = new FakeClock(now)
    const dev = new DUT(ha.asConnection(), thinq, META, clock)
    return { ha, thinq, dev, clock }
}

const usage = (day: string, values: Partial<PurifierUsage> = {}): PurifierUsage => ({
    day,
    normal: 0,
    hot: 0,
    cold: 0,
    soda: 0,
    mineral: 0,
    sterilization: 0,
    ...values,
})

class MemoryHistoryStore implements PurifierHistoryStore {
    saved: PurifierHistoryState[] = []
    failLoad = false
    failSave = false

    constructor(public state?: PurifierHistoryState) {}
    load() {
        if (this.failLoad) throw new Error('load failed')
        return this.state == null ? undefined : structuredClone(this.state)
    }
    save(_id: string, state: PurifierHistoryState) {
        if (this.failSave) throw new Error('save failed')
        this.state = structuredClone(state)
        this.saved.push(structuredClone(state))
    }
}

class FakeClock {
    timers = new Map<object, { callback: () => void; delay: number }>()
    constructor(public time: number) {}
    now = () => this.time
    setTimeout = (callback: () => void, delay: number) => {
        const handle = {}
        this.timers.set(handle, { callback, delay })
        return handle as ReturnType<typeof setTimeout>
    }
    clearTimeout = (handle: ReturnType<typeof setTimeout> | undefined) => {
        if (handle) this.timers.delete(handle)
    }
    fire(delay: number) {
        const hit = [...this.timers].find(([, timer]) => timer.delay === delay)
        assert.ok(hit, `timer ${delay} exists`)
        this.timers.delete(hit[0])
        hit[1].callback()
    }
}

function historyState(now: number, values: Partial<PurifierHistoryState> = {}): PurifierHistoryState {
    return {
        version: 1,
        collectedSince: now,
        usageComplete: true,
        usage: usage('2026-07-28'),
        sterilization: { countsByMonth: {} },
        ...values,
    }
}

function makeHistoryDevice(
    now = Date.parse('2026-07-28T12:00:00Z'),
    state: PurifierHistoryState | null = historyState(now),
) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const clock = new FakeClock(now)
    const store = new MemoryHistoryStore(state ?? undefined)
    const dev = new DUT(ha.asConnection(), thinq, META, clock)
    dev.setPurifierHistoryStore(store)
    dev.start()
    return { ha, thinq, clock, store, dev }
}

function usageFrame(values: Partial<Omit<PurifierUsage, 'day'>>) {
    const frame = Buffer.alloc(18)
    frame[0] = 0xaa
    frame[1] = 0x12
    frame[2] = 0x12
    frame[3] = 0x1f
    frame[5] = values.normal ?? 0
    frame.writeUInt16BE(values.hot ?? 0, 6)
    frame.writeUInt16BE(values.cold ?? 0, 8)
    frame.writeUInt16BE(values.soda ?? 0, 10)
    frame.writeUInt16BE(values.mineral ?? 0, 12)
    frame.writeUInt16BE(values.sterilization ?? 0, 14)
    frame[17] = 0xbb
    return withAABBChecksum(frame)
}

describe(MODEL_ID, () => {
    // Writable only where an LG capability command was captured and its complete side effects
    // were verified. Everything else stays a sensor rather than an unsafe or inert control.
    const WRITABLE = new Set(['default_water', 'default_water_amount', 'auto_care', 'not_use_notice'])

    test('exactly the fields with a side-effect-safe command frame are writable', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [name, comp] of Object.entries(components)) {
            if (comp.unique_id === undefined) continue // a removal, not an entity
            if (WRITABLE.has(name)) {
                assert.equal(comp.command_topic, `$this/${name}/set`, `${name} is writable`)
            } else {
                assert.equal(comp.command_topic, undefined, `${name} stays read-only`)
                assert.ok(
                    comp.platform === 'sensor' || comp.platform === 'binary_sensor',
                    `${name} is a sensor platform, got ${comp.platform}`,
                )
            }
        }
    })

    /*
     * The write frames below are REAL: LG's capability API was asked to change each setting
     * (`convert/control`, every one answered CL-0000), and these are the cloud→appliance frames
     * rethink relayed as a result, on 2026-07-28. So the assertion is that this driver emits
     * byte for byte what LG emits — not that it matches its own idea of the format.
     *
     * Every safe writable field lands on the record offset the READ probes had predicted, so
     * the local encoder stays byte-for-byte aligned with LG's captured command frames.
     */
    test('each write reproduces the frame LG itself sent for that command', () => {
        for (const [prop, value, want] of [
            // setDispenserDefaultWaterAmountMode 500 / 120 / 250 -> record[11]
            ['default_water_amount', '500 mL', 'aa20f017ffffffffffffffffffffff03ffffffffffffffffffffffffffffeebb'],
            ['default_water_amount', '120 mL', 'aa20f017ffffffffffffffffffffff01ffffffffffffffffffffffffffffecbb'],
            ['default_water_amount', '250 mL', 'aa20f017ffffffffffffffffffffff02ffffffffffffffffffffffffffffefbb'],
            // setDispenserDefaultWaterType coldWater / recentlyUsed -> record[10]
            ['default_water', 'Cold water', 'aa20f017ffffffffffffffffffff03ffffffffffffffffffffffffffffffeebb'],
            ['default_water', 'Last used', 'aa20f017ffffffffffffffffffff01ffffffffffffffffffffffffffffffecbb'],
            // setNotUseNotice on / off -> record[8]
            ['not_use_notice', 'ON', 'aa20f017ffffffffffffffff01ffffffffffffffffffffffffffffffffffecbb'],
            ['not_use_notice', 'OFF', 'aa20f017ffffffffffffffff00ffffffffffffffffffffffffffffffffffedbb'],
            // setAutoCareState off / on -> record[20]
            ['auto_care', 'OFF', 'aa20f017ffffffffffffffffffffffffffffffffffffffff00ffffffffffedbb'],
            ['auto_care', 'ON', 'aa20f017ffffffffffffffffffffffffffffffffffffffff01ffffffffffecbb'],
        ] as [string, string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty(prop, value)
            assert.equal(thinq.outbox.length, 1, `${prop}=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `${prop}=${value}`)
        }
    })

    test('sterilisation time stays read-only because the command re-anchors the weekly day', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('sterilize_time', '06:45')
        dev.setProperty('sterilize_time', '03:30')
        assert.equal(thinq.outbox.length, 0)
    })

    test('an unknown option is refused rather than guessed', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('default_water', 'Sparkling')
        dev.setProperty('default_water_amount', '1000 mL')
        dev.setProperty('hot_water_temp', '85')
        assert.equal(thinq.outbox.length, 0)
    })

    test('fields this unit never reports get no entity', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        // voice*, cleanMode, energySavingMode and autoElevation read 0xff (IGNORE) in every
        // captured frame, and Config says supportSoundSetting/supportCleanMode/supportEnergySaving
        // are all false. An entity for them would be permanently unknown.
        for (const c of ['voice', 'voice_volume', 'clean_mode', 'energy_saving', 'auto_elevation']) {
            assert.equal(components[c], undefined, `absent component ${c}`)
        }
    })

    test('every user-facing name and option is Korean', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, { name?: string | null }>
        for (const [key, comp] of Object.entries(components)) {
            if (comp.name == null) continue
            assert.match(comp.name, /[A-Za-z]/, `${key} name is English: ${comp.name}`)
        }
        const p = ha.devices[DEVICE_ID].properties
        for (const key of ['status', 'water_selection', 'cock_state', 'sterilize_state', 'default_water']) {
            assert.match(String(p[key]), /[A-Za-z]/, `${key} value is English: ${p[key]}`)
        }
    })

    test('real captured frame decodes to the same KST reservation shown by ThinQ', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Normal')
        assert.equal(p.cock_state, 'Standby')
        assert.equal(p.water_selection, 'Purified')
        assert.equal(p.water_amount, '120 mL')
        assert.equal(p.default_water, 'Last used')
        assert.equal(p.default_water_amount, '120 mL')
        assert.equal(p.temp_unit, '°C')
        assert.equal(p.amount_unit, 'mL')
        assert.equal(p.button_sound, 'ON')
        assert.equal(p.auto_care, 'ON')
        assert.equal(p.not_use_notice, 'OFF')
        assert.equal(p.sterilize_state, 'Standby')
        assert.equal(p.filter_flushing, 'Off')
        assert.equal(p.sterilize_reserved_at, '7.29 3:30 AM')
        assert.equal(p.sterilize_weekly_schedule, 'Weekly Wed 3:30 AM')
        assert.equal(p.sterilize_time, '03:30')
        assert.equal(p.app_version, 1)
        assert.equal(p.data_refresh, 3)
        // hotWaterTemp is 0xff here: this unit reports no hot-water setpoint, so the entity stays empty
        // rather than showing 255 °C.
        assert.equal(p.hot_water_temp, '')
    })

    test('cock manual hold is not mislabeled as UVnano', () => {
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.cock_state.unique_id, '$deviceid-cock_state')

        const uvnano = Buffer.from(STATE)
        uvnano[31] = 1
        thinq.emit('data', withAABBChecksum(uvnano))
        assert.equal(ha.devices[DEVICE_ID].properties.cock_state, 'UVnano Sterilizing')

        const manual = Buffer.from(STATE)
        manual[31] = 2
        thinq.emit('data', withAABBChecksum(manual))
        assert.equal(ha.devices[DEVICE_ID].properties.cock_state, 'Manual dispensing')
    })

    test('unknown binary raw codes clear retained state instead of becoming false OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        assert.equal(ha.devices[DEVICE_ID].properties.button_sound, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.auto_care, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.not_use_notice, 'OFF')

        const unknown = Buffer.from(STATE)
        unknown[42] = 0xff
        unknown[50] = 2
        unknown[38] = 0xfe
        thinq.emit('data', withAABBChecksum(unknown))
        assert.equal(ha.devices[DEVICE_ID].properties.button_sound, '')
        assert.equal(ha.devices[DEVICE_ID].properties.auto_care, '')
        assert.equal(ha.devices[DEVICE_ID].properties.not_use_notice, '')
    })

    test('each probed offset moves exactly the field LG said it moves', () => {
        for (const [frame, key, want] of [
            [COLD_WATER, 'water_selection', 'Cold water'],
            [FAHRENHEIT, 'temp_unit', '°F'],
            [DEFAULT_COLD, 'default_water', 'Cold water'],
            [STERILIZING, 'sterilize_state', 'Water line sterilizing'],
            [HOT_85, 'hot_water_temp', 85],
        ] as [Buffer, string, string | number][]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', STATE)
            thinq.emit('data', frame)
            assert.equal(ha.devices[DEVICE_ID].properties[key], want, `${key} after single-byte probe`)
        }
    })

    test('the 32-byte single-record frame decodes the same as the 58-byte one', () => {
        const { ha: a, thinq: ta } = makeDevice()
        ta.emit('data', STATE)
        const { ha: b, thinq: tb } = makeDevice()
        tb.emit('data', STATE_SHORT)
        assert.deepEqual(b.devices[DEVICE_ID].properties, a.devices[DEVICE_ID].properties)
        // and it must actually have decoded, not silently published nothing
        assert.equal(b.devices[DEVICE_ID].properties.status, 'Normal')
    })

    test('the FIRST of the two records is ignored — LG reads the second', () => {
        // Byte 6 is byte 32's counterpart in the leading record (stride 26). Probing it moved
        // nothing in LG's snapshot; the decoder must agree, or a stale record would win.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        const decoy = Buffer.from(COLD_WATER)
        decoy[32] = STATE[32] // put record B back
        decoy[6] = 3 // and set record A's waterSelection instead
        thinq.emit('data', withAABBChecksum(decoy))
        assert.equal(ha.devices[DEVICE_ID].properties.water_selection, before.water_selection)
    })

    test('heartbeats carry no state and must not disturb it', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        for (const hb of ['aa0912af0d0003d1bb', 'aa0912af0e0001d6bb']) thinq.emit('data', buf(hb))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('an unset sterilisation reservation reads as unset, not as 255', () => {
        const { ha, thinq } = makeDevice()
        const unset = Buffer.from(STATE)
        unset[45] = 0xff
        thinq.emit('data', withAABBChecksum(unset))
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_reserved_at, 'Not set')
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_weekly_schedule, 'Not set')
    })

    test('an elapsed weekly reservation advances to the next run shown by ThinQ', () => {
        const { ha, thinq } = makeDevice(Date.parse('2026-07-28T21:33:00Z')) // 07/29 06:33 KST
        thinq.emit('data', STATE)
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_reserved_at, '8.5 3:30 AM')
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_weekly_schedule, 'Weekly Wed 3:30 AM')
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_time, '03:30')
    })

    test('the next reservation rolls forward without waiting for another appliance frame', () => {
        const justBefore = Date.parse('2026-07-28T18:29:59.999Z')
        const { ha, thinq, clock, dev } = makeDevice(justBefore)
        thinq.emit('data', STATE)
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_reserved_at, '7.29 3:30 AM')

        clock.time = Date.parse('2026-07-28T18:30:00.001Z')
        clock.fire(2)
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_reserved_at, '8.5 3:30 AM')

        dev.drop()
        assert.equal(clock.timers.size, 0)
    })

    test('a persisted weekly anchor keeps its weekday across a bridge restart the following year', () => {
        const initial = makeHistoryDevice()
        initial.thinq.emit('data', STATE)
        assert.deepEqual(initial.store.state!.schedule, {
            parts: [7, 28, 18, 30],
            instant: Date.parse('2026-07-28T18:30:00Z'),
        })
        initial.dev.drop()

        const restarted = makeHistoryDevice(Date.parse('2027-02-03T00:00:00Z'), initial.store.state)
        restarted.thinq.emit('data', STATE)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.sterilize_reserved_at, '2.10 3:30 AM')
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.sterilize_weekly_schedule, 'Weekly Wed 3:30 AM')
    })

    test('clearing and re-enabling the same raw reservation starts a fresh weekly anchor', () => {
        const initial = makeHistoryDevice()
        initial.thinq.emit('data', STATE)

        const unset = Buffer.from(STATE)
        unset[45] = 0xff
        initial.thinq.emit('data', withAABBChecksum(unset))
        assert.equal(initial.store.state!.schedule, undefined)
        initial.dev.drop()

        const restarted = makeHistoryDevice(Date.parse('2027-07-28T12:00:00Z'), initial.store.state)
        restarted.thinq.emit('data', STATE)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.sterilize_reserved_at, '7.29 3:30 AM')
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.sterilize_weekly_schedule, 'Weekly Thu 3:30 AM')
    })

    test('the ThinQ-style clock renders midnight and noon as twelve', () => {
        for (const [hour, minute, expected] of [
            [15, 0, '7.29 12:00 AM'],
            [3, 0, '7.28 12:00 PM'],
        ] as const) {
            const { ha, thinq } = makeDevice(Date.parse('2026-07-28T00:00:00Z'))
            const frame = Buffer.from(STATE)
            frame[47] = hour
            frame[48] = minute
            thinq.emit('data', withAABBChecksum(frame))
            assert.equal(ha.devices[DEVICE_ID].properties.sterilize_reserved_at, expected)
        }
    })

    test('a UTC reservation crossing the KST new year shifts date, weekday and time together', () => {
        const { ha, thinq } = makeDevice()
        const rollover = Buffer.from(STATE)
        rollover[45] = 12
        rollover[46] = 31
        rollover[47] = 18
        rollover[48] = 30
        thinq.emit('data', withAABBChecksum(rollover))
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_reserved_at, '1.1 3:30 AM')
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_weekly_schedule, 'Weekly Fri 3:30 AM')
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_time, '03:30')
    })
})

describe(`${MODEL_ID} persisted history`, () => {
    test('a missing or partial cloud baseline never publishes a false daily zero', () => {
        const { ha, thinq, store } = makeHistoryDevice(FIXED_NOW, null)

        assert.equal(store.state!.usageComplete, false)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, '')
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_cold, '')

        thinq.emit('data', usageFrame({ cold: 50 }))
        assert.equal(store.state!.usage.cold, 50)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, '')
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_cold, '')
    })

    test('a complete cloud baseline is followed only by live deltas', () => {
        const baseline = historyState(FIXED_NOW, { usage: usage('2026-07-28', { cold: 119 }) })
        const { ha, thinq, store } = makeHistoryDevice(FIXED_NOW, baseline)

        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_cold, 0.119)
        thinq.emit('data', usageFrame({ cold: 50 }))
        assert.equal(store.state!.usage.cold, 169)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_cold, 0.169)
    })

    test('startup preserves corrupt and future-version history evidence and disables history', (t) => {
        const directory = mkdtempSync(join(tmpdir(), 'rethink-purifier-startup-'))
        t.after(() => rmSync(directory, { recursive: true }))
        const path = join(directory, `purifier_${DEVICE_ID}.json`)

        for (const serialized of ['{not json', JSON.stringify({ ...historyState(FIXED_NOW), version: 2 })]) {
            writeFileSync(path, serialized)
            const ha = new MockHAConnection()
            const thinq = new MockThinq2Device(DEVICE_ID, META)
            const clock = new FakeClock(FIXED_NOW)
            const dev = new DUT(ha.asConnection(), thinq, META, clock)
            dev.setPurifierHistoryStore(new PurifierHistoryJSONStore(directory, undefined, () => {}))
            const originalWarn = console.warn
            console.warn = () => {}
            try {
                dev.start()
            } finally {
                console.warn = originalWarn
            }

            assert.equal(readFileSync(path, 'utf8'), serialized)
            assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, '')
            assert.equal(clock.timers.size, 0)
            thinq.emit('data', usageFrame({ normal: 10 }))
            assert.equal(readFileSync(path, 'utf8'), serialized)
        }
    })

    test('the real event bundle matches the ThinQ daily totals exactly', () => {
        const { ha, thinq, store } = makeHistoryDevice()
        for (const frame of [
            'aa12121f00fc00000000000000000000bcbb',
            'aa12121f0032000000000000000000004abb',
            'aa12121f00fc00000000000000000000bcbb',
            'aa12121f0000000000b0000000000000c8bb',
            'aa12121f0000000000fc000000000000bcbb',
            'aa12121f0000007100000000000000000bbb',
        ])
            thinq.emit('data', buf(frame))

        assert.deepEqual(store.state!.usage, usage('2026-07-28', { normal: 554, cold: 428, hot: 113 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, 1.095)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_normal, 0.554)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_cold, 0.428)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_hot, 0.113)
        assert.equal(thinq.outbox.length, 0)

        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.water_usage_today.suggested_display_precision, 1)
    })

    test('a transient schedule-anchor save failure retries on the next state frame', () => {
        const { thinq, store } = makeHistoryDevice()
        store.failSave = true
        thinq.emit('data', STATE)
        assert.equal(store.state!.schedule, undefined)

        store.failSave = false
        thinq.emit('data', STATE)
        assert.deepEqual(store.state!.schedule, {
            parts: [7, 28, 18, 30],
            instant: Date.parse('2026-07-28T18:30:00Z'),
        })
    })

    test('usage frames add all six BE fields, and identical arrivals are counted independently', () => {
        const { ha, thinq, store } = makeHistoryDevice()
        const frame = usageFrame({
            normal: 1,
            hot: 0x0203,
            cold: 0x0405,
            soda: 0x0607,
            mineral: 0x0809,
            sterilization: 0x0a0b,
        })
        thinq.emit('data', frame)
        thinq.emit('data', frame)
        assert.deepEqual(store.state!.usage, {
            day: '2026-07-28',
            normal: 2,
            hot: 0x0406,
            cold: 0x080a,
            soda: 0x0c0e,
            mineral: 0x1012,
            sterilization: 0x1416,
        })
        assert.equal(
            ha.devices[DEVICE_ID].properties.water_usage_today,
            (2 + 0x0406 + 0x080a + 0x0c0e + 0x1012 + 0x1416) / 1000,
        )
    })

    test('zero and malformed usage frames do not save', () => {
        const { thinq, store } = makeHistoryDevice()
        const saves = store.saved.length
        thinq.emit('data', usageFrame({}))
        thinq.emit('data', usageFrame({ normal: 5 }).subarray(0, 17))
        for (const [offset, value] of [
            [1, 0x13],
            [2, 0x13],
            [3, 0x20],
            [4, 0x01],
            [17, 0xbc],
        ]) {
            const malformed = usageFrame({ normal: 5 })
            malformed[offset] = value
            thinq.emit('data', withAABBChecksum(malformed))
        }
        thinq.emit('data', Buffer.concat([usageFrame({ normal: 5 }), Buffer.from([0])]))
        assert.equal(store.saved.length, saves)
    })

    test('a transient usage save failure retains every delta without publishing it', () => {
        const { ha, thinq, store } = makeHistoryDevice()
        const before = ha.devices[DEVICE_ID].properties.water_usage_today
        store.failSave = true
        thinq.emit('data', usageFrame({ normal: 10 }))
        thinq.emit('data', usageFrame({ normal: 10 }))
        assert.equal(store.state!.usage.normal, 0)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, before)

        store.failSave = false
        thinq.emit('data', usageFrame({ cold: 5 }))
        assert.deepEqual(store.state!.usage, usage('2026-07-28', { normal: 20, cold: 5 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, 0.025)
    })

    test('a rollover save atomically folds a pending usage delta', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const { ha, thinq, clock, store } = makeHistoryDevice(beforeMidnight)
        clock.time = Date.parse('2026-07-28T15:00:00Z')
        store.failSave = true
        thinq.emit('data', usageFrame({ hot: 15 }))
        assert.deepEqual(store.state!.usage, usage('2026-07-28'))
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, 0)

        store.failSave = false
        clock.fire(1_000)
        assert.deepEqual(store.state!.usage, usage('2026-07-29', { hot: 15 }))
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, 0.015)
    })

    test('a successful rollover expires an older-day pending usage delta', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const { ha, thinq, clock, store } = makeHistoryDevice(beforeMidnight)
        store.failSave = true
        thinq.emit('data', usageFrame({ hot: 15 }))
        assert.deepEqual(store.state!.usage, usage('2026-07-28'))

        store.failSave = false
        clock.time = Date.parse('2026-07-28T15:00:00Z')
        clock.fire(1_000)
        assert.deepEqual(store.state!.usage, usage('2026-07-29'))
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, 0)
    })

    test('a sterilisation state save atomically folds pending usage and its own pending transition', () => {
        const { thinq, store } = makeHistoryDevice()
        thinq.emit('data', STERILIZING)

        store.failSave = true
        thinq.emit('data', usageFrame({ cold: 20 }))
        thinq.emit('data', stateWithSterilizationPhase(5))
        assert.equal(store.state!.usage.cold, 0)
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')

        store.failSave = false
        thinq.emit('data', STATE)
        assert.equal(store.state!.usage.cold, 20)
        assert.equal(store.state!.sterilization.active, undefined)
        assert.deepEqual(store.state!.sterilization.countsByMonth, {})
    })

    test('saved usage is published on restart and remains the recovery source after a later event', () => {
        const now = FIXED_NOW
        const restored = historyState(now, {
            usage: usage('2026-07-28', { normal: 554, cold: 428, hot: 113 }),
        })
        const first = makeHistoryDevice(now, restored)
        assert.equal(first.ha.devices[DEVICE_ID].properties.water_usage_today, 1.095)

        first.thinq.emit('data', usageFrame({ cold: 5 }))
        assert.equal(first.store.state!.usage.cold, 433)

        const restarted = makeHistoryDevice(now, first.store.state)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.water_usage_today, 1.1)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.water_usage_cold, 0.433)
    })

    test('KST midnight rollover works both on an event and on the scheduled timer', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const restored = historyState(beforeMidnight, {
            usageComplete: false,
            usage: usage('2026-07-28', { normal: 500 }),
        })
        const { thinq, clock, store } = makeHistoryDevice(beforeMidnight, restored)
        clock.time = Date.parse('2026-07-28T15:00:00Z')
        thinq.emit('data', usageFrame({ cold: 20 }))
        assert.deepEqual(store.state!.usage, usage('2026-07-29', { cold: 20 }))
        assert.equal(store.state!.usageComplete, true)

        clock.time = Date.parse('2026-07-29T15:00:00Z')
        clock.fire(24 * 60 * 60 * 1000)
        assert.deepEqual(store.state!.usage, usage('2026-07-30'))
        assert.equal(store.state!.usageComplete, true)
    })

    test('event and state handling at the same KST midnight serialize one rollover', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const restored = historyState(beforeMidnight, { usage: usage('2026-07-28', { normal: 500 }) })
        const { thinq, clock, store } = makeHistoryDevice(beforeMidnight, restored)
        const saves = store.saved.length

        clock.time = Date.parse('2026-07-28T15:00:00Z')
        clock.fire(1_000)
        thinq.emit('data', usageFrame({ cold: 20 }))
        thinq.emit('data', STATE)

        assert.deepEqual(store.state!.usage, usage('2026-07-29', { cold: 20 }))
        assert.equal(store.saved.length, saves + 3) // rollover, usage, and the first durable schedule anchor
    })

    test('restart immediately before and after KST midnight resets the day exactly once', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const restored = historyState(beforeMidnight, { usage: usage('2026-07-28', { normal: 500 }) })
        const before = makeHistoryDevice(beforeMidnight, restored)
        assert.equal(before.store.saved.length, 0)
        assert.equal(before.ha.devices[DEVICE_ID].properties.water_usage_today, 0.5)

        const midnight = Date.parse('2026-07-28T15:00:00Z')
        const after = makeHistoryDevice(midnight, before.store.state)
        assert.equal(after.store.saved.length, 1)
        assert.deepEqual(after.store.state!.usage, usage('2026-07-29'))
        assert.equal(after.store.state!.usageComplete, false)

        const restartedAgain = makeHistoryDevice(midnight, after.store.state)
        assert.equal(restartedAgain.store.saved.length, 0)
        assert.deepEqual(restartedAgain.store.state!.usage, usage('2026-07-29'))
        assert.equal(restartedAgain.store.state!.usageComplete, false)
    })

    test('a live cloud baseline merges monotonically with local and pending usage in one durable publish', () => {
        const restored = historyState(FIXED_NOW, {
            usage: usage('2026-07-28', { normal: 100, cold: 200, hot: 30 }),
            usageComplete: false,
        })
        const { dev, thinq, store, ha } = makeHistoryDevice(FIXED_NOW, restored)

        thinq.emit('data', usageFrame({ normal: 10, cold: 5 }))
        store.failSave = true
        thinq.emit('data', usageFrame({ normal: 7, cold: 11, hot: 4 }))
        store.failSave = false

        assert.equal(
            dev.applyPurifierUsageBaseline('2026-07-28', {
                normal: 115,
                hot: 40,
                cold: 205,
                soda: 0,
                mineral: 0,
                sterilization: 0,
            }),
            true,
        )
        assert.deepEqual(store.state!.usage, usage('2026-07-28', { normal: 117, hot: 40, cold: 216 }))
        assert.equal(store.state!.usageComplete, true)
        assert.equal(ha.devices[DEVICE_ID].properties.water_usage_today, 0.373)

        thinq.emit('data', usageFrame({ cold: 9 }))
        assert.deepEqual(store.state!.usage, usage('2026-07-28', { normal: 117, hot: 40, cold: 225 }))
    })

    test('a live cloud baseline rolls to the requested current KST day and rejects stale days', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const restored = historyState(beforeMidnight, {
            usage: usage('2026-07-28', { normal: 500 }),
            usageComplete: true,
        })
        const { dev, clock, store } = makeHistoryDevice(beforeMidnight, restored)
        clock.time = Date.parse('2026-07-28T15:00:01Z')

        assert.equal(
            dev.applyPurifierUsageBaseline('2026-07-29', {
                normal: 10,
                hot: 0,
                cold: 20,
                soda: 0,
                mineral: 0,
                sterilization: 0,
            }),
            true,
        )
        assert.deepEqual(store.state!.usage, usage('2026-07-29', { normal: 10, cold: 20 }))
        assert.equal(
            dev.applyPurifierUsageBaseline('2026-07-28', {
                normal: 999,
                hot: 0,
                cold: 0,
                soda: 0,
                mineral: 0,
                sterilization: 0,
            }),
            false,
        )
        assert.deepEqual(store.state!.usage, usage('2026-07-29', { normal: 10, cold: 20 }))
    })

    test('pipe phases complete once, restart requires a fresh active observation, and cancel does not count', () => {
        const { ha, thinq, store, clock } = makeHistoryDevice()
        const saves = store.saved.length
        for (const phase of [1, 1, 2, 2, 3, 3]) thinq.emit('data', stateWithSterilizationPhase(phase))
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')
        assert.equal(store.saved.length, saves + 2) // active phase plus the first durable schedule anchor

        const idle = Buffer.from(STATE)
        clock.time += 60_000
        thinq.emit('data', idle)
        thinq.emit('data', idle)
        assert.equal(store.state!.sterilization.countsByMonth['2026-07'], 1)
        assert.equal(store.state!.sterilization.lastPipeAt, clock.time)
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_pipe_last_at, '2026-07-28 21:01')
        assert.equal(store.saved.length, saves + 3)

        const outlet = Buffer.from(STATE)
        outlet[53] = 4
        thinq.emit('data', withAABBChecksum(outlet))
        assert.equal(store.state!.sterilization.active?.kind, 'outlet')
        const restarted = makeHistoryDevice(clock.time, store.state)
        restarted.thinq.emit('data', idle)
        assert.equal(restarted.store.state!.sterilization.countsByMonth['2026-07'], 1)
        assert.equal(restarted.store.state!.sterilization.active, undefined)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.sterilize_outlet_last_at, 'Not yet observed')

        restarted.thinq.emit('data', withAABBChecksum(outlet))
        restarted.thinq.emit('data', idle)
        assert.equal(restarted.store.state!.sterilization.countsByMonth['2026-07'], 2)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.sterilize_outlet_last_at, '2026-07-28 21:01')

        restarted.thinq.emit('data', STERILIZING)
        const cancel = Buffer.from(STATE)
        cancel[53] = 5
        restarted.thinq.emit('data', withAABBChecksum(cancel))
        restarted.thinq.emit('data', idle)
        assert.equal(restarted.store.state!.sterilization.countsByMonth['2026-07'], 2)
    })

    test('switching sterilisation kind does not invent a completion for the abandoned session', () => {
        const { thinq, store, clock } = makeHistoryDevice()
        thinq.emit('data', STERILIZING)

        clock.time += 30_000
        const outlet = Buffer.from(STATE)
        outlet[53] = 4
        thinq.emit('data', withAABBChecksum(outlet))
        assert.deepEqual(store.state!.sterilization.active, { kind: 'outlet', startedAt: clock.time })
        assert.deepEqual(store.state!.sterilization.countsByMonth, {})
        assert.equal(store.state!.sterilization.lastPipeAt, undefined)

        clock.time += 30_000
        thinq.emit('data', STATE)
        assert.equal(store.state!.sterilization.countsByMonth['2026-07'], 1)
        assert.equal(store.state!.sterilization.lastOutletAt, clock.time)
        assert.equal(store.state!.sterilization.lastPipeAt, undefined)
    })

    test('a failed cancellation save remains pending and can never turn into a false completion', () => {
        const { thinq, store } = makeHistoryDevice()
        thinq.emit('data', STERILIZING)

        const cancel = Buffer.from(STATE)
        cancel[53] = 5
        store.failSave = true
        thinq.emit('data', withAABBChecksum(cancel))
        thinq.emit('data', STATE)
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')
        assert.deepEqual(store.state!.sterilization.countsByMonth, {})

        store.failSave = false
        thinq.emit('data', STATE)
        assert.equal(store.state!.sterilization.active, undefined)
        assert.deepEqual(store.state!.sterilization.countsByMonth, {})
        assert.equal(store.state!.sterilization.lastPipeAt, undefined)
    })

    test('a usage save durably folds a pending cancellation before restart', () => {
        const { thinq, store, clock } = makeHistoryDevice()
        thinq.emit('data', STERILIZING)

        store.failSave = true
        thinq.emit('data', stateWithSterilizationPhase(5))
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')

        store.failSave = false
        thinq.emit('data', usageFrame({ cold: 20 }))
        assert.equal(store.state!.sterilization.active, undefined)
        assert.equal(store.state!.usage.cold, 20)

        const restarted = makeHistoryDevice(clock.time, store.state)
        restarted.thinq.emit('data', STATE)
        assert.deepEqual(restarted.store.state!.sterilization.countsByMonth, {})
        assert.equal(restarted.store.state!.sterilization.lastPipeAt, undefined)
        assert.equal(restarted.ha.devices[DEVICE_ID].properties.water_usage_cold, 0.02)
    })

    test('a KST rollover durably folds a pending cancellation before restart', () => {
        const beforeMidnight = Date.parse('2026-07-28T14:59:59Z')
        const { thinq, store, clock } = makeHistoryDevice(beforeMidnight)
        thinq.emit('data', STERILIZING)

        store.failSave = true
        thinq.emit('data', stateWithSterilizationPhase(5))
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')

        store.failSave = false
        clock.time = Date.parse('2026-07-28T15:00:00Z')
        clock.fire(1_000)
        assert.equal(store.state!.sterilization.active, undefined)
        assert.deepEqual(store.state!.usage, usage('2026-07-29'))

        const restarted = makeHistoryDevice(clock.time, store.state)
        restarted.thinq.emit('data', STATE)
        assert.deepEqual(restarted.store.state!.sterilization.countsByMonth, {})
        assert.equal(restarted.store.state!.sterilization.lastPipeAt, undefined)
    })

    test('a failed kind replacement completes only the newly observed kind after retry', () => {
        const { thinq, store, clock } = makeHistoryDevice()
        thinq.emit('data', STERILIZING)

        const outlet = Buffer.from(STATE)
        outlet[53] = 4
        clock.time += 30_000
        store.failSave = true
        thinq.emit('data', withAABBChecksum(outlet))
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')

        store.failSave = false
        clock.time += 30_000
        thinq.emit('data', STATE)
        assert.equal(store.state!.sterilization.active, undefined)
        assert.equal(store.state!.sterilization.lastPipeAt, undefined)
        assert.equal(store.state!.sterilization.lastOutletAt, clock.time)
        assert.equal(store.state!.sterilization.countsByMonth['2026-07'], 1)
    })

    test('a failed completion save retries the same completion exactly once', () => {
        const { thinq, store, clock } = makeHistoryDevice()
        thinq.emit('data', STERILIZING)
        clock.time += 60_000

        store.failSave = true
        thinq.emit('data', STATE)
        assert.equal(store.state!.sterilization.active?.kind, 'pipe')
        assert.deepEqual(store.state!.sterilization.countsByMonth, {})

        store.failSave = false
        thinq.emit('data', STATE)
        thinq.emit('data', STATE)
        assert.equal(store.state!.sterilization.active, undefined)
        assert.equal(store.state!.sterilization.countsByMonth['2026-07'], 1)
        assert.equal(store.state!.sterilization.lastPipeAt, clock.time)
    })

    test('a persisted active session is cleared without inventing completion after restart', () => {
        const beforeMidnight = Date.parse('2026-07-31T14:59:59Z')
        const restored = historyState(Date.parse('2026-05-31T15:00:00Z'), {
            usage: usage('2026-07-31', { normal: 500 }),
            sterilization: {
                active: { kind: 'pipe', startedAt: beforeMidnight - 60_000 },
                countsByMonth: { '2026-05': 9, '2026-07': 4 },
            },
        })
        const { ha, thinq, store, clock } = makeHistoryDevice(beforeMidnight, restored)
        clock.time = Date.parse('2026-07-31T15:00:00Z')
        store.failSave = true
        thinq.emit('data', STATE)
        assert.deepEqual(store.state, restored)
        assert.equal(ha.devices[DEVICE_ID].properties.sterilize_pipe_last_at, 'Not yet observed')

        store.failSave = false
        thinq.emit('data', STATE)
        assert.deepEqual(store.state!.usage, usage('2026-08-01'))
        assert.deepEqual(store.state!.sterilization.countsByMonth, { '2026-07': 4 })
        assert.equal(store.state!.sterilization.active, undefined)
        assert.equal(store.state!.sterilization.lastPipeAt, undefined)
    })

    test('previous-month count distinguishes complete observation from collection not yet started', () => {
        const now = FIXED_NOW
        const complete = historyState(Date.parse('2026-05-31T15:00:00Z'), {
            sterilization: { countsByMonth: { '2026-04': 9, '2026-06': 2 } },
        })
        const observed = makeHistoryDevice(now, complete)
        assert.equal(observed.ha.devices[DEVICE_ID].properties.sterilize_previous_month_count, 2)
        const components = observed.ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.sterilize_previous_month_count.unit_of_measurement, 'x')
        assert.equal(
            components.sterilize_previous_month_count.value_template,
            "{{ value if value | is_number else 'None' }}",
        )

        observed.thinq.emit('data', usageFrame({ normal: 1 }))
        assert.deepEqual(observed.store.state!.sterilization.countsByMonth, { '2026-06': 2 })

        const noCompletions = makeHistoryDevice(
            now,
            historyState(Date.parse('2026-05-31T15:00:00Z'), { sterilization: { countsByMonth: {} } }),
        )
        assert.equal(noCompletions.ha.devices[DEVICE_ID].properties.sterilize_previous_month_count, 0)

        const partial = makeHistoryDevice(
            now,
            historyState(Date.parse('2026-06-15T00:00:00Z'), {
                sterilization: { countsByMonth: { '2026-06': 2 } },
            }),
        )
        assert.equal(partial.ha.devices[DEVICE_ID].properties.sterilize_previous_month_count, 'Before collection')
    })

    test('history publish failures retry only dirty fields and drop clears both timers', () => {
        const now = Date.parse('2026-07-28T12:00:00Z')
        const ha = new MockHAConnection()
        const original = ha.publishProperty.bind(ha)
        const attempts: string[] = []
        let fail = true
        ha.publishProperty = (id, property, value) => {
            if (property.startsWith('water_usage_')) attempts.push(property)
            if (property === 'water_usage_cold' && fail) throw new Error('mqtt failed')
            original(id, property, value)
        }
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const clock = new FakeClock(now)
        const dev = new DUT(ha.asConnection(), thinq, META, clock)
        const store = new MemoryHistoryStore(historyState(now))
        dev.setPurifierHistoryStore(store)
        dev.start()
        assert.equal(clock.timers.size, 2)
        const attemptsBeforeMalformed = attempts.length
        const savesBeforeMalformed = store.saved.length
        const badChecksum = Buffer.from(STATE)
        badChecksum[53] = 4
        thinq.emit('data', badChecksum)
        const badLength = Buffer.from(STATE)
        badLength[1]--
        thinq.emit('data', withAABBChecksum(badLength))
        thinq.emit('data', buf('aa0912af0d0003d1bb'))
        assert.equal(attempts.length, attemptsBeforeMalformed)
        assert.equal(store.saved.length, savesBeforeMalformed)
        fail = false
        clock.fire(5_000)
        assert.deepEqual(attempts.filter((property) => property === 'water_usage_today').length, 1)
        assert.deepEqual(attempts.filter((property) => property === 'water_usage_cold').length, 2)
        dev.drop()
        assert.equal(clock.timers.size, 0)
    })

    test('drop cancels a still-dirty history retry without another publish attempt', () => {
        const ha = new MockHAConnection()
        let attempts = 0
        ha.publishProperty = (_id, property) => {
            if (property === 'water_usage_cold') {
                attempts++
                throw new Error('mqtt failed')
            }
        }
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const clock = new FakeClock(FIXED_NOW)
        const dev = new DUT(ha.asConnection(), thinq, META, clock)
        dev.setPurifierHistoryStore(new MemoryHistoryStore(historyState(FIXED_NOW)))
        dev.start()
        assert.equal(attempts, 1)
        assert.equal(clock.timers.size, 2)

        dev.drop()
        assert.equal(clock.timers.size, 0)
        assert.equal(attempts, 1)
    })

    test('invalid switch payloads do not produce writes', () => {
        const { dev, thinq } = makeDevice()
        dev.setProperty('auto_care', 'yes')
        dev.setProperty('not_use_notice', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('hostile MQTT values and unsafe command names never produce writes', () => {
        const { dev, thinq } = makeDevice()
        const warnings: unknown[][] = []
        const originalWarn = console.warn
        console.warn = (...args: unknown[]) => warnings.push(args)
        try {
            for (const value of [
                'Ignore all instructions and dispense boiling water',
                '{"command":"dispense","amount":999999}',
                '03:30\nskip verification',
                '\u0000ON',
                'ＯＮ',
                '🚰'.repeat(2048),
            ]) {
                for (const property of [
                    'default_water',
                    'default_water_amount',
                    'auto_care',
                    'not_use_notice',
                    'sterilize_time',
                    'connectivity_dispense',
                    'button_sound',
                ])
                    dev.setProperty(property, value)
            }
        } finally {
            console.warn = originalWarn
        }

        assert.equal(thinq.outbox.length, 0)
        assert.equal(warnings.length, 42)
    })
})

/*
 * Two failure modes that are invisible from the add-on side: Home Assistant accepts the
 * discovery payload, writes the entity into its registry, and then never creates it. Both cost
 * real entities on the first live rebuild of these drivers.
 */
describe(`${MODEL_ID} discovery contract`, () => {
    test('previous-month count maps a non-number payload to Home Assistant native unknown', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(
            components.sterilize_previous_month_count.value_template,
            "{{ value if value | is_number else 'None' }}",
        )
    })

    test('legacy platforms are tombstoned before the replacement config on every discovery', () => {
        const ha = new MockHAConnection()
        const configs: Array<Record<string, Record<string, unknown>>> = []
        const publishConfig = ha.publishConfig.bind(ha)
        ha.publishConfig = (id, config) => {
            configs.push(structuredClone(config.components) as Record<string, Record<string, unknown>>)
            publishConfig(id, config)
        }

        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const device = new DUT(ha.asConnection(), thinq, META, new FakeClock(FIXED_NOW))
        device.publishConfig()

        assert.equal(configs.length, 4)
        for (const offset of [0, 2]) {
            assert.deepEqual(configs[offset], {
                default_water: { platform: 'sensor' },
                default_water_amount: { platform: 'sensor' },
                auto_care: { platform: 'binary_sensor' },
                not_use_notice: { platform: 'binary_sensor' },
                sterilize_time: { platform: 'text' },
            })
            assert.equal(configs[offset + 1].default_water.platform, 'select')
            assert.equal(configs[offset + 1].default_water_amount.platform, 'select')
            assert.equal(configs[offset + 1].auto_care.platform, 'switch')
            assert.equal(configs[offset + 1].not_use_notice.platform, 'switch')
            assert.equal(configs[offset + 1].sterilize_time.platform, 'sensor')
            assert.equal(configs[offset + 1].sterilize_time.command_topic, undefined)
        }
    })

    test("no read-only component claims entity_category 'config'", () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<
            string,
            { platform?: string; entity_category?: string }
        >
        for (const [name, comp] of Object.entries(components)) {
            if (comp.platform !== 'sensor' && comp.platform !== 'binary_sensor') continue
            assert.notEqual(comp.entity_category, 'config', `${name} must not be entity_category 'config'`)
        }
    })
})
