export function splitter(callback: (Buffer)=>void, options?: { maxPayloadLength?: number }) {
    let accum: Buffer|undefined

	return function(buf: Buffer) {
        accum = (accum && accum.length > 0) ? Buffer.concat([accum, buf]) : buf;

        while(accum && accum.length >= 4) {
            const payloadLen = accum.readInt32BE(0);
            if(payloadLen > (options?.maxPayloadLength ?? 65536))
                throw new Error("Payload length exceeded")
            
            if(accum.length >= 4 + payloadLen) {
                callback(accum.subarray(4, 4 + payloadLen))
                accum = accum.subarray(4 + payloadLen)
            }
        }
    }
}

export function make(input: Buffer | string) {
    if(typeof(input) === 'string')
        input = Buffer.from(input, 'utf-8')

    const output = Buffer.alloc(4 + input.length)
    output.writeInt32BE(input.length)
    input.copy(output, 4)
    return output
}