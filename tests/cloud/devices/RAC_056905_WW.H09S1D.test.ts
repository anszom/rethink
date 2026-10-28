import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'TEST', swVersion: '1.0' }

// Live captures from an H09S1D.NS indoor unit (firmware 0x55703, EEPROM checksum 0x4eb9), switched off.
// Its capabilities include AI Air (0x2ca), ACTIVE_ENERGY_CONTROL + WINDOW_DETECTION (0x34f),
// AIRCLEAN_ONLY (0x2d2), SOUND_ON_OFF (0x374), GOODSLEEP (0x2f0), the humidity sensor (0x2dd),
// RAC_88_DISPLAY_CONTROL (0x2d6 bit 15) and per-mode temperature limits (0x2e1-0x2ec).
const H09S1D_CAPS_RESPONSE_HEX =
    '000004000000870201139FB001E180B05077B0A0017CD41012D3F0100400B85024B8903CB8D020B9103CBAD024BB103CB0C1B1101F' +
    'B3200205B2B0030000B2C0BC08B34FABC0B4B0041020B4F0045011B5A08000B54EB6A04EB9B6F0055703B701B75020BC40BD300800' +
    '00EA01BD7040480BFB0FDD046440649054FA016C81B5C0B61028B642B5C1B61020B642B5C2B61020B642B5C4B61028B642B5D02EB6' +
    '1020B642B5C6B6102CB6429A18'
const H09S1D_QUERY_RESPONSE_HEX =
    '00000400000087020419B27E407DC07E827F50347F90287EC17F00C840C8847BD0147C00C8C083408390FF83C0A880868086C08700' +
    '87C18F8089407C82E8805940CD903688408A10FF8A408A80ADA00205ACC0AD4059C0A0406D4168816901D440F2700A50018200D540' +
    'D580D5D03CD61020C900CAC0CB1092CB40CB89CBC0CC10CCCC40CC90908B40E801FA80BF40BFE00355BF80C0200355BE508FBE908E' +
    '6240BEC0C340C0C0EE40C380CCC0CD00CD4090004B414BC14CC152C053404A4C'

// Live captures from a DC12RT.NSJ (firmware 0x690409, EEPROM checksum 0x4d87), switched off.
const DC12RT_CAPS_RESPONSE_HEX =
    '0000040000008702017C4EB001B05077B0A0017CB0C1B103B307B34FB4C7B582B6A04D87B6F0690409B701BC40BD46B5C0B61029B6' +
    '42B5C1B6102EB642B5C2B6102EB642B5C4B6102CB642B5C5B6102EB642B5C6B6102CB64294E8'
const DC12RT_QUERY_RESPONSE_HEX =
    '00000400000087020480697E407DC07E827F50317F9029C840C881C8C08340838183C0868086C0870087C1894088408A008A408A80' +
    '8C808CC0ACC0D540D580C900CAC0CB108BCB40CB8CCBC0CC10CCCC40CC90968B40BF6001C7BFC0BFA001C7C000BE5089BE90881B00' +
    'BEC0C300C340C0C0C3800C05'

// Writes, each one accepted by the H09S1D and read back with a values query.
const WRITE_BEEP_OFF_HEX = '0101040000006502010102E8012B05' // 0x3a0=1: muted
const WRITE_DISPLAY_ON_HEX = '010104000000650201010287C0F97C' // 0x21f=0: lit
const WRITE_WINDOW_OFF_HEX = '0101040000006502010105F2700A5000FEC8'
const WRITE_AUTODRY_OFF_HEX = '010104000000650201010283807D7C'
const WRITE_AUTODRY_ON_HEX = '01010400000065020101038390FFB80D'
const WRITE_AUTODRY_FAN_MEDIUM_HEX = '01010400000065020101027C843E07'
const WRITE_ENERGY_60_HEX = '010104000000650201010383503C4776'
const WRITE_LOWHEAT_ON_HEX = '01010400000065020101028B413DB8'
const WRITE_AIAIR_ON_HEX = '01010400000065020101028F812830'
const WRITE_GOODSLEEP_OFF_HEX = '01010400000065020101024B403BCD'
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'
const WRITE_SOFTAIR_ON_HEX = '0101040000006502010105D470010000C5B7'

/** A device notification carrying the given TLVs (the CRC is not checked by the device class). */
function notify(...tlv: [number, number][]) {
    const body = Buffer.from(TLV.build(tlv.map(([t, v]) => ({ t, v }))))
    return Buffer.concat([Buffer.from([0, 0, 4, 0, 0, 0, 0x87, 2, 4, 0, body.length]), body, Buffer.from([0, 0])])
}

function buildReadyDevice(t: import('node:test').TestContext, capsHex: string, queryHex: string) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))

    thinq.emit('data', buf(capsHex))
    thinq.emit('data', buf(queryHex))
    // filter probe timeout, then initMakeSetConfig queries the values again
    tickMockTimers(t, 6000)
    thinq.emit('data', buf(queryHex))

    thinq.resetRecorder()
    return { ha, thinq, dev, components: ha.devices[DEVICE_ID]!.config!.components as Record<string, any> }
}

const sent = (thinq: MockThinq2Device) => thinq.outbox.map((b) => hex(b))

describe('RAC_056905_WW H09S1D (fw 0x55703)', () => {
    test('exposes the features advertised by the unit', (t) => {
        const { components, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)

        assert.equal(components.climate.min_temp, 16) // heat low limit 0x2e3
        assert.equal(components.climate.max_temp, 30)
        assert.equal(components.climate.current_humidity_topic, '$this/climate-current_humidity')
        assert.equal(components.humidity.device_class, 'humidity')

        assert.equal(components.energylimit.platform, 'select')
        assert.deepEqual(components.energylimit.options, ['off', '80%', '60%', '40%'])
        assert.deepEqual(components.autodryfan.options, ['low', 'medium', 'high'])
        // mode-bound features carry their own availability topic and all carry a description
        assert.equal(components.energylimit.availability.at(-1).topic, '$this/energylimit-available')
        assert.equal(components.lowheating.availability.at(-1).topic, '$this/lowheating-available')
        assert.equal(components.beep.availability, undefined)
        assert.equal(components.beep.json_attributes_topic, '$this/beep-attributes')
        assert.ok(components.starttimer, 'relative on-timer via TIMEBS_ONOFF')
        assert.ok(components.stoptimer, 'relative off-timer via TIMEBS_ONOFF')

        // the read-only auto dry sensor is withdrawn in favour of the setting
        assert.deepEqual(JSON.parse(JSON.stringify(components.autodry)), { platform: 'binary_sensor' })
        // 0x20d is the energy limit here, not the energy-saving switch
        assert.equal(components.energysave, undefined)

        dev.drop()
    })

    test('publishes the reported values', (t) => {
        const { ha, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        const get = (comp: string, topic = 'state') => ha.getProperty(DEVICE_ID, comp, topic)

        assert.equal(get('climate', 'current_humidity'), 54)
        assert.equal(get('humidity'), 54)
        assert.equal(get('climate', 'mode_state'), 'off')
        assert.equal(get('windowdetection'), 'ON') // 0x3c9=0xa5001
        // captured with 0x3a0=1 and 0x21f=1, which the ThinQ app shows as beep off and display off
        assert.equal(get('beep'), 'OFF')
        // stored preferences show their real value although the AC is off
        assert.equal(get('goodsleep'), 'ON')
        assert.equal(get('goodsleepop'), 'ON')
        assert.equal(get('goodsleeptemp'), 'ON')
        assert.equal(get('autodrysetting'), 'ON') // 0x20e=255
        assert.equal(get('autodryfan'), 'low')
        assert.equal(get('displaylight'), 'OFF')

        dev.drop()
    })

    test('settings write the values the unit accepts', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        const write = (comp: string, value: string) => {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, comp, 'command', value)
            return sent(thinq)
        }

        assert.deepEqual(write('beep', 'OFF'), [WRITE_BEEP_OFF_HEX])
        assert.deepEqual(write('windowdetection', 'OFF'), [WRITE_WINDOW_OFF_HEX]) // upper bits kept
        assert.deepEqual(write('autodrysetting', 'OFF'), [WRITE_AUTODRY_OFF_HEX])
        assert.deepEqual(write('autodrysetting', 'ON'), [WRITE_AUTODRY_ON_HEX])
        assert.deepEqual(write('autodryfan', 'medium'), [WRITE_AUTODRY_FAN_MEDIUM_HEX])
        // a stored preference: written and reported while the AC is off as well
        assert.deepEqual(write('goodsleep', 'OFF'), [WRITE_GOODSLEEP_OFF_HEX])
        assert.deepEqual(write('displaylight', 'ON'), [WRITE_DISPLAY_ON_HEX])

        dev.drop()
    })

    test('mode 46 (Air Purify started from off) reads back as fan_only', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 46], [0x20f, 1]))
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'fan_only')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'action'), 'fan')
        assert.equal(ha.getProperty(DEVICE_ID, 'airclean', 'state'), 'ON')

        dev.drop()
    })

    test('energy limit is held while off and sent once the unit runs', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)

        ha.setProperty(DEVICE_ID, 'energylimit', 'command', '60%')
        assert.deepEqual(sent(thinq), [], 'the unit ignores 0x20d while off')

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0]))
        assert.ok(sent(thinq).includes(WRITE_ENERGY_60_HEX))

        dev.drop()
    })

    test('low heating is only sent in heat mode, and not re-applied later', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0]))
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'lowheating', 'command', 'ON')
        assert.deepEqual(sent(thinq), [], 'not accepted in cool mode')

        // the manual: changing temperature, fan or mode cancels it, so a request is not carried over
        thinq.emit('data', notify([0x1f9, 4]))
        assert.ok(!sent(thinq).includes(WRITE_LOWHEAT_ON_HEX))

        ha.setProperty(DEVICE_ID, 'lowheating', 'command', 'ON')
        assert.ok(sent(thinq).includes(WRITE_LOWHEAT_ON_HEX))

        dev.drop()
    })

    test('AI Air is written only while running', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)

        ha.setProperty(DEVICE_ID, 'aiair', 'command', 'ON')
        assert.deepEqual(sent(thinq), [])

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 4]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'aiair', 'command', 'ON')
        assert.deepEqual(sent(thinq), [WRITE_AIAIR_ON_HEX])

        thinq.emit('data', notify([0x23e, 1]))
        assert.equal(ha.getProperty(DEVICE_ID, 'aiair', 'state'), 'ON')

        dev.drop()
    })
})

describe('RAC_056905_WW H09S1D feature requirements', () => {
    test('availability follows the power state and mode the manual requires', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        const avail = (name: string) => ha.devices[DEVICE_ID]!.properties[name + '-available']

        // switched off
        for (const name of ['energylimit', 'aiair', 'lowheating', 'sleeptimer', 'softair', 'goodsleep'])
            assert.equal(avail(name), 'offline', name)

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0])) // cooling
        assert.equal(avail('energylimit'), 'online')
        assert.equal(avail('aiair'), 'online')
        assert.equal(avail('goodsleep'), 'online')
        assert.equal(avail('sleeptimer'), 'online')
        assert.equal(avail('lowheating'), 'offline')

        thinq.emit('data', notify([0x1f9, 4])) // heating
        assert.equal(avail('goodsleep'), 'online', 'any mode while on')
        assert.equal(avail('energylimit'), 'offline')
        assert.equal(avail('aiair'), 'online')
        assert.equal(avail('lowheating'), 'online')

        thinq.emit('data', notify([0x1f9, 46])) // purify only, counts as fan
        assert.equal(avail('aiair'), 'offline')
        assert.equal(avail('softair'), 'online')

        thinq.emit('data', notify([0x1f7, 0]))
        assert.equal(avail('lowheating'), 'offline')

        dev.drop()
    })

    test('every new entity publishes a description', (t) => {
        const { ha, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        const attrs = (name: string) => JSON.parse(ha.devices[DEVICE_ID]!.properties[name + '-attributes'] as string)

        assert.equal(attrs('energylimit').requires, 'AC on, in Cooling')
        assert.equal(attrs('lowheating').requires, 'AC on, in Heating')
        assert.equal(attrs('beep').requires, 'nothing, always available')
        for (const name of ['aiair', 'windowdetection', 'displaylight', 'autodrysetting', 'goodsleep'])
            assert.match(attrs(name).description, /\w+/, name)

        dev.drop()
    })

    test('the sleep timer is only written while the AC is on', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '1')
        assert.deepEqual(sent(thinq), [])

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'sleeptimer', 'command', '1')
        assert.equal(sent(thinq).length, 1)

        dev.drop()
    })
})

describe('RAC_056905_WW Soft Air', () => {
    test('is only available and written in Cooling or Fan', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        const avail = () => ha.devices[DEVICE_ID]!.properties['softair-available']

        assert.equal(avail(), 'offline')
        ha.setProperty(DEVICE_ID, 'softair', 'command', 'ON')
        assert.deepEqual(sent(thinq), [])

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 4]))
        assert.equal(avail(), 'offline', 'not in heating')

        thinq.emit('data', notify([0x1f9, 0]))
        assert.equal(avail(), 'online')
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'softair', 'command', 'ON')
        assert.deepEqual(sent(thinq), [WRITE_SOFTAIR_ON_HEX])

        thinq.emit('data', notify([0x351, 0x10000]))
        assert.equal(ha.getProperty(DEVICE_ID, 'softair', 'state'), 'ON')

        dev.drop()
    })
})

describe('RAC_056905_WW power sensor', () => {
    test('reports the raw value for a unit with MOMENTARY_OUTDOOR, created while it reads 0', (t) => {
        // H09S1DA (0x2d5 = 0xe) captured switched off: 0x2b3 = 0
        const { ha, thinq, components, dev } = buildReadyDevice(t, H09S1D_CAPS_RESPONSE_HEX, H09S1D_QUERY_RESPONSE_HEX)
        assert.equal(components.energy_current?.device_class, 'power')

        thinq.emit('data', notify([0x2b3, 223]))
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 223)

        dev.drop()
    })

    test('is not created for a multi-split unit without accumMode', (t) => {
        // DC12RT.NSJ on a multi-split ODU: no 0x2d5, 0x2b3 always 0
        const { components, dev } = buildReadyDevice(t, DC12RT_CAPS_RESPONSE_HEX, DC12RT_QUERY_RESPONSE_HEX)
        assert.equal(components.energy_current, undefined)
        dev.drop()
    })
})

describe('RAC_056905_WW DC12RT (fw 0x690409)', () => {
    test('Jet, Energy saving and the Sleep timer are unavailable unless their requirement is met', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t, DC12RT_CAPS_RESPONSE_HEX, DC12RT_QUERY_RESPONSE_HEX)
        const avail = (name: string) => ha.devices[DEVICE_ID]!.properties[name + '-available']
        const attrs = (name: string) => JSON.parse(ha.devices[DEVICE_ID]!.properties[name + '-attributes'] as string)

        // switched off
        for (const name of ['jet', 'energysave', 'sleeptimer']) assert.equal(avail(name), 'offline', name)
        assert.equal(avail('airclean'), undefined, 'air purify is always available')

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0])) // cooling
        for (const name of ['jet', 'energysave', 'sleeptimer']) assert.equal(avail(name), 'online', name)

        thinq.emit('data', notify([0x1f9, 4])) // heating
        assert.equal(avail('jet'), 'online')
        assert.equal(avail('energysave'), 'offline')

        thinq.emit('data', notify([0x1f9, 2])) // fan
        assert.equal(avail('jet'), 'offline')
        assert.equal(avail('sleeptimer'), 'online')

        assert.equal(attrs('energysave').requires, 'AC on, in Cooling')
        assert.equal(attrs('jet').requires, 'AC on, in Cooling or Heating')
        assert.equal(attrs('starttimer').requires, 'nothing, always available')

        dev.drop()
    })

    test('keeps the older feature set', (t) => {
        const { components, dev } = buildReadyDevice(t, DC12RT_CAPS_RESPONSE_HEX, DC12RT_QUERY_RESPONSE_HEX)

        assert.equal(components.climate.min_temp, 18)
        assert.equal(components.climate.max_temp, 30)
        assert.equal(components.energysave?.platform, 'switch')
        assert.equal(components.autodry?.platform, 'binary_sensor')
        assert.equal(components.sleeptimer.max, 15)
        assert.ok(components.starttimer)

        // the unit ignores 0x21f writes, and none of the newer features are advertised
        for (const name of [
            'displaylight',
            'humidity',
            'aiair',
            'energylimit',
            'windowdetection',
            'lowheating',
            'beep',
            'goodsleep',
            'softair',
            'autodrysetting',
            'autodryfan',
        ])
            assert.equal(components[name], undefined, name)

        dev.drop()
    })
})
