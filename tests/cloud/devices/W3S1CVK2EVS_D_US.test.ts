import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/W3S1CVK2EVS_D_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'W3S1CVK2EVS_D_US'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures below are unmodified frames captured from the dryer half of a WashTower while walking
// the dial and buttons and running a 20-minute Time Dry.
const EB_IDLE = buf('AA2434EB001C01000100010000000000040000000028020000000000006900000000F6BB')

const NORMAL = buf(
    'AA4234EC001C01000100010000000000040000004028020000000000006900000000001C01003B003B03000504000400000040280300000000000069000000002CBB',
)
const HEAVY_DUTY = buf(
    'AA4234EC001C01003B003B0300050400040000004028030000000000006900000000001C01003600360100030500040000004028020000000000006900000000B9BB',
)
const BEDDING = buf(
    'AA4234EC001C01003600360100030500040000004028020000000000006900000000001C01003700370700030300040000004028020000000000006900000000B1BB',
)
const SMALL_LOAD = buf(
    'AA4234EC001C01003700370700030300040000004028020000000000006900000000001C01001E001E0900030500040000004028020000000000006900000000E9BB',
)
const DELICATES = buf(
    'AA4234EC001C01001E001E0900030500040000004028020000000000006900000000001C01001C001C0500030200040000004028020000000000006900000000D6BB',
)
const STEAM_FRESH = buf(
    'AA4234EC001C01001E001E1200000502040000000028020000000000006900000000001C01000A000A1500000400040000000028020000000000026900000000ADBB',
)

const DRY_LEVEL_DAMP = buf(
    'AA4234EC001C01003B003B0300050400040000000028030000000000006900000000001C01001E001E03000104000400000000280200000000000069000000006EBB',
)
const DRY_LEVEL_MORE = buf(
    'AA4234EC001C01002900290300030400040000000028060000000000006900000000001C0100320032030004040004000000002802000000000000690000000016BB',
)

const TIME_DRY_60 = buf(
    'AA4234EC001C01003200321200000504040000000028020000000000006900000000001C0101000100120000050504000000002802000000000000690000000044BB',
)
const TIME_DRY_20 = buf(
    'AA4234EC001C01010001001200000505040000000028020000000000006900000000001C0100140014120000050104000000002802000000000000690000000087BB',
)
const TEMP_ULTRA_LOW = buf(
    'AA4234EC001C01001400141200000501040000000028020000000000006900000000001C01001400141200000101040000000028020000000000006900000000A5BB',
)

const STEAM_ON = buf(
    'AA4234EC001C01003200320300040400040000000028020000000000006900000000001C0100320032030004040004000000002C02000000000000690000000003BB',
)
const STEAM_OFF = buf(
    'AA4234EC001C0100320032030004040004000000002C020000000000006900000000001C0100320032030004040004000000002802000000000000690000000003BB',
)
const REDUCE_STATIC_ON = buf(
    'AA4234EC001C01003200320300040400040000000028020000000000006900000000001C0100300030030004040004000000022802000000000005690000000000BB',
)
const REDUCE_STATIC_OFF = buf(
    'AA4234EC001C01003000300300040400040000000228020000000000056900000000001C0100320032030004040004000000002802000000000002690000000002BB',
)
const WRINKLE_CARE_ON = buf(
    'AA4234EC001C01003200320300040400040000000028020000000000026900000000001C0100320032030004040004000000102802000000000002690000000033BB',
)
const WRINKLE_CARE_OFF = buf(
    'AA4234EC001C01003200320300040400040000001028020000000000026900000000001C0100320032030004040004000000002802000000000002690000000033BB',
)
const REMOTE_ON = buf(
    'AA4234EC001C01001E001E1200000502040000000028020000000000006900000000001C01001E001E12000005020400000000290200000000000069000000004ABB',
)
const REMOTE_OFF = buf(
    'AA4234EC001C01001E001E1200000502040000000029020000000000006900000000001C01001E001E12000005020400000000280200000000000069000000004ABB',
)
const CONTROL_LOCK_ON = buf(
    'AA4234EC001C01001E001E1200000502040000000028020000000000006900000000001C01001E001E12000005020400000001280200000000000069000000004ABB',
)
const CONTROL_LOCK_OFF = buf(
    'AA4234EC001C01001E001E1200000502040000000128020000000000006900000000001C01001E001E12000005020400000000280200000000000069000000004ABB',
)
const SIGNAL_OFF = buf(
    'AA4234EC001C01001E001E1200000502040000000028020000000000006900000000001C01001E001E12000005020000000000280200000000000069000000004FBB',
)
const SIGNAL_HIGH = buf(
    'AA4234EC001C01001E001E1200000502000000000028020000000000006900000000001C01001E001E12000005020400000000280200000000000069000000004FBB',
)

const DRYING = buf(
    'AA4234EC001C01001400141200000101040000001028020000000000006900000000001C320014001412000001010400000010290200000100000069000000006ABB',
)
const DRYING_19 = buf(
    'AA4234EC001C32001400141200000101040000001029020000010000006900000000001C3200130014120000010104000000102902000301000000690000000021BB',
)
const PAUSE = buf(
    'AA4234EC001C32001300141200000101040000001029020003010000006900000000001C03001300141200000101040000005028020005320000006900000000ECBB',
)
const RESUME = buf(
    'AA4234EC001C03001300141200000101040000005028020005320000006900000000001C32001300141200000101040000001029020005030000006900000000E8BB',
)
const COOLING = buf(
    'AA4234EC001C3200060014120000010104000000102902002F030000006900000000001C33000500141200000101040000001029020033320000006900000000BEBB',
)
const END = buf(
    'AA4234EC001C33000100141200000101040000001029020041320000006900000000001C0400010015120000010104000000502802004433000000690000000012BB',
)
const WRINKLE_CARE_RUNNING = buf(
    'AA4234EC001C04000100151200000101040000005028020044330000006900000000001C380001000112000001010400000050290200440400000069000000001BBB',
)
const DOWNLOADED = buf(
    'AA4234EC001C01001C001C0500030200040000004028020000000000006900000000001C01003200320D0003020004000000402802000000690000690000000040BB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const frame of frames) thinq.emit('data', frame)
    return ha.devices[DEVICE_ID].properties
}

describe('W3S1CVK2EVS_D_US', () => {
    test('discovery drops the RV13D5JSD-only entities and adds remote start and control lock', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components
        assert.ok(components.power_off)
        assert.ok(components.power_on)
        assert.equal(components.damp_dry_signal, undefined)
        assert.ok(components.remote_start)
        assert.ok(components.child_lock)
        assert.ok(components.energy)
        assert.ok(components.course)
    })

    test('0xEB snapshot decodes under the WashTower class byte', () => {
        const p = feed([EB_IDLE])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.remaining_time, 1)
    })

    test('dial walk decodes course, times, dry level and temperature', () => {
        let p = feed([NORMAL])
        assert.equal(p.course, 'Normal')
        assert.equal(p.remaining_time, 59)
        assert.equal(p.initial_time, 59)
        assert.equal(p.dry_level, 'Very')
        assert.equal(p.temp, 'Mid High')

        p = feed([HEAVY_DUTY])
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.remaining_time, 54)
        assert.equal(p.temp, 'High')

        p = feed([BEDDING])
        assert.equal(p.course, 'Bedding')
        assert.equal(p.remaining_time, 55)
        assert.equal(p.temp, 'Medium')

        p = feed([SMALL_LOAD])
        assert.equal(p.course, 'Small Load')
        assert.equal(p.remaining_time, 30)

        p = feed([DELICATES])
        assert.equal(p.course, 'Delicates')
        assert.equal(p.remaining_time, 28)
        assert.equal(p.temp, 'Low')

        p = feed([STEAM_FRESH])
        assert.equal(p.course, 'Steam Fresh')
        assert.equal(p.remaining_time, 10)
    })

    test('dry level walk', () => {
        assert.equal(feed([DRY_LEVEL_DAMP]).dry_level, 'Damp')
        assert.equal(feed([DRY_LEVEL_MORE]).dry_level, 'More')
    })

    test('Time Dry reports hours and minutes and the selected duration', () => {
        let p = feed([TIME_DRY_60])
        assert.equal(p.course, 'Time Dry')
        assert.equal(p.remaining_time, 60)
        assert.equal(p.time_dry_setting, 60)

        p = feed([TIME_DRY_60, TIME_DRY_20])
        assert.equal(p.remaining_time, 20)
        assert.equal(p.time_dry_setting, 20)

        assert.equal(feed([TEMP_ULTRA_LOW]).temp, 'Ultra Low')
    })

    test('option bits toggle without colliding', () => {
        assert.equal(feed([STEAM_ON]).turbo_steam, 'ON')
        assert.equal(feed([STEAM_ON, STEAM_OFF]).turbo_steam, 'OFF')

        let p = feed([REDUCE_STATIC_ON])
        assert.equal(p.reduce_static, 'ON')
        assert.equal(p.wrinkle_care, 'OFF')
        assert.equal(p.child_lock, 'OFF')
        assert.equal(feed([REDUCE_STATIC_ON, REDUCE_STATIC_OFF]).reduce_static, 'OFF')

        p = feed([WRINKLE_CARE_ON])
        assert.equal(p.wrinkle_care, 'ON')
        assert.equal(p.reduce_static, 'OFF')
        assert.equal(feed([WRINKLE_CARE_ON, WRINKLE_CARE_OFF]).wrinkle_care, 'OFF')

        p = feed([REMOTE_ON])
        assert.equal(p.remote_start, 'ON')
        assert.equal(p.energy_saver, 'OFF')
        assert.equal(feed([REMOTE_ON, REMOTE_OFF]).remote_start, 'OFF')

        p = feed([CONTROL_LOCK_ON])
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.reduce_static, 'OFF')
        assert.equal(feed([CONTROL_LOCK_ON, CONTROL_LOCK_OFF]).child_lock, 'OFF')

        assert.equal(feed([SIGNAL_OFF]).signal, 'Off')
        assert.equal(feed([SIGNAL_OFF, SIGNAL_HIGH]).signal, 'High')
    })

    test('Damp Dry Signal is never published', () => {
        const p = feed([NORMAL, WRINKLE_CARE_ON, DRYING])
        assert.equal(p.damp_dry_signal, undefined)
    })

    test('run decodes Drying and Pause, counting down from the initial time', () => {
        let p = feed([DRYING])
        assert.equal(p.status, 'Drying')
        assert.equal(p.energy, 0)
        assert.equal(p.remote_start, 'ON')
        assert.equal(p.dry_completed, 'OFF')

        p = feed([DRYING, DRYING_19])
        assert.equal(p.remaining_time, 19)
        assert.equal(p.initial_time, 20)

        p = feed([DRYING, DRYING_19, PAUSE])
        assert.equal(p.status, 'Pause')
        assert.equal(p.remote_start, 'OFF')

        p = feed([DRYING, DRYING_19, PAUSE, RESUME])
        assert.equal(p.status, 'Drying')
    })

    test('run ends through Cooling and End into Wrinkle Care, keeping completion latched', () => {
        let p = feed([DRYING, COOLING])
        assert.equal(p.status, 'Cooling')
        assert.equal(p.remaining_time, 5)

        p = feed([DRYING, COOLING, END])
        assert.equal(p.status, 'End')
        assert.equal(p.dry_completed, 'ON')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.remote_start, 'OFF')
        assert.equal(p.energy, 68)

        p = feed([DRYING, COOLING, END, WRINKLE_CARE_RUNNING])
        assert.equal(p.status, 'Wrinkle Care')
        assert.equal(p.dry_completed, 'ON')
        assert.equal(p.remaining_time, 0)
    })

    test('the Downloaded position reports the course stored in it', () => {
        const p = feed([DOWNLOADED])
        assert.equal(p.course, 'Low Temp Dry')
        assert.equal(p.remaining_time, 50)
        assert.equal(p.temp, 'Low')
    })

    // Both frames as the ThinQ app sent them while bridged; the dryer answered each with AA08340024005FBB.
    test('sends no status request; power off and on send the captured F0 24 commands', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('power_on', 'PRESS')
        dev.setProperty('power_off', 'PRESS')
        dev.setProperty('power_off', 'not-a-press')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            ['AA09F0240101019FBB', 'AA09F0240101009CBB'],
        )
    })

    test('RV13D5JSD frames and short remote-state frames are ignored', () => {
        for (const junk of [
            'AA2330EB001B000039003900000000000400000000A800000001000000CA000000B9BB',
            'AA09347200C90077BB',
        ]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
        }
    })

    // Captured right after downloading Super Dry (0x64, base course 0x1a) from the ThinQ app, which also
    // selects the Downloaded position; the old record is the Normal dial course with Low Temp Dry stored.
    test('a course downloaded from the ThinQ app is named on the Downloaded position', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit(
            'data',
            buf(
                'aa4234ec001c01000100010000000000040000004028020000000000006900000000001c01003b003b1a00050500040000004028020000006400006400000000babb',
            ),
        )
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Super Dry')
        assert.equal(p.downloaded_course, 'Super Dry')
    })
})
