import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { encodePacket, decodePacket } from '@/util/packet-codec'

// Real captured packets from the wiki (Thinq2CloudProtocol / TLVProtocol / AABBProtocol).

// device_packet (device -> cloud), kind 0x87
const FROM_DEVICE = '000004000000870204690b8ca036458cd059ace001de6ac9'
// cloud -> device packet, kind 0x65
const TO_DEVICE = '00010400000065020201027d416a0d'
// AABB frame
const AABB = 'aa16f0263a03ff040100000000000300000000004fbb'

test('decode: fromDevice TLV packet, CRC valid', () => {
    const d = decodePacket(FROM_DEVICE)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.direction, 'fromDevice')
    assert.equal(d.crcOk, true)
    assert.equal(d.frame.kind, 0x87)
    assert.equal(d.frame.len, 0x0b)
    assert.ok(d.tlv.length > 0)
})

test('decode: toDevice TLV packet, CRC valid', () => {
    const d = decodePacket(TO_DEVICE)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.direction, 'toDevice')
    assert.equal(d.crcOk, true)
    assert.equal(d.frame.kind, 0x65)
    assert.equal(d.a, 0x00)
    assert.equal(d.s, 0x01)
})

test('decode: AABB frame, checksum valid', () => {
    const d = decodePacket(AABB)
    assert.equal(d.protocol, 'aabb')
    if (d.protocol !== 'aabb') return
    assert.equal(d.checksumOk, true)
    assert.equal(d.length, 0x16)
})

test('decode: corrupted CRC is reported, not thrown', () => {
    const bad = FROM_DEVICE.slice(0, -2) + '00'
    const d = decodePacket(bad)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.crcOk, false)
})

test('decode: garbage is unknown, not thrown', () => {
    assert.equal(decodePacket('deadbeef').protocol, 'unknown')
})

// ── encode is the inverse of decode ────────────────────────────────────────

test('encode fromDevice round-trips through decode with a valid CRC', () => {
    const tlv = [
        { t: 0x2c1, v: 1 },
        { t: 0x2c2, v: 380 },
    ]
    const { hex } = encodePacket({ protocol: 'tlv', direction: 'fromDevice', tlv, byte7: 0x69 })
    const d = decodePacket(hex)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.direction, 'fromDevice')
    assert.equal(d.crcOk, true)
    assert.deepEqual(
        d.tlv.map((e) => ({ t: e.t, v: e.v })),
        tlv,
    )
})

test('encode fromDevice honors byte5/byte6/byte7 (decode is the exact inverse)', () => {
    // Regression: byte6/byte7 used to be ignored for fromDevice (only subtype/seq applied),
    // so a decoded capture could not be re-encoded faithfully.
    const { hex } = encodePacket({
        protocol: 'tlv',
        direction: 'fromDevice',
        tlv: [{ t: 0x1fa, v: 3 }],
        byte5: 0x02,
        byte6: 0x04,
        byte7: 0x9a,
    })
    const d = decodePacket(hex)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.deepEqual(d.frame, { kind: 0x87, byte5: 0x02, byte6: 0x04, byte7: 0x9a, len: d.frame.len })
})

test('encode fromDevice defaults byte6 to 0x04 (unsolicited state report)', () => {
    const { hex } = encodePacket({ protocol: 'tlv', direction: 'fromDevice', tlv: [{ t: 0x1fa, v: 3 }] })
    const d = decodePacket(hex)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.frame.byte6, 0x04)
})

test('encode fromDevice reproduces a real captured state packet byte-for-byte', () => {
    // Captured 506=3 state report (incl. its CRC): the encoder must match it exactly.
    const { hex } = encodePacket({
        protocol: 'tlv',
        direction: 'fromDevice',
        tlv: [{ t: 506, v: 3 }],
        byte5: 0x02,
        byte6: 0x04,
        byte7: 0x9a,
    })
    assert.equal(hex, '0000040000008702049a027e83ab55')
})

test('encode toDevice round-trips and preserves framing knobs', () => {
    const { hex } = encodePacket({
        protocol: 'tlv',
        direction: 'toDevice',
        tlv: [{ t: 0x1f5, v: 2 }],
        a: 1,
        s: 1,
        byte5: 2,
        byte6: 2,
        byte7: 1,
    })
    const d = decodePacket(hex)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.crcOk, true)
    assert.equal(d.a, 1)
    assert.equal(d.s, 1)
    assert.deepEqual(d.frame, { kind: 0x65, byte5: 2, byte6: 2, byte7: 1, len: d.frame.len })
})

test('encode toDevice reproduces the real queryCaps packet bytes', () => {
    // tlv_device.ts queryCaps(): send([1,1,2,2,1], [{t:0x1f5, v:1}])
    const { hex } = encodePacket({
        protocol: 'tlv',
        direction: 'toDevice',
        tlv: [{ t: 0x1f5, v: 1 }],
        a: 1,
        s: 1,
        byte5: 2,
        byte6: 2,
        byte7: 1,
    })
    // 0101 04 00 00 00 65 02 02 01 02 7d41 <crc>
    assert.ok(hex.startsWith('0101040000006502020102'), `unexpected framing: ${hex}`)
    assert.equal(decodePacket(hex).protocol, 'tlv')
})

test('encode AABB round-trips body and checksum', () => {
    const d0 = decodePacket(AABB)
    assert.equal(d0.protocol, 'aabb')
    if (d0.protocol !== 'aabb') return
    const { hex } = encodePacket({ protocol: 'aabb', body: d0.body })
    assert.equal(hex, AABB)
})

// ST_B_E4H01Y_APL status envelope captured from the appliance; also used by
// tests/cloud/devices/aabb_device.test.ts. CRC16/XMODEM = 0x9317, total length = 35.
const LONG_AABB = 'aaff310a00230053ed000101030011100b0306100000008a00000000000000059317bb'

function mutate(hex: string, offset: number, value: number): string {
    const bytes = Buffer.from(hex, 'hex')
    bytes[offset] = value
    return bytes.toString('hex')
}

test('decode: captured short and long AABB and both TLV directions pass all checks', () => {
    for (const hex of [AABB, LONG_AABB, FROM_DEVICE, TO_DEVICE]) {
        const d = decodePacket(hex)
        assert.notEqual(d.protocol, 'unknown')
        if (d.protocol === 'unknown') return
        assert.equal('failures' in d, false)
    }
    const d = decodePacket(LONG_AABB)
    assert.equal(d.protocol, 'aabb')
    if (d.protocol !== 'aabb') return
    // Diagnostics use long-frame wire rules; the legacy fields remain unchanged.
    assert.equal(d.length, 255)
    assert.equal(d.checksumOk, false)
    assert.equal(d.body, LONG_AABB.slice(4, -4))
})

test('decode: specific failed integrity checks retain decoded fields', () => {
    for (const [hex, offset, value, check, expected, actual] of [
        [AABB, 20, 0, 'aabb.checksum', 0x4f, 0],
        [LONG_AABB, 33, 0, 'aabb.crc16', 0x9317, 0x9300],
        [FROM_DEVICE, 23, 0, 'tlv.crc16', 0x6ac9, 0x6a00],
    ] as const) {
        const d = decodePacket(mutate(hex, offset, value))
        assert.notEqual(d.protocol, 'unknown')
        if (d.protocol === 'unknown') return
        assert.deepEqual(d.failures, [{ check, expected, actual }])
        if (d.protocol === 'aabb') assert.ok(d.body.length > 0)
        else assert.ok(d.tlv.length > 0)
    }
})

test('decode: declared lengths report observed lengths, including TLV overrun and trailing bytes', () => {
    for (const [hex, offset, value, check, actual] of [
        [AABB, 1, 23, 'aabb.length', 22],
        [LONG_AABB, 5, 36, 'aabb.length', 35],
        [FROM_DEVICE, 10, 12, 'tlv.length', 11],
        [FROM_DEVICE, 10, 10, 'tlv.length', 11],
    ] as const) {
        const d = decodePacket(mutate(hex, offset, value))
        assert.equal(d.protocol, hex === FROM_DEVICE && value === 12 ? 'unknown' : hex === FROM_DEVICE ? 'tlv' : 'aabb')
        assert.ok(d.failures?.some((f) => f.check === check && f.expected === value && f.actual === actual))
        if (d.protocol === 'unknown') assert.equal(d.reason, 'TLV length field overruns buffer')
    }
})

test('decode: unsupported checks stay quiet without changing boundary classifications', () => {
    for (const hex of ['deadbeef', 'aaff0102bb', '00000400000087', 'aa0', 'aaZZ', 'aa03bb', 'aa0400bb']) {
        const d = decodePacket(hex)
        assert.equal(d.protocol, hex === 'aaff0102bb' ? 'aabb' : 'unknown')
        if (d.protocol === 'unknown') {
            assert.equal(d.hex, hex)
            assert.equal(d.reason, 'unrecognized framing')
        }
        assert.equal('failures' in d, false)
    }
})

// Frozen decode results from upstream master 0de21e2e, including malformed input,
// truncation, length mismatches and integrity failures. Only failures may be added.
const legacyFixtures = JSON.parse(readFileSync(new URL('./fixtures/packet-codec-legacy.json', import.meta.url), 'utf8'))

test('decode: every legacy field and classification matches upstream fixtures', () => {
    for (const { hex, decoded } of legacyFixtures) {
        const { failures, ...legacy } = decodePacket(hex)
        assert.deepEqual(legacy, decoded, hex)
    }
})
