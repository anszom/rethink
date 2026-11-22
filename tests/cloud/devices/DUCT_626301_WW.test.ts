import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/DUCT_626301_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'DUCT_626301_WW'
const META: Metadata = {
    modelId: MODEL_ID,
    modelName: MODEL_ID,
    swVersion: '626301',
}

function makeReadyDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)

    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })

    // Representative state captured from the real DUCT_626301_WW:
    // power=off, mode=cool, fan=low, setpoint=24 C.
    dev.raw_clip_state[0x1f7] = 0
    dev.raw_clip_state[0x1f9] = 0
    dev.raw_clip_state[0x1fa] = 2
    dev.raw_clip_state[0x1fe] = 48

    dev.initMakeSetConfig()

    // Ignore constructor/configuration queries; tests below care only about
    // packets caused by HA commands.
    thinq.resetRecorder()

    return { ha, thinq, dev }
}

function packetTLVs(packet: Buffer) {
    return TLV.parse(packet.subarray(11, packet.length - 2))
}

function valueFor(packet: Buffer, id: number) {
    return packetTLVs(packet).find(({ t }) => t === id)?.v
}

describe(MODEL_ID, () => {
    test('exposes the three fan modes supported by the ducted unit', () => {
        const { ha, dev } = makeReadyDevice()

        const climate = ha.devices[DEVICE_ID]!.config!.components.climate as Record<string, unknown>
        assert.deepEqual(climate.fan_modes, ['low', 'medium', 'high'])

        dev.drop()
    })

    test('maps low, medium and high fan modes to 2, 4 and 6', () => {
        const { ha, thinq, dev } = makeReadyDevice()

        for (const [mode, expected] of [
            ['low', 2],
            ['medium', 4],
            ['high', 6],
        ] as const) {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', mode)

            assert.equal(thinq.outbox.length, 1)
            assert.equal(valueFor(thinq.outbox[0], 0x1fa), expected)
        }

        dev.drop()
    })

    test('selecting an operating mode explicitly powers on the unit', () => {
        const { ha, thinq, dev } = makeReadyDevice()

        assert.equal(dev.raw_clip_state[0x1f7], 0)

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(valueFor(thinq.outbox[0], 0x1f7), 1)
        assert.equal(valueFor(thinq.outbox[0], 0x1f9), 0)
        assert.equal(valueFor(thinq.outbox[0], 0x1fa), 2)
        assert.equal(valueFor(thinq.outbox[0], 0x1fe), 48)

        dev.drop()
    })

    test('selecting off sends power off', () => {
        const { ha, thinq, dev } = makeReadyDevice()

        dev.raw_clip_state[0x1f7] = 1
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(valueFor(thinq.outbox[0], 0x1f7), 0)

        dev.drop()
    })
})
