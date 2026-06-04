import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V__F___W.B_1QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V__F___W.B_1QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_V__F___W.B_1QEUK', swVersion: '2.10.123' }

const SAMPLE_INITIAL = buf(
    'AA5420EC002500000000000000000000000000000000000000010036006400000000000000000000000000002501000000000000000000000000000000000000000036006400000000000000000000000000DFBB',
)
const SAMPLE_INITIAL_WASH_1200_40C_DRY_AUTO = buf(
    'AA5420EC00250101000100180000000000020000000000000600001000640000000000000000000000000000250104380438130003090401020000000000000400001000640000040000000000000000000053BB',
)
const SAMPLE_INITIAL_COTTON_1000_40C_TURBO_WASH_DRY_1H = buf(
    'AA5420EC002501040C040C0100030904010400000000010002000010006400000400000000000000000000002501030603060100030704010400000100010002000010006400000400000000000000000000FCBB',
)
const SAMPLE_RUNNING_QUICK_400_40C = buf(
    'AA5420EC002506001300140C00030204010000000142200001010036006400000100000E00000000000000002506001300140C00030204010000000142200001010036006400000100000F00000000000000A2BB',
)
const SAMPLE_RINSING_QUICK_400_40C = buf(
    'AA5420EC002507000A00140C0003020001000000014200000106003600640000010000B900000000000000002507000A00140C0003020001000000014200000106003600640000010000BA00000000000000AABB',
)
const SAMPLE_SPINNING_QUICK_400_40C = buf(
    'AA5420EC002507000600140C0003020001000000014200000106003600640000010000BC00000000000000002508000500140C0000020000000000004200000107003600640000010000BC00000000000000ADBB',
)
const SAMPLE_END_QUICK_400_40C = buf(
    'AA5420EC002508000100140C0000020000000000004200000107003600640000010000BF0000000000000000250A000000140C0000000000000000000000000108003600640000010000BF00000000000000E5BB',
)
const SAMPLE_POWER_OFF = buf(
    'AA5420EC00250A000000140C0000000000000000000000000108003600640000010000BF00000000000000002500000000140C000000000000000000000000010A003600640000010000BF0000000000000033BB',
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
            'drying_mode',
            'cycles',
            'remote_start',
            'door_lock',
            'energy',
            'initial_time',
            'remaining_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.status.options as string[]).includes('Error'))
    })

    test('initial state push decodes status, time and error state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.remaining_time, 0 * 60 + 0) // 00:00
        assert.equal(props.initial_time, 0 * 60 + 0) // 00:00
        assert.equal(props.drying_mode, 'Off')
        assert.equal(props.cycles, 54)
        assert.equal(props.energy, 0)
        // flags1=0x00 = remote_start=OFF, door_lock=ON (unlocked, the inverted convention)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.energy, 0)
    })

    test('initial (wash + dry auto) state push decodes status, course, drying mode, temp and spin', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_WASH_1200_40C_DRY_AUTO)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Wash + Dry')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.remaining_time, 4 * 60 + 56) // 04:56
        assert.equal(props.initial_time, 4 * 60 + 56) // 04:56
        assert.equal(props.spin, 1200)
        assert.equal(props.temp, 40)
        assert.equal(props.drying_mode, 'Auto')
        assert.equal(props.cycles, 16)
        assert.equal(props.energy, 0)
        // flags1=0x00 = remote_start=OFF, door_lock=ON (unlocked, the inverted convention)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.energy, 0)
    })

    test('initial (wash + dry 1H) state push decodes status, course, drying mode, temp and spin', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INITIAL_COTTON_1000_40C_TURBO_WASH_DRY_1H)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.remaining_time, 3 * 60 + 6) // 03:06
        assert.equal(props.initial_time, 3 * 60 + 6) // 03:06
        assert.equal(props.spin, 1000)
        assert.equal(props.temp, 40)
        assert.equal(props.drying_mode, '01:00')
        assert.equal(props.cycles, 16)
        assert.equal(props.energy, 0)
        // flags1=0x00 = remote_start=OFF, door_lock=ON (unlocked, the inverted convention)
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.door_lock, 'ON')
        assert.equal(props.energy, 0)
    })

    test('running state with door locked + remote_start active', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RUNNING_QUICK_400_40C)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Washing') // 0x06
        assert.equal(props.course, 'Quick 14')
        assert.equal(props.spin, 400)
        assert.equal(props.temp, 40)
        assert.equal(props.drying_mode, 'Off')
        assert.equal(props.initial_time, 0 * 60 + 20) // 00:20
        assert.equal(props.remaining_time, 0 * 60 + 19) // 00:14
        // flags1=0x42 = 0x40 lock bit set + 0x02 remote_start bit set
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.door_lock, 'OFF')
        assert.equal(props.energy, 15)
    })

    test('rinsing state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSING_QUICK_400_40C)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing') // 0x07
        assert.equal(props.remaining_time, 10)
        assert.equal(props.energy, 186)
    })

    test('spinning state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_SPINNING_QUICK_400_40C)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning') // 0x08
        assert.equal(props.remaining_time, 5)
        assert.equal(props.energy, 188)
    })

    test('end state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_END_QUICK_400_40C)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'End') // 0x0A
        assert.equal(props.remaining_time, 0)
        assert.equal(props.door_lock, 'ON') // still locked at the end-of-cycle reading
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.energy, 191)
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
        // valid AA..BB envelope but inner is too short to be a 53-byte status
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
