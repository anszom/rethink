import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'TEST', swVersion: '1.0' }

// Live captures from a US-Q19MWZE indoor unit (firmware 0x885631, EEPROM checksum 0x5449), switched off.
// Cooling-only: 0x2c1 = 0x7 (cool, dry, fan).
const CAPS_RESPONSE_HEX =
    '0000040000008702010C79B001E180B047B0A0017CD40AD3E004006480B85020B8903CB8D020B9103CBAD020BB103CB0C1B103B304' +
    'B2A04000B2C0BC1022B37080000DABC0B480B4E01011B5A08000B542B6A05449B6F0885631B701B740BC40BD00EA10C0BD600C0FDD' +
    '04FA016C81B5C0B61034B648B5C1B61030B648B5C2B61030B64805BC'
const QUERY_RESPONSE_HEX =
    '0000040000008702041BAB7E407DC07E887F50347F90347EC07F00C85064C8817BD0147C00C8C0834083807C8083C0A880868086C0' +
    '870087C08F808940E880594088408A10188A50768A80ACE0021A59C05A005A7001050A5F406D4168816901D440F2700A50008200D5' +
    '40D580D5D03CD61020C900CAD05ACB10AFCB40CB9012CBC0CC105ECC4DCC909F8B40E800BF6003FFBFC0BFA003E6C000BE40BE801B' +
    '00BEC0C340C0C0C380CCC8CD08CD4890004B414BC14CC16002'

/** The captured caps response with one tag left out (the CRC is not checked by the device class). */
function withoutTag(capsHex: string, tag: number) {
    const frame = buf(capsHex)
    const body = Buffer.from(TLV.build(TLV.parse(frame.subarray(11, frame.length - 2)).filter((e) => e.t !== tag)))
    const header = Buffer.from(frame.subarray(0, 11))
    header[10] = body.length
    return Buffer.concat([header, body, Buffer.from([0, 0])])
}

function buildReadyDevice(t: import('node:test').TestContext, caps: Buffer) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)

    thinq.emit('data', caps)
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    // filter probe timeout, then initMakeSetConfig queries the values again
    tickMockTimers(t, 6000)
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))

    return { dev, components: ha.devices[DEVICE_ID]!.config!.components as Record<string, any> }
}

describe('RAC_056905_WW US-Q19MWZE (fw 0x885631)', () => {
    test('offers only the modes 0x2c1 advertises', (t) => {
        const { components, dev } = buildReadyDevice(t, buf(CAPS_RESPONSE_HEX))

        assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only'])

        dev.drop()
    })

    test("keeps HA's default modes when 0x2c1 is missing", (t) => {
        const { components, dev } = buildReadyDevice(t, withoutTag(CAPS_RESPONSE_HEX, 0x2c1))

        assert.ok(components.climate)
        assert.equal(components.climate.modes, undefined)

        dev.drop()
    })
})
