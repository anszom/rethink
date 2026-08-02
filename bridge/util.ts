import { spawn } from 'node:child_process'

export type SubprocessOptions = {
    timeoutMs?: number
    maxOutputBytes?: number
    maxStderrBytes?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

function diagnostic(stderr: Buffer[], stderrBytes: number): string {
    if (stderrBytes === 0) return ''
    const text = Buffer.concat(stderr, stderrBytes)
        .toString('utf-8')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
        .trim()
    return text ? `: ${text}` : ''
}

export function subprocess(
    command: string,
    args: string[],
    stdin: string = '',
    options: SubprocessOptions = {},
): Promise<string> {
    return new Promise((resolve, reject) => {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
        const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
        const child = spawn(command, args)
        const out: Buffer[] = []
        const err: Buffer[] = []
        let outBytes = 0
        let errBytes = 0
        let failure: Error | undefined
        let settled = false

        const fail = (error: Error) => {
            if (settled) return
            if (!failure) failure = error
            child.kill('SIGKILL')
        }
        const timer = setTimeout(
            () => fail(new Error(`Subprocess ${command} timed out after ${timeoutMs}ms`)),
            timeoutMs,
        )
        timer.unref()

        child.stdout.on('data', (data: Buffer) => {
            outBytes += data.length
            if (outBytes > maxOutputBytes) {
                fail(new Error(`Subprocess ${command} exceeded ${maxOutputBytes} bytes of stdout`))
                return
            }
            out.push(data)
        })
        child.stderr.on('data', (data: Buffer) => {
            const remaining = maxStderrBytes - errBytes
            if (remaining <= 0) return
            const bounded = data.subarray(0, remaining)
            err.push(bounded)
            errBytes += bounded.length
        })
        child.on('close', (code, signal) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (failure) reject(new Error(failure.message + diagnostic(err, errBytes)))
            else if (code !== 0)
                reject(
                    new Error(
                        signal
                            ? `Subprocess ${command} terminated by ${signal}${diagnostic(err, errBytes)}`
                            : `Subprocess ${command} exited with code ${code}${diagnostic(err, errBytes)}`,
                    ),
                )
            else resolve(Buffer.concat(out, outBytes).toString('utf-8'))
        })
        child.on('error', (error) => {
            failure = new Error(`Failed to start subprocess ${command}: ${error.message}`)
        })
        child.stdin.on('error', (error) => fail(new Error(`Subprocess ${command} stdin failed: ${error.message}`)))
        child.stdin.end(stdin)
    })
}
