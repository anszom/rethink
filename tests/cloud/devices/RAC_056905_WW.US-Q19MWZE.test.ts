import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'TEST', swVersion: '1.0' }

// Live captures from a US-Q19MWZE indoor unit (firmware 0x885631, EEPROM checksum 0x5449), switched off.
// Cooling-only: 0x2c1 = 0x7 (cool, dry, fan). 0x2ca = 0x201ee9 has the AI Air bits 16-17 clear.
const CAPS_RESPONSE_HEX =
    '0000040000008702010C79B001E180B047B0A0017CD40AD3E004006480B85020B8903CB8D020B9103CBAD020BB103CB0C1B103B304' +
    'B2A04000B2C0BC1022B37080000DABC0B480B4E01011B5A08000B542B6A05449B6F0885631B701B740BC40BD00EA10C0BD600C0FDD' +
    '04FA016C81B5C0B61034B648B5C1B61030B648B5C2B61030B64805BC'
const QUERY_RESPONSE_HEX =
    '0000040000008702041BAB7E407DC07E887F50347F90347EC07F00C85064C8817BD0147C00C8C0834083807C8083C0A880868086C0' +
    '870087C08F808940E880594088408A10188A50768A80ACE0021A59C05A005A7001050A5F406D4168816901D440F2700A50008200D5' +
    '40D580D5D03CD61020C900CAD05ACB10AFCB40CB9012CBC0CC105ECC4DCC909F8B40E800BF6003FFBFC0BFA003E6C000BE40BE801B' +
    '00BEC0C340C0C0C380CCC8CD08CD4890004B414BC14CC16002'

// 0x23e=1, accepted by the unit: setpoint went to 24, both swings and the energy limit off
const WRITE_AIAIR_ON_HEX = '01010400000065020101028F812830'

/** A device notification carrying the given TLVs (the CRC is not checked by the device class). */
function notify(...tlv: [number, number][]) {
    const body = Buffer.from(TLV.build(tlv.map(([t, v]) => ({ t, v }))))
    return Buffer.concat([Buffer.from([0, 0, 4, 0, 0, 0, 0x87, 2, 4, 0, body.length]), body, Buffer.from([0, 0])])
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    // filter probe timeout, then initMakeSetConfig queries the values again
    tickMockTimers(t, 6000)
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))

    thinq.resetRecorder()
    return { ha, thinq, dev, components: ha.devices[DEVICE_ID]!.config!.components as Record<string, any> }
}

const sent = (thinq: MockThinq2Device) => thinq.outbox.map((b) => hex(b))

describe('RAC_056905_WW US-Q19MWZE (fw 0x885631)', () => {
    test('AI Air is exposed although 0x2ca does not advertise it', (t) => {
        const { components, dev } = buildReadyDevice(t)

        assert.equal(components.aiair.platform, 'switch')

        dev.drop()
    })

    test('AI Air is written only while running, and reads back', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'aiair', 'command', 'ON')
        assert.deepEqual(sent(thinq), [])

        thinq.emit('data', notify([0x1f7, 1], [0x1f9, 0]))
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'aiair', 'command', 'ON')
        assert.deepEqual(sent(thinq), [WRITE_AIAIR_ON_HEX])

        thinq.emit('data', notify([0x23e, 1]))
        assert.equal(ha.getProperty(DEVICE_ID, 'aiair', 'state'), 'ON')

        dev.drop()
    })
})
