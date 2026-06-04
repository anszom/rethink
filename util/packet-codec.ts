// Pure encode/decode of the wire packets exchanged between an appliance and the
// (re)cloud, so an agent can build/inspect packets from primitives instead of
// hand-assembling framing, CRC16 and the AABB checksum.
//
// The framing here mirrors the real device code exactly:
//   - TLV toDevice   (cloud -> device): cloud/devices/tlv_device.ts  send()
//   - TLV fromDevice (device -> cloud): cloud/devices/tlv_device.ts  processData()
//   - AABB (both directions):           cloud/devices/aabb_device.ts send()/processData()
//
// "Direction" is from the appliance's point of view:
//   fromDevice = a packet the appliance emits   (safe to fake: inject as sendFromDevice)
//   toDevice   = a packet the cloud sends down   (actuates hardware: inject as sendToDevice)

import * as TLV from './tlv'
import crc16 from './crc16'

export type Protocol = 'tlv' | 'aabb'
export type Direction = 'fromDevice' | 'toDevice'

// ── Encode inputs ──────────────────────────────────────────────────────────

export type TlvEncodeInput = {
    protocol: 'tlv'
    direction: Direction
    tlv: { t: number; v: number }[]
    // framing knobs — all defaulted; copy them from a captured packet of the
    // same direction (decodePacket exposes them) when probing a real device.
    a?: number // toDevice reliability byte ("a"), default 0
    s?: number // toDevice ack-forward byte ("s"), default 0
    // The three uart header bytes after the kind byte (uart[5..7]) — the same positions
    // decode reports as frame.byte5/6/7, so a decoded packet can be re-encoded as-is.
    // Defaults differ by direction:
    //   fromDevice: byte5=0x02, byte6=0x04 (unsolicited state report; 0x01 = query reply), byte7=0x00 (sequence)
    //   toDevice:   byte5=2,    byte6=2,    byte7=1
    byte5?: number
    byte6?: number
    byte7?: number
}

export type AabbEncodeInput = {
    protocol: 'aabb'
    direction?: Direction // envelope is identical both ways; used only to route injection
    body: string // checksum-stripped inner body, hex (no AA / length / checksum / BB)
}

export type EncodeInput = TlvEncodeInput | AabbEncodeInput

// ── Decode result ──────────────────────────────────────────────────────────

export type DecodedTlv = {
    protocol: 'tlv'
    direction: Direction
    crcOk: boolean
    tlv: TLV.TLV[]
    frame: {
        kind: number // uart byte4: 0x87 fromDevice, 0x65 toDevice
        byte5: number
        byte6: number
        byte7: number
        len: number
    }
    a?: number // toDevice only
    s?: number
}

export type DecodedAabb = {
    protocol: 'aabb'
    checksumOk: boolean
    length: number
    body: string // inner body, hex
}

export type DecodedUnknown = {
    protocol: 'unknown'
    hex: string
    reason: string
}

export type Decoded = DecodedTlv | DecodedAabb | DecodedUnknown

// ── AABB checksum (mirrors aabb_device.ts) ─────────────────────────────────

function aabbChecksum(packetWithoutChecksum: Buffer): number {
    // sum of every byte preceding the BB terminator (the checksum + BB slots
    // contribute 0 during the sum in the device code), modulo 256, xor 0x55.
    let sum = 0
    for (const b of packetWithoutChecksum) sum += b
    return (sum & 0xff) ^ 0x55
}

// ── Encode ─────────────────────────────────────────────────────────────────

export function encodePacket(input: EncodeInput): { hex: string; buffer: Buffer } {
    const buffer = input.protocol === 'aabb' ? encodeAabb(input) : encodeTlv(input)
    return { hex: buffer.toString('hex'), buffer }
}

function encodeTlv(input: TlvEncodeInput): Buffer {
    const tlvBytes = TLV.build(input.tlv.map((e) => ({ t: e.t, v: e.v })))
    if (tlvBytes.length > 255) throw new Error('TLV payload exceeds 255 bytes')

    let uart: number[]
    let prefix: number[]
    if (input.direction === 'fromDevice') {
        // 0000 | 04 00 00 00 87 <byte5=02> <byte6=04> <byte7=seq> <len> <tlv> <crc16>
        uart = [
            0x04,
            0x00,
            0x00,
            0x00,
            0x87,
            input.byte5 ?? 0x02,
            input.byte6 ?? 0x04,
            input.byte7 ?? 0x00,
            tlvBytes.length,
        ].concat(tlvBytes)
        prefix = [0x00, 0x00]
    } else {
        // a s | 04 00 00 00 65 <byte5> <byte6> <byte7> <len> <tlv> <crc16>
        uart = [
            0x04,
            0x00,
            0x00,
            0x00,
            0x65,
            input.byte5 ?? 2,
            input.byte6 ?? 2,
            input.byte7 ?? 1,
            tlvBytes.length,
        ].concat(tlvBytes)
        prefix = [input.a ?? 0, input.s ?? 0]
    }

    const crc = crc16(uart) // CRC covers the uart frame only (matches tlv_device.ts)
    return Buffer.from(prefix.concat(uart, [(crc >> 8) & 0xff, crc & 0xff]))
}

function encodeAabb(input: AabbEncodeInput): Buffer {
    const inner = Buffer.from(input.body, 'hex')
    const head = Buffer.from([0xaa, inner.length + 4])
    const checksum = aabbChecksum(Buffer.concat([head, inner]))
    return Buffer.concat([head, inner, Buffer.from([checksum, 0xbb])])
}

// ── Decode ─────────────────────────────────────────────────────────────────

export function decodePacket(hex: string): Decoded {
    const buf = Buffer.from(hex.replace(/\s+/g, ''), 'hex')

    // AABB: AA <len> ...body <checksum> BB
    if (buf.length >= 5 && buf[0] === 0xaa && buf[buf.length - 1] === 0xbb) {
        const expected = aabbChecksum(buf.subarray(0, buf.length - 2))
        return {
            protocol: 'aabb',
            checksumOk: buf[buf.length - 2] === expected,
            length: buf[1],
            body: buf.subarray(2, buf.length - 2).toString('hex'),
        }
    }

    // TLV: identify by the uart "kind" byte at index 6
    if (buf.length >= 13 && buf[2] === 0x04 && (buf[6] === 0x87 || buf[6] === 0x65)) {
        const fromDevice = buf[6] === 0x87
        const len = buf[10]
        if (11 + len + 2 > buf.length) {
            return { protocol: 'unknown', hex, reason: 'TLV length field overruns buffer' }
        }
        const crcOk = crc16(buf.subarray(2)) === 0
        const tlv = TLV.parse(buf.subarray(11, 11 + len))
        const frame = { kind: buf[6], byte5: buf[7], byte6: buf[8], byte7: buf[9], len }
        return fromDevice
            ? { protocol: 'tlv', direction: 'fromDevice', crcOk, tlv, frame }
            : { protocol: 'tlv', direction: 'toDevice', crcOk, tlv, frame, a: buf[0], s: buf[1] }
    }

    return { protocol: 'unknown', hex, reason: 'unrecognized framing' }
}
