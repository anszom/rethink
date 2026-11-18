import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13B6AM_D_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13B6AM_D_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// Real frames captured from a DLE3500W through rethink-capture, each next to the LG cloud's own reading.
// The comments name the cloud fields that confirmed them.

// Downloaded position with Gym Clothes loaded: courseDryer27inchBase:"SPORTWEAR",
// smartCourseDryer27inchBase:"GYMCLOTHES". rec[6] holds the base course (0x0b), rec[21] the cycle (107).
const DOWNLOADED_GYM_CLOTHES = buf(
    'aa4030ec001b01003b003b1a000505000400000040a80000010064000064000000001b01001b001b0b000305000400000040a8000001006b00006b000000ccbb',
)

// courseDryer27inchBase:"RACKDRY" and "SMALLLOAD", the two courses RV13B6ES's table lacks.
const RACK_DRY = buf(
    'aa4030ec001b010029002903000303000400000040a80000000000000064000000001b010032003213000000000400000040a80000000000000064000000e5bb',
)
const SMALL_LOAD = buf(
    'aa4030ec001b010037003702000303000400000040a80000000000000064000000001b01001e001e09000305000400000040a80000000000000064000000f4bb',
)

// Time Dry starting to dry: timeDry:"TIMEDRY_40" is rec[10] = 3, temp:"TEMP_HIGH".
const TIME_DRY_40 = buf(
    'aa4030ec001b010028002812000005030400000040a80000000000000064000000001b320028002812000005030400000000a80000000100000064000000f1bb',
)

// End -> Wrinkle Care: state:"WRINKLECARE" (0x38), with wrinkleCare:"WRINKLECARE_ON".
const WRINKLE_CARE = buf(
    'aa4030ec001b040001000b120000050304e2000050a8000087330000006b000000001b3800010001120000050304e2000050a8000087040000006b000000c4bb',
)

// Flow Sense setting a few minutes into a Time Dry, then clearing at the next power-on.
const FLOW_SENSE_SET = buf(
    'aa4030ec001b32002d010012000005050400000000a90003020100000064000000001b32002d010012000005050400000000a900030a01000100640000003ebb',
)
const FLOW_SENSE_CLEARED = buf(
    'aa4030ec001b000001000100000000000400000040a80008330400010064000000001b010001000100000000000400000040a8000833000000006400000009bb',
)

function feed(frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new DUT(ha.asConnection(), thinq, META)
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID]
}

describe('RV13B6AM_D_US_WIFI', () => {
    test('a downloaded cycle is named from rec[21]', () => {
        const p = feed([DOWNLOADED_GYM_CLOTHES]).properties
        assert.equal(p.course, 'Downloaded (Gym Clothes)')
        assert.equal(p.dry_level, 'Normal')
        assert.equal(p.temp, 'High')
    })

    test('courses of its own table', () => {
        assert.equal(feed([RACK_DRY]).properties.course, 'Rack Dry')
        assert.equal(feed([SMALL_LOAD]).properties.course, 'Small Load')
    })

    test('Time Dry setting', () => {
        const p = feed([TIME_DRY_40]).properties
        assert.equal(p.status, 'Drying')
        assert.equal(p.course, 'Time Dry')
        assert.equal(p.time_dry_setting, 40)
        assert.equal(feed([RACK_DRY]).properties.time_dry_setting, 0)
    })

    test('Wrinkle Care phase', () => {
        const p = feed([WRINKLE_CARE]).properties
        assert.equal(p.status, 'Wrinkle care')
        assert.equal(p.wrinkle_care, 'ON')
    })

    test('Flow Sense', () => {
        assert.equal(feed([FLOW_SENSE_SET]).properties.flow_sense, 'ON')
        assert.equal(feed([FLOW_SENSE_SET, FLOW_SENSE_CLEARED]).properties.flow_sense, 'OFF')
    })
})
