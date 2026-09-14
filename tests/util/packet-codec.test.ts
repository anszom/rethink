import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePacket, decodePacket } from '@/util/packet-codec'

// Real captured packets from the wiki (Thinq2CloudProtocol / TLVProtocol / AABBProtocol).

// device_packet (device -> cloud), kind 0x87
const FROM_DEVICE = '000004000000870204690b8ca036458cd059ace001de6ac9'
// device_packet (device -> cloud), kind 0xa7 — used by DHUM_056905_WW/POT_056905_WW/WIN_056905_WW.
// Real capture from an LG LW1822IVSM window AC (2026-09-09), values report with mode=cool, fan=high.
const FROM_DEVICE_A7 =
    '000004000000A702045B477E407DC17E867F50317F902A8180C8C08340868086C08700884089408A10498A506A8A8F8CA0' +
    '12C48CC7ACE00711D550F8D590FACAD05ACB10BCCB8CCBCFCC00CC909E1B01C0C01A7F'
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

test('decode: fromDevice TLV packet with 0xa7 kind byte, CRC valid', () => {
    // Regression: decodePacket used to only recognize kind 0x87 for fromDevice, so captures
    // from 0xa7 devices (DHUM/POT/WIN protocol family) decoded as 'unknown'.
    const d = decodePacket(FROM_DEVICE_A7)
    assert.equal(d.protocol, 'tlv')
    if (d.protocol !== 'tlv') return
    assert.equal(d.direction, 'fromDevice')
    assert.equal(d.crcOk, true)
    assert.equal(d.frame.kind, 0xa7)
    assert.ok(
        d.tlv.some((e) => e.t === 0x1f9 && e.v === 0),
        'mode=cool present',
    )
    assert.ok(
        d.tlv.some((e) => e.t === 0x1fa && e.v === 6),
        'fan=high present',
    )
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
