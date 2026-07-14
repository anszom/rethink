// Safe raw-data logger — try/catch wraps everything, never throws.
// Logs to stdout (systemd journal). Raw body capture + headers, method, URL.

function ts() {
    return new Date().toISOString()
}

function hex(buf: Buffer, maxLen = 4096): string {
    const b = buf.slice(0, maxLen)
    const lines: string[] = []
    for (let i = 0; i < b.length; i += 16) {
        const chunk = b.slice(i, i + 16)
        const h = Array.from(chunk)
            .map((x) => x.toString(16).padStart(2, '0'))
            .join(' ')
        const a = Array.from(chunk)
            .map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.'))
            .join('')
        lines.push(`  ${i.toString(16).padStart(4, '0')}: ${h.padEnd(48, ' ')} ${a}`)
    }
    return lines.join('\n')
}

export function rawHttp(label: string, req: any, body: Buffer) {
    try {
        const hdr = { ...req.headers }
        delete hdr.authorization // never log auth tokens
        console.log(`\n${'='.repeat(80)}`)
        console.log(ts(), 'RAW', label, req.method, (req.hostname || '') + req.url)
        console.log('HEADERS:', JSON.stringify(hdr, null, 2))
        if (body.length > 0) {
            console.log(`BODY (${body.length} bytes):`)
            console.log('  TEXT:', body.toString('utf-8').slice(0, 4000))
            if (body.length <= 8192) console.log('HEX:\n' + hex(body))
        }
    } catch {
        /* logging must never throw */
    }
}

export function rawSocket(label: string, addr: string, data: Buffer) {
    try {
        console.log(`\n${'='.repeat(80)}`)
        console.log(ts(), 'RAW', label, `from ${addr} (${data.length} bytes):`)
        console.log('  TEXT:', data.toString('utf-8').slice(0, 2000))
        if (data.length <= 4096) console.log('HEX:\n' + hex(data))
    } catch {
        /* logging must never throw */
    }
}

export function rawSocketConnect(label: string, addr: string) {
    try {
        console.log(ts(), 'RAW', label, 'connect from', addr)
    } catch {}
}

export function rawSocketClose(label: string, addr: string) {
    try {
        console.log(ts(), 'RAW', label, 'disconnect from', addr)
    } catch {}
}
