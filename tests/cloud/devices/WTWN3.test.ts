import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WTWN3'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq1Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WTWN3'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WTWN3', swVersion: '1.0' }

// Samples: a real Mix cycle captured from a WTWN3 by the local_smarthinq1 project
// (flows/washer-cycle-20260719.log), decoded there against LG's modelJson:
// Course Mix, Wash Normal, Spin 1000, Temp 40, Rinse+, TCLCount 57.
const SAMPLE_STATE_WASHING_MIX_1H33 = buf('06012101210700030704020000000040000001030039006400000400')
const SAMPLE_STATE_RINSING_MIX_0H47 = buf('07002f01210700030700020000000040000001060039006400000400')
const SAMPLE_STATE_SPINNING_MIX_0H11 = buf('08000b01210700000700000000000040000001070039006400000400')
const SAMPLE_STATE_END_MIX = buf('0a000001210700000000000000000000000001080039006400000400')
const SAMPLE_STATE_OFF_IDLE = buf('000000012107000000000000000000000000020a0039006400000400')
// Real frame from the author's F4J7TN1W (2026-09-08): Tub Clean just started, Measuring, 1:14, door locked,
// 41 washes since the last tub clean.
const SAMPLE_STATE_MEASURING_TUB_CLEAN_LOCKED = buf(
    '04 01 0e 01 0e 12 00 03 01 06 01 00 00 00 00 40 00 00 01 01 00 29 00 4b 00 00 02 00',
)
// Synthetic (bit layout from modelJson Option1/Option2): Ready, Cotton 1200/40, remaining 2:10,
// delay start 3:00, TurboWash|PreWash|Steam set, remote start + child lock set, door unlocked.
const SAMPLE_STATE_READY_COTTON_OPTIONS = buf(
    '01 02 0a 02 0a 01 00 03 09 04 01 00 03 00 c1 82 00 00 00 00 00 39 00 64 00 00 04 00',
)
// Synthetic: error DE1 with downloaded course Jeans (0x39 at byte 20) overriding base course 3
const SAMPLE_STATE_ERROR_DE1_SMART_JEANS = buf(
    '12 01 0e 01 0e 03 02 03 07 02 01 00 00 00 00 00 00 00 00 00 39 39 00 64 00 00 04 00',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq1Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected components', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published on construction')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'power',
            'start',
            'pause',
            'status',
            'error',
            'error_message',
            'course',
            'wash',
            'temp',
            'spin',
            'rinse',
            'turbo_wash',
            'pre_wash',
            'steam',
            'crease_care',
            'medic_rinse',
            'tub_clean_count',
            'remote_start',
            'door_lock',
            'child_lock',
            'standby',
            'initial_time',
            'remaining_time',
            'reserve_time',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        assert.ok((components.status.options as string[]).includes('Washing'))
        assert.ok((components.course.options as string[]).includes('Mix'))
        assert.ok((components.temp.options as string[]).includes('Cold'))
    })

    test('washing state decodes course, options and times from a real capture', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_WASHING_MIX_1H33)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Washing')
        assert.equal(props.course, 'Mix')
        assert.equal(props.wash, 'Normal')
        assert.equal(props.spin, 1000)
        assert.equal(props.temp, '40')
        assert.equal(props.rinse, 'Rinse+')
        assert.equal(props.remaining_time, 93)
        assert.equal(props.initial_time, 93)
        assert.equal(props.reserve_time, 0)
        assert.equal(props.error, 'OFF')
        assert.equal(props.error_message, 'OK')
        assert.equal(props.door_lock, 'OFF') // OFF means locked
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.remote_start, 'OFF')
        assert.equal(props.tub_clean_count, 57)
        assert.equal(props.standby, 'OFF')
    })

    test('tub clean start: Measuring with the door locked, from a live frame', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_MEASURING_TUB_CLEAN_LOCKED)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'Measuring')
        assert.equal(props.course, 'Tub Clean')
        assert.equal(props.wash, 'Normal')
        assert.equal(props.spin, 0)
        assert.equal(props.temp, '60')
        assert.equal(props.rinse, 'Normal')
        assert.equal(props.remaining_time, 74)
        assert.equal(props.initial_time, 74)
        assert.equal(props.door_lock, 'OFF') // locked
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.tub_clean_count, 41)
    })

    test('rinse and spin phases follow the state byte', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_RINSING_MIX_0H47)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Rinsing')
        assert.equal(props.remaining_time, 47)
        assert.equal(props.temp, 'None') // temperature cleared once washing is over

        thinq.emit('data', SAMPLE_STATE_SPINNING_MIX_0H11)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Spinning')
        assert.equal(props.remaining_time, 11)
        assert.equal(props.spin, 1000)
    })

    test('end state keeps power on, door unlocked', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_END_MIX)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.status, 'End')
        assert.equal(props.remaining_time, 0)
        assert.equal(props.door_lock, 'ON')
    })

    test('idle state publishes power=OFF and "Off" status', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_OFF_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.status, 'Off')
        assert.equal(props.course, 'Mix') // last course stays visible on the panel
        assert.equal(props.tub_clean_count, 57)
    })

    test('option bits, delay start and locks decode', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_READY_COTTON_OPTIONS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Ready')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.spin, 1200)
        assert.equal(props.temp, '40')
        assert.equal(props.remaining_time, 130)
        assert.equal(props.reserve_time, 180)
        assert.equal(props.turbo_wash, 'ON')
        assert.equal(props.pre_wash, 'ON')
        assert.equal(props.steam, 'ON')
        assert.equal(props.crease_care, 'OFF')
        assert.equal(props.medic_rinse, 'OFF')
        assert.equal(props.remote_start, 'ON')
        assert.equal(props.child_lock, 'ON')
        assert.equal(props.door_lock, 'ON') // unlocked
    })

    test('downloaded course overrides the base course; error publishes message', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_STATE_ERROR_DE1_SMART_JEANS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Error')
        assert.equal(props.error, 'ON')
        assert.equal(props.error_message, 'Door open error (DE1)')
        assert.equal(props.course, 'Jeans')
    })

    test('ignores frames that are not 28 bytes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('0102'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('power switch and buttons send ThinQ1 Control commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('power', 'OFF')
        dev.setProperty('pause', '')
        dev.setProperty('start', '')
        assert.deepEqual(thinq.sent, [
            { Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' },
            { Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' },
            { Cmd: 'Control', CmdOpt: 'Operation', Value: 'Start', Format: 'B64', Data: '' },
        ])
    })
})
