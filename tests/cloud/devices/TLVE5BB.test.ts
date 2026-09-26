import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/TLVE5BB'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'TLVE5BB'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// Real wire frames captured from a WT21BWV6 while washing. Each frame holds the previous and current
// 50-byte records; only the second record should be published.
const RUNNING_87_TO_86 = buf(
    'aa ff 20 0a 00 76 00 9c 86 00 01 00 ec 00 64' +
        '00 05 08 03 0e 09 00 00 09 06 00 00 00 00 57 00 6a 00 15 00 2e 0b 0b 6f 00 00 00 03 2d 04 00 00 00 00 00 00 00 10 01 00 30 00 00 00 00 00 00 00 00 00' +
        '00 05 08 03 0e 09 00 00 09 06 00 00 00 00 56 00 6a 00 17 00 2e 0b 0b 6f 00 00 00 03 2d 04 00 00 00 00 00 00 00 10 01 00 30 00 00 00 00 00 00 00 00 00' +
        '17 c9 bb',
)

const END = buf(
    'aaff200a007600a0cd000100ec0064000508000e09000009060000000001006a0050002e0e0e6f000000002d040000000000000010010030000000000000000000000508000e09000009060000000001006a0055002e10106f000000002d0400000000000000000100300000000000000000001e67bb',
)

const END_UNLOCKED = buf(
    'aaff200a007600a0d4000100ec0064000508000e09000009060000000001006a0055002e10106f000000002d040000000000000000010030000000000000000000000508000e09000009060000000001006a0055002e10106f000000002d0400000000000000000000300000000000000000003a09bb',
)

const OFF = buf(
    'aaff200a007600a0dd000100ec0064000508000e09000009060000000001006a0055002e10106f000000002d040000000000000000000030000000000000000000000508000e09000009060000000001006a0055002e00006f000000002d04000000000000000000003000000000000000000033b6bb',
)

const OFF_SNAPSHOT = buf(
    'aaff200a004400a0fa000100eb0032000508000e09000009060000000001006a0055002e00006f000000002d040000000000000000000030000000000000000000d5a3bb',
)

function feed(...frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const frame of frames) thinq.emit('data', frame)
    return ha.devices[DEVICE_ID].properties
}

describe('TLVE5BB', () => {
    test('decodes the current record from a paired running update', () => {
        const p = feed(RUNNING_87_TO_86)
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Running')
        assert.equal(p.remaining_time, 86)
        assert.equal(p.initial_time, 106)
        assert.equal(p.energy, 23)
        assert.equal(p.soil, 'Heavy')
        assert.equal(p.temp, 'Cold')
        assert.equal(p.spin, 'Medium')
        assert.equal(p.rinses_remaining, 3)
        assert.equal(p.tub_clean_count, 45)
        assert.equal(p.buzzer, 'Very loud')
        assert.equal(p.lid_lock, 'ON')
    })

    test('reports the real end-of-cycle transition', () => {
        const p = feed(END)
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'End')
        assert.equal(p.remaining_time, 1)
        assert.equal(p.energy, 85)
        assert.equal(p.rinses_remaining, 0)
        assert.equal(p.lid_lock, 'ON')
    })

    test('tracks the lid unlocking while the washer remains in End', () => {
        const p = feed(END_UNLOCKED)
        assert.equal(p.status, 'End')
        assert.equal(p.lid_lock, 'OFF')
    })

    test('emits one completion notification on the transition into End', () => {
        const p = feed(RUNNING_87_TO_86, END, END_UNLOCKED)
        assert.equal(p.notification, JSON.stringify({ event_type: 'cycle_complete' }))
    })

    test('reports off and clears the stale remaining minute', () => {
        const p = feed(OFF)
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.energy, 85)
        assert.equal(p.lid_lock, 'OFF')
    })

    test('decodes the single-record snapshot sent after power-off', () => {
        const p = feed(OFF_SNAPSHOT)
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.energy, 85)
        assert.equal(p.lid_lock, 'OFF')
    })

    test('rejects frames whose declared record length does not match this model', () => {
        const malformed = Buffer.from(RUNNING_87_TO_86)
        malformed[13] = 0
        malformed[14] = 99
        assert.deepEqual(feed(malformed), {})
    })
})
