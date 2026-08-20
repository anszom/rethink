import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/STUDIO_HOOD'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'STUDIO_HOOD'
const META: Metadata = { modelId: MODEL_ID, modelName: 'STUDIO_HOOD', swVersion: '1.0' }

// Real packet captures for an LG STUDIO_HOOD range hood (thinq2 deviceType 304), taken by
// wire-sniffing the live device while cycling the light (off -> 1 -> 2 -> off) and the fan
// (off -> 1..5 -> off), then confirmed against real hardware via direct packet injection.
// Frames: AA 1E 43 EC <12 prev> <12 cur> <cksum> BB
//   state block: [power][fanSpeed][fanTag=04?0][rsv][rsv][lightLevel][rsv x5][0x07]

const SAMPLE_ACK = buf('AA08430043006DBB')
const SAMPLE_DELTA_OFF_TO_LIGHT1 = buf('AA1E43EC00000000000000000000000701000000000100000000000752BB')
const SAMPLE_DELTA_LIGHT1_TO_LIGHT2 = buf('AA1E43EC0100000000010000000000070100000000020000000000075FBB')
const SAMPLE_DELTA_LIGHT2_TO_OFF = buf('AA1E43EC0100000000020000000000070000000000000000000000075DBB')
const SAMPLE_DELTA_OFF_TO_FAN1 = buf('AA1E43EC0000000000000000000000070101040000000000000000075EBB')
// fan running at speed 3, then a light-only command (fan fields zeroed) turns the fan OFF
// while setting light to 2 - confirms the device wants the full combined state on every
// write, not a delta (see notes in the device profile itself).
const SAMPLE_DELTA_FAN3_RESET_BY_LIGHT_CMD = buf('AA1E43EC01030400000000000000000701000000000200000000000745BB')
// reply to the start() status query: fan speed 1, light level 1, no "previous state" half
const SAMPLE_INITIAL_STATUS_FAN1_LIGHT1 = buf('AA1243EB010104000001000000000007ADBB')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config published on device creation with fan and light components', () => {
        const { ha } = makeDevice()
        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fan_power.platform, 'fan')
        assert.equal(components.fan_power.speed_range_min, 1)
        assert.equal(components.fan_power.speed_range_max, 5)
        assert.equal(components.light_power.platform, 'light')
        assert.equal(components.light_power.brightness_scale, 2)
    })

    test('light turned on to level 1', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_LIGHT1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.light_power, 'ON')
        assert.equal(props.light_level, 1)
        assert.equal(props.fan_power, 'OFF')
        assert.equal(props.fan_speed, 0)
    })

    test('light level 1 -> 2', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_LIGHT1_TO_LIGHT2)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.light_power, 'ON')
        assert.equal(props.light_level, 2)
    })

    test('light turned off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_LIGHT2_TO_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.light_power, 'OFF')
        assert.equal(props.light_level, 0)
    })

    test('fan turned on to speed 1', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_FAN1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fan_power, 'ON')
        assert.equal(props.fan_speed, 1) // raw device speed, not a percentage - see profile notes
        assert.equal(props.light_power, 'OFF')
    })

    test('a light-only command resets a running fan to off (device requires full combined state)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_FAN3_RESET_BY_LIGHT_CMD)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fan_power, 'OFF')
        assert.equal(props.fan_speed, 0)
        assert.equal(props.light_power, 'ON')
        assert.equal(props.light_level, 2)
    })

    test('generic command ack frames are ignored (no property changes)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_FAN1)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', SAMPLE_ACK)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('43 EB initial status (reply to start() query) decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_STATUS_FAN1_LIGHT1)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.fan_power, 'ON')
        assert.equal(props.fan_speed, 1)
        assert.equal(props.light_power, 'ON')
        assert.equal(props.light_level, 1)
    })

    test('start() sends the status query packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA12F0ED1141010000001804030400005ABB')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.fan_power, undefined)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.fan_power, undefined)
    })

    test('HA write fan_power=ON defaults to speed 1 and preserves light state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_LIGHT1) // light is already on at level 1
        thinq.resetRecorder()

        dev.setProperty('fan_power', 'ON')
        const pkt = thinq.outbox[0]
        // Frame: AA 0D F0 43 22 05 [fanFlag][fanSpeed][lightFlag][lightLevel] 00 <cksum> BB
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x43)
        assert.equal(pkt[2 + 4], 1) // fan flag
        assert.equal(pkt[2 + 5], 1) // fan speed defaults to 1
        assert.equal(pkt[2 + 6], 1) // light flag preserved
        assert.equal(pkt[2 + 7], 1) // light level preserved from prior state report
    })

    test('HA write fan_speed=3 (raw device speed, not a percentage) preserves light state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_LIGHT1_TO_LIGHT2) // light is on at level 2
        thinq.resetRecorder()

        dev.setProperty('fan_speed', '3')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2 + 4], 1)
        assert.equal(pkt[2 + 5], 3)
        assert.equal(pkt[2 + 6], 1)
        assert.equal(pkt[2 + 7], 2)
    })

    test('HA write fan_power=OFF zeroes only the fan fields, preserving light', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_FAN1)
        thinq.emit('data', SAMPLE_DELTA_LIGHT1_TO_LIGHT2) // light also on, at level 2
        thinq.resetRecorder()

        dev.setProperty('fan_power', 'OFF')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2 + 4], 0)
        assert.equal(pkt[2 + 5], 0)
        assert.equal(pkt[2 + 6], 1)
        assert.equal(pkt[2 + 7], 2)
    })

    test('HA write light_power=ON defaults to level 1 and preserves fan state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_FAN1) // fan is on at speed 1
        thinq.resetRecorder()

        dev.setProperty('light_power', 'ON')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2 + 4], 1)
        assert.equal(pkt[2 + 5], 1)
        assert.equal(pkt[2 + 6], 1)
        assert.equal(pkt[2 + 7], 1)
    })

    test('HA write light_level=2 preserves fan state', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_FAN1) // fan is on at speed 1
        thinq.resetRecorder()

        dev.setProperty('light_level', '2')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[2 + 4], 1)
        assert.equal(pkt[2 + 5], 1)
        assert.equal(pkt[2 + 6], 1)
        assert.equal(pkt[2 + 7], 2)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SAMPLE_DELTA_OFF_TO_LIGHT1)
        thinq.resetRecorder()

        dev.setProperty('nonsense', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
