import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13B6ES_D_US_WIFI'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13B6ES_D_US_WIFI'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames captured live from the appliance via rethink-capture, each cross-checked
// against the LG cloud's own decoded washerDryer state at matching timestamps — not guessed from static
// analysis. The comments name the cloud field that confirmed each one.

// Single-record 0xEB frame, powered off. Seen right after the appliance reconnects.
const EB_IDLE = buf('aa2330eb001b000029002900000000000100000000280000000100000064000000b6bb')

// Power on with Normal selected: cloud courseDryer27inchBase:"NORMAL", dryLevel:"DRYLEVEL_NORMAL",
// temp:"TEMP_MEDIUMHIGH", initialTimeMinute:41.
const POWER_ON_NORMAL = buf(
    'aa4030ec001b01000a000a00000000000100000040280000000000000064000000001b0100290029030003040001000000402800000000000000640000001dbb',
)

// Antibacterial: the cloud reported initialTimeHour:1 + initialTimeMinute:10, which must decode as a
// single 70-minute value. Also dryLevel:"DRYLEVEL_VERYDRY".
const ANTIBACTERIAL = buf(
    'aa4030ec001b01001f001f16000005000100000040280000000000000064000000001b01010a010a080005050001000000402800000000000000640000000cbb',
)

// THE divergence from RV13B6BSD_D_US_WIFI: Wrinkle Care is rec[15] bit 0x10 on this model, not rec[16]
// bit 0x10. Confirmed across six clean transitions against the cloud's wrinkleCare. Aliasing to the
// relative would report this permanently OFF, since rec[16] bit 0x10 is never set here.
const WRINKLE_CARE_ON = buf(
    'aa4030ec001b010029002903000304000100000040280000000000000064000000001b010029002903000304000100000050280000000000000064000000f5bb',
)
const WRINKLE_CARE_OFF = buf(
    'aa4030ec001b010029002903000304000100000050280000000000000064000000001b010029002903000304000100000040280000000000000064000000f5bb',
)

// Child Lock, matching the cloud's childLock:"CHILDLOCK_ON". rec[15] keeps its 0x40 base bit alongside.
const CHILD_LOCK_ON = buf(
    'aa4030ec001b010029002903000304000100000040280000000000000064000000001b010029002903000304000100000041280000000000000064000000c4bb',
)

// Turbo Steam, matching turboSteam:"TURBOSTEAM_ON" (rec[16] bit 0x04).
const TURBO_STEAM_ON = buf(
    'aa4030ec001b010029002903000304000100000000280000000000000064000000001b0100290029030003040001000000002c000000000000006400000041bb',
)

// Energy Saver, matching energySaver:"ENERGYSAVER_ON" (rec[16] bit 0x02). Turning it on also stretches
// the estimate from 41 minutes to 1h03, which the cloud reported as initialTimeHour:1/Minute:3.
const ENERGY_SAVER_ON = buf(
    'aa4030ec001b010029002903000304000100000000280000000000000264000000001b0101030103030003040001000000002a000000000000026400000099bb',
)

// Reduce Static on (rec[15] bit 0x02) together with a load-item count of 5 in rec[23], matching the
// cloud's reduceStatic:"REDUCESTATIC_ON" and loadItem:"LOADITEM_5" in the same notification.
const REDUCE_STATIC_AND_LOAD_ITEM = buf(
    'aa4030ec001b010029002903000304000100000000280000000000000064000000001b01002700270300030400010000000228000000000000056400000046bb',
)

// A real Speed Dry run trimmed to 10 minutes with More/Less Time (rec[12] = 0xf1 = -15, against the
// course default of 25). Start: phase 0x01 -> 0x32, cloud state:"DRYING" with remoteStart turning ON
// (rec[16] bit 0x01) in the same frame.
const STARTS_DRYING = buf(
    'aa4030ec001b01000a000a100000020001f1000000280000000000000064000000001b32000a000a100000020001f1000000290000000100000064000000ecbb',
)

// Pause, cloud state:"PAUSE" with preState:"DRYING" — and rec[20] holds that previous phase (0x32).
const PAUSES = buf(
    'aa4030ec001b32000a000a100000020001f1000000290000000100000064000000001b03000a000a100000020001f10000402800000132000000640000007bbb',
)

// Resume back to Drying, cloud preState:"PAUSE" (rec[20] = 0x03).
const RESUMES = buf(
    'aa4030ec001b03000a000a100000020001f1000040280000013200000064000000001b32000a000a100000020001f100000028000001030000006400000065bb',
)

// End of the run: phase 0x32 -> 0x33, cloud state:"COOLING". Remaining time has counted down to 5 while
// the initial estimate stays pinned at 10 — the separate-timer behavior this model genuinely has.
const COOLING = buf(
    'aa4030ec001b320006000a100000020001f10000002900000e0300000064000000001b330005000a100000020001f100000029000012320000006400000062bb',
)

// Cooling -> End, cloud preState:"COOLING" state:"END".
const ENDS = buf(
    'aa4030ec001b330001000b100000020001f1000000290000243200000064000000001b040001000b100000020001f1000040280000243300000064000000ccbb',
)

// End -> Off ~30s later: course, temperature and the More/Less trim all reset to their zero sentinel,
// matching the cloud's courseDryer27inchBase:"NOT_SELECTED" and moreLessTime:0.
const SETTLES_OFF = buf(
    'aa4030ec001b040001000b100000020001f1000040280000243300000064000000001b0000010001000000000001000000402800002404000000640000003fbb',
)

// Signal (beeper) volume, rec[11]. Unlike every other fixture here this one is NOT cloud-confirmed — the
// LG cloud sends no signal field for this dryer at all — so the three values were tied to the panel's own
// Off/Low/High indicator by reading the lit LED after each press.
const SIGNAL_OFF = buf(
    'aa4030ec001b010036003601000305000400000040280000000000000064000000001b01003600360100030500000000004028000000000000006400000091bb',
)
const SIGNAL_LOW = buf(
    'aa4030ec001b010036003601000305000000000040280000000000000064000000001b01003600360100030500010000004028000000000000006400000094bb',
)
const SIGNAL_HIGH = buf(
    'aa4030ec001b010029002903000304000100000040280000000000000064000000001b010029002903000304000400000040280000000000000064000000c6bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('RV13B6ES_D_US_WIFI', () => {
    test('0xEB single-record frames decode with the same offsets as 0xEC', () => {
        const p = feed([EB_IDLE])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'unknown') // course byte is 0 — nothing selected
        assert.equal(p.remaining_time, 0)
    })

    test('power on with Normal selected', () => {
        const p = feed([POWER_ON_NORMAL])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'Normal')
        assert.equal(p.dry_level, 'Normal')
        assert.equal(p.temp, 'Mid High')
        assert.equal(p.remaining_time, 41)
        assert.equal(p.initial_time, 41)
    })

    test('an hour-plus estimate folds hour and minute into one value', () => {
        const p = feed([ANTIBACTERIAL])
        assert.equal(p.course, 'Antibacterial')
        assert.equal(p.dry_level, 'Very')
        assert.equal(p.remaining_time, 70) // cloud: initialTimeHour 1 + initialTimeMinute 10
        assert.equal(p.initial_time, 70)
    })

    // This is the test that would fail if this model were aliased to RV13B6BSD_D_US_WIFI.
    test('Wrinkle Care is read from rec[15] bit 0x10, not rec[16]', () => {
        const on = feed([WRINKLE_CARE_ON])
        assert.equal(on.wrinkle_care, 'ON')
        // the neighbouring bitfield is untouched by this control
        assert.equal(on.energy_saver, 'OFF')
        assert.equal(on.turbo_steam, 'OFF')

        const off = feed([WRINKLE_CARE_ON, WRINKLE_CARE_OFF])
        assert.equal(off.wrinkle_care, 'OFF')
    })

    test('child lock, reduce static and damp dry share rec[15] without collision', () => {
        const lock = feed([CHILD_LOCK_ON])
        assert.equal(lock.child_lock, 'ON')
        assert.equal(lock.wrinkle_care, 'OFF')
        assert.equal(lock.reduce_static, 'OFF')

        const stat = feed([REDUCE_STATIC_AND_LOAD_ITEM])
        assert.equal(stat.reduce_static, 'ON')
        assert.equal(stat.child_lock, 'OFF')
        assert.equal(stat.wrinkle_care, 'OFF')
    })

    test('load item count is reported from rec[23]', () => {
        const p = feed([REDUCE_STATIC_AND_LOAD_ITEM])
        assert.equal(p.load_item, 5) // cloud: loadItem "LOADITEM_5"
    })

    test('turbo steam and energy saver share rec[16]', () => {
        const steam = feed([TURBO_STEAM_ON])
        assert.equal(steam.turbo_steam, 'ON')
        assert.equal(steam.energy_saver, 'OFF')

        const saver = feed([ENERGY_SAVER_ON])
        assert.equal(saver.energy_saver, 'ON')
        assert.equal(saver.turbo_steam, 'OFF')
        assert.equal(saver.remaining_time, 63) // 1h03: energy saver stretches the estimate
    })

    test('More/Less Time is a signed trim of the course default', () => {
        const p = feed([STARTS_DRYING])
        assert.equal(p.more_less_time, -15) // Speed Dry 25min default, trimmed to 10
        assert.equal(p.remaining_time, 10)
    })

    test('remote start is visible in rec[16] bit 0x01', () => {
        const p = feed([STARTS_DRYING])
        assert.equal(p.remote_start, 'ON')
        const paused = feed([STARTS_DRYING, PAUSES])
        assert.equal(paused.remote_start, 'OFF')
    })

    test('a real run: Initial -> Drying -> Pause -> Drying -> Cooling', () => {
        const start = feed([STARTS_DRYING])
        assert.equal(start.status, 'Drying')
        assert.equal(start.course, 'Speed Dry')
        assert.equal(start.temp, 'Low')
        assert.equal(start.dry_level, 'unknown') // Speed Dry does not auto-sense: cloud NO_DRYLEVEL

        const paused = feed([STARTS_DRYING, PAUSES])
        assert.equal(paused.status, 'Pause')

        const resumed = feed([STARTS_DRYING, PAUSES, RESUMES])
        assert.equal(resumed.status, 'Drying')

        const cooling = feed([STARTS_DRYING, PAUSES, RESUMES, COOLING])
        assert.equal(cooling.status, 'Cooling')
        // remaining counts down while the initial estimate stays pinned
        assert.equal(cooling.remaining_time, 5)
        assert.equal(cooling.initial_time, 10)
    })

    test('the run finishes: Cooling -> End -> Off, and Off clears the selection', () => {
        const ended = feed([STARTS_DRYING, RESUMES, COOLING, ENDS])
        assert.equal(ended.status, 'End')
        assert.equal(ended.power, 'ON') // End is still powered on, just finished

        const off = feed([STARTS_DRYING, RESUMES, COOLING, ENDS, SETTLES_OFF])
        assert.equal(off.status, 'Off')
        assert.equal(off.power, 'OFF')
        assert.equal(off.course, 'unknown') // cloud: courseDryer27inchBase "NOT_SELECTED"
        assert.equal(off.remaining_time, 0)
        assert.equal(off.more_less_time, 0)
    })

    test('the Signal beeper setting is read from rec[11]', () => {
        assert.equal(feed([SIGNAL_OFF]).signal, 'Off')
        assert.equal(feed([SIGNAL_LOW]).signal, 'Low')
        assert.equal(feed([SIGNAL_HIGH]).signal, 'High')
        // pressing Signal must not disturb the neighbouring fields
        const p = feed([SIGNAL_HIGH])
        assert.equal(p.course, 'Normal')
        assert.equal(p.dry_level, 'Normal')
    })

    test('start() requests a status snapshot, so a reconnect does not leave HA blank', () => {
        // Without this the driver is purely passive: the dryer only volunteers a frame when
        // something changes, so after a restart HA would sit at "Off"/unknown until someone
        // physically touched the machine.
        const { thinq, dev } = makeDevice()
        dev.start()

        // AA | length | 0xF0ED status query | checksum | BB. Verified against a live RV13B6ES,
        // which answered this exact frame with a 0xEB snapshot.
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa0ef0ed1121010000001800b5bb'],
        )
    })

    test('the reply to start() decodes as an ordinary status frame', () => {
        // whatever the appliance sends back must flow through the normal path, not a special case
        const p = feed([EB_IDLE])
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
    })

    test('frames that are not status frames publish nothing', () => {
        // a short 0xD8 heartbeat, a 0x72 ping and a truncated 0xEC must all be ignored rather than
        // decoded from whatever bytes happen to sit at the status offsets
        for (const junk of ['aa0730d82b91bb', 'aa09307200c80048bb', 'aa0a30ec001b010029bb']) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {}, `frame ${junk} should publish nothing`)
        }
    })
})
