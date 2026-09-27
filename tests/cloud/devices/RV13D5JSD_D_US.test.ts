import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RV13D5JSD_D_US'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RV13D5JSD_D_US'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures below are unmodified frames captured from a DLEX4200B. They cover the physical dial
// walk, option-button walk and complete runs rather than relying on synthetic records.
const EB_OFF = buf('AA2330EB001B000039003900000000000400000000A800000001000000CA000000B9BB')

const NORMAL = buf(
    'AA4030EC001B010001000100000000000400000040A800000000000000CA000000001B010039003903000304000400000040AA00000000000000CA0000007FBB',
)
const SMALL_LOAD = buf(
    'AA4030EC001B010037003707000303000400000040A800000000000000CA000000001B01001E001E09000305000400000040A800000000000000CA00000027BB',
)
const SPORTSWEAR = buf(
    'AA4030EC001B010019001910000005000400000040A800000000000000CA000000001B01001B001B0B000303000400000040A800000000000000CA0000006DBB',
)
const ANTIBACTERIAL = buf(
    'AA4030EC001B01001E001E09000305000400000040A800000000000000CA000000001B01010A010A08000505000400000040A800000000000000CA0000004ABB',
)

const TIME_DRY_60 = buf(
    'AA4030EC001B010028002812000003030400000040A800000000000002CA000000001B010100010012000005050400000040A800000000000000CA00000067BB',
)
const TIME_DRY_20 = buf(
    'AA4030EC001B010100010012000005050400000040A800000000000000CA000000001B010014001412000005010400000040A800000000000000CA0000005DBB',
)
const TEMP_ULTRA_LOW = buf(
    'AA4030EC001B010028002812000005030400000040A800000000000000CA000000001B010028002812000001030400000040A800000000000000CA0000002FBB',
)
const LESS_TIME = buf(
    'AA4030EC001B010014001412000005010400000040A800000000000000CA000000001B01000F000F120000050104FB000040A800000000000000CA0000004EBB',
)
const MORE_TIME = buf(
    'AA4030EC001B01000F000F120000050104FB000040A800000000000000CA000000001B010014001412000005010400000040A800000000000000CA0000004EBB',
)

const SIGNAL_OFF = buf(
    'AA4030EC001B010014001412000005010400000040A800000000000000CA000000001B010014001412000005010000000040A800000000000000CA00000073BB',
)
const SIGNAL_HIGH = buf(
    'AA4030EC001B010014001412000005010000000040A800000000000000CA000000001B010014001412000005010400000040A800000000000000CA00000073BB',
)
const WRINKLE_CARE_ON = buf(
    'AA4030EC001B010014001412000005010400000040A800000000000000CA000000001B010014001412000005010400000050A800000000000000CA0000006FBB',
)
const WRINKLE_CARE_OFF = buf(
    'AA4030EC001B010014001412000005010400000050A800000000000000CA000000001B010014001412000005010400000040A800000000000000CA0000006FBB',
)
const DAMP_DRY_ON = buf(
    'AA4030EC001B010036003601000305000400000040A800000000000000CA000000001B010036003601000305000400000048A800000000000000CA000000C9BB',
)
const DAMP_DRY_OFF = buf(
    'AA4030EC001B010036003601000305000400000048A800000000000000CA000000001B010036003601000305000400000040A800000000000000CA000000C9BB',
)
const REDUCE_STATIC_ON = buf(
    'AA4030EC001B010036003601000305000400000040A800000000000000CA000000001B010034003401000305000400000042A800000000000005CA000000C2BB',
)
const REDUCE_STATIC_OFF = buf(
    'AA4030EC001B010034003401000305000400000042A800000000000005CA000000001B010036003601000305000400000040A800000000000002CA000000CCBB',
)
const TURBO_STEAM_ON = buf(
    'AA4030EC001B010036003601000305000400000040A800000000000002CA000000001B010036003601000305000400000040AC00000000000000CA000000CFBB',
)
const TURBO_STEAM_OFF = buf(
    'AA4030EC001B010036003601000305000400000040AC00000000000000CA000000001B010036003601000305000400000040A800000000000000CA000000CDBB',
)

const DRYING = buf(
    'AA4030EC001B000001000100000000000400000040A80001A738000000CA000000001B320039003903000304000400000000AB00000001000000CA000000A9BB',
)
const COOLING = buf(
    'AA4030EC001B320006010303000304000400000000AB00068801000000CA000000001B330005010203000304000400000000AB0006B032000000CA00000065BB',
)
const END = buf(
    'AA4030EC001B330001010903000304000400000000AB0006D632000000CA000000001B040001010903000304000400000040AA0006D633000000CA000000BEBB',
)
const WRINKLE_CARE_RUNNING = buf(
    'AA4030EC001B040001000A15000004000400000050A80001A733000002CA000000001B380001000115000004000400000050A90001A704000002CA0000009ABB',
)
const SETTLES_OFF = buf(
    'AA4030EC001B040001010903000304000400000040AA0006D633000000CA000000001B000001000100000000000400000040A80006D604000000CA000000E1BB',
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

describe('RV13D5JSD_D_US', () => {
    test('publishes the locally observed dryer entities', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config?.components ?? {}
        for (const name of [
            'power',
            'status',
            'dry_completed',
            'course',
            'remaining_time',
            'initial_time',
            'dry_level',
            'temp',
            'signal',
            'reduce_static',
            'damp_dry_signal',
            'energy_saver',
            'turbo_steam',
            'wrinkle_care',
        ])
            assert.ok(components[name], `${name} entity present`)
    })

    test('0xEB reconnect snapshot decodes as Off', () => {
        const p = feed([EB_OFF])
        assert.equal(p.power, 'OFF')
        assert.equal(p.status, 'Off')
        assert.equal(p.course, 'None')
        assert.equal(p.dry_completed, 'OFF')
    })

    test('dial course, time, dry-level and temperature fields decode from captured values', () => {
        let p = feed([NORMAL])
        assert.equal(p.course, 'Normal')
        assert.equal(p.remaining_time, 57)
        assert.equal(p.initial_time, 57)
        assert.equal(p.dry_level, 'Normal')
        assert.equal(p.temp, 'Mid High')
        assert.equal(p.energy_saver, 'ON')

        p = feed([SMALL_LOAD])
        assert.equal(p.course, 'Small Load')
        assert.equal(p.remaining_time, 30)
        assert.equal(p.temp, 'High')

        p = feed([SPORTSWEAR])
        assert.equal(p.course, 'Sportswear')
        assert.equal(p.remaining_time, 27)
        assert.equal(p.temp, 'Medium')

        p = feed([ANTIBACTERIAL])
        assert.equal(p.course, 'Antibacterial')
        assert.equal(p.remaining_time, 70)
        assert.equal(p.dry_level, 'Very')
    })

    test('Time Dry button cycles setting codes and its temperature can be changed', () => {
        let p = feed([TIME_DRY_60])
        assert.equal(p.course, 'Time Dry')
        assert.equal(p.remaining_time, 60)
        assert.equal(p.time_dry_setting, 60)
        assert.equal(p.temp, 'High')

        p = feed([TIME_DRY_60, TIME_DRY_20])
        assert.equal(p.remaining_time, 20)
        assert.equal(p.time_dry_setting, 20)

        p = feed([TEMP_ULTRA_LOW])
        assert.equal(p.temp, 'Ultra Low')
    })

    test('More/Less Time is decoded as a signed minute adjustment', () => {
        let p = feed([LESS_TIME])
        assert.equal(p.remaining_time, 15)
        assert.equal(p.more_less_time, -5)

        p = feed([LESS_TIME, MORE_TIME])
        assert.equal(p.remaining_time, 20)
        assert.equal(p.more_less_time, 0)
    })

    test('Signal and each captured option bit toggle without colliding', () => {
        assert.equal(feed([SIGNAL_OFF]).signal, 'Off')
        assert.equal(feed([SIGNAL_OFF, SIGNAL_HIGH]).signal, 'High')

        let p = feed([WRINKLE_CARE_ON])
        assert.equal(p.wrinkle_care, 'ON')
        assert.equal(p.damp_dry_signal, 'OFF')
        assert.equal(p.reduce_static, 'OFF')
        p = feed([WRINKLE_CARE_ON, WRINKLE_CARE_OFF])
        assert.equal(p.wrinkle_care, 'OFF')

        p = feed([DAMP_DRY_ON])
        assert.equal(p.damp_dry_signal, 'ON')
        assert.equal(p.wrinkle_care, 'OFF')
        p = feed([DAMP_DRY_ON, DAMP_DRY_OFF])
        assert.equal(p.damp_dry_signal, 'OFF')

        p = feed([REDUCE_STATIC_ON])
        assert.equal(p.reduce_static, 'ON')
        assert.equal(p.load_item, 5)
        p = feed([REDUCE_STATIC_ON, REDUCE_STATIC_OFF])
        assert.equal(p.reduce_static, 'OFF')

        p = feed([TURBO_STEAM_ON])
        assert.equal(p.turbo_steam, 'ON')
        p = feed([TURBO_STEAM_ON, TURBO_STEAM_OFF])
        assert.equal(p.turbo_steam, 'OFF')
    })

    test('full run decodes Drying, Cooling and End, then latches completion through Off', () => {
        let p = feed([DRYING])
        assert.equal(p.status, 'Drying')
        assert.equal(p.dry_completed, 'OFF')

        p = feed([DRYING, COOLING])
        assert.equal(p.status, 'Cooling')

        p = feed([DRYING, COOLING, END])
        assert.equal(p.status, 'End')
        assert.equal(p.dry_completed, 'ON')
        assert.equal(p.remaining_time, 0)

        p = feed([DRYING, COOLING, END, SETTLES_OFF])
        assert.equal(p.status, 'Off')
        assert.equal(p.power, 'OFF')
        assert.equal(p.dry_completed, 'ON')

        p = feed([DRYING, COOLING, END, SETTLES_OFF, NORMAL])
        assert.equal(p.dry_completed, 'OFF')
    })

    test('post-completion Wrinkle Care is a state and keeps completion latched', () => {
        const p = feed([END, WRINKLE_CARE_RUNNING])
        assert.equal(p.status, 'Wrinkle Care')
        assert.equal(p.power, 'ON')
        assert.equal(p.remaining_time, 0)
        assert.equal(p.dry_completed, 'ON')
    })

    test('start requests a status snapshot', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa0ef0ed1121010000001800b5bb'],
        )
    })

    test('unrelated and truncated frames are ignored', () => {
        for (const junk of ['AA09307200C80048BB', 'AA0A30EC001B010029BB', '001122']) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(junk))
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
        }
    })
})
