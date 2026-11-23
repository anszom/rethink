import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/TLXA5CFPH'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'TLXA5CFPH'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '3.0.79' }

// Real wire frames captured from the washer while stepping through the front panel and running a short
// cycle. Each frame holds the previous and current 67-byte records; only the second is published.

// Power on: Cotton, cold, medium spin, 2 rinses, 17 min wash, Auto water level.
const POWER_ON = buf(
    'aaff200a00980008ac000100ec0086000308020e2e00000603000000003900390000002e00008b00000002110400000000000000020020300000000000000400000000000000000000000000000000000000000308020e2e0000060b000000003900000000002e01018b000000021104000000000000000208203000000000000004000000000000000000000000000000000000003a96bb',
)

// Warm, rinse dialled back to 0.
const WARM_NO_RINSE = buf(
    'aaff200a00980008b5000100ec008600030905002e0000060b000000005a00000000002e01018b0000000511040000000000000002082030000000000000040000000000000000000000000000000000000000030900002e0000060b000000001800000000002e01018b000000001104000000000000000208203000000000000004000000000000000000000000000000000000008d15bb',
)

// Quick Wash selected: its defaults are 1 rinse and a 3 min wash.
const QUICK_WASH = buf(
    'aaff200a00980008cf000100ec0086000308020e2e0000060b000000003900000000002e01018b00000002110400000000000000020820300000000000000400000000000000000000000000000000000000000308010e4a0000010b000000001800000000002e01018b0000000111040000000000000002082030000000000000040000000000000000000000000000000000000093a3bb',
)

// Duvet selected: its defaults are 3 rinses and a 25 min wash.
const DUVET = buf(
    'aaff200a00980008d0000100ec0086000308010e4a0000010b000000001800000000002e01018b00000001110400000000000000020820300000000000000400000000000000000000000000000000000000000508030e0900000a0b000000006c00000000002e01018b000000031104000000000000000208203000000000000004000000000000000000000000000000000000008773bb',
)

// Washing: the Auto water level has resolved to level 7 and the lid has locked.
const WASHING = buf(
    'aaff200a00980008d6000100ec0086000508030e0900000a0b000000006c00000000002e03038b00000003110400000000000000100900300000000000000400000000000000000000000000000000000000000508030e0900000906000000006a006a0000002e0b0b8b00000003110400000000000000100100300000000000000400000000000000000000000000000000000000854dbb',
)

// A few seconds after pausing, the lid unlocks.
const PAUSED_UNLOCKED = buf(
    'aaff200a00980008d9000100ec0086000508030e0900000906000000006a006a0000002e02028b00000003110400000000000000000100300000000000000400000000000000000000000000000000000000000508030e0900000906000000006a006a0000002e02028b00000003110400000000000000000000300000000000000400000000000000000000000000000000000000505cbb',
)

// Spin Only selected: no wash, no rinse, no temperature, no water level.
const SPIN_ONLY = buf(
    'aaff200a009800091e000100ec0086000309020eff00000602000000009300930000000001018b00000002110400000000000000020020300000000000000400000000000000000000000000000000000000000300000e4e0000000a000000000e000e0000002e01018b000000001104000000000000000200203000000000000004000000000000000000000000000000000000009635bb',
)

// Allergy Care selected: warm, water level 3, and a remaining time above 255 minutes.
const ALLERGY_CARE = buf(
    'aaff200a0098000924000100ec0086000308020e3e0000050b000000003600000000002e01018b00000002110400000000000000020820300000000000000400000000000000000000000000000000000000000109020e2d00000602000000011f011f0000002e01018b000000021104000000000010000200203000000000000004000000000000000000000000000000000000008a0dbb',
)

// Delicates selected: delicate spin, 6 min wash, water level 5.
const DELICATES = buf(
    'aaff200a009800092a000100ec0086000308020e720000060b000000003c00000000002e01018b0000000211040000000000000002082030000000000000040000000000000000000000000000000000000000030802125e00000204000000003900390000002e01018b000000021104000000000000000200203000000000000004000000000000000000000000000000000000002a57bb',
)

// Downloaded selected, after Rinse + Spin.
const DOWNLOADED = buf(
    'aaff200a009800092d000100ec0086000300010e370000000b000000001900000000002e01018b00000001110400000000000000020820300000000000000400000000000000000000000000000000000000000309020eff00000602000000009300930000000001018b000000021104000000000000000200203000000000000004000000000000000000000000000000000000006000bb',
)

// Single-record snapshot answering the status request, with Rinse + Spin selected.
const RINSE_SPIN_SNAPSHOT = buf(
    'aaff200a0055000918000100eb0043000300010e370000000b000000001900000000002e01018b000000011104000000000000000208203000000000000004000000000000000000000000000000000000006ad1bb',
)

const OFF = buf(
    'aaff200a00980008e4000100ec0086000508030e0900000906000000006a006a0001002e02028b00000003110400000000000000000000300000000000000400000000000000000000000000000000000000000508030e0900000906000000006a006a0001002e00008b0000000311040000000000000000000030000000000000040000000000000000000000000000000000000066bbbb',
)

function feed(...frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const frame of frames) thinq.emit('data', frame)
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('decodes the power-on defaults', () => {
        const p = feed(POWER_ON)
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Cotton')
        assert.equal(p.temp, 'Cold')
        assert.equal(p.spin, 'Medium')
        assert.equal(p.rinses_remaining, 2)
        assert.equal(p.wash_time, '17 min')
        assert.equal(p.water_level, 'Auto')
        assert.equal(p.remaining_time, 57)
        // bit 3 of the flags byte is set here (Auto water level), the lid is not locked
        assert.equal(p.lid_lock, 'OFF')
    })

    test('decodes panel changes', () => {
        const p = feed(WARM_NO_RINSE)
        assert.equal(p.temp, 'Warm')
        assert.equal(p.rinses_remaining, 0)
        assert.equal(p.remaining_time, 24)
    })

    test('decodes course changes along with the defaults they load', () => {
        let p = feed(QUICK_WASH)
        assert.equal(p.course, 'Quick Wash')
        assert.equal(p.rinses_remaining, 1)
        assert.equal(p.wash_time, '3 min')

        p = feed(DUVET)
        assert.equal(p.course, 'Duvet')
        assert.equal(p.rinses_remaining, 3)
        assert.equal(p.wash_time, '25 min')
        assert.equal(p.remaining_time, 108)

        p = feed(SPIN_ONLY)
        assert.equal(p.course, 'Spin Only')
        assert.equal(p.temp, 'Not selected')
        assert.equal(p.rinses_remaining, 0)
        assert.equal(p.wash_time, 'Not selected')
        assert.equal(p.water_level, 'Not selected')

        p = feed(ALLERGY_CARE)
        assert.equal(p.course, 'Allergy Care')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.water_level, 'Level 3')
        assert.equal(p.remaining_time, 287)

        p = feed(DELICATES)
        assert.equal(p.course, 'Delicates')
        assert.equal(p.spin, 'Delicate')
        assert.equal(p.wash_time, '6 min')
        assert.equal(p.water_level, 'Level 5')

        p = feed(DOWNLOADED)
        assert.equal(p.course, 'Downloaded')
        assert.equal(p.remaining_time, 147)
    })

    test('decodes the single-record snapshot', () => {
        const p = feed(RINSE_SPIN_SNAPSHOT)
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Rinse + Spin')
        assert.equal(p.rinses_remaining, 1)
        assert.equal(p.wash_time, 'Not selected')
        assert.equal(p.remaining_time, 25)
    })

    test('decodes a running cycle with the lid locked', () => {
        const p = feed(WASHING)
        assert.equal(p.status, 'Washing')
        assert.equal(p.water_level, 'Level 7')
        assert.equal(p.remaining_time, 106)
        assert.equal(p.initial_time, 106)
        assert.equal(p.lid_lock, 'ON')
    })

    test('tracks the lid unlocking after a pause', () => {
        const p = feed(PAUSED_UNLOCKED)
        assert.equal(p.status, 'Paused')
        assert.equal(p.lid_lock, 'OFF')
    })

    test('reports off and clears the stale times', () => {
        const p = feed(OFF)
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
    })
})
