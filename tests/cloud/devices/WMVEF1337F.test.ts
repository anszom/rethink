import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WMVEF1337F'
import WMVEL2137 from '@/cloud/devices/WMVEL2137'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WMVEF1337F'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WMVEF1337F', swVersion: '20240722' }

// Real frames from an LG over-the-range microwave reporting modelId WMVEF1337F (thinq2 deviceType 302,
// clip_ble_v2.9.242), connected to rethink with no LG cloud. Each EC frame below is the appliance's
// own report after a vent/lamp command was injected from the management panel; every command was
// acknowledged with AA084100430063BB first.
//
// Frames: AA 70 41 EC <53B previous record> <53B current record> <cksum> BB
//         AA 3B 41 EB <53B current record> <cksum> BB

// The 41 EB reply to the F0 ED status query: idle, vent off, lamp off.
const INITIAL_STATUS = buf(
    'AA3B41EB003100015500000000000000FF030C000000000000000000000000000000C300000000530000808080800100000000000000000000E8BB',
)
// lamp -> 1 from off.
const LAMP_LOW = buf(
    'AA7041EC003100015500000000000000FF030C000000000000000000000000000000C300000000530000808080800100000000000000000000003000015500000000000000FF030C000000000000000000000000000000C300000000531000808080800100000000000000000000FBBB',
)
// lamp -> 2 from off.
const LAMP_HIGH = buf(
    'AA7041EC003000015500000000000000FF030C000000000000000000000000000000C300000000530000808080800100000000000000000000003000015500000000000000FF030C000000000000000000000000000000C300000000532000808080800100000000000000000000E8BB',
)
// vent -> 4 while the lamp sat at 1.
const VENT_4_LAMP_LOW = buf(
    'AA7041EC003000015500000000000000FF030C000000000000000000000000000000C300000000531300808080800100000000000000000000003000015500000000000000FF030C000000000000000000000000000000C30000000053140080808080010000000000000000000091BB',
)
// vent and lamp both off from vent 3 / lamp 1.
const ALL_OFF = buf(
    'AA7041EC003000015500000000000000FF030C000000000000000000000000000000C300000000531300808080800100000000000000000000003000015500000000000000FF030C000000000000000000000000000000C300000000530000808080800100000000000000000000E5BB',
)
// A one-minute Microwave cook at full power, started on the front panel: the start, the first
// tick, the pause at 0:26 and the cancel that followed.
const COOK_START = buf(
    'AA7041EC003000015500000000000000FF030D000000000000000000000000000000C300000000530000808080800100000000000000000000023000004401000000000A00FF030D000100000100000000000000000000C700010000530001808080800100000000000000000000F7BB',
)
const COOK_TICK = buf(
    'AA7041EC023000004401000000000A00FF030D000100000100000000000000000000C700010000530001808080800100000000000000000000023000004401000000000A00FF030D00003B000100000000000000000000C7000100005300018080808001000000000000000000008ABB',
)
const COOK_PAUSED = buf(
    'AA7041EC023000004401000000000A00FF030D00003B000100000000000000000000C700010000530001808080800100000000000000000000043000004401000000000A00FF030D00001A000100000000000000000000C700010000530001808080800100000000000000000000AFBB',
)
const COOK_CANCELLED = buf(
    'AA7041EC043000004401000000000A00FF030D00001A000100000000000000000000C700010000530001808080800100000000000000000000003000015500000000000000FF030D000000000000000000000000000000C300000000530000808080800100000000000000000000E8BB',
)
// The 41 0A content-sync envelope (sequence 0x0001, inner type 0x85, "302-1".."302-4") the appliance
// sends on connect and repeats every 5 s until it is acked.
const CONTENT_SYNC = buf(
    'AAFF410A003000000100010A85001E0004053330322D3100053330322D3200053330322D3300053330322D340088EABB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config matches WMVEL2137: four vent speeds, two lamp levels', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fan_power.platform, 'fan')
        assert.equal(components.fan_power.speed_range_max, 4)
        assert.equal(components.light_power.platform, 'light')
        assert.equal(components.light_power.brightness_scale, 2)
    })

    test('start() sends the same status query as WMVEL2137', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(hex(thinq.outbox[0]), 'AA1CF0ED114101000000180E111718191A1A1B0000000000000091BB')
    })

    test('the 53-byte EB reply decodes as idle with vent and lamp off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL_STATUS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Idle')
        assert.equal(props.fan_speed, 0)
        assert.equal(props.fan_power, 'OFF')
        assert.equal(props.light_level, 0)
        assert.equal(props.light_power, 'OFF')
    })

    test('EC reports carry the vent and lamp levels in the same nibbles as WMVEL2137', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', LAMP_LOW)
        assert.equal(props().light_level, 1)
        assert.equal(props().light_power, 'ON')
        assert.equal(props().fan_speed, 0)

        thinq.emit('data', LAMP_HIGH)
        assert.equal(props().light_level, 2)

        thinq.emit('data', VENT_4_LAMP_LOW)
        assert.equal(props().fan_speed, 4)
        assert.equal(props().fan_power, 'ON')
        assert.equal(props().light_level, 1)

        thinq.emit('data', ALL_OFF)
        assert.equal(props().fan_speed, 0)
        assert.equal(props().fan_power, 'OFF')
        assert.equal(props().light_level, 0)
        assert.equal(props().light_power, 'OFF')
    })

    test('a manual cook decodes at the WMVEL2137 offsets: start, countdown, pause, cancel', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', COOK_START)
        assert.equal(props().status, 'Cooking')
        assert.equal(props().cook_mode, 'Microwave')
        assert.equal(props().power_level, 100)
        assert.equal(props().cook_time, 60)
        assert.equal(props().remaining_time, 60)

        thinq.emit('data', COOK_TICK)
        assert.equal(props().remaining_time, 59)
        assert.equal(props().cook_time, 60, 'the cook length holds while the remaining time ticks')

        thinq.emit('data', COOK_PAUSED)
        assert.equal(props().status, 'Paused')
        assert.equal(props().remaining_time, 26)

        thinq.emit('data', COOK_CANCELLED)
        assert.equal(props().status, 'Idle')
        assert.equal(props().cook_mode, 'Off')
        assert.equal(props().power_level, 0)
        assert.equal(props().cook_time, 0)
        assert.equal(props().remaining_time, 0)
    })

    // These exact bytes were sent to the real unit; it acked each and reported the matching state.
    test('vent and lamp commands are the ones the appliance accepted', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('light_level', '1')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220480800101808046BB')

        thinq.resetRecorder()
        dev.setProperty('fan_speed', '4')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401048080808043BB')

        // past the top speed: clamped to 4 rather than sent as 5, which the appliance turns into 3
        thinq.resetRecorder()
        dev.setProperty('fan_speed', '5')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401048080808043BB')
    })

    test('the content-sync envelope is acked by sequence; status records are not', () => {
        const { thinq } = makeDevice()
        thinq.resetRecorder()
        thinq.emit('data', CONTENT_SYNC)
        thinq.emit('data', INITIAL_STATUS)
        thinq.emit('data', LAMP_LOW)

        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, [AABBDevice.frame(buf('f0000a040001')).toString('hex').toUpperCase()])
        assert.deepEqual(thinq.outbox, [], 'acks are not sent as packets')
    })

    test('WMVEL2137 itself rejects these longer records', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        new WMVEL2137(ha.asConnection(), thinq, META)
        thinq.emit('data', INITIAL_STATUS)
        thinq.emit('data', LAMP_LOW)
        assert.equal(ha.devices[DEVICE_ID].properties.fan_speed, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.light_level, undefined)
    })
})
