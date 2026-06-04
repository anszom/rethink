// Minimal MCP server (stdio, newline-delimited JSON-RPC 2.0, zero extra deps)
// exposing the rethink reverse-engineering primitives to an LLM agent.
//
//   set_mgmt_host                  — set the management host[:port] the device tools use
//   list_devices                   — enumerate devices connected to rethink + their status
//   encode_packet / decode_packet  — pure, build/inspect framed hex from primitives
//   read_capture                   — page through a JSONL capture file (rethink-capture.ts)
//   cloud_start / cloud_stop       — enable/disable the live LG cloud notification feed
//   read_cloud                     — page through buffered cloud messages (like read_capture)
//   device_start / device_stop     — enable/disable live capture of a device's wire traffic
//   read_device                    — page through buffered device wire packets (decoded)
//   inject                         — send a packet via the management /device WS (gated)
//   probe                          — sweep a field across values, inject each, observe the cloud reaction
//
// Run:  npx tsx tools/mcp-server.ts
// Diagnostics go to stderr; stdout carries the protocol only.

import readline from 'node:readline'
import * as fs from 'node:fs'
import WebSocket from 'ws'
import { encodePacket, decodePacket, type EncodeInput } from '@/util/packet-codec'
import { connect as cloudConnect } from '@/util/lgcloud/monitor'
import { loadState } from '@/util/lgcloud/state'

const DEFAULT_MGMT = process.env.RETHINK_MGMT ?? 'localhost:44401'

// Session-level management host[:port] that the device tools connect to. Starts at
// DEFAULT_MGMT and is changeable at runtime via the set_mgmt_host tool.
let mgmtHost = DEFAULT_MGMT

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── cloud-oracle feed ───────────────────────────────────────────────────────
// Subscribe to the real LG cloud's notification feed and buffer every message with a
// timestamp and a monotonic sequence number (stable across buffer rotation, so read_cloud
// can page reliably). Enabled explicitly via cloud_start, or auto-enabled on first probe;
// pure tools never trigger the connection.

type CloudFeedStatus = 'connected' | 'unavailable'
type Observation = { seq: number; ts: number; topic: string; payload: unknown | null; raw: string }

const CLOUD_BUFFER_MAX = 1000
const cloudBuffer: Observation[] = []
let cloudSeq = 0
let cloudClient: Awaited<ReturnType<typeof cloudConnect>> | undefined
let cloudFeed: Promise<CloudFeedStatus> | undefined

function ensureCloudFeed(): Promise<CloudFeedStatus> {
    if (!cloudFeed) {
        cloudFeed = (async () => {
            const state = loadState()
            if (!state) {
                console.error(
                    '[cloud] not logged in; run `npx tsx tools/lgcloud-monitor.ts` once to enable observation',
                )
                return 'unavailable' as const
            }
            cloudClient = await cloudConnect(state, {
                log: (m) => console.error(`[cloud] ${m}`),
                onMessage: ({ topic, payload, raw }) => {
                    cloudBuffer.push({ seq: cloudSeq++, ts: Date.now(), topic, payload, raw })
                    if (cloudBuffer.length > CLOUD_BUFFER_MAX) cloudBuffer.shift()
                },
            })
            return 'connected' as const
        })().catch((err) => {
            console.error(`[cloud] feed unavailable: ${err.message}`)
            return 'unavailable' as const
        })
    }
    return cloudFeed
}

function stopCloudFeed() {
    cloudClient?.end(true)
    cloudClient = undefined
    cloudFeed = undefined
}

// 'disabled' = never started or explicitly stopped; otherwise the connect outcome.
async function cloudFeedStatus(): Promise<CloudFeedStatus | 'disabled'> {
    return cloudFeed ? await cloudFeed : 'disabled'
}

// ── device wire capture ─────────────────────────────────────────────────────
// Subscribe to a device's management /device WS and buffer its wire packets (rx =
// fromDevice, tx = toDevice), decoded like a capture file. Several devices can be
// captured at once; read_device pages the shared buffer. The in-memory live counterpart
// to read_capture (which reads a JSONL file on disk).

type WireEvent = {
    seq: number
    ts: number
    deviceId: string
    dir: 'fromDevice' | 'toDevice'
    injected: boolean
    hex?: string
    raw?: string
    protocol?: 'tlv' | 'aabb' | 'unknown'
    crcOk?: boolean
    checksumOk?: boolean
    frame?: unknown
    tlv?: unknown
    body?: string
}

const DEVICE_BUFFER_MAX = 2000
const deviceBuffer: WireEvent[] = []
let deviceSeq = 0
const deviceSubs = new Map<string, WebSocket>()

function pushWire(deviceId: string, dir: 'fromDevice' | 'toDevice', hex: string, injected: boolean) {
    const base = { seq: deviceSeq++, ts: Date.now(), deviceId, dir, injected }
    let event: WireEvent
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
        event = { ...base, protocol: 'unknown', raw: hex } // T1 object frames the WS stringifies
    } else {
        const d = decodePacket(hex)
        if (d.protocol === 'tlv') event = { ...base, hex, protocol: 'tlv', crcOk: d.crcOk, frame: d.frame, tlv: d.tlv }
        else if (d.protocol === 'aabb')
            event = { ...base, hex, protocol: 'aabb', checksumOk: d.checksumOk, body: d.body }
        else event = { ...base, hex, protocol: 'unknown' }
    }
    deviceBuffer.push(event)
    if (deviceBuffer.length > DEVICE_BUFFER_MAX) deviceBuffer.shift()
}

// Resolves with the device status ('online'/'offline') once the WS reports it. Idempotent.
function deviceCaptureStart(host: string, deviceId: string): Promise<string> {
    if (deviceSubs.has(deviceId)) return Promise.resolve('already-capturing')
    const h = host.includes(':') ? host : `${host}:44401`
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${h}/device?id=${encodeURIComponent(deviceId)}`)
        deviceSubs.set(deviceId, ws)
        let settled = false
        const done = (status: string) => {
            if (!settled) {
                settled = true
                resolve(status)
            }
        }
        ws.on('message', (data: WebSocket.RawData) => {
            let msg: any
            try {
                msg = JSON.parse(data.toString())
            } catch {
                return
            }
            if (typeof msg.rx === 'string') pushWire(deviceId, 'fromDevice', msg.rx, !!msg.injected)
            else if (typeof msg.tx === 'string') pushWire(deviceId, 'toDevice', msg.tx, !!msg.injected)
            else if (msg.status) done(msg.status)
        })
        ws.on('error', (err) => {
            deviceSubs.delete(deviceId)
            if (!settled) {
                settled = true
                reject(err)
            }
        })
        ws.on('close', () => deviceSubs.delete(deviceId))
        setTimeout(() => done('unknown'), 5000)
    })
}

function deviceCaptureStop(deviceId?: string) {
    if (deviceId) {
        deviceSubs.get(deviceId)?.close()
        deviceSubs.delete(deviceId)
    } else {
        for (const ws of deviceSubs.values()) ws.close()
        deviceSubs.clear()
    }
}

// ── tool implementations ───────────────────────────────────────────────────

const tools: Record<string, { description: string; inputSchema: object; handler: (args: any) => Promise<any> }> = {
    set_mgmt_host: {
        description:
            'Set the rethink-cloud management host[:port] that the device tools (list_devices, device_start, inject, probe) connect to, for the rest of this session. Starts at the RETHINK_MGMT env value (or localhost:44401). Port defaults to 44401 if omitted. Returns the current value.',
        inputSchema: {
            type: 'object',
            properties: { host: { type: 'string', description: 'host[:port]' } },
            required: ['host'],
        },
        handler: async (args) => {
            mgmtHost = String(args.host)
            return { mgmtHost }
        },
    },

    list_devices: {
        description:
            'Enumerate devices currently connected to rethink-cloud and their status (from the management interface). Per device: model, deviceType, platform (thinq1/thinq2), whether rethink maps it to Home Assistant (mapped), and its bridge/cloud status (bridged). Also returns global bridge-login (bridge) and HA-connection (ha) state. Read-only — usually the first call, to discover device ids for inject/probe.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
        handler: async () => {
            const snap = await mgmtSnapshot(mgmtHost)
            return { ha: snap.ha, bridge: snap.bridge, devices: snap.devices ?? {} }
        },
    },

    encode_packet: {
        description:
            'Build a framed wire packet (hex) from primitives. TLV: {protocol:"tlv", direction:"fromDevice"|"toDevice", tlv:[{t,v}], ...framing}. To build a toDevice TLV set-command that actually actuates hardware, the observed real-cloud defaults are a:1, s:1, byte6:1 (the schema defaults a:0/s:0/byte6:2 produce a frame that is acked but ignored by the appliance). AABB: {protocol:"aabb", body:"<checksum-stripped hex>"}. Pure; computes CRC16/checksum/framing exactly as the device code does.',
        inputSchema: {
            type: 'object',
            properties: {
                protocol: { type: 'string', enum: ['tlv', 'aabb'] },
                direction: { type: 'string', enum: ['fromDevice', 'toDevice'] },
                tlv: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { t: { type: 'number' }, v: { type: 'number' } },
                        required: ['t', 'v'],
                    },
                },
                body: { type: 'string', description: 'AABB inner body, hex' },
                a: {
                    type: 'number',
                    description:
                        'toDevice reliability byte (default 0; set 1 for reliable delivery — the modem retransmits until the device acks. Real set-commands use a:1)',
                },
                s: {
                    type: 'number',
                    description:
                        'toDevice ack-forward byte (default 0; set 1 to forward the device ack back to the cloud. Real set-commands use s:1)',
                },
                byte5: { type: 'number', description: 'uart header byte5 (default: fromDevice 0x02, toDevice 2)' },
                byte6: {
                    type: 'number',
                    description:
                        'uart header byte6 — for fromDevice this is the report type: 0x04 unsolicited state report (default) vs 0x01 query reply. For toDevice the default is 2, BUT real cloud->device set-commands (e.g. power on/off, set fan/temp) are observed to use 0x01 — a bare 0x02 frame is delivered/acked at the transport layer but the appliance ignores it. To actuate state, pass byte6:1.',
                },
                byte7: {
                    type: 'number',
                    description:
                        'uart header byte7 — fromDevice sequence counter (default 0); toDevice default 1 (real set-commands observed with byte7:0; value is not significant to actuation)',
                },
            },
            required: ['protocol'],
        },
        handler: async (args) => {
            const { hex } = encodePacket(args as EncodeInput)
            return { hex, bytes: hex.length / 2 }
        },
    },

    decode_packet: {
        description:
            'Decode a framed wire packet (hex) into its protocol, direction, framing, CRC/checksum validity and decoded fields. Pure; never throws on malformed input.',
        inputSchema: {
            type: 'object',
            properties: { hex: { type: 'string' } },
            required: ['hex'],
        },
        handler: async (args) => decodePacket(String(args.hex)),
    },

    read_capture: {
        description:
            'Read events from a JSONL capture produced by rethink-capture.ts. Optional filter by event kind (k), direction (dir) and injected flag; supports paging via cursor/limit.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                k: { type: 'string', description: 'filter by event kind: session|wire|cloud|note|marker' },
                dir: { type: 'string', enum: ['fromDevice', 'toDevice'] },
                injected: { type: 'boolean' },
                cursor: { type: 'number', description: 'event index to start from (default 0)' },
                limit: { type: 'number', description: 'max events to return (default 200)' },
            },
            required: ['path'],
        },
        handler: async (args) => {
            const lines = fs.readFileSync(String(args.path), 'utf8').split('\n').filter(Boolean)
            const all = lines.map((l) => JSON.parse(l))
            const filtered = all.filter(
                (e) =>
                    (args.k === undefined || e.k === args.k) &&
                    (args.dir === undefined || e.dir === args.dir) &&
                    (args.injected === undefined || e.injected === args.injected),
            )
            const cursor = Number(args.cursor ?? 0)
            const limit = Number(args.limit ?? 200)
            const page = filtered.slice(cursor, cursor + limit)
            const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null
            return { total: filtered.length, cursor, nextCursor, events: page }
        },
    },

    cloud_start: {
        description:
            'Enable the LG cloud notification feed: connect (using the oauth.json login) and start buffering messages for read_cloud and probe. Idempotent — returns feed:"unavailable" if not logged in. The device(s) must be bridged for their updates to appear.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
            const feed = await ensureCloudFeed()
            return { feed, buffered: cloudBuffer.length }
        },
    },

    cloud_stop: {
        description:
            'Disable the cloud feed: disconnect from the cloud MQTT. Pass clear:true to also drop the buffered messages. (probe will re-enable the feed on demand.)',
        inputSchema: {
            type: 'object',
            properties: { clear: { type: 'boolean', description: 'also discard buffered messages' } },
        },
        handler: async (args) => {
            stopCloudFeed()
            if (args.clear) cloudBuffer.length = 0
            return { feed: 'disabled', buffered: cloudBuffer.length }
        },
    },

    read_cloud: {
        description:
            "Read buffered cloud notification messages (the cloud's decoded interpretation of device state), like read_capture. Filter by device (id substring) and topic (substring); page via cursor/limit. cursor is an opaque sequence value — pass back the returned nextCursor to continue. Enable the feed first with cloud_start (or run a probe).",
        inputSchema: {
            type: 'object',
            properties: {
                device: { type: 'string', description: 'only messages mentioning this device id' },
                topic: { type: 'string', description: 'only topics containing this substring' },
                cursor: {
                    type: 'number',
                    description: 'sequence value to start from (default 0); use nextCursor to page',
                },
                limit: { type: 'number', description: 'max messages to return (default 200)' },
            },
        },
        handler: async (args) => {
            const filtered = cloudBuffer.filter(
                (m) =>
                    (args.device === undefined || m.raw.includes(String(args.device))) &&
                    (args.topic === undefined || m.topic.includes(String(args.topic))),
            )
            const cursor = Number(args.cursor ?? 0)
            const limit = Number(args.limit ?? 200)
            const fromCursor = filtered.filter((m) => m.seq >= cursor)
            const page = fromCursor.slice(0, limit)
            const nextCursor = fromCursor.length > page.length ? page[page.length - 1].seq + 1 : null
            return {
                feed: await cloudFeedStatus(),
                total: filtered.length,
                nextCursor,
                events: page.map((m) => ({ seq: m.seq, ts: m.ts, topic: m.topic, payload: m.payload })),
            }
        },
    },

    device_start: {
        description:
            "Start capturing a device's live wire traffic (rx=fromDevice, tx=toDevice packets) from the management /device WS into the in-memory buffer, read with read_device. Each packet is decoded like a capture file. Idempotent per device; several devices can be captured at once. Returns the device status (online/offline).",
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: { type: 'string' },
            },
            required: ['deviceId'],
        },
        handler: async (args) => {
            const deviceId = String(args.deviceId)
            const status = await deviceCaptureStart(mgmtHost, deviceId)
            return { deviceId, status, buffered: deviceBuffer.filter((e) => e.deviceId === deviceId).length }
        },
    },

    device_stop: {
        description:
            'Stop capturing device wire traffic. Without deviceId, stops all captures. Pass clear:true to also drop buffered events (for the given device, or all).',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: { type: 'string' },
                clear: { type: 'boolean', description: 'also discard buffered events' },
            },
        },
        handler: async (args) => {
            const deviceId = args.deviceId ? String(args.deviceId) : undefined
            deviceCaptureStop(deviceId)
            if (args.clear) {
                if (deviceId) {
                    for (let i = deviceBuffer.length - 1; i >= 0; i--)
                        if (deviceBuffer[i].deviceId === deviceId) deviceBuffer.splice(i, 1)
                } else deviceBuffer.length = 0
            }
            return { capturing: [...deviceSubs.keys()], buffered: deviceBuffer.length }
        },
    },

    read_device: {
        description:
            'Read buffered device wire traffic captured by device_start (rx=fromDevice, tx=toDevice), decoded. The in-memory live counterpart to read_capture (which reads a JSONL file). Filter by deviceId, dir, injected; page via cursor/limit (opaque sequence — pass back nextCursor). Correlate with read_cloud by timestamp (ts).',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: { type: 'string' },
                dir: { type: 'string', enum: ['fromDevice', 'toDevice'] },
                injected: { type: 'boolean' },
                cursor: {
                    type: 'number',
                    description: 'sequence value to start from (default 0); use nextCursor to page',
                },
                limit: { type: 'number', description: 'max events to return (default 200)' },
            },
        },
        handler: async (args) => {
            const filtered = deviceBuffer.filter(
                (e) =>
                    (args.deviceId === undefined || e.deviceId === String(args.deviceId)) &&
                    (args.dir === undefined || e.dir === args.dir) &&
                    (args.injected === undefined || e.injected === args.injected),
            )
            const cursor = Number(args.cursor ?? 0)
            const limit = Number(args.limit ?? 200)
            const fromCursor = filtered.filter((e) => e.seq >= cursor)
            const page = fromCursor.slice(0, limit)
            const nextCursor = fromCursor.length > page.length ? page[page.length - 1].seq + 1 : null
            return { capturing: [...deviceSubs.keys()], total: filtered.length, nextCursor, events: page }
        },
    },

    inject: {
        description:
            'Inject a raw hex packet via the management /device WebSocket and wait for rethink to echo it back (delivery ack) — errors if the device id is unknown/offline or the packet is dropped. direction "fromDevice" fakes a device->cloud packet (safe). direction "toDevice" sends a cloud->device packet that ACTUATES HARDWARE and requires confirm:true. NOTE: acked:true only confirms transport-layer delivery, NOT that the appliance acted — verify the effect via read_cloud/read_device. A toDevice set-command that is acked but has no effect is usually mis-framed: use the real-cloud header defaults a:1, s:1, byte6:1 (see encode_packet).',
        inputSchema: {
            type: 'object',
            properties: {
                deviceId: { type: 'string' },
                hex: { type: 'string' },
                direction: { type: 'string', enum: ['fromDevice', 'toDevice'] },
                confirm: { type: 'boolean', description: 'required true for toDevice' },
            },
            required: ['deviceId', 'hex', 'direction'],
        },
        handler: async (args) => {
            if (args.direction === 'toDevice' && args.confirm !== true)
                throw new Error('toDevice injection actuates hardware; pass confirm:true to proceed')
            await injectOnce(mgmtHost, String(args.deviceId), args.direction, String(args.hex))
            return { ok: true, acked: true, direction: args.direction, hex: args.hex }
        },
    },

    probe: {
        description:
            'Sweep one field across values to learn its meaning: for each value, clone a base packet, apply the value, encode, inject it as a fromDevice packet (waiting for a delivery ack), then observe how the real LG cloud decodes it (the notification feed). Each result has delivered (did rethink accept the inject) and observed (the cloud\'s reaction) — so delivered:true + observed:[] means the cloud saw it but didn\'t react, while delivered:false means it never reached rethink. The device MUST be bridged or the cloud never sees the packet. Observation is a coarse time-window correlation (filtered to the device by id), needs a prior `lgcloud-monitor.ts` login, and returns observed:null with feed:"unavailable" if not logged in.',
        inputSchema: {
            type: 'object',
            properties: {
                base: { type: 'object', description: 'an encode_packet input (the unmodified fromDevice packet)' },
                mutate: {
                    type: 'object',
                    properties: {
                        tlvId: { type: 'number' },
                        byteOffset: { type: 'number', description: 'offset into the AABB body' },
                        values: { type: 'array', items: { type: 'number' } },
                    },
                    required: ['values'],
                },
                deviceId: { type: 'string' },
                settleMs: {
                    type: 'number',
                    description: 'how long to wait for the cloud reaction per value (default 2000)',
                },
                allDevices: { type: 'boolean', description: 'do not filter cloud messages to this device' },
            },
            required: ['base', 'mutate', 'deviceId'],
        },
        handler: async (args) => {
            const base = args.base as EncodeInput
            if (base.protocol === 'tlv' && base.direction === 'toDevice')
                throw new Error('probe injects fromDevice packets only; set base.direction to fromDevice')
            const deviceId = String(args.deviceId)
            const settleMs = Number(args.settleMs ?? 2000)
            const feed = await ensureCloudFeed()

            const results = []
            for (const value of args.mutate.values as number[]) {
                const mutated = applyMutation(base, args.mutate, value)
                const { hex } = encodePacket(mutated)
                const since = Date.now()

                let delivered = true
                try {
                    await injectOnce(mgmtHost, deviceId, 'fromDevice', hex)
                } catch {
                    delivered = false
                }

                // Only meaningful to wait for a reaction if the packet was actually delivered.
                let observed: { topic: string; payload: unknown }[] | null = null
                if (delivered && feed === 'connected') {
                    await sleep(settleMs)
                    observed = cloudBuffer
                        .filter((m) => m.ts >= since && (args.allDevices || m.raw.includes(deviceId)))
                        .map((m) => ({ topic: m.topic, payload: m.payload }))
                }
                results.push({ value, hex, delivered, observed })
            }
            return { feed, settleMs, results }
        },
    },
}

function applyMutation(base: EncodeInput, mutate: any, value: number): EncodeInput {
    if (base.protocol === 'tlv') {
        const tlv = base.tlv.map((e) => (e.t === mutate.tlvId ? { ...e, v: value } : e))
        if (!tlv.some((e) => e.t === mutate.tlvId)) tlv.push({ t: mutate.tlvId, v: value })
        return { ...base, tlv }
    } else {
        const bytes = Buffer.from(base.body, 'hex')
        bytes[mutate.byteOffset] = value & 0xff
        return { ...base, body: bytes.toString('hex') }
    }
}

// Open the management /ws, grab the snapshot it sends on connect ({ha, bridge, devices}), close.
function mgmtSnapshot(host: string): Promise<any> {
    const h = host.includes(':') ? host : `${host}:44401`
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${h}/ws`)
        const timer = setTimeout(() => {
            ws.close()
            reject(new Error('timed out connecting to the management /ws'))
        }, 5000)
        ws.on('message', (data: WebSocket.RawData) => {
            clearTimeout(timer)
            try {
                resolve(JSON.parse(data.toString()))
            } catch (err) {
                reject(err as Error)
            } finally {
                ws.close()
            }
        })
        ws.on('error', (err) => {
            clearTimeout(timer)
            reject(err)
        })
    })
}

// Inject a packet and wait for the /device WS to echo it back (injected:true, matching
// hex) — confirming rethink actually accepted and dispatched it. Rejects on timeout, so an
// unknown id / offline device / dropped packet becomes a real error rather than a silent
// no-op. (The echo proves delivery into rethink's pipeline, not that the cloud reacted.)
function injectOnce(host: string, deviceId: string, direction: 'fromDevice' | 'toDevice', hex: string): Promise<void> {
    const h = host.includes(':') ? host : `${host}:44401`
    const sendKey = direction === 'fromDevice' ? 'sendFromDevice' : 'sendToDevice'
    const echoKey = direction === 'fromDevice' ? 'rx' : 'tx'
    const want = hex.toLowerCase()
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${h}/device?id=${encodeURIComponent(deviceId)}`)
        let settled = false
        let timer: ReturnType<typeof setTimeout>
        const finish = (err?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            ws.close()
            err ? reject(err) : resolve()
        }
        timer = setTimeout(
            () =>
                finish(new Error('inject not acknowledged (unknown device id, device offline, or rethink dropped it)')),
            5000,
        )
        ws.on('open', () => ws.send(JSON.stringify({ [sendKey]: hex })))
        ws.on('message', (data: WebSocket.RawData) => {
            let msg: any
            try {
                msg = JSON.parse(data.toString())
            } catch {
                return
            }
            if (msg.injected === true && typeof msg[echoKey] === 'string' && msg[echoKey].toLowerCase() === want)
                finish()
        })
        ws.on('error', (err) => finish(err as Error))
    })
}

// ── JSON-RPC / MCP plumbing ─────────────────────────────────────────────────

function send(msg: object) {
    process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(req: any) {
    const { id, method, params } = req
    try {
        if (method === 'initialize') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'rethink-agent', version: '0.1.0' },
                },
            }
        }
        if (method === 'ping') {
            // MCP keepalive: respond with an empty result
            return { jsonrpc: '2.0', id, result: {} }
        }
        if (method === 'tools/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    tools: Object.entries(tools).map(([name, t]) => ({
                        name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                    })),
                },
            }
        }
        if (method === 'tools/call') {
            const tool = tools[params?.name]
            if (!tool) throw new Error(`unknown tool: ${params?.name}`)
            const out = await tool.handler(params.arguments ?? {})
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } }
        }
        // notifications (no id) and anything else: no response
        if (id === undefined) return null
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    } catch (err: any) {
        if (id === undefined) return null
        // surface tool errors as a tool result so the agent can react, not a transport error
        if (method === 'tools/call')
            return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true },
            }
        return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } }
    }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
    const text = line.trim()
    if (!text) return
    let req: any
    try {
        req = JSON.parse(text)
    } catch {
        return
    }
    const res = await handle(req)
    if (res) send(res)
})
rl.on('close', () => process.exit(0))

console.error('rethink-agent MCP server ready on stdio')
