import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13D5JSD_D_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, captureLog } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13D5JSD_D_US'
const META: Metadata = { modelId: MODEL_ID, modelName: 'RV13D5JSD_D_US', swVersion: '0.0.0' }

// This dryer's real traffic over three days of captures (device 89711260-...) was only 0x31 (serial),
// 0x72 (heartbeat) and 0xE2 (end-of-cycle summary) — never the 0xEC/0xEB status records the handler
// was originally written for. All frames below are REAL, taken verbatim from those captures.

// 0x72 heartbeat: buf[3] flips between 0xC9 (running) and 0xC8 (paused/stopped), with a single
// transient 0x00 observed immediately before a 0xC8 at cycle end.
const HB_RUNNING = buf('AA09307200C9004BBB')
const HB_STOPPED = buf('AA09307200C80048BB')
const HB_TRANSIENT_ZERO = buf('AA09307200000000BB')

// 0xE2 end-of-cycle summaries. First: cycle 0x03, 1:03, Normal dry level, Med High temp (panel photo).
const E2_END_OF_CYCLE = buf('AA2330E2031B320103010303000304000000000000AB0001870100000072000000B2BB')
// Second: a 10-minute Steam Fresh cycle (code 0x15), no dry level, Med High temp.
// Third: Towels (code 0x02), 0:55, Normal dry level, Med High temp (user-reported, no photo).
const E2_TOWELS = buf('AA2330E2031B320037003702000304000000000000A90000B701000000720000002CBB')
// Fourth: Bedding (0x07), 1:05 estimate, Very dry level, Medium temp (panel photo); it stopped after
// under 4 minutes with only a dry towel inside, but the summary still carries the start estimate.
const E2_BEDDING = buf('AA2330E2031B320105010507000503000000000000A900000F010000007200000020BB')
// Fifth: Normal with Energy Saver OFF (panel photo), otherwise the same settings as E2_END_OF_CYCLE,
// which had Energy Saver on: 0:41, Normal dry level, Med High.
const E2_NORMAL_ENERGY_SAVER_OFF = buf('AA2330E2031B3200290029030003040000000000002904009D01000000720000009DBB')
// Sixth: Heavy Duty (0x01), 0:54, Normal dry level, High temp, TurboSteam lamp lit, Energy Saver off
// (panel photo). rec[17] = 0x2d: 0x04 is set only here — possibly TurboSteam, not yet confirmed.
const E2_HEAVY_DUTY_HIGH = buf('AA2330E2031B3200360036010003050000000000002D0000EC010000007200000065BB')
// Seventh: Towels, 0:49, Damp dry level, Med High, TurboSteam and Energy Saver off (panel photo).
const E2_TOWELS_DAMP = buf('AA2330E2031B32003100310200010400000000000029000012010000007200000013BB')
// Eighth (2026-09-24 17:34Z): Heavy Duty with TurboSteam again — rec[17] 0x04 set a second time.
const E2_HEAVY_DUTY_TURBO_STEAM_2 = buf('AA2330E2031B3200360036010003050000000000002D000010010000007200000001BB')
// Ninth (2026-09-24 17:56Z): Delicates (0x05), 0:15, dry level on the step between Damp and Normal
// (0x02, "Less"), temp 0x02 (Low, the course default), Reduce Static not active.
const E2_DELICATES_LESS = buf('AA2330E2031B32000F000F050002020000000000002900000E010000007200000055BB')
// Tenth (2026-09-24 18:15Z): Small Load (0x09), 0:35, dry level on the step between Normal and Very
// (0x04, "More"), High, Wrinkle Care lit — rec[16] = 0x10, zero on every other cycle.
const E2_SMALL_LOAD_WRINKLE_CARE = buf('AA2330E2031B32002300230900040500000000001029000013010000007200000013BB')
// Eleventh (2026-09-24 18:25Z): Sportswear (0x0b), 0:25, Normal, Medium, Reduce Static lit —
// rec[16] = 0x02, zero on every cycle without it.
const E2_SPORTSWEAR_REDUCE_STATIC = buf('AA2330E2031B32001900190B0003030000000000022900002401000005720000006CBB')
// Twelfth (2026-09-24 18:37Z): Perm. Press (0x04), 0:32, Normal, Medium, no options (panel photo).
const E2_PERM_PRESS = buf('AA2330E2031B32002000200400030300000000000029000017010000007200000079BB')
// Thirteenth (2026-09-24 18:43Z): Antibacterial (0x08), 1:10, Very, High — both locked by the cycle
// (panel photo). Stopped after 5 min with a dry item.
const E2_ANTIBACTERIAL = buf('AA2330E2031B32010A010A0800050500000000000029000014010000007200000052BB')
// Fourteenth (2026-09-24 19:30Z): Steam Sanitary (0x16), 0:31, no dry level, High (panel photo);
// TurboSteam lamp lit, but rec[17] 0x04 is clear, as on Steam Fresh.
const E2_STEAM_SANITARY = buf('AA2330E2031B32001F001F16000005000000000000290000A3010000007200000092BB')
// Fifteenth (2026-09-24 20:47Z): Air Dry (0x11, as in the map), 0:30, no dry level, temp 0x00 (no
// temp lamp lit — Air Dry has no heat) (panel photo).
const E2_AIR_DRY = buf('AA2330E2031B32001E001E110000000000000000002900007A0100000072000000C7BB')
// Sixteenth (2026-09-24 21:33Z): Manual Dry with Time Dry 40 min, Ultra Low (0x01, first sighting),
// Control Lock on (panel photo). rec[11] = 0x03, zero on every earlier cycle — probably the Time Dry
// step (20/30/40/50/60 lamps -> 40 = 3rd), not published; nothing else changed with the lock on.
const E2_MANUAL_TIME_DRY_ULTRA_LOW = buf('AA2330E2031B320028002812000001030000000000290000A3010000007200000081BB')
// Time Dry (Manual, 0x12) at 20 minutes (rec[11] = 0x01, High; panel photo) and at 40 minutes
// (rec[11] = 0x03, Ultra Low).
const E2_TIME_DRY_20 = buf('AA2330E2031B32001400141200000501000000000028000052010000007200000009BB')
const E2_TIME_DRY_40 = buf('AA2330E2031B320028002812000001030000000000290000A3010000007200000081BB')
// Speed Dry (0x10), a 25-minute timed cycle: High, no dry level (panel photo).
const E2_SPEED_DRY = buf('AA2330E2031B3200190019100000050000000000002900006601000000720000002DBB')
const E2_STEAM_CYCLE = buf('AA2330E2031B32000A000A15000004000000000000A90000420100000272000000E9BB')

// A real 0xEB single-record frame for the sibling RV13U6AM8W_D_US_WIFI model (identical processRecord
// offsets) — this dryer never actually sends these, but the dispatcher must still route them.
const EB_STARTING = buf('AA2330EB000001003C00000000000000000000000000000000000000000000000000BB')

// Same as HB_RUNNING but with the class byte changed from 0x30 (dryer) to 0x20 (washer) — must be
// ignored.
const HB_WRONG_CLASS = buf('AA09207200C9004BBB')

// Real 0x31 serial/identity frame, sent once per reconnect — currently undecoded.
const SERIAL = buf(
    'AA373031020153414133383936343432300000A814000080000000000002534141333839363433313400001FF200008000000000005DBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes power alongside the existing status/cycle/temp entities', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'status',
            'cycle',
            'cycle_time',
            'temp',
            'dry_level',
            'energy_saver',
            'turbo_steam',
            'wrinkle_care',
            'reduce_static',
            'time_dry',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // 0xEC/0xEB-only fields this model never sends must not be advertised (they'd sit at Unknown)
        for (const c of ['remaining_time', 'drum_running']) {
            assert.equal(components[c], undefined, `component ${c} absent`)
        }
    })

    test('0x72 heartbeat publishes power ON for 0xC9 and OFF for 0xC8 (real captures)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HB_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Running')

        thinq.emit('data', HB_STOPPED)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Off')
    })

    test('0x72 transient 0x00 value is treated as not-running (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HB_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')

        thinq.emit('data', HB_TRANSIENT_ZERO)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('0xE2 end-of-cycle summary publishes the last cycle settings (real captures)', () => {
        const { ha, thinq } = makeDevice()
        const props = ha.devices[DEVICE_ID].properties

        thinq.emit('data', E2_END_OF_CYCLE)
        assert.equal(props.cycle, 'Normal')
        assert.equal(props.cycle_time, 63)
        assert.equal(props.temp, 'Med High')
        assert.equal(props.dry_level, 'Normal')
        assert.equal(props.energy_saver, 'ON') // Energy Saver lamp lit in the panel photo

        thinq.emit('data', E2_STEAM_CYCLE)
        assert.equal(props.cycle, 'Steam Fresh')
        assert.equal(props.cycle_time, 10)
        assert.equal(props.temp, 'Med High')
        assert.equal(props.dry_level, 'None')

        thinq.emit('data', E2_TOWELS)
        assert.equal(props.cycle, 'Towels')
        assert.equal(props.cycle_time, 55)
        assert.equal(props.temp, 'Med High')
        assert.equal(props.dry_level, 'Normal')

        thinq.emit('data', E2_BEDDING)
        assert.equal(props.energy_saver, 'OFF')
        assert.equal(props.cycle, 'Bedding')
        assert.equal(props.cycle_time, 65)
        assert.equal(props.temp, 'Medium')
        assert.equal(props.dry_level, 'Very')

        thinq.emit('data', E2_NORMAL_ENERGY_SAVER_OFF)
        assert.equal(props.cycle, 'Normal')
        assert.equal(props.cycle_time, 41)
        assert.equal(props.temp, 'Med High')
        assert.equal(props.dry_level, 'Normal')
        assert.equal(props.energy_saver, 'OFF')

        thinq.emit('data', E2_HEAVY_DUTY_HIGH)
        assert.equal(props.cycle, 'Heavy Duty')
        assert.equal(props.cycle_time, 54)
        assert.equal(props.temp, 'High')
        assert.equal(props.dry_level, 'Normal')
        assert.equal(props.energy_saver, 'OFF')

        thinq.emit('data', E2_TOWELS_DAMP)
        assert.equal(props.cycle, 'Towels')
        assert.equal(props.cycle_time, 49)
        assert.equal(props.dry_level, 'Damp')
        assert.equal(props.temp, 'Med High')
        assert.equal(props.energy_saver, 'OFF')

        thinq.emit('data', E2_DELICATES_LESS)
        assert.equal(props.cycle, 'Delicates')
        assert.equal(props.cycle_time, 15)
        assert.equal(props.dry_level, 'Less')
        assert.equal(props.temp, 'Low')

        thinq.emit('data', E2_SMALL_LOAD_WRINKLE_CARE)
        assert.equal(props.cycle, 'Small Load')
        assert.equal(props.cycle_time, 35)
        assert.equal(props.dry_level, 'More')
        assert.equal(props.temp, 'High')
        assert.equal(props.wrinkle_care, 'ON')
        assert.equal(props.turbo_steam, 'OFF')
        assert.equal(props.reduce_static, 'OFF')
        thinq.emit('data', E2_DELICATES_LESS)
        assert.equal(props.wrinkle_care, 'OFF')

        thinq.emit('data', E2_SPORTSWEAR_REDUCE_STATIC)
        assert.equal(props.cycle, 'Sportswear')
        assert.equal(props.cycle_time, 25)
        assert.equal(props.dry_level, 'Normal')
        assert.equal(props.temp, 'Medium')
        assert.equal(props.reduce_static, 'ON')
        assert.equal(props.wrinkle_care, 'OFF')

        thinq.emit('data', E2_PERM_PRESS)
        assert.equal(props.cycle, 'Perm. Press')
        assert.equal(props.cycle_time, 32)
        assert.equal(props.dry_level, 'Normal')
        assert.equal(props.temp, 'Medium')
        assert.equal(props.reduce_static, 'OFF')

        thinq.emit('data', E2_ANTIBACTERIAL)
        assert.equal(props.cycle, 'Antibacterial')
        assert.equal(props.cycle_time, 70)
        assert.equal(props.dry_level, 'Very')
        assert.equal(props.temp, 'High')

        thinq.emit('data', E2_AIR_DRY)
        assert.equal(props.cycle, 'Air Dry')
        assert.equal(props.cycle_time, 30)
        assert.equal(props.dry_level, 'None')
        assert.equal(props.temp, 'Off')

        thinq.emit('data', E2_MANUAL_TIME_DRY_ULTRA_LOW)
        assert.equal(props.cycle, 'Manual')
        assert.equal(props.cycle_time, 40)
        assert.equal(props.dry_level, 'None')
        assert.equal(props.temp, 'Ultra Low')

        thinq.emit('data', E2_STEAM_SANITARY)
        assert.equal(props.cycle, 'Steam Sanitary')
        assert.equal(props.cycle_time, 31)
        assert.equal(props.dry_level, 'None')
        assert.equal(props.temp, 'High')

        thinq.emit('data', E2_TIME_DRY_20)
        assert.equal(props.cycle, 'Manual')
        assert.equal(props.cycle_time, 20)
        assert.equal(props.time_dry, 20)
        assert.equal(props.temp, 'High')
        thinq.emit('data', E2_TIME_DRY_40)
        assert.equal(props.time_dry, 40)
        assert.equal(props.temp, 'Ultra Low')
        thinq.emit('data', E2_PERM_PRESS)
        assert.equal(props.time_dry, 0) // sensor cycle

        thinq.emit('data', E2_SPEED_DRY)
        assert.equal(props.cycle, 'Speed Dry')
        assert.equal(props.cycle_time, 25)
        assert.equal(props.temp, 'High')
        assert.equal(props.dry_level, 'None')

        // TurboSteam: set on both Heavy Duty + TurboSteam cycles, clear on regular cycles without
        // it and on the dedicated Steam Fresh and Steam Sanitary cycles
        for (const [frame, turboSteam] of [
            [E2_HEAVY_DUTY_HIGH, 'ON'],
            [E2_HEAVY_DUTY_TURBO_STEAM_2, 'ON'],
            [E2_END_OF_CYCLE, 'OFF'],
            [E2_NORMAL_ENERGY_SAVER_OFF, 'OFF'],
            [E2_TOWELS_DAMP, 'OFF'],
            [E2_BEDDING, 'OFF'],
            [E2_STEAM_CYCLE, 'OFF'],
            [E2_STEAM_SANITARY, 'OFF'],
        ] as const) {
            thinq.emit('data', frame)
            assert.equal(props.turbo_steam, turboSteam)
        }

        // phase/power come from the 0x72 heartbeat, not the summary
        assert.equal(props.status, undefined)
        assert.equal(props.power, undefined)
    })

    test('the pre-existing 0xEB/0xEC dispatch still works after adding 0x72 (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_STARTING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Starting')
        assert.equal(props.remaining_time, 60)
        assert.equal(props.power, 'ON')
    })

    // ── Ignored packet tests ──────────────────────────────────────────────────

    test('frames with wrong device class byte (not 0x30) are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HB_WRONG_CLASS)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    // ── Logging (for future status-code hunting) ────────────────────────────────

    test('undecoded frame types (0x31 serial) are logged, decoded ones are not (real captures)', () => {
        const { thinq } = makeDevice()
        const cap = captureLog()
        try {
            thinq.emit('data', SERIAL)
            thinq.emit('data', E2_END_OF_CYCLE)
            assert.equal(cap.calls.length, 1)
            for (const call of cap.calls) {
                const [, topic, message] = call.arguments
                assert.equal(topic, 'RV13D5JSD_D_US')
                assert.equal(message, 'unrecognized frame')
            }
            assert.equal(cap.calls[0].arguments[3], SERIAL.subarray(2, -2).toString('hex'))
        } finally {
            cap.restore()
        }
    })
})
