import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/HUM_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'HUM_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST HUM', swVersion: '4378' }

/*
 * Both frames are verbatim from the appliance: the answers it gave to a capabilities query
 * (0x1f5=1) and a values query (0x1f5=2), injected through the management API on 2026-07-28.
 */
const CAPS_RESPONSE_HEX =
    '000004000000a702012778640f644f6c4cb00eb0601020b480a5c0965020b0a001d4b4e05000b5b020100057c3580f79507bb6a04956b6e04378b700b750feb9501eb99046bc200800bc70020201b3c0bd1031bd60099fbd85d3c0d400dd04f7905af7d014fa01fb0bf870fffc40ef83b5c5b600b642b5ccb600b642b5d018b600b642e059'
const QUERY_RESPONSE_HEX =
    '000004000000a702042d9d6880698069c06a006a406a806ac06b006b406b806bc06c006cc06e405902fa807dc17e457e827f50374241584179c07a437a807b50647b8fb4501cb7901c86c0870087c08940898094d041d8808790c8cd46cd05ccc49001cd90308840d5503ed59064ab007f00e801e900e94ae989ebc1ed08ed40ee405cf0180c055d00f80b6e0178c179007980ab40b5c5b600b642b5ccb600b642b5d018b600b64290c1'

/** Confirmed on the wire by driving the appliance from LG's cloud through the bridge. */
const MODES = [
    ['Air Clean', 5],
    ['Humidify+Clean', 12],
    ['Humidify', 24],
] as const

const FANS = [
    ['Auto', 8],
    ['Low', 2],
    ['Mid', 4],
    ['High', 6],
    ['Turbo', 7],
] as const

function writtenFields(thinq: MockThinq2Device) {
    const packet = thinq.outbox[thinq.outbox.length - 1]
    assert.ok(packet, 'a packet was sent')
    return TLV.parse(packet.subarray(11, packet.length - 2)).map(({ t, v }) => ({ t, v }))
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    thinq.resetRecorder()
    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 6000)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('the captured values frame populates the entities it is meant to', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const props = ha.devices[DEVICE_ID]!.properties
        assert.equal(props['humidifier-power'], 'ON')
        assert.equal(props['humidifier-mode'], 'Air Clean')
        assert.equal(props['humidifier-target_humidity'], 65)
        assert.equal(props['fan_speed-'], 'Low')
        assert.equal(props['current_humidity-'], 48)
        // 0x1fd is half-degrees: wire 55 is 27.5 degC, which is what the cloud read at the time.
        assert.equal(props['temperature-'], 27.5)
        assert.equal(props['night_mode-'], 'ON')
        assert.equal(props['sleep_mode-'], 'OFF')
        assert.equal(props['auto_strength-'], 'OFF')
        // The tank was out of its seat during the capture, which is what LG's code 1 means.
        assert.equal(props['status-'], 'No tank')
        dev.drop()
    })

    test('config offers the LG mode and fan vocabularies', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(
            components.humidifier.modes,
            MODES.map(([label]) => label),
        )
        assert.deepEqual(
            components.fan_speed.options,
            FANS.map(([label]) => label),
        )
        dev.drop()
    })

    test('every mode code decodes to its label', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        for (const [label, wire] of MODES) {
            dev.processKeyValue(0x1f9, wire)
            assert.equal(ha.devices[DEVICE_ID]!.properties['humidifier-mode'], label)
        }
        dev.drop()
    })

    test('every mode label writes its wire code and turns the appliance on', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        for (const [label, wire] of MODES) {
            thinq.resetRecorder()
            dev.setProperty('humidifier-mode', label)
            assert.deepEqual(writtenFields(thinq), [
                { t: 0x1f9, v: wire },
                { t: 0x1f7, v: 1 },
            ])
        }
        dev.drop()
    })

    test('every fan code decodes, and every fan label writes 0x1fa alone', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        for (const [label, wire] of FANS) {
            dev.processKeyValue(0x1fa, wire)
            assert.equal(ha.devices[DEVICE_ID]!.properties['fan_speed-'], label)
            thinq.resetRecorder()
            dev.setProperty('fan_speed-', label)
            assert.deepEqual(writtenFields(thinq), [{ t: 0x1fa, v: wire }])
        }
        dev.drop()
    })

    test('target humidity snaps to LG’s 5% step', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        dev.setProperty('humidifier-target_humidity', '52')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x253, v: 50 }])
        dev.drop()
    })

    test('target humidity rejects non-finite and out-of-range writes', (t) => {
        const { thinq, dev } = buildReadyDevice(t)
        for (const value of ['NaN', 'Infinity', '-1', '101']) {
            dev.setProperty('humidifier-target_humidity', value)
        }
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })

    test('enum entities use the exact unknown fallback and declare their options', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const props = ha.devices[DEVICE_ID]!.properties
        dev.processKeyValue(0x1f9, 99)
        dev.processKeyValue(0x1e3, 99)
        assert.equal(props['humidifier-mode'], 'unknown')
        assert.equal(props['status-'], 'unknown')

        const status = ha.devices[DEVICE_ID]!.config!.components.status as Record<string, unknown>
        assert.equal(status.device_class, 'enum')
        assert.deepEqual(status.options, [
            'Normal',
            'No tank',
            'Low water',
            'Sterilizing',
            'Drying',
            'Boiling',
            'Boiling (low)',
        ])
        dev.drop()
    })

    test('display brightness round-trips its LG codes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        dev.processKeyValue(0x21f, 9)
        assert.equal(ha.devices[DEVICE_ID]!.properties['display-'], 'Level 2')
        thinq.resetRecorder()
        dev.setProperty('display-', 'Level 3')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x21f, v: 10 }])
        dev.drop()
    })

    test('every registered tag is present in the captured values response', (t) => {
        const { dev } = buildReadyDevice(t)
        const frame = buf(QUERY_RESPONSE_HEX)
        const capturedTags = new Set(TLV.parse(frame.subarray(11, frame.length - 2)).map(({ t }) => t))
        const registeredTags = Object.keys(dev.fields_by_id).map(Number)
        assert.deepEqual(
            registeredTags.filter((tag) => !capturedTags.has(tag)),
            [],
        )
        dev.drop()
    })

    test('unverified and raw-only entities are not exposed', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID]!.config!.components
        for (const name of [
            'over_prevention',
            'sensor_mon',
            'auto_dry',
            'watertank_light',
            'air_quality',
            'error',
            'water_lack',
        ]) {
            assert.equal(components[name], undefined)
        }
        dev.drop()
    })

    test('the off timer is hours in HA and minutes on the wire, as on RAC_056905_WW', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        dev.processKeyValue(0x21b, 90)
        assert.equal(ha.devices[DEVICE_ID]!.properties['stoptimer-'], 1.5)
        thinq.resetRecorder()
        dev.setProperty('stoptimer-', '2.25')
        assert.deepEqual(writtenFields(thinq), [{ t: 0x21b, v: 135 }])
        // LG caps targetTimeToStop at 720 minutes.
        assert.equal((ha.devices[DEVICE_ID]!.config!.components.stoptimer as Record<string, unknown>).max, 12)
        dev.drop()
    })

    test('the absolute HHMM schedule tags are not exposed', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const components = ha.devices[DEVICE_ID]!.config!.components
        assert.equal(components.start_time, undefined)
        assert.equal(components.stop_time, undefined)
        dev.drop()
    })
})
