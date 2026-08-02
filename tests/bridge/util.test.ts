import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subprocess } from '@/bridge/util'

test('subprocess returns stdout only for a successful exit', async () => {
    assert.equal(await subprocess(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok')
})

test('subprocess rejects nonzero exits with bounded sanitized stderr', async () => {
    await assert.rejects(
        subprocess(process.execPath, ['-e', 'process.stderr.write("bad\\u0000detail"); process.exit(7)']),
        (error: Error) => {
            assert.match(error.message, /exited with code 7/)
            assert.match(error.message, /bad\?detail/)
            return true
        },
    )
})

test('subprocess rejects signals and spawn failures', async () => {
    await assert.rejects(
        subprocess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']),
        /terminated by SIGTERM/,
    )
    await assert.rejects(subprocess('/definitely/not/a/real/executable', []), /Failed to start subprocess/)
})

test('subprocess enforces its timeout', async () => {
    // The deadline starts at spawn, so a fixed one races the child's own startup: the arm64 image
    // is smoke-tested under QEMU, where spawning Node costs two orders of magnitude more than it
    // does natively and the child never reaches its stderr write in time. Price one real spawn and
    // scale the deadline off that, so the child always writes before the timeout it is meant to
    // trip, and the test stays fast wherever spawning is cheap.
    const startedAt = Date.now()
    await subprocess(process.execPath, ['-e', 'process.stderr.write("warm")'])
    const timeoutMs = Math.max(Date.now() - startedAt, 1) * 4 + 50

    await assert.rejects(
        subprocess(process.execPath, ['-e', 'process.stderr.write("timed detail"); setInterval(() => {}, 1000)'], '', {
            timeoutMs,
        }),
        new RegExp(`timed out after ${timeoutMs}ms: timed detail`),
    )
})

test('subprocess rejects oversized stdout and bounds stderr diagnostics', async () => {
    await assert.rejects(
        subprocess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], '', {
            maxOutputBytes: 1024,
        }),
        /exceeded 1024 bytes of stdout/,
    )

    await assert.rejects(
        subprocess(process.execPath, ['-e', 'process.stderr.write("x".repeat(10000)); process.exit(1)'], '', {
            maxStderrBytes: 128,
        }),
        (error: Error) => {
            assert.match(error.message, /exited with code 1/)
            assert(error.message.length < 256)
            return true
        },
    )
})
