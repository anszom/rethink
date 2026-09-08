import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/AIR_910604_WW'
import Bridge from '@/cloud/ha_bridge'
import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'AIR_910604_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real AIR_910604_WW A7 frames captured from the owner's physical unit.
// Full state: power on, single clean, clean-booster fan auto, rotation on,
// clean indicator and air sanitization on, PM1/PM2.5/PM10=8, humidity=30%.
const BASE_HEX =
    '000004000000A7020464627DC17E4E7E887F007F807F5050868086C087008980D7C0D801D840D88087809381' +
    'CD48CD08CCC890419001CD901E8840D55022D5A00FA0D8E00C75D9200FA0CE80AB00C988C9C1CA00B5D010' +
    'B600B648B5CDB600B648B5CFB600B648B5CEB60EB64EAFAA'

// Owner-labelled real transition frames.
const POWER_OFF_HEX = '000004000000A702048C0A7DC09380AC600100AC84ACD5'
const POWER_ON_HEX = '000004000000A702048F0A7DC19381AC600100AC80BA8C'
const CLEAN_BOOSTER_HEX = '000004000000A7020455027E4D9A6B'
const SINGLE_CLEAN_HEX = '000004000000A7020430027E4E4F9F'
const DUAL_CLEAN_HEX =
    '000004000000A7020425627DC17E4F7E887F007F807F5050868086C087008980D7C0D801D840D88087809381' +
    'CD48CD08CCC890419001CD901E8840D55022D5A00FA0D8E00C75D9200FA0CE80AB00C988C9C1CA00B5D010' +
    'B600B648B5CDB600B648B5CFB600B648B5CEB60EB64E6B03'
const AUTO_HEX = '000004000000A702044E037E5010B0FC'
const BOOSTER_HIGH_HEX = '000004000000A702046702C986B457'
const BOOSTER_TURBO_HEX = '000004000000A702046B02C987EB44'
// Prior exact-model capture: main fan low plus the remembered-per-mode rows.
const MAIN_FAN_LOW_HEX = '000004000000A702047B147E82B5CDB600B642B5CFB600B642B5CEB60EB64E5078'
const ROTATION_OFF_HEX = '000004000000A702046D02C9C0F4FE'
const ROTATION_ON_HEX = '000004000000A702046E02C9C17F03'
const INDICATOR_OFF_HEX = '000004000000A7020480029380E022'
const INDICATOR_ON_HEX = '000004000000A70204820293811D6B'
const SANITIZATION_OFF_HEX = '000004000000A702048402D8006A6D'
const SANITIZATION_ON_HEX = '000004000000A702048502D8010CF8'
const SLEEP_120_HEX = '000004000000A702048605869078938038E2'
const SLEEP_119_HEX = '000004000000A702048A038690774AA4'
const SLEEP_CANCEL_HEX = '000004000000A702048B04868093817146'
const TRUNCATED_HEX = '000004000000A7020464627DC17E4E7E88'

// Command frames the LG app itself sent, captured on the same unit. Each write
// below must reproduce the TLVs of one of these.
const CMD_MODE_SINGLE = '01010400000065020100027e4e56d7' // 0x1f9 = 14
const CMD_MODE_BOOSTER = '01010400000065020100027e4d66b4' // 0x1f9 = 13
const CMD_BOOSTER_MEDIUM = '0101040000006502010002c984a94b' // 0x326 = 4
const CMD_BOOSTER_TURBO = '0101040000006502010002c9879928' // 0x326 = 7
const CMD_ROTATION_OFF = '0101040000006502010002c9c0a10b' // 0x327 = 0
const CMD_ROTATION_ON = '0101040000006502010002c9c1b12a' // 0x327 = 1
const CMD_INDICATOR_OFF = '0101040000006502010002938008bb' // 0x24e = 0
const CMD_INDICATOR_ON = '01010400000065020100029381189a' // 0x24e = 1
const CMD_STERILIZE_OFF = '0101040000006502010002d8004805' // 0x360 = 0
const CMD_STERILIZE_ON = '0101040000006502010002d8015824' // 0x360 = 1
const CMD_SLEEP_CANCEL = '01010400000065020100028680f43d' // 0x21a = 0

/** TLVs of a captured toDevice command frame, as {tag: value}. */
function commandTlvs(hex: string): Record<number, number> {
    const b = Buffer.from(hex, 'hex')
    const out: Record<number, number> = {}
    for (const { t, v } of TLV.parse(b.subarray(11, 11 + b[10]))) out[t] = v
    return out
}

/** TLVs the handler actually put on the wire, as {tag: value}. */
function sentTlvs(thinq: MockThinq2Device): Record<number, number> {
    assert.equal(thinq.outbox.length, 1, 'exactly one frame should be sent')
    const b = thinq.outbox[0]
    const out: Record<number, number> = {}
    for (const { t, v } of TLV.parse(b.subarray(11, 11 + b[10]))) out[t] = v
    return out
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('every declared capture fixture has a valid envelope length and CRC', () => {
        for (const frame of [
            BASE_HEX,
            POWER_OFF_HEX,
            POWER_ON_HEX,
            CLEAN_BOOSTER_HEX,
            SINGLE_CLEAN_HEX,
            DUAL_CLEAN_HEX,
            AUTO_HEX,
            BOOSTER_HIGH_HEX,
            BOOSTER_TURBO_HEX,
            MAIN_FAN_LOW_HEX,
            ROTATION_OFF_HEX,
            ROTATION_ON_HEX,
            INDICATOR_OFF_HEX,
            INDICATOR_ON_HEX,
            SANITIZATION_OFF_HEX,
            SANITIZATION_ON_HEX,
            SLEEP_120_HEX,
            SLEEP_119_HEX,
            SLEEP_CANCEL_HEX,
        ]) {
            const packet = Buffer.from(frame, 'hex')
            assert.equal(packet[6], 0xa7, frame)
            assert.equal(packet[10], packet.length - 13, frame)
            assert.equal(crc16(packet.subarray(2)), 0, frame)
        }
    })

    test('discovery is immediate and a delta-first connection publishes state', () => {
        const { ha, thinq, dev } = makeDevice()
        assert.ok(ha.devices[DEVICE_ID]?.config)
        thinq.emit('data', buf(DUAL_CLEAN_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'mode', 'state'), 'dual_clean')
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })

    test('bridge registry selects this handler for the exact model id', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        thinq.emit('data', buf(BASE_HEX))
        assert.ok(ha.devices[DEVICE_ID]?.config)
        assert.equal(ha.getProperty(DEVICE_ID, 'mode', 'state'), 'single_clean')
        assert.equal(thinq.outbox.length, 0)
        assert.equal(thinq.sent.length, 0)
        thinq.emit('close')
    })

    test('real full frame publishes discovery and initial state', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const components = device.config!.components as Record<string, Record<string, unknown>>

        assert.deepEqual(components.mode.options, ['clean_booster', 'single_clean', 'dual_clean', 'auto'])
        assert.deepEqual(components.fan.preset_modes, ['low', 'medium', 'high', 'turbo', 'auto'])
        assert.deepEqual(components.clean_booster_fan_speed.options, ['low', 'medium', 'high', 'turbo', 'auto'])
        assert.equal(components.humidity, undefined, 'internal humidity is not room humidity')
        // Sensors stay strictly read-only even though the appliance is writable.
        for (const name of [
            'pm1',
            'pm25',
            'pm10',
            'air_quality',
            'odor',
            'error',
            'filter_remaining_time',
            'filter_life_time',
            'top_filter_remaining_time',
            'top_filter_life_time',
        ]) {
            for (const key of Object.keys(components[name])) {
                assert.ok(!key.endsWith('command_topic'), `${name}.${key} must not exist`)
            }
        }

        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'mode', 'state'), 'single_clean')
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'preset_mode_state'), 'auto')
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_booster_fan_speed', 'state'), 'auto')
        assert.equal(ha.getProperty(DEVICE_ID, 'circulation_rotation', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_indicator', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'air_sanitization', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'sleep_timer', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'pm1', 'state'), 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'pm25', 'state'), 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'pm10', 'state'), 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), undefined)
        assert.equal(ha.getProperty(DEVICE_ID, 'air_quality', 'state'), 1)
        assert.equal(ha.getProperty(DEVICE_ID, 'odor', 'state'), 1)
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_remaining_time', 'state'), 34)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_life_time', 'state'), 4000)
        assert.equal(ha.getProperty(DEVICE_ID, 'top_filter_remaining_time', 'state'), 3189)
        assert.equal(ha.getProperty(DEVICE_ID, 'top_filter_life_time', 'state'), 4000)
        assert.equal(components.filter_life, undefined, 'derived percentage is not published')
        assert.equal(components.top_filter_life, undefined, 'derived percentage is not published')

        assert.equal(thinq.outbox.length, 0)
        assert.equal(thinq.sent.length, 0)
        dev.drop()
    })

    test('filter counters publish raw remaining and lifetime hours', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))

        dev.processKeyValue(0x355, 500)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_remaining_time', 'state'), 500)
        dev.processKeyValue(0x356, 1000)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_life_time', 'state'), 1000)

        assert.equal(thinq.outbox.length, 0)
        assert.equal(thinq.sent.length, 0)
        dev.drop()
    })

    test('owner-labelled mode transitions decode without inventing unsupported modes', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        for (const [frame, expected] of [
            [CLEAN_BOOSTER_HEX, 'clean_booster'],
            [SINGLE_CLEAN_HEX, 'single_clean'],
            [DUAL_CLEAN_HEX, 'dual_clean'],
            [AUTO_HEX, 'auto'],
        ] as const) {
            thinq.emit('data', buf(frame))
            assert.equal(ha.getProperty(DEVICE_ID, 'mode', 'state'), expected)
        }
        dev.drop()
    })

    test('clean-booster fan high and turbo deltas decode', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        thinq.emit('data', buf(BOOSTER_HIGH_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_booster_fan_speed', 'state'), 'high')
        thinq.emit('data', buf(BOOSTER_TURBO_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_booster_fan_speed', 'state'), 'turbo')
        dev.drop()
    })

    test('main fan state uses 0x1fa independently of clean-booster fan 0x326', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        thinq.emit('data', buf(MAIN_FAN_LOW_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'preset_mode_state'), 'low')
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_booster_fan_speed', 'state'), 'auto')
        dev.drop()
    })

    test('circulation rotation, indicator, and sanitization round trips decode', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        for (const [frame, component, expected] of [
            [ROTATION_OFF_HEX, 'circulation_rotation', 'OFF'],
            [ROTATION_ON_HEX, 'circulation_rotation', 'ON'],
            [INDICATOR_OFF_HEX, 'clean_indicator', 'OFF'],
            [INDICATOR_ON_HEX, 'clean_indicator', 'ON'],
            [SANITIZATION_OFF_HEX, 'air_sanitization', 'OFF'],
            [SANITIZATION_ON_HEX, 'air_sanitization', 'ON'],
        ] as const) {
            thinq.emit('data', buf(frame))
            assert.equal(ha.getProperty(DEVICE_ID, component, 'state'), expected)
        }
        dev.drop()
    })

    test('sleep timer is minutes, counts down, and restores the indicator on cancel', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        thinq.emit('data', buf(SLEEP_120_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'sleep_timer', 'state'), 120)
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_indicator', 'state'), 'OFF')
        thinq.emit('data', buf(SLEEP_119_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'sleep_timer', 'state'), 119)
        thinq.emit('data', buf(SLEEP_CANCEL_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'sleep_timer', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'clean_indicator', 'state'), 'ON')
        dev.drop()
    })

    test('short delta frames preserve omitted state and power round trip decodes', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        thinq.emit('data', buf(POWER_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'mode', 'state'), 'single_clean')
        assert.equal(ha.getProperty(DEVICE_ID, 'pm1', 'state'), 8)
        thinq.emit('data', buf(POWER_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'state'), 'ON')
        dev.drop()
    })

    test('each single-tag write reproduces the frame the app itself sent', () => {
        for (const [prop, value, captured] of [
            ['clean_booster_fan_speed-', 'medium', CMD_BOOSTER_MEDIUM],
            ['clean_booster_fan_speed-', 'turbo', CMD_BOOSTER_TURBO],
            ['circulation_rotation-', 'OFF', CMD_ROTATION_OFF],
            ['circulation_rotation-', 'ON', CMD_ROTATION_ON],
            ['clean_indicator-', 'OFF', CMD_INDICATOR_OFF],
            ['clean_indicator-', 'ON', CMD_INDICATOR_ON],
            ['air_sanitization-', 'OFF', CMD_STERILIZE_OFF],
            ['air_sanitization-', 'ON', CMD_STERILIZE_ON],
            ['sleep_timer-', '0', CMD_SLEEP_CANCEL],
        ] as const) {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', buf(BASE_HEX))
            thinq.resetRecorder()

            dev.setProperty(prop, value)
            const want = commandTlvs(captured)
            const got = sentTlvs(thinq)
            for (const [tag, v] of Object.entries(want)) {
                assert.equal(got[Number(tag)], v, `${prop}=${value} tag 0x${Number(tag).toString(16)}`)
            }
            dev.drop()
        }
    })

    test('mode and fan writes force power on, because the unit ignores them while off', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))

        // Mode: reproduces the app's mode tag and attaches power + fan.
        thinq.resetRecorder()
        dev.setProperty('mode-', 'single_clean')
        let got = sentTlvs(thinq)
        assert.equal(got[0x1f9], commandTlvs(CMD_MODE_SINGLE)[0x1f9])
        assert.equal(got[0x1f7], 1, 'power is attached so the write is not ignored')

        thinq.resetRecorder()
        dev.setProperty('mode-', 'clean_booster')
        got = sentTlvs(thinq)
        assert.equal(got[0x1f9], commandTlvs(CMD_MODE_BOOSTER)[0x1f9])

        // Main fan speed does the same.
        thinq.resetRecorder()
        dev.setProperty('fan-preset_mode', 'high')
        got = sentTlvs(thinq)
        assert.equal(got[0x1fa], 6)
        assert.equal(got[0x1f7], 1)

        dev.drop()
    })

    test('power on restores mode and fan in one frame; power off does not', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))

        thinq.resetRecorder()
        dev.setProperty('fan-', 'ON')
        let got = sentTlvs(thinq)
        assert.equal(got[0x1f7], 1)
        assert.equal(got[0x1f9], 14, 'last mode is restored')
        assert.equal(got[0x1fa], 8, 'last fan speed is restored')

        thinq.resetRecorder()
        dev.setProperty('fan-', 'OFF')
        got = sentTlvs(thinq)
        assert.equal(got[0x1f7], 0)
        assert.equal(got[0x1f9], undefined, 'nothing is attached when switching off')
        assert.equal(got[0x1fa], undefined)

        dev.drop()
    })

    test('sensors are not writable and malformed frames change nothing', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        thinq.resetRecorder()

        for (const prop of ['pm25-', 'air_quality-', 'error-', 'filter_remaining_time-']) {
            dev.setProperty(prop, '42')
        }
        thinq.emit('data', buf(TRUNCATED_HEX))
        thinq.emit('data', Buffer.from([0, 1, 2, 3]))

        assert.equal(thinq.outbox.length, 0, 'no sensor write reaches the wire')
        assert.equal(thinq.sent.length, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'fan', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'pm25', 'state'), 8)
        dev.drop()
    })
})
