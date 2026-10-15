// Decode helper for the management panel's /api/re/export.
// Uses the existing packet codec. Tag names stay blank — the panel still
// renders offsets, values, and a text breakdown.

import { decodePacket } from '@/util/packet-codec'

type ExportBody = {
    hex?: unknown
    direction?: unknown
    model_id?: unknown
}

type TlvElement = {
    t: number
    v: number
    hex: string
    known: false
    name: null
    byteStart: number
    byteEnd: number
}

export function reExport(body: ExportBody) {
    const raw = typeof body.hex === 'string' ? body.hex.trim() : ''
    if (!raw) return { ok: false as const, error: 'hex required' }

    const hex = raw.replace(/\s+/g, '')
    const decoded = decodePacket(hex)
    const direction = typeof body.direction === 'string' ? body.direction : undefined
    const modelId = typeof body.model_id === 'string' ? body.model_id : undefined
    const modelLine = modelId ? `modelId: ${modelId}` : ''

    if (decoded.protocol === 'aabb') {
        const inner = Buffer.from(decoded.body, 'hex')
        const text = [
            '# ThinQ AABB frame',
            modelLine,
            direction ? `direction: ${direction}` : '',
            `checksumOk: ${decoded.checksumOk}`,
            `length: ${decoded.length}`,
            `body: ${decoded.body}`,
            `hex: ${hex}`,
        ]
            .filter(Boolean)
            .join('\n')
        return {
            ok: true as const,
            text,
            unknownCount: 0,
            decode: {
                protocol: 'Aabb',
                direction: direction ?? null,
                crcOk: decoded.checksumOk,
                elements: [] as TlvElement[],
                unknownCount: 0,
                notes: [] as string[],
                hex,
                binaryAnalysis: {
                    kind: inner.length ? inner[0] : null,
                    frame_type: inner.length > 1 ? inner[1] : null,
                    kind_label: '',
                    frame_type_label: '',
                    body_len: inner.length,
                    fields: [] as unknown[],
                    checksum_ok: decoded.checksumOk,
                    length_byte: decoded.length,
                    body_hex: decoded.body,
                },
            },
        }
    }

    if (decoded.protocol === 'tlv') {
        const elements = tlvElements(Buffer.from(hex, 'hex'))
        const text = [
            '# ThinQ TLV frame',
            modelLine,
            `direction: ${direction ?? decoded.direction}`,
            `crcOk: ${decoded.crcOk}`,
            `kind: 0x${decoded.frame.kind.toString(16)}`,
            'tags:',
            ...elements.map((el) => `  ${el.hex} = ${el.v}`),
            `hex: ${hex}`,
        ]
            .filter(Boolean)
            .join('\n')
        return {
            ok: true as const,
            text,
            unknownCount: elements.length,
            decode: {
                protocol: 'Tlv',
                direction: direction ?? decoded.direction,
                crcOk: decoded.crcOk,
                elements,
                unknownCount: elements.length,
                notes: [] as string[],
                hex,
            },
        }
    }

    return {
        ok: true as const,
        text: `# unrecognized frame\n${decoded.reason}\nhex: ${hex}`,
        unknownCount: 0,
        decode: {
            protocol: 'Raw',
            direction: direction ?? null,
            elements: [] as TlvElement[],
            unknownCount: 0,
            notes: [decoded.reason],
            hex,
        },
    }
}

/** TLV elements inside a UART frame, with byte offsets into the full packet. */
function tlvElements(buf: Buffer): TlvElement[] {
    if (buf.length < 13) return []
    const end = Math.min(buf.length, 11 + buf[10])
    const out: TlvElement[] = []
    let i = 11
    while (i + 2 <= end) {
        const t = (buf[i] << 2) + (buf[i + 1] >> 6)
        const l = (buf[i + 1] >> 4) & 3
        if (i + 2 + l > end) break
        let v = buf[i + 1] & 15
        if (l > 0) {
            v = 0
            for (let j = 0; j < l; j++) v = (v << 8) | buf[i + 2 + j]
        }
        const byteEnd = i + 2 + l
        out.push({
            t,
            v,
            hex: '0x' + t.toString(16).padStart(3, '0'),
            known: false,
            name: null,
            byteStart: i,
            byteEnd,
        })
        i = byteEnd
    }
    return out
}
