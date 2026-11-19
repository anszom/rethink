import assert from 'node:assert/strict'
import { test } from 'node:test'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const MODEL_ID = 'RV13B6AM_D_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.10.89' }

// Captured from the DLE3500W while changing courses on the panel.
const NORMAL = buf(
    'aa4030ec001b010001000100000000000000000040a8000b580000000069000000001b010039003903000303000000000040aa000b58000000006900000070bb',
)
const AIR_DRY = buf(
    'aa4030ec001b01001c001c05000302000000000040a8000b580000000069000000001b01001e001e11000000000000000040a8000b58000000006900000060bb',
)
const SPEED_DRY = buf(
    'aa4030ec001b01001e001e11000000000000000040a8000b580000000069000000001b010019001910000005000000000040a8000b5800000000690000006fbb',
)
const WRINKLE_CARE_ON = buf(
    'aa4030ec001b010019001910000005000000000000a8000b580000000069000000001b010019001910000005000000000010a8000b58000000006900000091bb',
)
const WRINKLE_CARE_OFF = buf(
    'aa4030ec001b010019001910000005000000000010a8000b580000000069000000001b010019001910000005000000000000a8000b58000000006900000091bb',
)
const POWER_OFF = buf(
    'aa4030ec001b010019001910000005000000000000a8000b580000000069000000001b000019001900000000000000000000a8000b580100000069000000cabb',
)
const STARTS_DRYING = buf(
    'aa4030ec001b01001e001e11000000000000000040a8000b580000000069000000001b32001e001e11000000000000000000a800000001000000690000009abb',
)
const PAUSES = buf(
    'aa4030ec001b32001e001e11000000000000000000a80000000100000069000000001b03001e001e11000000000000000040a80000003200000069000000f5bb',
)

// From the annotated DLE3500W capture, after each panel or ThinQ app action.
const DRY_LEVEL_MORE = buf(
    'aa4030ec001b010036003601000305000000000000a80000000000000069000000001b010101010101000405000000000000a80000000000000069000000b6bb',
)
const DRY_LEVEL_VERY = buf(
    'aa4030ec001b010101010101000405000000000000a80000000000000069000000001b01010a010a01000505000000000000a80000000000000069000000dabb',
)
const DRY_LEVEL_DAMP = buf(
    'aa4030ec001b01010a010a01000505000000000000a80000000000000069000000001b010026002601000105000000000000a8000000000000006900000081bb',
)
const DRY_LEVEL_LESS = buf(
    'aa4030ec001b010026002601000105000000000000a80000000000000069000000001b01002c002c01000205000000000000a8000000000000006900000046bb',
)
const DRY_LEVEL_NORMAL = buf(
    'aa4030ec001b01002c002c01000205000000000000a80000000000000069000000001b010036003601000305000000000000a8000000000000006900000060bb',
)
const TIME_DRY_40 = buf(
    'aa4030ec001b010036003601000305000000000000a80000000000000069000000001b010028002812000005030000000000a800000000000000690000006abb',
)
const TIME_DRY_60 = buf(
    'aa4030ec001b010028002812000005030000000000a80000000000000069000000001b010100010012000005050000000000a80000000000000069000000bdbb',
)
const TIME_DRY_20 = buf(
    'aa4030ec001b010100010012000005050000000000a80000000000000069000000001b010014001412000005010000000000a80000000000000069000000ebbb',
)
const RACK_DRY = buf(
    'aa4030ec001b010019001910000005000000000000a80000000000000069000000001b010032003213000000000000000000a800000000000000690000004bbb',
)
const ENERGY_SAVER_OFF = buf(
    'aa4030ec001b010039003903000303000000000000aa0000000000000069000000001b010029002903000303000000000000a800000000000000690000006dbb',
)
const ENERGY_SAVER_ON = buf(
    'aa4030ec001b010029002903000303000000000000a80000000000000069000000001b010039003903000303000000000000aa00000000000000690000006dbb',
)
const DAMP_DRY_SIGNAL_ON = buf(
    'aa4030ec001b010039003903000303000000000000aa0000000000000069000000001b010039003903000303000000000008aa000000000000006900000037bb',
)
const DAMP_DRY_SIGNAL_OFF = buf(
    'aa4030ec001b010039003903000303000000000008aa0000000000000069000000001b010039003903000303000000000000aa000000000000006900000037bb',
)
const TEMP_LOW = buf(
    'aa4030ec001b010019001910000005000000000000a80000000000000069000000001b010019001910000002000000000000a80000000000000069000000bebb',
)
const TEMP_MEDIUM = buf(
    'aa4030ec001b010019001910000002000000000000a80000000000000069000000001b010019001910000003000000000000a80000000000000069000000bcbb',
)
const TEMP_HIGH = buf(
    'aa4030ec001b010019001910000003000000000000a80000000000000069000000001b010019001910000005000000000000a80000000000000069000000b9bb',
)
const TIME_ADJUSTED_UP = buf(
    'aa4030ec001b010019001910000005000000000000a80000000000000069000000001b01001a001a10000005000001000000a80000000000000069000000a4bb',
)
const TIME_ADJUSTMENT_RESET = buf(
    'aa4030ec001b01001a001a10000005000001000000a80000000000000069000000001b010019001910000005000000000000a80000000000000069000000a4bb',
)
const TIME_ADJUSTED_DOWN = buf(
    'aa4030ec001b010019001910000005000000000000a80000000000000069000000001b0100180018100000050000ff000000a80000000000000069000000bebb',
)
const POWER_OFF_FROM_APP = buf(
    'aa4030ec001b0100180018100000050000ff000000a80000000000000069000000001b000018001800000000000000000000a8000000010000006900000081bb',
)
const REMOTE_START_ON = buf(
    'aa4030ec001b010018001800000000000000000040a80000000000000069000000001b010018001800000000000000000040a9000000000000006900000014bb',
)
const REMOTE_START_OFF = buf(
    'aa4030ec001b010018001800000000000000000040a90000000000000069000000001b010018001800000000000000000040a8000000000000006900000014bb',
)

function connectDryer() {
    const ha = new MockHAConnection()
    const dryer = new MockThinq2Device('dryer', META)
    new Bridge(ha.asConnection()).newDevice(dryer)
    assert.ok(dryer.managed)
    return { ha, dryer, state: ha.devices[dryer.id].properties }
}

test('publishes the current course and panel time for DLE3500W status frames', () => {
    const { dryer, state } = connectDryer()
    for (const [frame, course, minutes] of [
        [NORMAL, 'Normal', 57],
        [AIR_DRY, 'Air Dry', 30],
        [SPEED_DRY, 'Speed Dry', 25],
        [RACK_DRY, 'Rack Dry', 50],
        [
            buf(
                'aa4030ec001b01001e001e00000000000000000040a80000000000000069000000001b010020002004000303000000000040a8000000000000006900000033bb',
            ),
            'Perm Press',
            32,
        ],
        [
            buf(
                'aa4030ec001b010020002004000303000000000040a80000000000000069000000001b01001c001c05000302000000000040a8000000000000006900000039bb',
            ),
            'Delicates',
            28,
        ],
        [
            buf(
                'aa4030ec001b01001e001e11000000000000000040a80000000000000069000000001b01003200320d000302000000000040a8000000006900006900000059bb',
            ),
            'Downloaded',
            50,
        ],
        [
            buf(
                'aa4030ec001b01003200320d000302000000000040a80000000069000069000000001b01001e001e09000305000000000040a8000000000000006900000059bb',
            ),
            'Small Load',
            30,
        ],
        [
            buf(
                'aa4030ec001b01001e001e09000305000000000040a80000000000000069000000001b010037003702000303000000000040a80000000000000069000000f6bb',
            ),
            'Towels',
            55,
        ],
        [
            buf(
                'aa4030ec001b010037003702000303000000000040a80000000000000069000000001b010037003707000303000000000040a8000000000000006900000084bb',
            ),
            'Bedding',
            55,
        ],
        [
            buf(
                'aa4030ec001b010037003707000303000000000040a80000000000000069000000001b010036003601000305000000000040a8000000000000006900000085bb',
            ),
            'Heavy Duty',
            54,
        ],
    ] as const) {
        dryer.inject(frame)
        assert.equal(state.power, 'ON')
        assert.equal(state.status, 'Standby')
        assert.equal(state.course, course)
        assert.equal(state.remaining_time, minutes)
    }
})

test('tracks Wrinkle Care changes independently of the previous status record', () => {
    const { dryer, state } = connectDryer()
    dryer.inject(WRINKLE_CARE_ON)
    assert.equal(state.wrinkle_care, 'ON')
    dryer.inject(WRINKLE_CARE_OFF)
    assert.equal(state.wrinkle_care, 'OFF')
})

test('clears the course and remaining time when the dryer powers off', () => {
    const { dryer, state } = connectDryer()
    dryer.inject(SPEED_DRY)
    dryer.inject(POWER_OFF)
    assert.equal(state.power, 'OFF')
    assert.equal(state.status, 'Off')
    assert.equal(state.course, 'None')
    assert.equal(state.remaining_time, 0)
})

test('reports Drying and Paused during an Air Dry cycle', () => {
    const { dryer, state } = connectDryer()
    dryer.inject(STARTS_DRYING)
    assert.equal(state.status, 'Drying')
    assert.equal(state.course, 'Air Dry')
    assert.equal(state.remaining_time, 30)

    dryer.inject(PAUSES)
    assert.equal(state.status, 'Paused')
    assert.equal(state.remaining_time, 30)
})

test('reports the selected temperature and dry level', () => {
    const { dryer, state } = connectDryer()
    for (const [frame, temperature] of [
        [TEMP_LOW, 'Low'],
        [TEMP_MEDIUM, 'Medium'],
        [TEMP_HIGH, 'High'],
    ] as const) {
        dryer.inject(frame)
        assert.equal(state.temp, temperature)
    }
    for (const [frame, dryLevel] of [
        [DRY_LEVEL_MORE, 'More'],
        [DRY_LEVEL_VERY, 'Very'],
        [DRY_LEVEL_DAMP, 'Damp'],
        [DRY_LEVEL_LESS, 'Less'],
        [DRY_LEVEL_NORMAL, 'Normal'],
    ] as const) {
        dryer.inject(frame)
        assert.equal(state.dry_level, dryLevel)
    }
})

test('reports Time Dry presets separately from the remaining time', () => {
    const { dryer, state } = connectDryer()
    for (const [frame, minutes] of [
        [TIME_DRY_40, 40],
        [TIME_DRY_60, 60],
        [TIME_DRY_20, 20],
    ] as const) {
        dryer.inject(frame)
        assert.equal(state.course, 'Time Dry')
        assert.equal(state.time_dry_setting, minutes)
        assert.equal(state.remaining_time, minutes)
    }
    dryer.inject(SPEED_DRY)
    assert.equal(state.time_dry_setting, 0)
    assert.equal(state.remaining_time, 25)
})

test('reports positive and negative More/Less Time adjustments', () => {
    const { dryer, state } = connectDryer()
    for (const [frame, adjustment, minutes] of [
        [TIME_ADJUSTED_UP, 1, 26],
        [TIME_ADJUSTMENT_RESET, 0, 25],
        [TIME_ADJUSTED_DOWN, -1, 24],
    ] as const) {
        dryer.inject(frame)
        assert.equal(state.more_less_time, adjustment)
        assert.equal(state.remaining_time, minutes)
    }
})

test('reports independent Energy Saver and Damp Dry Signal settings', () => {
    const { dryer, state } = connectDryer()
    dryer.inject(ENERGY_SAVER_OFF)
    assert.equal(state.energy_saver, 'OFF')
    assert.equal(state.remaining_time, 41)

    dryer.inject(ENERGY_SAVER_ON)
    assert.equal(state.energy_saver, 'ON')
    assert.equal(state.remaining_time, 57)
    assert.equal(state.damp_dry_signal, 'OFF')

    dryer.inject(DAMP_DRY_SIGNAL_ON)
    assert.equal(state.damp_dry_signal, 'ON')
    assert.equal(state.energy_saver, 'ON')
    assert.equal(state.wrinkle_care, 'OFF')

    dryer.inject(DAMP_DRY_SIGNAL_OFF)
    assert.equal(state.damp_dry_signal, 'OFF')
    assert.equal(state.energy_saver, 'ON')
})

test('reports whether Remote Start is armed at the dryer', () => {
    const { dryer, state } = connectDryer()
    dryer.inject(REMOTE_START_ON)
    assert.equal(state.remote_start, 'ON')
    assert.equal(state.energy_saver, 'OFF')

    dryer.inject(REMOTE_START_OFF)
    assert.equal(state.remote_start, 'OFF')
})

test('Power Off sends the captured ThinQ command and waits for the dryer to report Off', () => {
    const { ha, dryer, state } = connectDryer()
    ha.setProperty(dryer.id, 'power_off', 'command', 'PRESS')
    assert.equal(dryer.outbox.length, 0)

    dryer.inject(TIME_ADJUSTED_DOWN)
    ha.setProperty(dryer.id, 'power_off', 'command', 'ON')
    assert.equal(dryer.outbox.length, 0)

    ha.setProperty(dryer.id, 'power_off', 'command', 'PRESS')
    assert.deepEqual(dryer.outbox, [buf('aa09f0240101009cbb')])
    assert.equal(state.power, 'ON')

    dryer.inject(POWER_OFF_FROM_APP)
    assert.equal(state.status, 'Off')
    assert.equal(state.power, 'OFF')
    assert.equal(state.remaining_time, 0)

    ha.setProperty(dryer.id, 'power_off', 'command', 'PRESS')
    assert.equal(dryer.outbox.length, 1)
})
