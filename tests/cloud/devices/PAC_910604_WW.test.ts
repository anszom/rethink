import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/PAC_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'
import { encodePacket } from '@/util/packet-codec'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'PAC_910604_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '310917' }

/*
 * Every frame below is a real capture of a physical PAC_910604_WW, from the four hand-operated
 * sessions kkqq9320 reported in issue #105. They all carry the 0xA7 state marker this model uses
 * instead of 0x87, so the tests exercise the isHeaderByte6() widening end to end.
 */

// The appliance's own capability reply, 174 bytes / 54 TLVs. 0x2c1 = 35 (modes 0, 1, 5),
// 0x2c2 = 127100, 0x2e1/0x2e2 = 36/60 (18..30 C), 0x2d3 = 282643 (sleep timer), and - the point of
// this model - NO 0x2cc at all, with 0x2cd reading 0.
const CAPS_RESPONSE_HEX =
    '000004000000A7020161A1' +
    '6400644F64907C6C6018036C816D01B000B05023B0B001F07CB0C0B10DB23004F800B290C0B2E0084' +
    '3B340B4F0045013B500B5601213B5A0C002B76001A0B780B7C0B801B85024B8903CB8D020B9103CBC' +
    '600201BD1010BD60580FB240D3F0020000BC08D42001FFEA1021E1901CDD05FB102FB4A00200B6B03' +
    '53028B6F0310917EFC0F010FFF06003FEFA01B5C0B61030B644B5C1B61030B648B5C5B61030B643' +
    '2A9C'

// Comprehensive state dump, 221 bytes / 94 TLVs: power ON, mode cool, fan 4 ('medium'),
// temp step 0.5, current 25.0 C, target 21.0 C, filter 3000 h rated with 2442 h left.
const QUERY_RESPONSE_HEX =
    '000004000000A7020440' +
    'D091009283918091C0A300A3407DC17E407F902A7E847F5032820081408180808080C082408D8082' +
    'C0830083408390FF83C19080868086C087009F4087C08780938193C09440948090409000D2008940' +
    '8840ACE00DAD8E808E408E0090C0CCC0CD00CD40CD9039D5A00BB8D560098ACDC1C8C08F808FC08F' +
    '41AB40AB00D1009780A801A840A881A8C1E8807EC0E3D065E800FA80F140E480EB103CEA80EAC0EA' +
    '40EEC2EE407C86EE80698169C16D406E416CD03C5DF0B405A0A740AA0064F00201016F8059404B40' +
    '4BC14CC15F41C490CD' +
    '5D7F'

// Fan steps 1..5 on the panel, wire 2..6.
const STATE_FAN_1_HEX = '000004000000A7020441047E82C4829AD1' // 0x1fa=2
const STATE_FAN_5_HEX = '000004000000A7020447027E860483' // 0x1fa=6

// Cool / dry / air-clean.
const STATE_MODE_COOL_HEX = '000004000000A70204920B7E407F902A7E86D200C489366F'
const STATE_MODE_DRY_HEX = '000004000000A70204850B7E417F90307E88D201C489B93B'
const STATE_MODE_AIRCLEAN_HEX = '000004000000A702048E0B7E457F90347E82D205C4898B59'

// Sideways aim, 0x2a3.
const STATE_WIND_CONCENTRATED_HEX = '000004000000A702049A02A8C112A4' // 0x2a3=1
const STATE_WIND_SPLIT_HEX = '000004000000A70204940F8CA001F08CD045ACE00129A8C5C48D2B51' // 0x2a3=5, 0x2b3=297

// Panel switches, in the polarity the appliance stores them.
const STATE_CHILDLOCK_ON_HEX = '000004000000A70204EE04EA41C482CD33' // 0x3a9=1
const STATE_DISPLAY_OFF_HEX = '000004000000A70204F70487C1C482C45B' // 0x21f=1, i.e. display off
const STATE_DISPLAY_ON_HEX = '000004000000A70204F90487C0C48273C8' // 0x21f=0
const STATE_UVNANO_ON_HEX = '000004000000A702046204A881C482B7F3' // 0x2a2=1

// AI dry: 0x20e is 0 or 255 and nothing else.
const STATE_AIDRY_ON_HEX = '000004000000A702046E038390FF03DE' // 0x20e=255
const STATE_AIDRY_END_HEX = '000004000000A7020404068940A8C1C48485B6' // 0x225=0, 0x2a3=1

const STATE_POWER_OFF_HEX = '000004000000A70204AC117DC07E407F90327E86D2008F40E880C48F64F0'

/*
 * 0xa8 telemetry records, 307 bytes, from the purpose-run hvac_action experiment. The compressor
 * flag lives at byte 160 and the labels are the owner's live annotations.
 */
const A8_COOLING_HEX = // @160=1, "the compressor is running"
    '000004000000A8670301FF0B0101035601010000040000000000000000000001003C350000000000000000000100000B' +
    'B80BB801000500000000000044000000000100000100003C0001000000001800000202010156142D1E00320000000000' +
    '00000000006100001919000226024E023A000002E4030702F8000099009A180000000005250004800005D300020F4618' +
    '4646009F080015021702180000000000010004000026170002EE000000014B51CA3735CE000055093209F00420036C00' +
    '0000000101010100FF000000000000000000000000006400DE0003DE3900030186018601000000010000000012010000' +
    '000000000ACE000100030000000A00005600024D00335F00000000000000000000000000000000000A0A3300FFFFFF00' +
    '020000000000000000000000000000000530AD'
const A8_STOPPED_HEX = // @160=0, "it seems to have stopped", 0 W metered at the outdoor unit
    '000004000000A8666501FF0B0101655801010000040000000000000000000001003C350000000000000000000100000B' +
    'B80BB801000500000000000044000000000100000100003C0001000000001800000202010156142D1E00320000000000' +
    '00000000006100001919000226024E023A0000022B0253023F0000900091180000000005250004800005D300000A2800' +
    '00000000000016020000000000000000000005002800000002EE000000004B5FCB0035D3000000098209F00458036C00' +
    '00000001010100001C000000000000000000000000006400E20001CC050000012C012C00000000010000000012010000' +
    '000000000ACE000100030000000A00005700026C0003F0000000000000000000000000000000000004033300FFFFFF00' +
    '02000000000000000000000000000000051BA1'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (_id: string, prop: string, value: string) => dev.setProperty(prop, value))
    return { ha, thinq, dev }
}

/** The caps -> values -> initMakeSetConfig handshake ac_common builds its config from. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()
    thinq.resetRecorder() // discard the constructor's queryCaps

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    tickMockTimers(t, 600) // valuesReceived arms a 500 ms masking delay before building the config

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

const components = (ha: MockHAConnection) =>
    ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

/** TLVs of a packet the handler put on the wire. */
function sentTLVs(pkt: Buffer): Record<number, number> {
    const out: Record<number, number> = {}
    for (const { t, v } of TLV.parse(pkt.subarray(11, pkt.length - 2))) out[t] = v
    return out
}

describe(MODEL_ID, () => {
    test('the 0xA7 capability reply is accepted and provokes the values query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        // A handler that only accepted 0x87 would drop this and never ask for values.
        assert.equal(thinq.outbox.length, 1, 'values query sent in response to caps')
        dev.drop()
    })

    test('climate exposes only the three modes and five speeds this model has', (t) => {
        const { ha, dev } = buildReadyDevice(t)
        const climate = components(ha).climate

        assert.deepEqual(climate.modes, ['off', 'cool', 'dry', 'fan_only'])
        // 'auto' appears once even though both wire 7 and 8 read back as it
        assert.deepEqual(climate.fan_modes, ['very low', 'low', 'medium', 'high', 'very high', 'auto'])
        // sideways aim only - this model has no vertical vane
        assert.deepEqual(climate.swing_horizontal_modes, ['focus', 'wide', 'left', 'right', 'split'])
        assert.equal(climate.swing_modes, undefined)
        // 0x2e1/0x2e2 = 36/60 in the capability reply
        assert.equal(climate.min_temp, 18)
        assert.equal(climate.max_temp, 30)

        dev.drop()
    })

    test('the comprehensive dump publishes the climate state', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        /* the first dump is what builds the config; a second one is what it publishes from */
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 25)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 21)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')

        dev.drop()
    })

    test('mode notifications round-trip through the three supported modes', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_MODE_DRY_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry')
        thinq.emit('data', buf(STATE_MODE_AIRCLEAN_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'fan_only')
        thinq.emit('data', buf(STATE_MODE_COOL_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')

        thinq.emit('data', buf(STATE_POWER_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off')

        dev.drop()
    })

    test('fan speeds map onto the named steps', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_FAN_1_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'very low')
        thinq.emit('data', buf(STATE_FAN_5_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'very high')

        dev.drop()
    })

    test('sideways aim is published as the horizontal swing', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_WIND_CONCENTRATED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'focus')
        thinq.emit('data', buf(STATE_WIND_SPLIT_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'split')

        dev.drop()
    })

    test('power is in tenths of a watt on this model, not whole watts', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // the split-wind frame carries 0x2b3 = 297
        thinq.emit('data', buf(STATE_WIND_SPLIT_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['energy_current-'], 29.7)

        dev.drop()
    })

    test('the panel switches, including the two inverted ones', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(STATE_CHILDLOCK_ON_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['childlock-'], 'ON')

        thinq.emit('data', buf(STATE_UVNANO_ON_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['uvnano-'], 'ON')

        // 0x21f stores 1 for "display off", so the switch reads the other way round
        thinq.emit('data', buf(STATE_DISPLAY_OFF_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['display-'], 'OFF')
        thinq.emit('data', buf(STATE_DISPLAY_ON_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['display-'], 'ON')

        dev.drop()
    })

    test('an inverted switch writes the polarity the appliance stores', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.emit('setProperty', DEVICE_ID, 'display-', 'OFF')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x21f: 1 })

        dev.drop()
    })

    test('AI dry is an enable, a strength and a countdown on three tags', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const c = components(ha)

        assert.equal(c.autodry.platform, 'switch')
        assert.equal(c.autodrylevel.platform, 'select')
        assert.deepEqual(c.autodrylevel.options, ['1', '2', '3', '4', '5'])
        assert.equal(c.autodryremain.unit_of_measurement, 'min', 'minutes, not the wall units percent')

        // the enable reads 255, not 1
        thinq.emit('data', buf(STATE_AIDRY_ON_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['autodry-'], 'ON')

        // and writes it too
        thinq.resetRecorder()
        ha.emit('setProperty', DEVICE_ID, 'autodry-', 'ON')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x20e: 255 })

        dev.drop()
    })

    test('a running AI dry cycle is its own state, and can be cancelled', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // the comprehensive dump had 0x225 = 0
        assert.equal(ha.devices[DEVICE_ID].properties['autodryrunning'], 'OFF')

        thinq.resetRecorder()
        ha.emit('setProperty', DEVICE_ID, 'autodrycancel', 'PRESS')
        assert.equal(thinq.outbox.length, 1, 'the cancel is a plain write of 0 to 0x225')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x225: 0 })

        // the appliance's own reply is what moves the sensor
        thinq.emit('data', buf(STATE_AIDRY_END_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['autodryrunning'], 'OFF')

        dev.drop()
    })

    test('the filter counters are value tags here, and they reset', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))

        // 3000 h rated, 2442 h left
        assert.equal(ha.devices[DEVICE_ID].properties['filter_life'], 3000)
        assert.equal(ha.devices[DEVICE_ID].properties['filter_used'], 558)
        assert.equal(ha.devices[DEVICE_ID].properties['filter_remaining'], 81)

        assert.ok(components(ha).filterreset, 'this model accepts a reset')
        thinq.resetRecorder()
        ha.emit('setProperty', DEVICE_ID, 'filterreset', 'PRESS')
        assert.deepEqual(sentTLVs(thinq.outbox[0]), { 0x355: 0 })

        dev.drop()
    })

    test('hvac_action needs the compressor record, and says nothing until it lands', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        const action = () => ha.devices[DEVICE_ID].properties['climate-action']

        // cooling, but no 0xa8 record yet: better silent than guessing
        assert.equal(action(), undefined)

        thinq.emit('data', buf(A8_COOLING_HEX))
        assert.equal(action(), 'cooling')

        thinq.emit('data', buf(A8_STOPPED_HEX))
        assert.equal(action(), 'idle')

        // air-clean is answered from the mode alone, before the flag is consulted
        thinq.emit('data', buf(A8_COOLING_HEX))
        thinq.emit('data', buf(STATE_MODE_AIRCLEAN_HEX))
        assert.equal(action(), 'fan')

        // and a powered-off appliance is 'off' even while the compressor coasts down
        thinq.emit('data', buf(A8_COOLING_HEX))
        thinq.emit('data', buf(STATE_POWER_OFF_HEX))
        assert.equal(action(), 'off')

        dev.drop()
    })

    test('the compressor reading is discarded when the appliance is switched back on', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        thinq.emit('data', buf(A8_COOLING_HEX))
        thinq.emit('data', buf(STATE_POWER_OFF_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['climate-action'], 'off')

        // a reading taken before the off period cannot describe the run that is starting
        thinq.emit('data', buf(STATE_MODE_COOL_HEX))
        assert.equal(
            ha.devices[DEVICE_ID].properties['climate-action'],
            'off',
            'still the last thing known, not a stale "cooling"',
        )

        dev.drop()
    })

    test('the 15-byte 0xa8 variant is not mistaken for a telemetry record', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', buf(A8_STOPPED_HEX))
        assert.equal(ha.devices[DEVICE_ID].properties['climate-action'], 'idle')

        // same marker, but 15 bytes - it would index past the end of the buffer
        thinq.emit('data', buf('000004000000a8180201024ec1abda'))
        assert.equal(ha.devices[DEVICE_ID].properties['climate-action'], 'idle', 'unchanged')

        dev.drop()
    })

    test('the temperature step select tracks 0x1fb and republishes the config', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        thinq.emit('data', buf(QUERY_RESPONSE_HEX)) // carries 0x1fb = 0

        assert.equal(ha.devices[DEVICE_ID].properties['tempstep-'], '0.5')
        assert.equal(components(ha).climate.temp_step, 0.5)

        /* Synthesized rather than captured - no frame on file carries 0x1fb = 1. */
        thinq.emit(
            'data',
            buf(encodePacket({ protocol: 'tlv', direction: 'fromDevice', tlv: [{ t: 0x1fb, v: 1 }] }).hex),
        )
        assert.equal(ha.devices[DEVICE_ID].properties['tempstep-'], '1')
        assert.equal(components(ha).climate.temp_step, 1)

        dev.drop()
    })
})
