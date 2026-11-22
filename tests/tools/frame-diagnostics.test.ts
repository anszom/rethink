import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { WebSocketServer } from 'ws'

// Wiki AABBProtocol frame with its checksum zeroed; ST_B_E4H01Y_APL long capture
// from tests/cloud/devices/aabb_device.test.ts (unmodified).
const BAD_AABB = 'aa16f0263a03ff0401000000000003000000000000bb'
const LONG_AABB = 'aaff310a00230053ed000101030011100b0306100000008a00000000000000059317bb'
const UNKNOWN = 'deadbeef'
const TLV = '000004000000870204690b8ca036458cd059ace001de6ac9'
const OVERRUN_TLV = '000004000000870204690c8ca036458cd059ace001de6ac9'
const packets = [BAD_AABB, LONG_AABB, UNKNOWN, TLV, OVERRUN_TLV]

// Only the external management socket is faked; both tools run through their normal CLI.
test('capture and MCP preserve frames and expose the same diagnostics', { timeout: 15000 }, async (t) => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    t.after(() => {
        for (const socket of server.clients) socket.terminate()
        server.close()
    })
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const host = `127.0.0.1:${address.port}`
    let firstConnection = true
    server.on('connection', (socket) => {
        socket.send(JSON.stringify({ status: 'online' }))
        for (const rx of packets) socket.send(JSON.stringify({ rx, type: 'packet' }))
        if (firstConnection) socket.close()
        firstConnection = false
    })

    const dir = await mkdtemp(join(tmpdir(), 'rethink-diagnostics-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'capture.jsonl')
    const capture = spawn(process.execPath, ['--import', 'tsx', 'tools/rethink-capture.ts', host, 'test-device', path])
    t.after(() => capture.kill())
    let stderr = ''
    capture.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
    })
    const [code] = await once(capture, 'exit')
    assert.equal(code, 0, stderr)
    const wire = (await readFile(path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.k === 'wire')
    assert.equal(wire.length, packets.length)

    const mcp = spawn(process.execPath, ['--import', 'tsx', 'tools/mcp-server.ts'])
    t.after(() => mcp.kill())
    const replies = readline.createInterface({ input: mcp.stdout })
    const waiting = new Map<number, (value: any) => void>()
    replies.on('line', (line) => {
        const reply = JSON.parse(line)
        waiting.get(reply.id)?.(reply)
        waiting.delete(reply.id)
    })
    let id = 0
    const call = (name: string, args: object = {}): Promise<any> => {
        const next = ++id
        return new Promise((resolve) => {
            waiting.set(next, (reply) => {
                assert.notEqual(reply.result.isError, true)
                resolve(JSON.parse(reply.result.content[0].text))
            })
            mcp.stdin.write(
                JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { name, arguments: args } }) +
                    '\n',
            )
        })
    }
    await call('set_mgmt_host', { host })
    await call('device_start', { deviceId: 'test-device' })
    const live = await call('read_device')
    const recorded = await call('read_capture', { path, k: 'wire' })
    assert.deepEqual(recorded.events, wire)
    assert.equal(live.events.length, packets.length)
    for (let i = 0; i < packets.length; i++) {
        const decoded = await call('decode_packet', { hex: packets[i] })
        for (const event of [wire[i], live.events[i]]) {
            assert.equal(event.hex, packets[i])
            assert.equal(event.protocol, decoded.protocol)
            assert.deepEqual(event.failures, decoded.failures)
            assert.equal(event.body, decoded.body)
            assert.equal('long' in event, false)
            assert.equal('reason' in event, false)
        }
    }
    assert.deepEqual(wire[0].failures, [{ check: 'aabb.checksum', expected: 0x4f, actual: 0 }])
    assert.equal('failures' in wire[1], false)
    assert.equal('failures' in live.events[1], false)
    assert.equal('failures' in wire[2], false)
    assert.equal('failures' in wire[3], false)
    assert.equal(wire[4].protocol, 'unknown')
    assert.ok(wire[4].failures.some((f: any) => f.check === 'tlv.length' && f.expected === 12 && f.actual === 11))
    assert.equal(wire[1].checksumOk, false)
    assert.equal(wire[1].body, LONG_AABB.slice(4, -4))
    await call('device_stop')
    mcp.stdin.end()
    await once(mcp, 'exit')
})
