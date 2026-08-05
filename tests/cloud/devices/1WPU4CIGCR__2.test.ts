import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/1WPU4CIGCR__2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '1WPU4CIGCR__2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '' }

/*
 * STATE_SHORT is a REAL single-record frame captured from the appliance on 2026-07-28. The
 * variants are that frame with ONE byte changed and the checksum recomputed; each was injected
 * into LG's cloud that day, so the expected value is LG's own decode of that exact frame.
 */
const STATE_SHORT = buf('aa2012eb020002010101ffff00ff010101ffff071c121eff01ff0300000177bb')

function withAABBChecksum(frame: Buffer) {
    const packet = Buffer.from(frame)
    let sum = 0
    for (let i = 0; i < packet.length - 2; i++) sum += packet[i]
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

// The record starts 4 bytes into the whole frame (aa, len, tag, index), so whole-frame index N is
// record offset N-4.
function withByte(frame: Buffer, index: number, value: number) {
    const next = Buffer.from(frame)
    next[index] = value
    return withAABBChecksum(next)
}

const COLD_WATER = withByte(STATE_SHORT, 6, 3) // waterSelection -> COLD_WATER
const FAHRENHEIT = withByte(STATE_SHORT, 8, 0) // tempUnit -> FAHRENHEIT
const DEFAULT_COLD = withByte(STATE_SHORT, 14, 3) // defaultWaterSet -> COLD_WATER
const STERILIZING = withByte(STATE_SHORT, 27, 3) // highSterilizeState -> water line
const HOT_85 = withByte(STATE_SHORT, 10, 3) // hotWaterTemp code 3 -> 85 °C

function usageFrame(values: Partial<Record<'normal' | 'hot' | 'cold' | 'soda' | 'mineral' | 'sterilization', number>>) {
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

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}
const props = (ha: MockHAConnection) => ha.devices[DEVICE_ID].properties

describe(MODEL_ID, () => {
    test('a real state frame decodes to LG cloud values', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_SHORT)
        const p = props(ha)
        assert.equal(p.status, 'Normal')
        assert.equal(p.cock_state, 'Standby')
        assert.equal(p.water_selection, 'Purified')
        assert.equal(p.water_amount, '120 mL')
        assert.equal(p.default_water, 'Last used')
        assert.equal(p.default_water_amount, '120 mL')
        assert.equal(p.hot_water_temp, '') // 0xff -> not reported
        assert.equal(p.temp_unit, '°C')
        assert.equal(p.amount_unit, 'mL')
        assert.equal(p.button_sound, 'ON')
        assert.equal(p.auto_care, 'ON')
        assert.equal(p.not_use_notice, 'OFF')
        assert.equal(p.sterilize_state, 'Standby')
        assert.equal(p.filter_flushing, 'Off')
        assert.equal(p.app_version, 1)
        assert.equal(p.data_refresh, 3)
    })

    test('single-byte-changed frames decode the way LG read them', () => {
        for (const [frame, key, value] of [
            [COLD_WATER, 'water_selection', 'Cold water'],
            [FAHRENHEIT, 'temp_unit', '°F'],
            [DEFAULT_COLD, 'default_water', 'Cold water'],
            [STERILIZING, 'sterilize_state', 'Water line sterilizing'],
            [HOT_85, 'hot_water_temp', 85],
        ] as const) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', frame)
            assert.equal(props(ha)[key], value, key)
        }
    })

    test('the sterilization reservation is published raw, month.day HH:MM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_SHORT) // record bytes 15..18 = 07 1c 12 1e
        assert.equal(props(ha).sterilize_reserved_at, '7.28 18:30')
        assert.equal(props(ha).sterilize_time, '18:30')
    })

    test('an unset reservation (0xff) reads Not set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withByte(STATE_SHORT, 19, 0xff)) // sterilizeInitMonth -> IGNORE
        assert.equal(props(ha).sterilize_reserved_at, 'Not set')
        assert.equal(props(ha).sterilize_time, '')
    })

    test('usage deltas accumulate into total_increasing counters', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', usageFrame({ normal: 3, cold: 2, hot: 1, sterilization: 4 }))
        assert.equal(props(ha).water_usage_normal, 3)
        assert.equal(props(ha).water_usage_cold, 2)
        assert.equal(props(ha).water_usage_hot, 1)
        assert.equal(props(ha).water_usage_sterilization, 4)
        assert.equal(props(ha).water_usage_today, 10)

        // A second report adds to the running totals rather than replacing them.
        thinq.emit('data', usageFrame({ normal: 5, soda: 2, mineral: 1 }))
        assert.equal(props(ha).water_usage_normal, 8)
        assert.equal(props(ha).water_usage_today, 18)
    })

    test('a zero or truncated usage frame changes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', usageFrame({ normal: 4 }))
        assert.equal(props(ha).water_usage_today, 4)
        thinq.emit('data', usageFrame({})) // all-zero delta
        thinq.emit('data', usageFrame({ normal: 9 }).subarray(0, 17)) // truncated
        assert.equal(props(ha).water_usage_today, 4)
    })

    test('a usage frame is not mistaken for a state frame', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_SHORT)
        thinq.emit('data', usageFrame({ cold: 5 }))
        assert.equal(props(ha).status, 'Normal') // state decode did not re-run
        assert.equal(props(ha).water_usage_cold, 5)
    })

    test('exactly the side-effect-safe fields are writable', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('default_water', 'Cold water')
        assert.equal(thinq.outbox.length, 1)
        const record = thinq.outbox[0].subarray(4, thinq.outbox[0].length - 2)
        assert.equal(record[10], 3) // defaultWaterSet offset, code 3 = Cold water
        assert.ok(record.every((b, i) => i === 10 || b === 0xff)) // every other field left alone

        thinq.resetRecorder()
        dev.setProperty('sterilize_reserved_at', '9.9 09:09') // read-only
        dev.setProperty('status', 'Normal') // read-only
        assert.equal(thinq.outbox.length, 0)
    })

    test('config publishes usage as total_increasing and no persistent-history entities', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const key of [
            'water_usage_today',
            'water_usage_normal',
            'water_usage_cold',
            'water_usage_hot',
            'water_usage_sterilization',
        ]) {
            assert.equal(components[key].state_class, 'total_increasing', key)
        }
        for (const gone of ['sterilize_pipe_last_at', 'sterilize_outlet_last_at', 'sterilize_previous_month_count']) {
            assert.equal(components[gone], undefined, gone)
        }
    })
})
