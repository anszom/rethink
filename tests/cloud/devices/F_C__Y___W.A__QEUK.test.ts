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

// Real capture: Cotton/60°C/1400 RPM, 104 min remaining, 121 min initial, delay=0, tub_clean=10.
// buf[18]=0x00 → steam=OFF.
const SAMPLE_WASHING_EC = buf(
    'AA4220EC001C06012C02010100030A0601000000004000000306000A003400000500001C06012B02010100030A0601000000004000000306000A003400000500FEBB',
)

// Derived from SAMPLE_WASHING_EC with raw[20] (= buf[18]) changed 0x00→0x80 to set the steam flag.
// All other fields identical: Cotton/60°C/1400 RPM, 104 min remaining, 121 min initial, delay=0.
const SAMPLE_STEAM_ON_EC = buf(
    'AA4220EC001C06012C02010100030A0601000000804000000306000A003400000500001C06012B02010100030A0601000000004000000306000A003400000500FEBB',
)

// Derived from SAMPLE_WASHING_EC with raw[20] (= buf[18]) changed 0x00→0x20 to set the wrinkle_care flag.
// All other fields identical: Cotton/60°C/1400 RPM, 104 min remaining, initial=121 min, steam=OFF.
const SAMPLE_WRINKLE_CARE_ON_EC = buf(
    'AA4220EC001C06012C02010100030A0601000000204000000306000A003400000500001C06012B02010100030A0601000000004000000306000A003400000500FEBB',
)

// Derived from SAMPLE_WASHING_EC with raw[21] (= buf[19]) changed 0x40→0xC0 to set the child_lock flag (bit7).
// Real-capture confirmation: 2026-07-15T16:24 buf[19]=0xC0 observed immediately after user enabled child lock.
// All other fields identical: Cotton/60°C/1400 RPM, 104 min remaining, initial=121 min, delay=0.
const SAMPLE_CHILD_LOCK_ON_EC = buf(
    'AA4220EC001C06012C02010100030A060100000000C000000306000A003400000500001C06012B02010100030A0601000000004000000306000A003400000500FEBB',
)

// Real capture: Ready state, Ease Care/40°C/1200 RPM, 59 min, remote_start=ON.
// buf[9]=0x32 (bit1 set) — captured while machine was in Ready state with remote start enabled.
// Section 1 shows this config; section 2 shows Cotton/60°C/1400/267 min (user was scrolling options).
const SAMPLE_REMOTE_START_ON_EC = buf(
    'AA4220EC001C01003B003B3200030904010000000100000001010030003400000000001C01041B041B0400030A0601000000000000000201003000340000020044BB',
)

// Synthetic packet: Cotton/40°C/1400 RPM delayed-start, delay=4h, 72 min program, tub_clean=9.
const SAMPLE_DELAYED_EC = buf(
    'AA4220EC001C03004800480100000A04010004000000000006030009003400000500001C03004700480100000A040100040000000000060300090034000005009BBB',
)

// Real capture: Cotton/60°C/1400 RPM, 3 min remaining (final spin), tub_clean=10.
const SAMPLE_SPINNING_EC = buf(
    'AA4220EC001C08000302010100000A0000000000004000000608000A003400000500001C08000202010100000A0000000000004000000608000A003400000500D6BB',
)

// Real capture: End state — status=End, remaining=0, spin/temp/course all cleared, tub_clean=10.
const SAMPLE_END_EC = buf(
    'AA4220EC001C0A0000020101000000000000000000400000060A000A003400000500001C0A0000020101000000000000000000000000060A000A00340000050067BB',
)

// Real capture: Off state — machine powered off after cycle, tub_clean=10.
const SAMPLE_OFF_EC = buf(
    'AA4220EC001C000000020101000000000000000000000000030A000A003400000500001C0000000201010000000000000000000000000300000A0034000005009BBB',
)

// Real capture: 0xE2 end-of-cycle alert packet — floods at ~2s intervals at End.
// Must be silently ignored (different field layout from 0xEC/0xEB).
const SAMPLE_E2_IGNORED = buf('AA2420E2091C04032603260100030A0601000000400000000604000A003400000500B8BB')

// Synthetic: 0xEB compact status packet (32-byte, sent after commands/reconnect).
// Same field layout as the first section of 0xEC. Cotton/60°C/1400 RPM, 50 min remaining, tub_clean=10.
const SAMPLE_WASHING_EB = buf('AA2420EB001C06003200480100000A0601000000000000000606000A003400000500C4BB')

// Real captures: 0xD8 door-state packets (3-byte).
// 0x00 = door not machine-locked (accessible); non-zero = door machine-locked.
const SAMPLE_DOOR_UNLOCKED = buf('AA0720D800FCBB') // buf[2]=0x00 → not machine-locked → ON (Unlocked)
const SAMPLE_DOOR_LOCKED = buf('AA0720D80BE1BB') //  buf[2]=0x0B → machine-locked → OFF (Locked)
// Real capture from cycle start: buf[2]=0x30 → door sealed by machine → OFF (Locked)
const SAMPLE_DOOR_LOCKED_0x30 = buf('AA0720D8308CBB')

// Real capture: Error state — dE2 (door lock error), Cotton/60°C/1400 RPM, delay=7h, tub_clean=50.
// buf[4]=0x12=Error, buf[10]=0x01=DE2, buf[23]=0x12=Error.
// Captured 2026-08-02T19:42:33Z after machine failed to lock door during delayed-start attempt.
const SAMPLE_ERROR_EC = buf(
    'AA4220EC001C12031503150101030A06010007000000000004120032003400000400001C00031503150100000000000000000000000004010032003400000400FABB',
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
            'pre_state',
            'tub_clean',
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
        assert.equal(props.remaining_time, 72) // 0h 72m
        assert.equal(props.initial_time, 72)
        assert.equal(props.delay_remaining, 4 * 60) // 4h 0m
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.active, 'OFF') // synthetic packet: start not yet pressed
        assert.equal(props.door_lock, 'OFF') // derived from status: Delayed → locked → OFF (HA device_class=lock)
        assert.equal(props.pre_state, 'Delayed')
        assert.equal(props.tub_clean, 9)
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
        assert.equal(props.remaining_time, 1 * 60 + 44) // 1h 44m = 104 min
        assert.equal(props.initial_time, 2 * 60 + 1) // 2h 1m = 121 min
        assert.equal(props.delay_remaining, 0)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.wrinkle_care, 'OFF')
        assert.equal(props.active, 'ON')
        assert.equal(props.child_lock, 'ON') // bit7=0 → disengaged → Unlocked → ON (HA device_class=lock)
        assert.equal(props.door_lock, 'OFF') // derived from status: Washing → locked → OFF
        assert.equal(props.pre_state, 'Washing')
        assert.equal(props.tub_clean, 10)
    })

    test('spinning state decodes status and remaining time', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning')
        assert.equal(props.remaining_time, 3)
        assert.equal(props.spin, 1400) // spin index still populated during final spin
    })

    test('end state: status=End, power still ON, spin/temp/course cleared', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'End')
        assert.equal(props.power, 'ON') // power stays ON until status goes to 0
        assert.equal(props.remaining_time, 0)
        assert.equal(props.spin, 'unknown')
        assert.equal(props.temp, 'unknown')
        assert.equal(props.course, 'unknown')
        assert.equal(props.door_lock, 'OFF') // still locked at End → OFF; becomes ON when status→Off
        assert.equal(props.pre_state, 'End')
        assert.equal(props.tub_clean, 10)
    })

    test('steam=OFF when buf[18] bit7 is clear (standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
    })

    test('steam=ON when buf[18] bit7 is set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STEAM_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.steam, 'ON')
        // All other fields identical to SAMPLE_WASHING_EC
        assert.equal(props.status, 'Washing')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 1400)
        assert.equal(props.remaining_time, 104)
    })

    test('steam toggles correctly across ON→OFF sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STEAM_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
    })

    test('wrinkle_care=OFF when buf[18] bit5 is clear (standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'OFF')
    })

    test('wrinkle_care=ON when buf[18] bit5 is set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WRINKLE_CARE_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.wrinkle_care, 'ON')
        // steam is still OFF (bit7 clear), other fields unchanged
        assert.equal(props.steam, 'OFF')
        assert.equal(props.status, 'Washing')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 1400)
    })

    test('wrinkle_care toggles correctly across ON→OFF sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WRINKLE_CARE_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'ON')
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'OFF')
    })

    test('child_lock=ON (Unlocked) when buf[19] bit7 is clear (disengaged)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
    })

    test('child_lock=OFF (Locked) when buf[19] bit7 is set (engaged)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_CHILD_LOCK_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.child_lock, 'OFF')
        // All other fields identical to SAMPLE_WASHING_EC
        assert.equal(props.status, 'Washing')
        assert.equal(props.temp, 60)
        assert.equal(props.spin, 1400)
        assert.equal(props.remaining_time, 104)
    })

    test('child_lock toggles correctly when engaged/disengaged', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_CHILD_LOCK_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF') // engaged → Locked → OFF
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON') // disengaged → Unlocked → ON
    })

    test('remote_start=OFF when buf[9] bit1 is clear (standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
    })

    test('remote_start=ON when buf[9] bit1 is set (real capture, Ready state)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START_ON_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.remote_start, 'ON')
        // Verify other fields decoded correctly from this packet
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1200) // SPINS[9]
        assert.equal(props.temp, 40)
        assert.equal(props.remaining_time, 59)
        assert.equal(props.initial_time, 59)
        assert.equal(props.steam, 'OFF')
        assert.equal(props.wrinkle_care, 'OFF')
        assert.equal(props.active, 'OFF')
    })

    test('remote_start toggles correctly across ON→OFF sequence', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_REMOTE_START_ON_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
        thinq.emit('data', SAMPLE_DELAYED_EC) // buf[9]=0x01 → bit1=0 → OFF
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
    })

    test('off state: power=OFF, status=Off, pre_state retains last run state (End)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_OFF_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.active, 'OFF')
        assert.equal(props.door_lock, 'ON') // derived from status: Off → unlocked → ON
        assert.equal(props.pre_state, 'End') // buf[23] retains End even after power-off
    })

    test('0xEB compact packet is parsed identically to 0xEC first section', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EB)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.remaining_time, 50)
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 60)
        assert.equal(props.tub_clean, 10)
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

    test('error=OFF, error_message=OK when buf[10]=0x00 (no error, standard washing packet)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_WASHING_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
    })

    test('error=ON, error_message=DE2 when buf[10]=0x01 (dE2 door lock error, real capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ERROR_EC)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door lock error (DE2)')
        assert.equal(props.status, 'Error')
        assert.equal(props.pre_state, 'Error')
        assert.equal(props.tub_clean, 50)
    })

    test('error clears when machine recovers from error state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ERROR_EC)
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        thinq.emit('data', SAMPLE_WASHING_EC) // buf[10]=0x00
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'OK')
    })
})
