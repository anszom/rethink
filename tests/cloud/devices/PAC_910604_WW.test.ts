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
//   0x20f air clean (0/1)        0x21a sleep timer (minutes)    0x225 auto-dry countdown (minutes)
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
        // The eight controls expose command topics; everything else is state-only.
        const controls = [
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

    test('swing states decode', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        thinq.emit('data', buf(SWING_V_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'swing_v', 'state'), 'ON')
        thinq.emit('data', buf(SWING_L_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'swing_h', 'state'), 'left') // 256
        thinq.emit('data', buf(SWING_R_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'swing_h', 'state'), 'right') // 1
        thinq.emit('data', buf(SWING_BOTH_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'swing_h', 'state'), 'both') // 257
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

    test('climate and sensor writes still send nothing', () => {
        const { ha, thinq, dev } = buildReadyDevice()
        dev.setProperty('climate-mode', 'dry')
        dev.setProperty('climate-fan_mode', 'high')
        dev.setProperty('climate-temperature', '24')
        dev.setProperty('swing_h-', 'left')
        dev.setProperty('pm1-', '10')
        assert.equal(thinq.outbox.length, 0, 'writes must not reach the wire')
        assert.equal(thinq.sent.length, 0, 'writes must not send ThinQ messages')
        dev.drop()
        assert.ok(ha, 'mock kept alive')
    })

    test('appliance status is diagnostic; controls and room readings stay primary', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        for (const name of ['power', 'swing_v', 'smartguide', 'dry_remain']) {
            assert.equal(components[name].entity_category, 'diagnostic', `${name} should be diagnostic`)
        }
        for (const name of [
            'climate',
            'eco',
            'airclean',
            'smartcare',
            'wind_mode',
            'human_sense',
            'swing_h',
            'sleep_timer',
            'start_timer',
            'stop_timer',
            'pm1',
            'pm25',
            'pm10',
            'humidity',
        ]) {
            assert.equal(components[name].entity_category, undefined, `${name} should stay primary`)
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

    test('swing and human sense options match the published contract', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(BASE_HEX))
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.swing_h.device_class, 'enum')
        assert.deepEqual(components.swing_h.options, ['off', 'right', 'left', 'both'])
        assert.equal(components.human_sense.platform, 'select')
        assert.deepEqual(components.human_sense.options, ['off', 'direct', 'indirect'])

        dev.drop()
    })
})
