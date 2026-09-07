import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_C__Y___W.A__QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_C__Y___W.A__QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_C__Y___W.A__QEUK', swVersion: '1.0.0' }

// Real packet captures from an F_C__Y___W.A__QEUK washer (A-gen UK front-loader).
// Frame format: AA <total_len> 20 EC <payload...> <checksum> BB (62-byte 0xEC inner block = 66 bytes total).
// Confirmed offsets — see device file header.
//
// The 62-byte 0xEC payload is two back-to-back 30-byte records, [old][new]: record 2 (the
// second half) is always the live/current state, record 1 is what record 2 was in the
// *previous* packet. Every "real capture" fixture below is quoted verbatim from wire traffic;
// the values asserted are what the corrected parser reads from record 2 (not necessarily
// what an earlier, buggy reading of record 1 would have shown for the same bytes).

// Real capture: Cotton/60°C/1400 RPM, 103 min remaining, 121 min initial, delay=0, tub_clean_count=10.
const SAMPLE_WASHING_EC = buf(
    'AA4220EC001C06012C02010100030A0601000000004000000306000A003400000500001C06012B02010100030A0601000000004000000306000A003400000500FEBB',
)

// Real capture (2026-08-02T05:35:56Z): Ready state, Cotton/60°C/1400 RPM, 220 min, steam=ON.
const SAMPLE_STEAM_ON_EC = buf(
    'AA4220EC001C01033B033B0100030A0401000000000000000301002D003400000400001C01032803280100030A0601000000800000000401002D0034000004002ABB',
)

// Real capture (2026-09-04T12:07Z): Washing, Cotton/40°C/1400 RPM, 97 min, wrinkle_care ON.
// Note: wrinkle_care lives in record 2's rec[17] bit5 (0x20, alongside active/child_lock), NOT
// rec[16] bit5 as originally assumed — a same-model wash with only steam enabled has rec[16]
// bit5 clear and steam still correctly in rec[16] bit7, while an otherwise identical wash without
// wrinkle care has rec[17]=0x40 (active only) instead of 0x60 (active+wrinkle_care) here.
const SAMPLE_WRINKLE_CARE_ON_EC = buf(
    'AA4220EC001C060126012B0100030A04010000000060000001060024003400000400001C060125012B0100030A04010000000060000001060024003400000400D8BB',
)

// Real capture (2026-09-04T08:44:30Z): Washing, Cotton/40°C/1400 RPM, 69 min, child_lock engaged
// (record 2's rec[17]=0xC0: active bit + child_lock bit both set).
const SAMPLE_CHILD_LOCK_ON_EC = buf(
    'AA4220EC001C060109010C0100030A04010000000040000001060023003400000400001C060109010C0100030A040100000000C000000106002300340000040001BB',
)

// Real capture: Ready state, Cotton/40°C/1000 RPM, 81 min, remote_start=ON (lock_status bit1 set).
const SAMPLE_REMOTE_START_ON_EC = buf(
    'AA4220EC001C01003B003B3200030904010000000100000001010027003400000000001C01011501150700030704010000000000000002010027003400000300B9BB',
)

// Synthetic packet: Cotton/40°C/1400 RPM delayed-start, delay=4h, 71 min remaining, 72 min program, tub_clean_count=9.
const SAMPLE_DELAYED_EC = buf(
    'AA4220EC001C03004800480100000A04010004000000000006030009003400000500001C03004700480100000A040100040000000000060300090034000005009BBB',
)

// Real capture: Cotton/60°C/1400 RPM, 2 min remaining (final spin), tub_clean_count=10.
const SAMPLE_SPINNING_EC = buf(
    'AA4220EC001C08000302010100000A0000000000004000000608000A003400000500001C08000202010100000A0000000000004000000608000A003400000500D6BB',
)

// Real capture: End state — status=End, remaining=0, spin/temp/course all cleared, tub_clean_count=10.
const SAMPLE_END_EC = buf(
    'AA4220EC001C0A0000020101000000000000000000400000060A000A003400000500001C0A0000020101000000000000000000000000060A000A00340000050067BB',
)

// Real capture: Off state — machine powered off after cycle, tub_clean_count=10.
const SAMPLE_OFF_EC = buf(
    'AA4220EC001C000000020101000000000000000000000000030A000A003400000500001C0000000201010000000000000000000000000300000A0034000005009BBB',
)

// Real capture: 0xE2 end-of-cycle alert packet — floods at ~2s intervals at End.
// Must be silently ignored (different field layout from 0xEC/0xEB).
const SAMPLE_E2_IGNORED = buf('AA2420E2091C04032603260100030A0601000000400000000604000A003400000500B8BB')

// Synthetic: 0xEB compact status packet (32-byte, sent after commands/reconnect).
// 0xEB carries a single record (no old/new pair) using the same relative layout as 0xEC's
// current record. Cotton/60°C/1400 RPM, 50 min remaining, tub_clean_count=10.
const SAMPLE_WASHING_EB = buf('AA2420EB001C06003200480100000A0601000000000000000606000A003400000500C4BB')

// Real captures: 0xD8 door-state packets (3-byte). Unaffected by the old/new record split —
// 0xD8 carries no such pair. 0x00 = door not machine-locked (accessible); non-zero = door
// machine-locked.
const SAMPLE_DOOR_UNLOCKED = buf('AA0720D800FCBB') // buf[2]=0x00 → not machine-locked → ON (Unlocked)
const SAMPLE_DOOR_LOCKED = buf('AA0720D80BE1BB') //  buf[2]=0x0B → machine-locked → OFF (Locked)
// Real capture from cycle start: buf[2]=0x30 → door sealed by machine → OFF (Locked)
const SAMPLE_DOOR_LOCKED_0x30 = buf('AA0720D8308CBB')

// Real capture: Error state — dE2 (door lock error), Cotton/60°C/1400 RPM, delay=7h, tub_clean_count=50.
// Captured 2026-08-02T19:42:30Z, three seconds before the machine's own status transitioned to
// Error — this packet's record 2 (current) already shows Error while record 1 (previous) still
// shows Measuring, which is itself part of the evidence for the old/new record ordering.
const SAMPLE_ERROR_EC = buf(
    'AA4220EC001C04031503150100030A06010007000000000001040032003400000400001C12031503150101030A060100070000000000041200320034000004009BBB',
)

// Expected outgoing packets emitted by the device file.
const WRITE_INIT = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components on construction', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'start',
            'pause',
            'status',
            'error',
            'error_message',
            'course',
            'temp',
            'spin',
            'remote_start',
            'door_lock',
            'steam',
            'wrinkle_care',
            'child_lock',
            'active',
            'tub_clean_count',
            'initial_time',
            'remaining_time',
            'delay_remaining',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.status.options as string[]).includes('Error'))
    })

    test('delayed-start state decodes status, course, spin, temp, times and delay', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELAYED_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Delayed')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
        assert.equal(props.remaining_time, 71)
        assert.equal(props.initial_time, 72)
        assert.equal(props.delay_remaining, 4 * 60) // 4h 0m
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.active, 'OFF') // synthetic packet: start not yet pressed
        assert.equal(props.door_lock, 'OFF') // derived from status: Delayed → locked → OFF (HA device_class=lock)
        assert.equal(props.tub_clean_count, 9)
    })

    test('washing state decodes status, course, spin, temp, times (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 60)
        assert.equal(props.remaining_time, 1 * 60 + 43) // 1h 43m = 103 min
        assert.equal(props.initial_time, 2 * 60 + 1) // 2h 1m = 121 min
        assert.equal(props.delay_remaining, 0)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.wrinkle_care, 'OFF')
        assert.equal(props.active, 'ON')
        assert.equal(props.child_lock, 'ON') // bit7=0 → disengaged → Unlocked → ON (HA device_class=lock)
        assert.equal(props.door_lock, 'OFF') // derived from status: Washing → locked → OFF
        assert.equal(props.tub_clean_count, 10)
    })

    test('spinning state decodes status and remaining time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning')
        assert.equal(props.remaining_time, 2)
        assert.equal(props.spin, 1400) // spin index still populated during final spin
    })

    test('end state: status=End, power still ON, spin/temp/course cleared', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'End')
        assert.equal(props.power, 'ON') // power stays ON until status goes to 0
        assert.equal(props.remaining_time, 0)
        assert.equal(props.spin, 'None')
        assert.equal(props.temp, 'None')
        assert.equal(props.course, 'None')
        assert.equal(props.door_lock, 'OFF') // still locked at End → OFF; becomes ON when status→Off
        assert.equal(props.tub_clean_count, 10)
    })

    test('steam=OFF when rec[16] bit7 is clear (standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
    })

    test('steam=ON (real capture, Ready state)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STEAM_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.steam, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 1400)
        assert.equal(props.remaining_time, 220)
        assert.equal(props.wrinkle_care, 'OFF')
    })

    test('steam toggles correctly across ON→OFF sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STEAM_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
    })

    test('wrinkle_care=OFF when rec[17] bit5 is clear (standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'OFF')
    })

    test('wrinkle_care=ON when rec[17] bit5 is set (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WRINKLE_CARE_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.wrinkle_care, 'ON')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.status, 'Washing')
        assert.equal(props.temp, 40)
        assert.equal(props.spin, 1400)
        assert.equal(props.active, 'ON')
    })

    test('wrinkle_care toggles correctly across ON→OFF sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WRINKLE_CARE_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'ON')
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'OFF')
    })

    test('child_lock=ON (Unlocked) when rec[17] bit7 is clear (disengaged)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
    })

    test('child_lock=OFF (Locked) when rec[17] bit7 is set (engaged, real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_CHILD_LOCK_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.status, 'Washing')
        assert.equal(props.temp, 40)
        assert.equal(props.spin, 1400)
        assert.equal(props.remaining_time, 69)
        assert.equal(props.active, 'ON')
    })

    test('child_lock toggles correctly when engaged/disengaged', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_CHILD_LOCK_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF') // engaged → Locked → OFF
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON') // disengaged → Unlocked → ON
    })

    test('remote_start=OFF when rec[7] bit1 is clear (standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
    })

    test('remote_start=ON when rec[7] bit1 is set (real capture, Ready state)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.remote_start, 'ON')
        // Verify other fields decoded correctly from this packet
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1000) // SPINS[7]
        assert.equal(props.temp, 40)
        assert.equal(props.remaining_time, 81)
        assert.equal(props.initial_time, 81)
        assert.equal(props.steam, 'OFF')
        assert.equal(props.wrinkle_care, 'OFF')
        assert.equal(props.active, 'OFF')
    })

    test('remote_start toggles correctly across ON→OFF sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
        thinq.emit('data', SAMPLE_DELAYED_EC) // rec[7]=0x01 → bit1=0 → OFF
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
    })

    test('off state: power=OFF, status=Off (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.active, 'OFF')
        assert.equal(props.door_lock, 'ON') // derived from status: Off → unlocked → ON
    })

    test('0xEB compact packet is parsed identically to 0xEC current record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EB)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.remaining_time, 50)
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 60)
        assert.equal(props.tub_clean_count, 10)
    })

    test('0xE2 end-of-cycle alert packet is silently ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC) // establish a known state
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', SAMPLE_E2_IGNORED) // must not alter any property
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('door_lock=OFF (Locked) derived from 0xEC for active/delayed states even without 0xD8', () => {
        const { ha, thinq } = makeDevice()
        // No 0xD8 ever arrives — door_lock must still reflect the cycle state.
        thinq.emit('data', SAMPLE_DELAYED_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF') // Delayed → locked
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF') // Washing → locked
        thinq.emit('data', SAMPLE_OFF_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'ON') // Off → unlocked
    })

    test('0xD8 door_lock=ON (Unlocked) is ignored during active wash (status-derived OFF prevails)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC) // status=Washing → door_lock=OFF (Locked)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF')
        thinq.emit('data', SAMPLE_DOOR_UNLOCKED) // 0xD8 buf[2]=0x00 must not override
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF')
    })

    test('0xD8 overrides door_lock during Ready/startup phase', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_LOCKED) // 0xD8 says locked → OFF
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF')
        thinq.emit('data', SAMPLE_DOOR_UNLOCKED) // 0xD8 says unlocked (door opened) → ON
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'ON')
    })

    test('0xD8 buf[2]=0x00 publishes door_lock=ON (not machine-locked → Unlocked)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_UNLOCKED)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'ON')
    })

    test('0xD8 buf[2]=non-zero (0x0B) publishes door_lock=OFF (machine-locked → Locked)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_LOCKED)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF')
    })

    test('0xD8 buf[2]=0x30 (cycle-start lock) publishes door_lock=OFF (real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_LOCKED_0x30)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF')
    })

    test('door_lock toggles correctly across lock/unlock sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DOOR_UNLOCKED)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'ON') // unlocked → ON
        thinq.emit('data', SAMPLE_DOOR_LOCKED)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'OFF') // locked → OFF
        thinq.emit('data', SAMPLE_DOOR_UNLOCKED)
        assert.equal(ha.devices[DEVICE_ID].properties.door_lock, 'ON') // unlocked → ON
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', buf('001122')) // no AA/BB wrapper
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('frames with unrecognised inner length are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', buf('AA0820EC010203040506BB')) // valid envelope, wrong payload length
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('start() sends the F0ED initialisation packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), WRITE_INIT)
    })

    test('HA write power=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'ON')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_ON)
    })

    test('HA write power=OFF', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF)
    })

    test('HA write pause button', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('pause', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_PAUSE)
    })

    test('HA write start button with default payload', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(hex(thinq.outbox[0]), WRITE_START)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('does-not-exist', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })

    test('error=OFF, error_message=OK when rec[8]=0x00 (no error, standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
    })

    test('error=ON, error_message=DE2 when rec[8]=0x01 (dE2 door lock error, real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ERROR_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door lock error (DE2)')
        assert.equal(props.status, 'Error')
        assert.equal(props.tub_clean_count, 50)
    })

    test('error clears when machine recovers from error state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ERROR_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        thinq.emit('data', SAMPLE_WASHING_EC) // rec[8]=0x00
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'OK')
    })
})
