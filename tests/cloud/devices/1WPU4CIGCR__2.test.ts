import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/1WPU4CIGCR__2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '1WPU4CIGCR__2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '' }
const FIXED_NOW = Date.parse('2026-07-28T12:00:00Z')

/*
 * STATE_SHORT is a REAL single-record frame captured from the appliance on 2026-07-28.
 * The variants are that frame with ONE byte changed and the checksum recomputed; each was
 * injected into LG's cloud that day, so the expected value is LG's own decode of that exact
 * frame.
 */
const STATE_SHORT = buf('aa2012eb020002010101ffff00ff010101ffff071c121eff01ff0300000177bb')

function withAABBChecksum(frame: Buffer) {
    const packet = Buffer.from(frame)
    let sum = 0
    for (let i = 0; i < packet.length - 2; i++) sum += packet[i]
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

function withByte(frame: Buffer, index: number, value: number) {
    const next = Buffer.from(frame)
    next[index] = value
    return withAABBChecksum(next)
}

function withFrozenNow<T>(now: number, fn: () => T): T {
    const originalNow = Date.now
    Date.now = () => now
    try {
        return fn()
    } finally {
        Date.now = originalNow
    }
}

const COLD_WATER = withByte(STATE_SHORT, 6, 3) // waterSelection -> COLD_WATER
const AMOUNT_OZ = withByte(STATE_SHORT, 9, 0) // amountUnit -> oz
const STERILIZING = withByte(STATE_SHORT, 27, 3) // highSterilizeState -> water line
const HOT_85 = withByte(STATE_SHORT, 10, 3) // hotWaterTemp code 3 -> 85 °C

const USAGE_FRAMES = [
    'aa12121f00fc00000000000000000000bcbb',
    'aa12121f0032000000000000000000004abb',
    'aa12121f00fc00000000000000000000bcbb',
    'aa12121f0000000000b0000000000000c8bb',
    'aa12121f000000fc0000000000000000bcbb',
    'aa12121f0000007100000000000000000bbb',
].map(buf)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

const props = (ha: MockHAConnection) => ha.devices[DEVICE_ID].properties

describe(MODEL_ID, () => {
    test('a real state frame decodes to HA-friendly values', () => {
        withFrozenNow(FIXED_NOW, () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', STATE_SHORT)
            const p = props(ha)
            assert.equal(p.status, 'Normal')
            assert.equal(p.cock_state, 'Standby')
            assert.equal(p.water_selection, 'Purified')
            assert.equal(p.water_amount, '120 mL')
            assert.equal(p.hot_water_temp, '') // 0xff -> not reported
            assert.equal(p.sterilize_reserved_at, '2026-07-28T18:30:00.000Z')
            assert.equal(p.sterilize_state, 'Standby')
            assert.equal(p.filter_flushing, 'Off')
            assert.equal(p.app_version, 1)
            assert.equal(p.data_refresh, 3)
        })
    })

    test('captured byte changes still decode the right live values', () => {
        withFrozenNow(FIXED_NOW, () => {
            for (const [frame, key, value] of [
                [COLD_WATER, 'water_selection', 'Cold water'],
                [AMOUNT_OZ, 'water_amount', '120 oz'],
                [STERILIZING, 'sterilize_state', 'Water line sterilizing'],
                [HOT_85, 'hot_water_temp', 85],
            ] as const) {
                const { ha, thinq } = makeDevice()
                thinq.emit('data', frame)
                assert.equal(props(ha)[key], value, key)
            }
        })
    })

    test('real usage captures accumulate into litres', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', USAGE_FRAMES[0])
        assert.equal(props(ha).water_usage_today, 0.252)
        assert.equal(props(ha).water_usage_normal, 0.252)

        thinq.emit('data', USAGE_FRAMES[1])
        assert.equal(props(ha).water_usage_today, 0.302)
        assert.equal(props(ha).water_usage_normal, 0.302)

        for (const frame of USAGE_FRAMES.slice(2)) thinq.emit('data', frame)
        assert.equal(props(ha).water_usage_today, 1.095)
        assert.equal(props(ha).water_usage_normal, 0.554)
        assert.equal(props(ha).water_usage_cold, 0.176)
        assert.equal(props(ha).water_usage_hot, 0.365)
        assert.equal(props(ha).water_usage_sterilization, 0)
    })

    test('config only exposes the verified read-only entities', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'app_version',
            'cock_state',
            'data_refresh',
            'filter_flushing',
            'hot_water_temp',
            'status',
            'sterilize_reserved_at',
            'sterilize_state',
            'water_amount',
            'water_selection',
            'water_usage_cold',
            'water_usage_hot',
            'water_usage_normal',
            'water_usage_sterilization',
            'water_usage_today',
        ])
        for (const [name, comp] of Object.entries(components)) {
            assert.equal(comp.command_topic, undefined, `${name} stays read-only`)
        }
        assert.equal(components.sterilize_reserved_at.device_class, 'timestamp')
        for (const key of [
            'water_usage_today',
            'water_usage_normal',
            'water_usage_cold',
            'water_usage_hot',
            'water_usage_sterilization',
        ]) {
            assert.equal(components[key].state_class, 'total_increasing', key)
            assert.equal(components[key].unit_of_measurement, 'L', key)
        }
        for (const gone of [
            'default_water',
            'default_water_amount',
            'button_sound',
            'auto_care',
            'not_use_notice',
            'temp_unit',
            'amount_unit',
            'sterilize_time',
        ]) {
            assert.equal(components[gone], undefined, gone)
        }
    })
})
