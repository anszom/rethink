import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WIN_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'WIN_056905_WW', modelName: 'TEST', swVersion: '1.0' }

// 0x2c1 = 0x107: cool, dry, fan, energy saver. 0x2c2 = 0x54: fan 2, 4, 6. 0x2e1 / 0x2e2 = 32 / 60: 16-30 °C.
const CAPS_RESPONSE_HEX =
    '000004000000A70201194AB009B0600107B09054B0C1B101B340B4C7B541B543B6A00346B6F0179800B85020B8903CB8D020B9103C' +
    'BC41BD47B5C0B61032B646B5C1B61030B646B5C2B61030B646B5C8B61032B646607B'
// Off in energy saver, 25 °C, fan high, no 0x322. 0x2b3 = 50, 0x355 / 0x356 = 174 / 250.
const QUERY_RESPONSE_HEX =
    '000004000000A70204F33F7E487DC07E867F50387F90328180868086C08700884089428A028A506F8A808C808CC0ACD032D550AED5' +
    '90FACAD092CB109CCB8CCBC0CC00CC909B1B00C0C02A2F'

/** A device notification carrying the given TLVs (the CRC is not checked by the device class). */
function notify(...tlv: [number, number][]) {
    const body = Buffer.from(TLV.build(tlv.map(([t, v]) => ({ t, v }))))
    return Buffer.concat([Buffer.from([0, 0, 4, 0, 0, 0, 0xa7, 2, 4, 0, body.length]), body, Buffer.from([0, 0])])
}

/** A frame with some tags of the captured one left out. */
function withoutTags(frameHex: string, ...tags: number[]) {
    const frame = buf(frameHex)
    const body = Buffer.from(
        TLV.build(TLV.parse(frame.subarray(11, frame.length - 2)).filter((e) => !tags.includes(e.t))),
    )
    const header = Buffer.from(frame.subarray(0, 11))
    header[10] = body.length
    return Buffer.concat([header, body, Buffer.from([0, 0])])
}

function buildReadyDevice(
    t: import('node:test').TestContext,
    caps = buf(CAPS_RESPONSE_HEX),
    values = buf(QUERY_RESPONSE_HEX),
) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))

    thinq.emit('data', caps)
    thinq.emit('data', values)
    thinq.emit('data', values)

    thinq.resetRecorder()
    const components = ha.devices[DEVICE_ID]!.config!.components as Record<string, any>
    return { ha, thinq, dev, components }
}

/** The TLVs of every frame sent to the unit, one array per frame. */
const sent = (thinq: MockThinq2Device) =>
    thinq.outbox.map((b) => TLV.parse(b.subarray(11, b.length - 2)).map(({ t, v }): [number, number] => [t, v]))

const last = <T>(list: T[]) => list[list.length - 1]!

describe('WIN_056905_WW window AC (EEPROM 0x346)', () => {
    test('publishes the device name inside the device block', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const config = ha.devices[DEVICE_ID]!.config as Record<string, any>

        assert.equal(config.device.name, 'LG Air Conditioner')
        assert.equal(config.name, undefined)

        dev.drop()
    })

    test('modes, fan speeds and setpoint range come from the caps', (t) => {
        const { components, dev } = buildReadyDevice(t)
        const climate = components.climate

        assert.deepEqual(climate.modes, ['off', 'cool', 'dry', 'fan_only'])
        assert.deepEqual(climate.preset_modes, ['eco'])
        assert.deepEqual(climate.fan_modes, ['low', 'medium', 'high'])
        assert.equal(climate.min_temp, 16)
        assert.equal(climate.max_temp, 30)

        dev.drop()
    })

    test('no swing when the unit never reports 0x322', (t) => {
        const { components, dev } = buildReadyDevice(t)

        assert.equal(components.climate.swing_modes, undefined)
        assert.equal(components.climate.swing_mode_command_topic, undefined)

        dev.drop()
    })

    test('swing is offered when the unit reports 0x322', (t) => {
        const { components, dev } = buildReadyDevice(
            t,
            buf(CAPS_RESPONSE_HEX),
            notify(
                [0x1f7, 0],
                [0x1f9, 0],
                [0x1fa, 6],
                [0x1fd, 56],
                [0x1fe, 50],
                [0x206, 0],
                [0x21a, 0],
                [0x21b, 0],
                [0x21c, 0],
                [0x322, 100],
            ),
        )

        assert.deepEqual(components.climate.swing_modes, ['on', 'off'])

        dev.drop()
    })

    test('without caps every known mode and fan speed is offered', (t) => {
        const { components, dev } = buildReadyDevice(t, withoutTags(CAPS_RESPONSE_HEX, 0x2c1, 0x2c2))

        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only', 'heat'])
        assert.equal(components.climate.preset_modes, undefined)
        assert.deepEqual(components.climate.fan_modes, ['low', 'medium', 'high'])

        dev.drop()
    })

    test('energy saver reads as cool with preset eco', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const get = (topic: string) => ha.getProperty(DEVICE_ID, 'climate', topic)

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 8]))
        assert.equal(get('mode_state'), 'cool')
        assert.equal(get('preset_mode_state'), 'eco')

        thinq.emit('data', notify([0x1f9, 1]))
        assert.equal(get('mode_state'), 'dry')
        assert.equal(get('preset_mode_state'), 'none')

        thinq.emit('data', notify([0x1f7, 0]))
        assert.equal(get('mode_state'), 'off')

        dev.drop()
    })

    test('off writes 0x1f7 = 0', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 8]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')
        assert.deepEqual(sent(thinq), [[[0x1f7, 0]]])

        dev.drop()
    })

    test('dry writes 0x1f9 = 1, and turns the unit on', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')
        const frames = sent(thinq)
        assert.deepEqual(frames[0]![0], [0x1f7, 1])
        assert.deepEqual(frames[1]![0], [0x1f9, 1])

        dev.drop()
    })

    test('preset eco writes energy saver, none goes back to cool', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'preset_mode_command', 'eco')
        assert.deepEqual(last(sent(thinq))[0], [0x1f9, 8])

        thinq.emit('data', notify([0x1f9, 8]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'preset_mode_command', 'none')
        assert.deepEqual(last(sent(thinq))[0], [0x1f9, 0])

        dev.drop()
    })

    test('preset none outside energy saver changes nothing', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 2]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'preset_mode_command', 'none')
        assert.deepEqual(sent(thinq), [])

        dev.drop()
    })

    test('fan medium writes 0x1fa = 4', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'medium')
        assert.deepEqual(sent(thinq)[0]![0], [0x1fa, 4])

        dev.drop()
    })
})
