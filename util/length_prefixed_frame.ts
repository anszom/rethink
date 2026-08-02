export type FrameSplitter = ((buf: Buffer) => void) & {
    end(): void
}

export function splitter(callback: (arg: Buffer) => void, options?: { maxPayloadLength?: number }): FrameSplitter {
    let accum: Buffer | undefined
    let failed = false
    const maxPayloadLength = options?.maxPayloadLength ?? 65536

    const split = function (buf: Buffer) {
        if (failed) return
        accum = accum && accum.length > 0 ? Buffer.concat([accum, buf]) : buf

        while (accum && accum.length >= 4) {
            const payloadLen = accum.readInt32BE(0)
            if (payloadLen < 0) {
                failed = true
                accum = undefined
                throw new Error('Payload length cannot be negative')
            }
            if (payloadLen > maxPayloadLength) {
                failed = true
                accum = undefined
                throw new Error('Payload length exceeded')
            }

            if (accum.length >= 4 + payloadLen) {
                callback(accum.subarray(4, 4 + payloadLen))
                accum = accum.subarray(4 + payloadLen)
            } else {
                break
            }
        }
    } as FrameSplitter

    split.end = () => {
        if (!failed && accum && accum.length > 0) {
            failed = true
            accum = undefined
            throw new Error('Truncated length-prefixed frame')
        }
    }

    return split
}

export function make(input: Buffer | string) {
    if (typeof input === 'string') input = Buffer.from(input, 'utf-8')

    const output = Buffer.alloc(4 + input.length)
    output.writeInt32BE(input.length)
    input.copy(output, 4)
    return output
}
