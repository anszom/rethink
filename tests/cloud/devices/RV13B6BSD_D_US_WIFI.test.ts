import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13B6BSD_D_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13B6BSD_D_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames captured live from the appliance (a DLEX3900B / RV13B6JSD.ABLEEUS, which
// self-reports modelId "RV13B6BSD_D_US_WIFI") via the rethink-agent MCP tools, cross-checked against the
// LG cloud's own decoded washerDryer state at matching timestamps — not guessed from static analysis.

// A single-record 0xEB frame, powered off with nothing selected (phase Off, course/dry-level/temp all
// their zero/none sentinel). Same field layout as 0xEC's current-state record.
const EB_IDLE = buf('aa2330eb001b0000010001000000000004000000402800065f04000000640000006bbb')

// Off -> Initial (dial-browsing/settings-selection begins).
const OFF_TO_INITIAL = buf(
    'aa4030ec001b0000010001000000000004000000402800065f0400000064000000001b0100010001000000000004000000402800000000000000640000001fbb',
)

// Course identifier (offset 6) confirmed across several programs, each cross-checked against the cloud's
// courseDryer27inchBase at matching timestamps.
const COURSE_NORMAL = buf(
    'aa4030ec001b010001000100000000000400000000280000000000000064000000001b010029002903000304000400000000280000000000000064000000e9bb',
)
const COURSE_BEDDING = buf(
    'aa4030ec001b010039003903000304000400000000aa0000000000000064000000001b010037003707000303000400000000a8000000000000006400000002bb',
)
const COURSE_SMALL_LOAD = buf(
    'aa4030ec001b010037003707000303000400000000a80000000000000064000000001b01001e001e09000305000400000000a8000000000000006400000073bb',
)
// Also demonstrates Small Load's Selecting/Initial -> Drying transition, matching the cloud's
// preState:"INITIAL" / state:"DRYING".
const SMALL_LOAD_STARTS_DRYING = buf(
    'aa4030ec001b01001e001e09000305000400000000a80000000000000064000000001b32001e001e09000305000400000000a800000001000000640000007fbb',
)

// Paused (from Small Load) -> Initial with Antibacterial selected. Confirms Dry level 'Very' (offset 8 =
// 5) and Temp 'High' (offset 9 = 5), cross-checked against the cloud's DRYLEVEL_VERYDRY/TEMP_HIGH for
// the Antibacterial course.
const PAUSE_THEN_ANTIBACTERIAL_SELECTED = buf(
    'aa4030ec001b03001e001e09000305000400000040a80000063200000064000000001b01010a010a08000505000400000040a80000060300000064000000c3bb',
)

// Heavy Duty selected, then Normal selected with Energy Saver turned on in the same step — matching the
// cloud's courseDryer27inchBase:"NORMAL", energySaver:"ENERGYSAVER_ON".
const HEAVY_DUTY_THEN_NORMAL_ENERGY_SAVER_ON = buf(
    'aa4030ec001b010036003601000305000400000040a80000060300000064000000001b010039003903000304000400000040aa0000060300000064000000b6bb',
)

// A real Normal/Energy-Saver-on run: Drying (remaining-time ticking down while initial-time stays fixed,
// the genuine separate-field behavior this model has and the washer doesn't) -> Cooling -> a brief Off
// blip -> End -> final settled Off (course/settings reset to their zero sentinel). Every phase and time
// value here was cross-checked against the cloud at matching timestamps.
const STARTS_DRYING = buf(
    'aa4030ec001b010039003903000304000400000040aa0000060300000064000000001b320039003903000304000400000000aa000000010000006400000080bb',
)
const REMAINING_TICKS_DOWN = buf(
    'aa4030ec001b320039003903000304000400000000aa0000000100000064000000001b320038003903000304000400000000aa000004010000006400000094bb',
)
const DRYING_TO_COOLING = buf(
    'aa4030ec001b320038003903000304000400000000aa0000040100000064000000001b330001000203000304000400000000aa0000063200000064000000dfbb',
)
const COOLING_TO_OFF_BLIP = buf(
    'aa4030ec001b330001000303000304000400000000aa0000083200000064000000001b000001000303000304000400000000aa00000a330000006400000073bb',
)
const OFF_BLIP_TO_END = buf(
    'aa4030ec001b000001000303000304000400000000aa00000a3300000064000000001b040001000303000304000400000040aa00000a000000006400000052bb',
)
const END_TO_FINAL_OFF = buf(
    'aa4030ec001b040001000303000304000400000040aa00000a0000000064000000001b000001000100000000000400000040a800000a04000000640000005fbb',
)

// Bedding selected, then Heavy Duty selected with Turbo Steam turned on in the same step — matching the
// cloud's courseDryer27inchBase:"HEAVYDUTY", turboSteam:"TURBOSTEAM_ON".
const BEDDING_THEN_HEAVY_DUTY_TURBO_STEAM_ON = buf(
    'aa4030ec001b010037003707000303000400000000a80000000000000064000000001b010036003601000305000400000000ac000000000000006400000007bb',
)
// Turbo Steam confirmed active into the Drying phase.
const HEAVY_DUTY_DRYING_TURBO_STEAM_ON = buf(
    'aa4030ec001b010036003601000305000400000000ac0000000000000064000000001b320036003601000305000400000000ac0000000100000064000000d7bb',
)

// Damp Dry Signal toggled on (while paused with settings open, mid-Drying-adjacent), matching the cloud's
// dampDrySignal:"DAMPDRYSIGNAL_ON".
const DAMP_DRY_SIGNAL_ON = buf(
    'aa4030ec001b010036003601000305000400000040280000430300000064000000001b01003600360100030500040000004828000043030000006400000009bb',
)
// Damp Dry Signal toggled back off, in the same step as reselecting Normal — matching the cloud's
// courseDryer27inchBase:"NORMAL", dampDrySignal:"DAMPDRYSIGNAL_OFF".
const DAMP_DRY_SIGNAL_OFF_NORMAL_SELECTED = buf(
    'aa4030ec001b030036003601000305000400000048280000113200000064000000001b01002900290300030400040000004028000011030000006400000045bb',
)

// Child Lock engaged (Antibacterial, paused), matching the cloud's childLock:"CHILDLOCK_ON".
const CHILD_LOCK_ON = buf(
    'aa4030ec001b03010a010a080005050004000000402800000e3200000064000000001b03010a010a080005050004000000412800000e3200000064000000e6bb',
)

// A real remote-start round trip: the LG app's Start command lands (captured verbatim as the outgoing
// packet below) and the phase flips Initial -> Drying, matching the cloud's state:"DRYING".
const APP_START_COMMAND = buf('aa1bf0260300000400000000410003000000000300d700000055bb')
const REMOTE_STARTS_DRYING = buf(
    'aa4030ec001b010029002903000304000400000040290000240000000064000000001b3200010001030003040004d700000029000000010000006400000060bb',
)

// A real remote-power-off round trip: the LG app's Power Off command (identical to the washer's own
// remote-power-off command, byte for byte) lands and the phase drops straight to Off, with the
// course/settings bytes reset to their zero sentinel.
const APP_POWEROFF_COMMAND = buf('aa09f0240101009cbb')
const REMOTE_POWEROFF = buf(
    'aa4030ec001b3201070108030003040004d70000002900006c0100000064000000001b0001070107000000000004000000402800009932000000640000005cbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('RV13B6BSD_D_US_WIFI', () => {
    test('0xEB single-record frames decode with the same offsets as 0xEC, seen right after reconnect', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_IDLE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'unknown') // course byte is 0 — nothing selected yet
    })

    test('Off -> Initial as dial-browsing begins', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF_TO_INITIAL)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
    })

    test('the course byte (offset 6) identifies each program, and Initial -> Drying on Start', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', COURSE_NORMAL)
        assert.equal(p.course, 'Normal')
        assert.equal(p.dry_level, 'Normal')
        assert.equal(p.temp, 'Mid High')

        thinq.emit('data', COURSE_BEDDING)
        assert.equal(p.course, 'Bedding')
        assert.equal(p.temp, 'Medium')

        thinq.emit('data', COURSE_SMALL_LOAD)
        assert.equal(p.course, 'Small Load')
        assert.equal(p.temp, 'High')

        thinq.emit('data', SMALL_LOAD_STARTS_DRYING)
        assert.equal(p.status, 'Drying')
        assert.equal(p.course, 'Small Load')
    })

    test('pause, then re-selecting Antibacterial shows Dry level Very and Temp High', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', PAUSE_THEN_ANTIBACTERIAL_SELECTED)
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'Antibacterial')
        assert.equal(p.dry_level, 'Very')
        assert.equal(p.temp, 'High')
    })

    test('Energy Saver and Turbo Steam toggle independently of course selection', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', HEAVY_DUTY_THEN_NORMAL_ENERGY_SAVER_ON)
        assert.equal(p.course, 'Normal')
        assert.equal(p.energy_saver, 'ON')

        thinq.emit('data', BEDDING_THEN_HEAVY_DUTY_TURBO_STEAM_ON)
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.turbo_steam, 'ON')

        thinq.emit('data', HEAVY_DUTY_DRYING_TURBO_STEAM_ON)
        assert.equal(p.status, 'Drying')
        assert.equal(p.turbo_steam, 'ON')
    })

    test('Damp Dry Signal toggles on and off', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', DAMP_DRY_SIGNAL_ON)
        assert.equal(p.damp_dry_signal, 'ON')

        thinq.emit('data', DAMP_DRY_SIGNAL_OFF_NORMAL_SELECTED)
        assert.equal(p.course, 'Normal')
        assert.equal(p.damp_dry_signal, 'OFF')
    })

    test('Child Lock engages', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
    })

    test('a full run: Drying with a genuine separate initial-time estimate, Cooling, End, and final Off', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties

        thinq.emit('data', STARTS_DRYING)
        assert.equal(p.status, 'Drying')
        assert.equal(p.remaining_time, 57)
        assert.equal(p.initial_time, 57)

        thinq.emit('data', REMAINING_TICKS_DOWN)
        assert.equal(p.remaining_time, 56)
        assert.equal(p.initial_time, 57) // stays fixed while remaining_time counts down

        thinq.emit('data', DRYING_TO_COOLING)
        assert.equal(p.status, 'Cooling')
        assert.equal(p.remaining_time, 1)

        thinq.emit('data', COOLING_TO_OFF_BLIP)
        assert.equal(p.status, 'Off') // a brief settle before the End notification

        thinq.emit('data', OFF_BLIP_TO_END)
        assert.equal(p.status, 'End')

        thinq.emit('data', END_TO_FINAL_OFF)
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.initial_time, 0)
        assert.equal(p.course, 'unknown')
    })

    test('a real remote-start round trip flips Initial -> Drying', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', APP_START_COMMAND) // the actual command captured from the LG app, for reference
        thinq.emit('data', REMOTE_STARTS_DRYING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Drying')
    })

    test('a real remote-power-off round trip drops straight to Off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', APP_POWEROFF_COMMAND) // identical, byte for byte, to the washer's own command
        thinq.emit('data', REMOTE_POWEROFF)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.course, 'unknown')
    })

    test('unknown frame type and non-envelope frames are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COURSE_NORMAL)
        const before = ha.devices[DEVICE_ID].properties.status
        thinq.emit('data', buf('aa09307200c9004bbb')) // 0x72 heartbeat
        thinq.emit('data', buf('001122')) // not an AA..BB envelope
        assert.equal(ha.devices[DEVICE_ID].properties.status, before)
    })
})
