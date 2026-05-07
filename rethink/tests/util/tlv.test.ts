import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as TLV from '@/util/tlv'

// This covers all cases of length encodings (l=0/1/2/3).
const cases: Array<{ name: string; tlv: TLV.TLV[]; bytes: number[] }> = [
    {
        name: 'l=0 single nibble',
        tlv: [{ t: 0x1f7, v: 1 }],
        bytes: [0x7d, 0xc1],
    },
    {
        name: 'l=1 byte value',
        tlv: [{ t: 0x1fe, v: 0x42 }],
        bytes: [0x7f, 0x90, 0x42],
    },
    {
        name: 'l=2 word value',
        tlv: [{ t: 0x1fd, v: 0x1234 }],
        bytes: [0x7f, 0x60, 0x12, 0x34],
    },
    {
        name: 'l=3 24-bit value',
        tlv: [{ t: 0x100, v: 0x123456 }],
        bytes: [0x40, 0x30, 0x12, 0x34, 0x56],
    },
]

describe('TLV', () => {
    for (const c of cases) {
        test(`build encodes ${c.name}`, () => {
            assert.deepEqual(TLV.build(c.tlv), c.bytes)
        })
        test(`parse decodes ${c.name}`, () => {
            const parsed = TLV.parse(Buffer.from(c.bytes))
            assert.equal(parsed.length, 1)
            assert.equal(parsed[0].t, c.tlv[0].t)
            assert.equal(parsed[0].v, c.tlv[0].v)
        })
    }

    test('round-trip over mixed sequence', () => {
        const seq: TLV.TLV[] = [
            { t: 0x1f7, v: 0 },
            { t: 0x1f9, v: 4 },
            { t: 0x1fa, v: 8 },
            { t: 0x1fe, v: 42 },
            { t: 0x2da, v: 0xabcd },
            { t: 0x300, v: 0x010203 },
        ]
        const bytes = TLV.build(seq)
        const back = TLV.parse(Buffer.from(bytes))
        assert.equal(back.length, seq.length)
        for (let i = 0; i < seq.length; i++) {
            assert.equal(back[i].t, seq[i].t)
            assert.equal(back[i].v, seq[i].v)
        }
    })

    test('parse vector from real capture', () => {
        const buf = Buffer.from('7E427DC17E837F502D7F902A', 'hex')
        const out = TLV.parse(buf)
        assert.deepEqual(
            out.map((x) => ({ t: x.t, v: x.v })),
            [
                { t: 0x1f9, v: 2 },
                { t: 0x1f7, v: 1 },
                { t: 0x1fa, v: 3 },
                { t: 0x1fd, v: 0x2d },
                { t: 0x1fe, v: 0x2a },
            ],
        )
    })

    test('parse tolerates truncation (returns what it has)', () => {
        // l=2 frame missing one of the value bytes
        const buf = Buffer.from([0x7f, 0x60, 0x12])
        const out = TLV.parse(buf)
        assert.equal(out.length, 0)
    })

    test('parse tolerates 1-byte truncation at start', () => {
        const out = TLV.parse(Buffer.from([0x7e]))
        assert.equal(out.length, 0)
    })
})
