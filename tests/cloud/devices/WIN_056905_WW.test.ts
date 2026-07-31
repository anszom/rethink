import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WIN_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import { encodePacket } from '@/util/packet-codec'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WIN_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'LW1823HRSM', swVersion: '1.0' }

/*
 * NB: unlike every other model here, these frames are SYNTHETIC. No capture from an LW1823HRSM
 * exists, so nothing below can attest to what the hardware actually reports - in particular the
 * capability bitmaps are deliberately left out, so this exercises the climate core only and no
 * optional entity. What it does pin down is the handler's own behaviour: the mode and fan scales
 * carried over from the standalone implementation, and the writes it emits.
 *
 * Other hardware is known to report this same ThinQ model id with a different feature set. Until
 * a capture from either exists, treat the entity set this handler produces as unverified.
 */
const CAPS_RESPONSE_HEX = encodePacket({
    protocol: 'tlv',
    direction: 'fromDevice',
    byte6: 0x01,
    /* the eeprom checksum is what marks a frame as the capability response */
    tlv: [{ t: 0x2da, v: 1135 }],
}).hex

const QUERY_RESPONSE_HEX = encodePacket({
    protocol: 'tlv',
    direction: 'fromDevice',
    byte6: 0x04,
    tlv: [
        { t: 0x1f7, v: 1 }, // power on
        { t: 0x1f9, v: 0 }, // mode cool
        { t: 0x1fa, v: 2 }, // fan low
        { t: 0x1fd, v: 40 }, // current temperature 20.0
        { t: 0x1fe, v: 44 }, // target temperature 22.0
        { t: 0x322, v: 0 }, // swing off
        /* filler: the values response is only recognised as one at >= 10 TLVs */
        { t: 0x228, v: 24 },
        { t: 0x229, v: 104 },
        { t: 0x232, v: 744 },
        { t: 0x233, v: 27 },
    ],
}).hex

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet, discard it.
    thinq.resetRecorder()

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 1000)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

/** The TLVs of an outgoing frame, as a tag -> value map. */
function sentTlvs(frame: Buffer) {
    return new Map(TLV.parse(frame.subarray(11, frame.length - 2)).map(({ t, v }) => [t, v]))
}

describe(MODEL_ID, () => {
    test('config exposes the climate component and no capability-gated entity', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const c = device.config!.components as Record<string, Record<string, unknown>>

        assert.equal(c.climate.platform, 'climate')
        assert.deepEqual(c.climate.modes, ['off', 'cool', 'fan_only', 'heat'])
        assert.deepEqual(c.climate.fan_modes, ['low', 'high'])
        assert.deepEqual(c.climate.swing_modes, ['on', 'off'])
        assert.equal(c.climate.temp_step, 0.5)
        // No 0x2e1 / 0x2e2 in the caps, so the handler's own 16 - 30 fallback applies.
        assert.equal(c.climate.min_temp, 16)
        assert.equal(c.climate.max_temp, 30)

        // The device name belongs to the HA device, not the discovery root - where the
        // standalone handler used to put it, leaving the device itself unnamed.
        assert.equal((device.config as unknown as Record<string, unknown>).name, undefined)
        assert.equal(device.config!.device.name, 'LG Air Conditioner')

        // Nothing here sets a capability bitmap, so none of the optional entities appear.
        for (const gated of ['jet', 'energysave', 'airclean', 'autodry', 'sleeptimer'])
            assert.ok(!c[gated], `${gated} stays off without a capability bit`)

        dev.drop()
    })

    test('initial values publish the expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 100)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool') // 0x1f9=0, power on
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low') // 0x1fa=2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 20) // 0x1fd=40 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 22) // 0x1fe=44 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'off') // 0x322=0

        dev.drop()
    })

    test('selecting off actually powers the unit down', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.raw_clip_state[0x1f7] = 1
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        /*
         * Regression: the standalone handler addressed the power field as 'power' where it is
         * registered as 'climate-power', so this emitted nothing at all and the unit stayed on.
         */
        assert.equal(thinq.outbox.length, 1, 'a frame is sent')
        const m = sentTlvs(thinq.outbox[0])
        assert.equal(m.get(0x1f7), 0, 'power off')
        assert.equal(m.size, 1, 'nothing else attached to a power-off')

        dev.drop()
    })

    test('selecting a mode while off turns the unit on', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.raw_clip_state[0x1f7] = 0
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'heat')

        assert.equal(thinq.outbox.length, 1)
        const m = sentTlvs(thinq.outbox[0])
        assert.equal(m.get(0x1f9), 4, 'mode heat')
        assert.equal(m.get(0x1f7), 1, 'power attached, so the mode is not ignored')

        dev.drop()
    })

    test('fan and swing scales round-trip', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'high')
        assert.equal(sentTlvs(thinq.outbox[0]).get(0x1fa), 6)
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'swing_mode_command', 'on')
        assert.equal(sentTlvs(thinq.outbox[0]).get(0x322), 100, 'sweep is 100, not 1')

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1, 'queryCaps sent from constructor')
        dev.drop()
    })
})
