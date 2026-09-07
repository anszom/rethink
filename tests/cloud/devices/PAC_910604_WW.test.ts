import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/PAC_910604_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'PAC_910604_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'TEST', swVersion: '1.0' }

// Real packet captures from a PAC_910604_WW floor-standing air conditioner (deviceType 401,
// TLV protocol with 0xA7 header, same envelope as RAC_056905_WW).
//
// Tag map (each verified by owner-operated toggles, on->off round trips):
//   0x1f7 power (0/1)            0x1f9 mode (0=cool, 1=dry)      0x1fa fan (level x 0x0101)
//   0x1fd current temp (/2)      0x1fe target temp (/2)         0x205 vertical swing (0/1)
//   0x206 horizontal swing (0=off, 1=right, 256=left, 257=both)
//   0x208 human sense (0=off, 1=direct, 2=indirect)             0x20d eco (0/1)
//   0x20e auto-dry enable (0/1)    0x20f air clean (0/1)        0x21a sleep timer (minutes)
//   0x225 auto-dry countdown (minutes)
//   0x236 cool power (0/1)       0x209 long power (0/1)         0x23e smart care (0/1)
//   0x23f smart guide (0/4096)
//   0x333 PM1.0  0x334 PM2.5  0x335 PM10  0x336 humidity (app cross-checked)

// Full state frame, power OFF (before first power-on).
//   0x1f7=0 power=OFF  0x1f9=0  0x1fa=1542(raw)  0x1fd=50  0x1fe=36
//   PM 0/0/0, humidity 57
const POWER_OFF_HEX =
    '000004000000A70204448491009283918091C09300A300A3407DC07E407F90247EA006067F50328200814081808' +
    '08080C082408D8082C083008340838183C09080868086C087009F4087C38780938193C094029440948090409000' +
    'D20089408840ACC08E808E408E0090C0CCC0CD00CD40CD9039D5A002D0D54CCDC0C8C08F808FC08F40AB40AB00D1' +
    '009780C49081A551'

// Full state frame, power ON, cool, fan medium, swings off.
//   0x1f7=1  0x1f9=0 cool  0x1fa=1028 medium  0x1fd=50 (25C)  0x1fe=52 (26C)
//   PM 8/8/10, humidity 62
const BASE_HEX =
    '000004000000A70204F48591009280918091C09300A300A3407DC17E407F90347EA004047F50328200814081808' +
    '08080C082408D8082C083008340838183C09080868086C087009F4087C38780938193C094029440948090409001' +
    'D20089408840ACD0208E808E408E0090C0CCC8CD08CD4ACD903ED5A002D0D54CCDC1C8C08F808FC08F41AB40AB00' +
    'D1009780C4908241AD'

// Short delta frames (device notifies only changed tags):
// FAN_LOW: mode=dry, fan=514 (low), target=48 (24C)
const FAN_LOW_HEX = '000004000000A702047B0F92C17E417F90307EA00202D201C48D320C'
// HUMAN_AUTO: fan=2056 (auto), human sense=direct
const HUMAN_AUTO_HEX = '000004000000A70204520C92C27EA0080882018180C48A1D97'
// HUMAN_INDIRECT: human sense=indirect
const HUMAN_INDIRECT_HEX = '000004000000A70204660692C28202C484189F'
// COOLPOWER: fan=1799 (turbo), target=36 (18C), swings both, coolpower=1
const COOLPOWER_HEX = '000004000000A70204CD1492C27F90247EA0070781A001018D81CD48C490118313'
// LONGPOWER: fan=2313 (max), swings off, longpower=1, coolpower=0
const LONGPOWER_HEX = '000004000000A70204D20E92C27EA00909818082418D80C48C1BE5'
// ECO_OVERRIDE: eco on, fan reads 0xFF04 (eco flag + medium level)
const ECO_OVERRIDE_HEX = '000004000000A702045F0D92C27F90347EA0FF048341C48B622A'
// Same transition observed with the bytes reversed: 0x04FF.
const ECO_OVERRIDE_REVERSED_HEX = '000004000000A702049C0A92C27EA004FF8341C4881A00'
// SLEEP: sleep timer 300 (5h)
const SLEEP_HEX = '000004000000A70204A70892C286A0012CC4862AD4'
// DRY: auto-dry countdown 25
const DRY_HEX = '000004000000A70204E205895019C4839773'
// ECO_ON / AIRCLEAN_ON / SMARTGUIDE / SWING_V / SWING_L / SWING_R / SWING_BOTH
const ECO_ON_HEX = '000004000000A702043F0C92C283418C90298CD05AC48AA44B'
const AIRCLEAN_ON_HEX = '000004000000A70204150692C283C1C48469F5'
const SMARTGUIDE_HEX = '000004000000A70204740A92C2CD4B8FE01000C48839F2'
const SWING_V_HEX = '000004000000A70204B50692C18141C484D7FC'
const SWING_L_HEX = '000004000000A70204560892C281A00100C48645C2'
const SWING_R_HEX = '000004000000A702049A0692C28181C484BD73'
const SWING_BOTH_HEX = '000004000000A70204F70892C281A00101C486C08E'
// SMARTCARE_ON: fan auto, target 25C, swings both, smartcare=1. The accompanying
// 0x25e=2 is not exposed because its precise meaning is unconfirmed.
const SMARTCARE_ON_HEX = '000004000000A70204A91492C27F90327EA0080881A001018F819782C4901142D5'
// SMARTCARE_OFF: fan medium, swings off, smartcare=0, detail=0
const SMARTCARE_OFF_HEX = '000004000000A70204B80E92C27EA0040481808F809780C48CF29B'
// Auto-dry enable, captured on the physical unit. The owner turned the setting
// off and back on; only 0x20e moves. The selectable duration is cloud-only.
const AUTODRY_OFF_HEX = '000004000000a70204c80492c28380647f'
const AUTODRY_ON_HEX = '000004000000a70204df0692c28381c484ee75'

// Malformed inputs (must be ignored without crashing):
const TRUNCATED_HEX = '000004000000A70204F48591009280' // cut mid-TLV
const BAD_LENGTH_HEX =
    '000004000000A70204FF8591009280918091C09300A300A3407DC17E407F90347EA004047F50328200814081808' +
    '0808080C082408D8082C083008340838183C09' // length byte disagrees with buffer

// State frames from a second owner-operated session (2026-09-07): each control
// below was toggled in the ThinQ app while the wire was recorded.
//   TIMER_ON_STATE: turn-on reservation set to 1h (0x21c=60)
//   TIMER_OFF_STATE: turn-off reservation set to 24h (0x21b=1440)
//   SLEEP_420_STATE: sleep timer set to 7h (0x21a=420)
//   HUMAN_DIRECT_STATE / HUMAN_INDIRECT_STATE: human sense direct (0x208=1) / indirect (2)
//   COOLPOWER_STATE: coolpower on (0x236=1)
const TIMER_ON_STATE_HEX = '000004000000a702043f0792c187103cc485187b'
const TIMER_OFF_STATE_HEX = '000004000000a70204500892c186e005a0c48640bb'
const SLEEP_420_STATE_HEX = '000004000000a70204630e92c18140818086a001a48f40c48cf807'
const HUMAN_DIRECT_STATE_HEX = '000004000000a70204720e92c17ea008ff82018341cd48c48cc406'
const HUMAN_INDIRECT_STATE_HEX =
    '000004000000a702047c2092c17ea00808820283408bc08c10008c408bc08c008c408bc08c008c40c4901daef4'
const COOLPOWER_STATE_HEX = '000004000000a70204b01492c17f90247ea0070781a0010182408d81c49011475a'

// Command frames the LG app itself sent in that session. Each control write
// below must reproduce these TLVs.
const CMD_AIRCLEAN_OFF = '010104000000650201000283c0430c' // 0x20f=0
const CMD_AIRCLEAN_ON = '010104000000650201000283c1532d' // 0x20f=1
const CMD_ECO_OFF = '01010400000065020100028340d284' // 0x20d=0
const CMD_ECO_ON = '01010400000065020100028341c2a5' // 0x20d=1
const CMD_SMARTCARE_ON = '01010400000065020100028f815e84' // 0x23e=1
const CMD_SMARTCARE_OFF = '01010400000065020100028f804ea5' // 0x23e=0
const CMD_SLEEP_420 = '010104000000650201000486a001a4b5e7' // 0x21a=420
const CMD_SLEEP_0 = '01010400000065020100028680f43d' // 0x21a=0 (cancel)
const CMD_START_60 = '010104000000650201000387103c3c2b' // 0x21c=60
const CMD_START_0 = '010104000000650201000287005684' // 0x21c=0 (cancel)
const CMD_STOP_1440 = '010104000000650201000486e005a0240a' // 0x21b=1440
const CMD_STOP_0 = '010104000000650201000286c0bcf9' // 0x21b=0 (cancel)
const CMD_HUMAN_DIRECT = '01010400000065020100028201b950' // 0x208=1
const CMD_HUMAN_INDIRECT = '010104000000650201000282028933' // 0x208=2
const CMD_HUMAN_OFF = '01010400000065020100028200a971' // 0x208=0
const CMD_COOLPOWER_ON = '01010400000065020100028d8138e6' // 0x236=1
const CMD_WIND_LONG = '01010400000065020100097e407ea009097f9034d41d' // mode 0, fan 2313, target 52
const CMD_WIND_OFF = '01010400000065020100097e407ea006067f9034650a' // mode 0, fan 1542, target 52

// Command frames for the climate entity from the first session, plus the
// per-vane horizontal swing states. 'both' (257) was seen as state only.
const CMD_COOL_HIGH_26 = '01010400000065020100097e407ea006067f9034650a' // mode 0, fan 1542, target 52
const CMD_COOL_MED_26 = '01010400000065020100097e407ea004047f9034cce1' // mode 0, fan 1028, target 52
const CMD_ON_COOL_HIGH_18 = '010104000000650201000b7dc17e407ea006067f90246e65' // power 1 + mode/fan/target
const CMD_DRY_LOW_24 = '01010400000065020100097e417ea002027f903021aa' // mode 1, fan 514, target 48
const CMD_SWING_V_ON = '01010400000065020100028141a4c7' // 0x205 = 1
const SWING_LEFT_ON_STATE_HEX = '000004000000a702041a0892c281a00100c486d0a6' // 0x206 = 256
const SWING_LEFT_OFF_STATE_HEX = '000004000000a702041e0692c28180c48478af' // 0x206 = 0
const SWING_RIGHT_ON_STATE_HEX = '000004000000a702042e0692c28181c4840943' // 0x206 = 1

/** TLVs of a captured frame, as {tag: value}. */
function frameTlvs(hex: string): Record<number, number> {
    const b = buf(hex)
    const out: Record<number, number> = {}
    for (const { t, v } of TLV.parse(b.subarray(11, 11 + b[10]))) out[t] = v
    return out
}

/** TLVs the handler put on the wire for the single frame it just sent. */
function sentTlvs(thinq: MockThinq2Device): Record<number, number> {
    assert.equal(thinq.outbox.length, 1, 'exactly one frame should be sent')
    return frameTlvs(thinq.outbox[0].toString('hex'))
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

/** Feed the base full frame so config is published; returns device with recorder cleared. */
function buildReadyDevice() {
    const { ha, thinq, dev } = makeDevice()
    thinq.emit('data', buf(BASE_HEX))
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('every declared capture fixture has a valid envelope length and CRC', () => {
        for (const frame of [
            POWER_OFF_HEX,
            BASE_HEX,
            FAN_LOW_HEX,
            HUMAN_AUTO_HEX,
            HUMAN_INDIRECT_HEX,
            COOLPOWER_HEX,
            LONGPOWER_HEX,
            ECO_OVERRIDE_HEX,
            ECO_OVERRIDE_REVERSED_HEX,
            SLEEP_HEX,
            DRY_HEX,
            ECO_ON_HEX,
            AIRCLEAN_ON_HEX,
            SMARTGUIDE_HEX,
            SWING_V_HEX,
            SWING_L_HEX,
            SWING_R_HEX,
            SWING_BOTH_HEX,
            SMARTCARE_ON_HEX,
            SMARTCARE_OFF_HEX,
            AUTODRY_OFF_HEX,
            AUTODRY_ON_HEX,
            TIMER_ON_STATE_HEX,
            TIMER_OFF_STATE_HEX,
            SLEEP_420_STATE_HEX,
            HUMAN_DIRECT_STATE_HEX,
            HUMAN_INDIRECT_STATE_HEX,
            COOLPOWER_STATE_HEX,
        ]) {
            const packet = buf(frame)
            assert.equal(packet.length, packet[10] + 13, frame)
            assert.equal(crc16(packet.subarray(2)), 0, frame)
        }
    })

    test('discovery is immediate and a delta-first connection publishes state', () => {
        const { ha, thinq, dev } = makeDevice()
        assert.ok(ha.devices[DEVICE_ID].config)
        thinq.emit('data', buf(FAN_LOW_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24)
        assert.equal(thinq.outbox.length, 0)
        assert.equal(thinq.sent.length, 0)
        dev.drop()
    })

    test('constructor and start() send nothing (never polled)', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 0, 'no packets on the wire')
        assert.equal(thinq.sent.length, 0, 'no ThinQ messages')
        dev.drop()
    })

    test('base frame publishes config: command topics only on controls', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')

        const components = device.config!.components as Record<string, Record<string, unknown>>
        assert.ok(components.climate, 'climate component')
        assert.equal(components.climate.platform, 'climate')
        assert.equal(components.climate.current_humidity_topic, '$this/humidity-')
        // The nine controls expose command topics; everything else is state-only.
        const controls = [
            'climate',
            'eco',
            'airclean',
            'smartcare',
            'wind_mode',
            'human_sense',
            'sleep_timer',
            'start_timer',
            'stop_timer',
        ]
        for (const [name, comp] of Object.entries(components)) {
            const hasCommand = Object.keys(comp).some((key) => key.endsWith('command_topic'))
            assert.equal(hasCommand, controls.includes(name), `${name} command topic`)
        }
        assert.deepEqual(components.wind_mode.options, ['off', 'coolpower', 'longpower'])
        assert.deepEqual(components.human_sense.options, ['off', 'direct', 'indirect'])
        assert.deepEqual(components.climate.swing_modes, ['off', 'on'])
        assert.deepEqual(components.climate.swing_horizontal_modes, ['off', 'right', 'left', 'both'])
        assert.equal(components.swing_v, undefined, 'no loose vertical swing entity')
        assert.equal(components.swing_h, undefined, 'no loose horizontal swing entity')
        // climate offers exactly the observed fan levels and modes
        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry'])
        assert.deepEqual(components.climate.fan_modes, ['auto', 'low', 'medium', 'high', 'turbo', 'max'])
        dev.drop()
    })

    test('base frame publishes expected state', () => {
        const { ha, dev } = buildReadyDevice()
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 25) // 50 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_humidity'), 62)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 26) // 52 / 2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium') // 1028
        assert.equal(ha.getProperty(DEVICE_ID, 'power', 'state'), 'ON')
        assert.equal(ha.getProperty(DEVICE_ID, 'pm1', 'state'), 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'pm25', 'state'), 8)
        assert.equal(ha.getProperty(DEVICE_ID, 'pm10', 'state'), 10)
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 62)
        dev.drop()
    })

    test('power-off frame reports off', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(POWER_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off')
        assert.equal(ha.getProperty(DEVICE_ID, 'power', 'state'), 'OFF')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'high') // 1542
        dev.drop()
    })

    test('fan levels decode (low/auto/turbo/max)', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(FAN_LOW_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low') // 514
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'dry') // 0x1f9=1
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24) // 48 / 2
        thinq.emit('data', buf(HUMAN_AUTO_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'auto') // 2056
        thinq.emit('data', buf(COOLPOWER_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'turbo') // 1799
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 18) // 36 / 2
        thinq.emit('data', buf(LONGPOWER_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'max') // 2313
        dev.drop()
    })

    test('eco override flag still reads the fan level', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(ECO_OVERRIDE_HEX))
        // 0x1fa=0xFF04: eco flag in one byte, medium level (0x04) in the other
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')
        thinq.emit('data', buf(ECO_OVERRIDE_REVERSED_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'medium')
        dev.drop()
    })

    test('swing states decode onto the climate entity', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(SWING_V_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'on')
        thinq.emit('data', buf(SWING_LEFT_ON_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'left') // 256
        thinq.emit('data', buf(SWING_RIGHT_ON_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'right') // 1
        thinq.emit('data', buf(SWING_BOTH_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'both') // 257
        thinq.emit('data', buf(SWING_LEFT_OFF_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'off') // 0
        dev.drop()
    })

    test('human sense states decode', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(HUMAN_AUTO_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'human_sense', 'state'), 'direct') // 1
        thinq.emit('data', buf(HUMAN_INDIRECT_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'human_sense', 'state'), 'indirect') // 2
        dev.drop()
    })

    test('function toggles decode', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(ECO_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'eco', 'state'), 'ON')
        thinq.emit('data', buf(AIRCLEAN_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'airclean', 'state'), 'ON')
        thinq.emit('data', buf(SMARTGUIDE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'smartguide', 'state'), 'ON')
        thinq.emit('data', buf(COOLPOWER_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'wind_mode', 'state'), 'coolpower')
        dev.drop()
    })

    test('smart care tags decode (delta-only tags)', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(SMARTCARE_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'smartcare', 'state'), 'ON') // 0x23e=1
        thinq.emit('data', buf(SMARTCARE_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'smartcare', 'state'), 'OFF')
        dev.drop()
    })

    test('timer sensors decode (minutes)', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(SLEEP_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'sleep_timer', 'state'), 300)
        thinq.emit('data', buf(DRY_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'dry_remain', 'state'), 25)
        dev.drop()
    })

    test('timer numbers decode minutes (sleep/reservations)', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(SLEEP_420_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'sleep_timer', 'state'), 420)
        thinq.emit('data', buf(TIMER_ON_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'start_timer', 'state'), 60)
        thinq.emit('data', buf(TIMER_OFF_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'stop_timer', 'state'), 1440)
        dev.drop()
    })

    test('wind mode derives from both power tags', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        assert.equal(ha.getProperty(DEVICE_ID, 'wind_mode', 'state'), 'off')
        thinq.emit('data', buf(COOLPOWER_STATE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'wind_mode', 'state'), 'coolpower')
        thinq.emit('data', buf(LONGPOWER_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'wind_mode', 'state'), 'longpower')
        dev.drop()
    })

    test('switch writes reproduce the captured app frames', () => {
        for (const [comp, on, off] of [
            ['airclean', CMD_AIRCLEAN_ON, CMD_AIRCLEAN_OFF],
            ['eco', CMD_ECO_ON, CMD_ECO_OFF],
            ['smartcare', CMD_SMARTCARE_ON, CMD_SMARTCARE_OFF],
        ] as const) {
            const { thinq, dev } = buildReadyDevice()
            dev.setProperty(comp + '-', 'ON')
            assert.deepEqual(sentTlvs(thinq), frameTlvs(on))
            thinq.resetRecorder()
            dev.setProperty(comp + '-', 'OFF')
            assert.deepEqual(sentTlvs(thinq), frameTlvs(off))
            dev.drop()
        }
    })

    test('human sense select writes reproduce the captured app frames', () => {
        const { thinq, dev } = buildReadyDevice()
        for (const [val, cmd] of [
            ['direct', CMD_HUMAN_DIRECT],
            ['indirect', CMD_HUMAN_INDIRECT],
            ['off', CMD_HUMAN_OFF],
        ] as const) {
            dev.setProperty('human_sense-', val)
            assert.deepEqual(sentTlvs(thinq), frameTlvs(cmd), val)
            thinq.resetRecorder()
        }
        dev.drop()
    })

    test('timer number writes reproduce the captured app frames', () => {
        const { thinq, dev } = buildReadyDevice()
        for (const [comp, val, cmd] of [
            ['sleep_timer', '420', CMD_SLEEP_420],
            ['sleep_timer', '0', CMD_SLEEP_0],
            ['start_timer', '60', CMD_START_60],
            ['start_timer', '0', CMD_START_0],
            ['stop_timer', '1440', CMD_STOP_1440],
            ['stop_timer', '0', CMD_STOP_0],
        ] as const) {
            dev.setProperty(comp + '-', val)
            assert.deepEqual(sentTlvs(thinq), frameTlvs(cmd), `${comp}=${val}`)
            thinq.resetRecorder()
        }
        dev.drop()
    })

    test('wind mode writes reproduce the captured app frames', () => {
        // BASE is cool / medium / 26C, matching the capture session state,
        // so the bundles must come out byte-identical.
        const { thinq, dev } = buildReadyDevice()
        dev.setProperty('wind_mode-', 'coolpower')
        assert.deepEqual(sentTlvs(thinq), frameTlvs(CMD_COOLPOWER_ON))
        thinq.resetRecorder()
        dev.setProperty('wind_mode-', 'longpower')
        assert.deepEqual(sentTlvs(thinq), frameTlvs(CMD_WIND_LONG))
        thinq.resetRecorder()
        dev.setProperty('wind_mode-', 'off')
        assert.deepEqual(sentTlvs(thinq), frameTlvs(CMD_WIND_OFF))
        dev.drop()
    })

    test('climate writes reproduce the frames the app itself sent', () => {
        // A mode write repeats the fan and setpoint the appliance currently
        // holds; the base frame is cool / medium / 26C, matching this capture.
        let { thinq, dev } = buildReadyDevice()
        dev.setProperty('climate-mode', 'cool')
        let got = sentTlvs(thinq)
        let want = frameTlvs(CMD_COOL_MED_26)
        assert.equal(got[0x1f9], want[0x1f9])
        assert.equal(got[0x1fa], want[0x1fa], 'fan is duplicated across both bytes')
        assert.equal(got[0x1fe], want[0x1fe])
        assert.equal(got[0x1f7], 1, 'power is attached; a write while off is ignored')
        dev.drop()

        // Selecting high reproduces the other captured cool/26C frame.
        ;({ thinq, dev } = buildReadyDevice())
        dev.setProperty('climate-fan_mode', 'high')
        got = sentTlvs(thinq)
        want = frameTlvs(CMD_COOL_HIGH_26)
        assert.equal(got[0x1fa], want[0x1fa])
        assert.equal(got[0x1f9], want[0x1f9])
        assert.equal(got[0x1fe], want[0x1fe])
        dev.drop()

        // Dry / low / 24C.
        ;({ thinq, dev } = buildReadyDevice())
        dev.setProperty('climate-mode', 'dry')
        dev.setProperty('climate-fan_mode', 'low')
        thinq.resetRecorder()
        dev.setProperty('climate-temperature', '24')
        got = sentTlvs(thinq)
        want = frameTlvs(CMD_DRY_LOW_24)
        assert.equal(got[0x1f9], want[0x1f9])
        assert.equal(got[0x1fa], want[0x1fa])
        assert.equal(got[0x1fe], want[0x1fe], '24C is written as raw 48')
        dev.drop()
    })

    test('power on restores mode, fan and setpoint in one frame; off sends power alone', () => {
        const { thinq, dev } = buildReadyDevice()
        dev.setProperty('climate-fan_mode', 'high')
        dev.setProperty('climate-temperature', '18')
        thinq.resetRecorder()

        dev.setProperty('climate-power', 'ON')
        const got = sentTlvs(thinq)
        const want = frameTlvs(CMD_ON_COOL_HIGH_18)
        assert.equal(got[0x1f7], want[0x1f7])
        assert.equal(got[0x1f9], want[0x1f9])
        assert.equal(got[0x1fa], want[0x1fa])
        assert.equal(got[0x1fe], want[0x1fe])

        thinq.resetRecorder()
        dev.setProperty('climate-power', 'OFF')
        const off = sentTlvs(thinq)
        assert.equal(off[0x1f7], 0)
        assert.equal(off[0x1f9], undefined, 'nothing is attached when switching off')
        assert.equal(off[0x1fa], undefined)
        dev.drop()
    })

    test("HA's 'off' climate mode powers the unit down instead of writing a wire mode", () => {
        const { thinq, dev } = buildReadyDevice()
        dev.setProperty('climate-mode', 'off')
        const got = sentTlvs(thinq)
        assert.equal(got[0x1f7], 0, 'power off')
        assert.equal(got[0x1f9], undefined, "'off' is not a wire mode")
        dev.drop()
    })

    test('swing writes reproduce the captured vertical frame; horizontal writes echo the driven states', () => {
        const { thinq, dev } = buildReadyDevice()
        dev.setProperty('climate-swing_mode', 'on')
        assert.equal(sentTlvs(thinq)[0x205], frameTlvs(CMD_SWING_V_ON)[0x205])
        dev.drop()

        // Each vane was driven separately on the unit; the writes echo those
        // resulting state values ('both' was seen as state only).
        for (const [value, expected] of [
            ['left', frameTlvs(SWING_LEFT_ON_STATE_HEX)[0x206]],
            ['off', frameTlvs(SWING_LEFT_OFF_STATE_HEX)[0x206]],
            ['right', frameTlvs(SWING_RIGHT_ON_STATE_HEX)[0x206]],
            ['both', 257],
        ] as const) {
            const { thinq: t2, dev: d2 } = buildReadyDevice()
            d2.setProperty('climate-swing_horizontal_mode', value)
            assert.equal(sentTlvs(t2)[0x206], expected, `swing_horizontal_mode=${value}`)
            d2.drop()
        }
    })

    test('power draw is published in watts and reads zero while off', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.power_draw.device_class, 'power')
        assert.equal(components.power_draw.unit_of_measurement, 'W')

        // Published raw: the RAC -60 correction would make these negative.
        assert.equal(ha.getProperty(DEVICE_ID, 'power_draw', 'state'), 32)
        dev.processKeyValue(0x2b3, 578)
        assert.equal(ha.getProperty(DEVICE_ID, 'power_draw', 'state'), 578)
        dev.processKeyValue(0x2b3, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'power_draw', 'state'), 0)
        dev.drop()
    })

    test('auto-dry enable state round trips on the owner-captured frames', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(AUTODRY_OFF_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'OFF')
        thinq.emit('data', buf(AUTODRY_ON_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry', 'state'), 'ON')
        assert.equal(thinq.outbox.length, 0)
        assert.equal(thinq.sent.length, 0)
        dev.drop()
    })

    test('filter counters expose used, rated and remaining hours plus used percentage', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        // Base frame carried 0x355=12 used out of 0x356=720 rated hours.
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used_time', 'state'), 12)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_life_time', 'state'), 720)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_remaining', 'state'), 708)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used', 'state'), 2)
        assert.equal(ha.getProperty(DEVICE_ID, 'error', 'state'), 0)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.filterreset, undefined, 'no reset button without a captured PAC reset command')

        dev.processKeyValue(0x355, 360)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used_time', 'state'), 360)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_remaining', 'state'), 360)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used', 'state'), 50)

        // A zero rated lifetime must not divide or replace the last good values.
        dev.processKeyValue(0x356, 0)
        dev.processKeyValue(0x355, 400)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used', 'state'), 50)
        dev.processKeyValue(0x356, 100)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_remaining', 'state'), 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used', 'state'), 100)

        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })

    test('sensor writes still send nothing', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        dev.setProperty('pm1-', '10')
        dev.setProperty('humidity-', '50')
        assert.equal(thinq.outbox.length, 0, 'writes must not reach the wire')
        assert.equal(thinq.sent.length, 0, 'writes must not send ThinQ messages')
        dev.drop()
        assert.ok(ha, 'mock kept alive')
    })

    test('appliance status is diagnostic; controls and room readings stay primary', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        for (const name of [
            'power',
            'smartguide',
            'autodry',
            'dry_remain',
            'filter_used',
            'filter_used_time',
            'filter_life_time',
            'filter_remaining',
            'error',
        ]) {
            assert.equal(components[name].entity_category, 'diagnostic', `${name} should be diagnostic`)
        }
        for (const name of [
            'climate',
            'sleep_timer',
            'start_timer',
            'stop_timer',
            'pm1',
            'pm25',
            'pm10',
            'humidity',
            'power_draw',
        ]) {
            assert.equal(components[name].entity_category, undefined, `${name} should stay primary`)
        }
        for (const name of ['eco', 'airclean', 'smartcare', 'wind_mode', 'human_sense']) {
            assert.equal(
                components[name].entity_category,
                'config',
                `${name} should be config, matching RAC's convention`,
            )
        }
        dev.drop()
    })

    test('malformed frames are ignored', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(TRUNCATED_HEX))
        thinq.emit('data', buf(BAD_LENGTH_HEX))
        thinq.emit('data', Buffer.from([0x00, 0x01, 0x02, 0x03]))
        // base state survives garbage
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })

    test('climate swing and human sense options match the published contract', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(components.climate.swing_modes, ['off', 'on'])
        assert.deepEqual(components.climate.swing_horizontal_modes, ['off', 'right', 'left', 'both'])
        assert.equal(components.human_sense.platform, 'select')
        assert.deepEqual(components.human_sense.options, ['off', 'direct', 'indirect'])

        dev.drop()
    })
})
