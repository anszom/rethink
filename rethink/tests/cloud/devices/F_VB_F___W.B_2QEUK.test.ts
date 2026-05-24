import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_VB_F___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_VB_F___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_VB_F___W.B_2QEUK', swVersion: '0.0.0' }

// Powered on, idle (Ready), no course selected, no locks engaged.
const SAMPLE_INITIAL = buf(
    'AA5420EC002500050F050F130000000000000000000000000401000A0064000004000CBD02022A1E00030100250100000000000000000000000000000000000000000A006400000000000002022A1E0040014EBB',
)

// Idle with child lock engaged — used to pin down the 0x80 bit polarity
// (it is set when locked on this model; see PR #52 conversation with xBelladonna).
const SAMPLE_CHILD_LOCK = buf(
    'AA5420EC00250100000000000000000000000000000000000000000A006400000000000002022A1E00030100250100000000000000000000000000008000000000000A006400000000000002022A1E00030107BB',
)

// Cotton, 1000 RPM (TurboWash auto-adjusted), 40°C, extra rinse + TurboWash + Pre-wash on,
// detergent dose Off, softener dose High. Steam is unavailable on this combo so it stays OFF.
const SAMPLE_COMBO_OPTIONS = buf(
    'AA5420EC00250104010401010003070402000000410001000200000A006400000500000000022A1E00020100250104010401010003070402000000410001000200000A006400000500000000032A1E000201C0BB',
)

// Same combo as above with delay_end dialled to 3 hours.
const SAMPLE_DELAY_END = buf(
    'AA5420EC00250104010401010003070402000000410001000200000A006400000500000000032A1E00020100250104010401010003070402000300410001000200000A006400000500000000032A1E000201CCBB',
)

// Powered off (status=0). Time/course bytes still hold the last cycle's values.
const SAMPLE_POWER_OFF = buf(
    'AA5420EC00250004010401010000000000000000000001000201000A006400000500000000032A1E00020100250004010401010000000000000000000001000201000A006400000500000000032A1E00420161BB',
)

// Mid-Washing on the Wash + Dry course (0x13), 1400 RPM, 40°C, drying = Auto.
// Door locked, remote_start active, 2h25m remaining.
const SAMPLE_RUNNING = buf(
    'AA5420EC002504050F050F1300030A0401020000004220000101000A006400000400000002022A1E000301002506021902191300030A0401020000004220000104000A006400000400000002022A1E0003010CBB',
)

// Drying-only course (0x18) just started — status=Drying, drying_mode=Auto, 55 min remaining.
const SAMPLE_DRYING = buf(
    'AA5420EC00250100370037180000000000020000000000000600000B006400000000002D00002A1E00000100250900370037180000000000020000000220000101000B006400000000002D00002A1E004001F7BB',
)

// Outgoing packets emitted by setProperty / start.
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
            'drying_mode',
            'cycles',
            'remote_start',
            'door_lock',
            'child_lock',
            'energy',
            'initial_time',
            'remaining_time',
            'delay_end',
            'detergent',
            'softener',
            'extra_rinse',
            'turbowash',
            'eco_hybrid',
            'prewash',
            'steam',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.detergent.options as string[]).includes('Medium'))
        assert.equal(components.door_lock.device_class, 'lock')
        assert.equal(components.child_lock.device_class, 'lock')
        assert.equal(components.delay_end.device_class, 'duration')
    })

    test('initial state push decodes power, status, lock and error state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.drying_mode, 'Off')
        assert.equal(props.delay_end, 0)
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.eco_hybrid, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.cycles, 10)
        assert.equal(props.energy, 0)
        assert.equal(props.initial_time, 0)
        assert.equal(props.remaining_time, 0)
        // flags1=0x00: remote_start=OFF, door_lock=ON (unlocked), child_lock=OFF
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.child_lock, 'OFF')
    })

    test('child lock engaged frame decodes child_lock=ON, polarity is non-inverted', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_CHILD_LOCK)
        const props = ha.devices[DEVICE_ID].properties
        // buf[58]=0x80: 0x80 bit is set when child lock engaged on this model.
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.door_lock, 'ON') // 0x40 bit still clear → door unlocked
        assert.equal(props.remote_start, 'OFF')
    })

    test('combo-options frame decodes extra_rinse, turbowash, prewash, detergent, softener', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COMBO_OPTIONS)
        const props = ha.devices[DEVICE_ID].properties
        // buf[57]=0x41: bit 0x01 (TurboWash) + bit 0x40 (Pre-wash) set; eco_hybrid + steam clear.
        assert.equal(props.extra_rinse, 'ON')
        assert.equal(props.turbowash, 'ON')
        assert.equal(props.prewash, 'ON')
        assert.equal(props.eco_hybrid, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.detergent, 'Off')
        assert.equal(props.softener, 'High')
        assert.equal(props.spin, 1000) // TurboWash forces 1000 RPM
        assert.equal(props.temp, 40)
        assert.equal(props.initial_time, 241)
        assert.equal(props.remaining_time, 241)
    })

    test('delay end frame decodes delay_end in hours', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DELAY_END)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.delay_end, 3)
    })

    test('running state on Wash + Dry course decodes status, spin, temp, lock', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing')
        assert.equal(props.spin, 1400)
        assert.equal(props.temp, 40)
        assert.equal(props.drying_mode, 'Auto')
        // flags1=0x42 = 0x40 (door locked, inverted) + 0x02 (remote_start)
        assert.equal(props.door_lock, 'OFF') // locked while running
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.child_lock, 'OFF')
    })

    test('drying state on Drying-only course decodes status=Drying, drying_mode=Auto', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_DRYING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Drying')
        assert.equal(props.drying_mode, 'Auto')
        assert.equal(props.initial_time, 55)
        assert.equal(props.remaining_time, 55)
        assert.equal(props.cycles, 11)
        // The Drying-only course does not set spin/temp on this model.
        assert.equal(props.spin, 'unknown')
        assert.equal(props.temp, 'unknown')
    })

    test('power-off transition (status=0)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_POWER_OFF)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
    })

    test('frames with wrong inner length are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = ha.devices[DEVICE_ID].properties.power
        thinq.emit('data', buf('AA08200A01020304BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, before)
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

    test('HA write start button', () => {
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
})
