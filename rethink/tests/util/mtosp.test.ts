import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { format, splitter } from '@/util/mtosp'

describe('mtosp format', () => {
    test('format then splitter round-trip', () => {
        const xml = '<root><a>hello</a></root>'
        const framed = format(xml)
        const split = splitter()
        const received: string[] = []
        for (const b of framed) split(b, (s) => received.push(s))
        assert.deepEqual(received, [xml])
    })

    test('splitter accepts multiple frames back-to-back', () => {
        const a = format('<a/>')
        const b = format('<b>x</b>')
        const stream = Buffer.concat([a, b])
        const split = splitter()
        const received: string[] = []
        for (const byte of stream) split(byte, (s) => received.push(s))
        assert.deepEqual(received, ['<a/>', '<b>x</b>'])
    })

    test('splitter throws on bad header byte', () => {
        const split = splitter()
        assert.throws(() => split(0x00, () => {}), /invalid header byte/)
    })

    test('splitter throws on bad trailer byte', () => {
        const framed = format('<x/>')
        const tampered = Buffer.from(framed)
        tampered[tampered.length - 1] = 0xcc // not 0xbb
        const split = splitter()
        assert.throws(() => {
            for (const byte of tampered) split(byte, () => {})
        }, /invalid trailer byte/)
    })

    test('splitter parses real captured WTDN3 deviceinfo response', () => {
        // Captured frame from a WTDN3 washer: 0xaa | 0x01a5 (length=421) | XML | 0x73da (CRC) | 0xbb
        const xml =
            '<mTosp><response type="deviceinfo">' +
            '<protocolVer>2.0</protocolVer>' +
            '<mac>7c:1c:4e:c8:cc:53</mac>' +
            '<uuid>48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53</uuid>' +
            '<deviceType>201</deviceType>' +
            '<modelName>WTDN3</modelName>' +
            '<softwareVer>1.3</softwareVer>' +
            '<countryCode>WW</countryCode>' +
            '<remainingTime>388</remainingTime>' +
            '<errorcodeDisplay>0</errorcodeDisplay>' +
            '<modemVer>QC_Modem_1.2.80</modemVer>' +
            '<demandType>MODEM_3k_SoC</demandType>' +
            '</response></mTosp>'
        assert.equal(xml.length, 0x01a5)

        const framed = Buffer.concat([
            Buffer.from([0xaa, 0x01, 0xa5]),
            Buffer.from(xml, 'utf-8'),
            Buffer.from([0x73, 0xda, 0xbb]),
        ])

        const split = splitter()
        const received: string[] = []
        for (const byte of framed) split(byte, (s) => received.push(s))
        assert.deepEqual(received, [xml])
    })

    test('splitter throws on bad checksum', () => {
        const framed = format('<x/>')
        const tampered = Buffer.from(framed)
        // flip a payload byte (index 3 is start of payload)
        tampered[3] ^= 0x01
        const split = splitter()
        assert.throws(() => {
            for (const byte of tampered) split(byte, () => {})
        }, /invalid checksum/)
    })
})
