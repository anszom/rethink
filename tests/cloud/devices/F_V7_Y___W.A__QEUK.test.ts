import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import DUT from '@/cloud/devices/F_V7_Y___W.A__QEUK'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const ID = 'test-washer'
const META: Metadata = { modelId: 'F_V7_Y___W.A__QEUK', modelName: 'WV5-1275W', swVersion: 'test' }
type Event = { ms: number; packet?: string; direction?: string; type?: string; lg?: Record<string, string | number> }
function fixture(name: string): Event[] {
    return JSON.parse(readFileSync(new URL(`../../fixtures/F_V7_Y___W.A__QEUK/${name}.json`, import.meta.url), 'utf8'))
}
function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, META)
    const device = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, device, properties: ha.devices[ID].properties }
}
function receive(device: DUT, event: Event) {
    if (event.packet && event.direction !== 'toDevice') device.processData(Buffer.from(event.packet, 'hex'))
}

const cloudLabels: Record<string, string> = {
    POWEROFF: 'Off',
    INITIAL: 'Standby',
    DETECTING: 'Measuring',
    RUNNING: 'Washing',
    RINSING: 'Rinsing',
    SPINNING: 'Spinning',
    END: 'Finished',
    PAUSE: 'Paused',
    RESERVED: 'Delayed',
    COTTON: 'Cotton',
    EASYCARE: 'Easy Care',
    COTTONPLUS: 'Cotton+',
    DUVET: 'Duvet',
    MIXEDFABRIC: 'Mixed Fabric',
    SPORTSWEAR: 'Sportswear',
    SILENTWASH: 'Silent Wash',
    RINSESPIN: 'Rinse + Spin',
    TUB_CLEAN: 'Tub Clean',
    WOOL: 'Wool',
    DELICATE: 'Delicates',
    QUICK30: 'Quick 30',
    BABYSTEAMCARE: 'Baby Steam Care',
    ALLERGYSPASTEAM: 'Allergy Care',
    BABYCARE: 'Baby Care',
    SMALLLOAD: 'Small Load',
    NOISEMINIMIZE: 'Noise Minimize',
    RINSE_NORMAL: 'Normal',
    RINSE_PLUS: 'Rinse+',
    NO_RINSE: 'Not selected',
    SOILWASH_NORMAL: 'Normal',
    SOILWASH_INTENSIVE: 'Intensive',
    NO_SOILWASH: 'Not selected',
}

for (const name of ['quick30', 'settings', 'remote-start', 'controls']) {
    test(`replays real ${name} packets against independent LG state patches`, (t) => {
        const { device, properties } = makeDevice()
        const reference: Record<string, string | number> = {}
        let comparisons = 0
        const flags: Record<string, [string, string]> = {
            remoteStart: ['remote_start', 'REMOTE_START_ON'],
            preWash: ['pre_wash', 'PREWASH_ON'],
            steam: ['steam', 'STEAM_ON'],
            medicRinse: ['medic_rinse', 'MEDICRINSE_ON'],
            childLock: ['child_lock', 'CHILDLOCK_ON'],
        }
        for (const e of fixture(name)) {
            receive(device, e)
            if (!e.lg) continue
            Object.assign(reference, e.lg)
            const expected: Record<string, string | number> = {}
            for (const [field, property] of Object.entries({
                state: 'status',
                rinse: 'rinse',
                soilWash: 'wash_mode',
            })) {
                if (field in e.lg) expected[property] = cloudLabels[String(e.lg[field])]
            }
            if ('courseFL24inchBaseTitan' in e.lg || 'smartCourseFL24inchBaseTitan' in e.lg) {
                const smart = reference.smartCourseFL24inchBaseTitan
                const course = smart && smart !== 'NOT_SELECTED' ? smart : reference.courseFL24inchBaseTitan
                expected.course = cloudLabels[String(course)]
            }
            if ('downloadedCourseFL24inchBaseTitan' in e.lg)
                expected.downloaded_course = cloudLabels[String(e.lg.downloadedCourseFL24inchBaseTitan)]
            if ('spin' in e.lg)
                expected.spin =
                    e.lg.spin === 'NOT_SELECTED'
                        ? 'None'
                        : e.lg.spin === 'NO_SPIN'
                          ? 0
                          : Number(String(e.lg.spin).replace('SPIN_', ''))
            if ('temp' in e.lg) {
                const noTemp = e.lg.temp === 'NO_TEMP'
                const cold = e.lg.temp === 'TEMP_COLD'
                expected.temp = noTemp || cold ? 'None' : Number(String(e.lg.temp).replace('TEMP_', ''))
                expected.temperature_setting = noTemp ? 'Not selected' : cold ? 'Cold' : `${expected.temp} °C`
            }
            for (const [field, [property, on]] of Object.entries(flags))
                if (field in e.lg) expected[property] = e.lg[field] === on ? 'ON' : 'OFF'
            if ('doorLock' in e.lg) expected.door_lock = e.lg.doorLock === 'DOOR_LOCK_ON' ? 'OFF' : 'ON'
            if ('TCLCount' in e.lg) expected.tub_clean_count = Number(e.lg.TCLCount)
            for (const [prefix, property] of [
                ['remain', 'remaining_time'],
                ['initial', 'initial_time'],
            ]) {
                if (`${prefix}TimeHour` in reference && `${prefix}TimeMinute` in reference)
                    expected[property] =
                        Number(reference[`${prefix}TimeHour`]) * 60 + Number(reference[`${prefix}TimeMinute`])
            }
            if ('reserveTimeHour' in e.lg) expected.delay_remaining = Number(e.lg.reserveTimeHour) * 60
            for (const [property, value] of Object.entries(expected)) {
                assert.equal(properties[property], value, `${property} at ${e.ms} ms`)
                comparisons++
            }
        }
        assert.ok(comparisons > 0)
        t.diagnostic(`${comparisons} comparisons with LG`)
    })
}

test('captured full cycle completes then powers off; old records and end alerts cannot regress state', () => {
    const { device, properties } = makeDevice()
    let finished = false
    for (const e of fixture('quick30')) {
        receive(device, e)
        if (properties.status === 'Finished') {
            finished = true
            assert.equal(properties.completed, 'ON')
        }
    }
    assert.ok(finished)
    assert.equal(properties.status, 'Off')
    assert.equal(properties.completed, 'OFF')
})

test('all downloaded presets, five-hour reservation, countdown and power-off decode from real reports', () => {
    const { device, properties } = makeDevice()
    const seen = new Set<string>()
    let delayed = false,
        countdown = false,
        poweredOff = false
    for (const e of fixture('controls')) {
        receive(device, e)
        if (!e.packet || e.direction !== 'fromDevice' || e.packet.slice(4, 8) !== '20ec') continue
        seen.add(String(properties.downloaded_course))
        if (properties.status === 'Delayed') {
            assert.equal(properties.course, 'Spin')
            assert.equal(properties.initial_time, 11)
            if (properties.delay_remaining === 300) delayed = true
            if (properties.delay_remaining === 299) countdown = true
        }
        if (delayed && properties.status === 'Off') {
            poweredOff = true
            assert.equal(properties.delay_remaining, 0)
        }
    }
    for (const name of ['Baby Care', 'Small Load', 'Noise Minimize', 'Minimize Detergent Residue', 'Hygiene', 'Spin'])
        assert.ok(seen.has(name), name)
    assert.ok(delayed && countdown && poweredOff)
    assert.equal(properties.tub_clean_count, 51)
})

test('acknowledgements match the captured bridge and decoding never sends an actuating command', () => {
    const { device, thinq } = makeDevice()
    device.start()
    let acknowledgements = 0
    for (const e of fixture('controls')) {
        if (e.direction === 'toDevice' && e.type === 'ack') {
            assert.equal(thinq.sent[acknowledgements]?.cmd, 'ack')
            assert.equal(thinq.sent[acknowledgements]?.data, e.packet?.toUpperCase())
            acknowledgements++
        } else receive(device, e)
    }
    assert.ok(acknowledgements > 0)
    assert.equal(thinq.sent.length, acknowledgements)
    assert.equal(thinq.outbox.length, 0)
})

test('discovery is sensor-only, all published enums are valid and the model is registered', () => {
    const ha = new MockHAConnection(),
        thinq = new MockThinq2Device(ID, META)
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    assert.ok(bridge.haDevices.get(ID) instanceof DUT)
    const components = ha.devices[ID].config!.components as Record<
        string,
        { platform: string; options?: string[]; command_topic?: string }
    >
    assert.equal(Object.keys(components).length, 20)
    for (const c of Object.values(components)) {
        assert.ok(['sensor', 'binary_sensor'].includes(c.platform))
        assert.equal(c.command_topic, undefined)
    }
    for (const name of ['quick30', 'settings', 'remote-start', 'controls']) {
        for (const e of fixture(name)) {
            receive(bridge.haDevices.get(ID) as DUT, e)
            for (const [key, c] of Object.entries(components)) {
                const value = ha.devices[ID].properties[key]
                if (value !== undefined && c.options) assert.ok(value === 'None' || c.options.includes(String(value)))
            }
        }
    }
    thinq.emit('close')
    assert.equal(ha.devices[ID].availability, 'offline')
})

test('corrupt frames, wrong record markers, impossible times and unknown codes cannot invent readings', () => {
    const { device, properties } = makeDevice()
    const first = Buffer.from(fixture('quick30').find((e) => e.packet)!.packet!, 'hex')
    device.processData(first)
    const baseline = { ...properties }
    const corrupted = Buffer.from(first)
    corrupted[40] ^= 1
    device.processData(corrupted)
    assert.deepEqual(properties, baseline)
    const change = (offset: number, value: number) => {
        const frame = Buffer.from(first)
        frame[offset] = value
        frame[frame.length - 2] = (frame.subarray(0, -2).reduce((s, b) => s + b, 0) & 255) ^ 0x55
        return frame
    }
    device.processData(change(35, 27))
    device.processData(change(38, 60))
    assert.deepEqual(properties, baseline)
    for (const [offset, key] of [
        [36, 'status'],
        [41, 'course'],
        [44, 'spin'],
        [45, 'temp'],
        [46, 'rinse'],
        [56, 'course'],
        [59, 'downloaded_course'],
    ] as const) {
        device.processData(change(offset, 255))
        assert.equal(properties[key], 'None')
    }
})
