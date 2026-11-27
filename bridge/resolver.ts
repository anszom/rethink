import * as dns from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import log from '@/util/logging'

// The appliances find rethink through a DNS redirect of the ThinQ hostnames, and the host
// running rethink usually sits behind the same resolver. Left to the system resolver, the
// bridge would connect back to rethink instead of the LG cloud, so its upstream connections
// can resolve names through servers of their own. With none configured, the system resolver
// is used.

const TIMEOUT = 5000
const MIN_TTL = 60
const MAX_TTL = 3600

const TYPE_A = 1
const TYPE_AAAA = 28

type Record = { address: string; family: 4 | 6; ttl: number }
type Server = { name: string; query: (hostname: string) => Promise<Record[]> }

let servers: Server[] = []
const cache = new Map<string, { records: dns.LookupAddress[]; expires: number }>()
const pending = new Map<string, Promise<dns.LookupAddress[]>>()

// Each entry is a DoH URL (RFC 8484) or a plain DNS server address (optionally with a port).
// They are tried in order until one answers.
export function setServers(entries: string[] = []) {
    servers = entries.map(makeServer)
    cache.clear()
}

function makeServer(entry: string): Server {
    if (entry.startsWith('https://')) {
        const url = new URL(entry)
        return {
            name: entry,
            query: (hostname) => queryBoth((type) => dohQuery(url, hostname, type)),
        }
    }

    // throws on anything that is not an address
    const resolver = new dns.promises.Resolver({ timeout: TIMEOUT, tries: 2 })
    resolver.setServers([entry])
    return {
        name: entry,
        query: (hostname) =>
            queryBoth(async (type) => {
                const records =
                    type === TYPE_A
                        ? await resolver.resolve4(hostname, { ttl: true })
                        : await resolver.resolve6(hostname, { ttl: true })
                return records.map((r) => ({ ...r, family: type === TYPE_A ? 4 : 6 }))
            }),
    }
}

// IPv4 first: an IPv6 address is of no use to a host without IPv6 connectivity, and the
// callers mostly want a single address.
async function queryBoth(query: (type: number) => Promise<Record[]>): Promise<Record[]> {
    const [v4, v6] = await Promise.allSettled([query(TYPE_A), query(TYPE_AAAA)])
    if (v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason
    return [...(v4.status === 'fulfilled' ? v4.value : []), ...(v6.status === 'fulfilled' ? v6.value : [])]
}

function dohQuery(url: URL, hostname: string, type: number): Promise<Record[]> {
    const target = new URL(url)
    target.searchParams.set('dns', encodeQuery(hostname, type).toString('base64url'))

    return new Promise((resolve, reject) => {
        const req = https.get(target, { headers: { accept: 'application/dns-message' }, timeout: TIMEOUT }, (resp) => {
            const chunks: Buffer[] = []
            resp.on('data', (chunk: Buffer) => chunks.push(chunk))
            resp.on('error', reject)
            resp.on('end', () => {
                try {
                    if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`)
                    resolve(parseResponse(Buffer.concat(chunks), type))
                } catch (err) {
                    reject(err)
                }
            })
        })
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', reject)
    })
}

export function encodeQuery(hostname: string, type: number): Buffer {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(0x0100, 2) // recursion desired; the ID stays 0, as RFC 8484 recommends
    header.writeUInt16BE(1, 4) // one question

    const labels = hostname
        .replace(/\.$/, '')
        .split('.')
        .map((label) => {
            const bytes = Buffer.from(label, 'ascii')
            if (bytes.length === 0 || bytes.length > 63) throw new Error(`Invalid hostname ${hostname}`)
            return Buffer.concat([Buffer.from([bytes.length]), bytes])
        })

    const question = Buffer.alloc(5)
    question.writeUInt16BE(type, 1)
    question.writeUInt16BE(1, 3) // class IN
    return Buffer.concat([header, ...labels, question])
}

// Returns the addresses of the requested type. CNAME records the server followed on the way
// come along in the answer section and are skipped.
export function parseResponse(msg: Buffer, type: number): Record[] {
    const rcode = msg.readUInt16BE(2) & 0x0f
    if (rcode === 3) return [] // NXDOMAIN
    if (rcode !== 0) throw new Error(`DNS error code ${rcode}`)

    const questions = msg.readUInt16BE(4)
    const answers = msg.readUInt16BE(6)

    let offset = 12
    for (let i = 0; i < questions; i++) offset = skipName(msg, offset) + 4

    const records: Record[] = []
    for (let i = 0; i < answers; i++) {
        offset = skipName(msg, offset)
        const rtype = msg.readUInt16BE(offset)
        const ttl = msg.readUInt32BE(offset + 4)
        const length = msg.readUInt16BE(offset + 8)
        const data = msg.subarray(offset + 10, offset + 10 + length)
        offset += 10 + length

        if (rtype !== type) continue
        if (type === TYPE_A && length === 4) records.push({ address: [...data].join('.'), family: 4, ttl })
        if (type === TYPE_AAAA && length === 16) {
            const groups = []
            for (let j = 0; j < 16; j += 2) groups.push(data.readUInt16BE(j).toString(16))
            // round-trip through the URL parser for the canonical compressed form
            records.push({ address: new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1), family: 6, ttl })
        }
    }

    return records
}

function skipName(msg: Buffer, offset: number): number {
    for (;;) {
        const length = msg[offset]
        if (length === undefined) throw new Error('Truncated DNS message')
        if (length === 0) return offset + 1
        if ((length & 0xc0) === 0xc0) return offset + 2 // compression pointer ends the name
        offset += length + 1
    }
}

function resolve(hostname: string): Promise<dns.LookupAddress[]> {
    const cached = cache.get(hostname)
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.records)

    // connections made together (fetch + MQTT at bridge startup) share one query
    let query = pending.get(hostname)
    if (!query) {
        query = queryServers(hostname).finally(() => pending.delete(hostname))
        pending.set(hostname, query)
    }
    return query
}

async function queryServers(hostname: string): Promise<dns.LookupAddress[]> {
    let lastError: unknown
    for (const server of servers) {
        try {
            const records = await server.query(hostname)
            if (records.length === 0) break

            const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, Math.min(...records.map((r) => r.ttl))))
            const addresses = records.map(({ address, family }) => ({ address, family }))
            cache.set(hostname, { records: addresses, expires: Date.now() + ttl * 1000 })
            log('bridge', `Resolved ${hostname} via ${server.name}: ${addresses.map((a) => a.address).join(', ')}`)
            return addresses
        } catch (err) {
            log('bridge', `Resolving ${hostname} via ${server.name} failed: ${err}`)
            lastError = err
        }
    }

    const err: NodeJS.ErrnoException = new Error(`Can't resolve ${hostname}` + (lastError ? `: ${lastError}` : ''))
    err.code = 'ENOTFOUND'
    throw err
}

// A drop-in for dns.lookup, for the `lookup` option of net/tls connections and HTTP agents.
export const lookup: net.LookupFunction = (hostname, options, callback) => {
    if (servers.length === 0) return dns.lookup(hostname, options, callback)

    const ip = net.isIP(hostname)
    if (ip) {
        if (options.all) callback(null, [{ address: hostname, family: ip }])
        else callback(null, hostname, ip)
        return
    }

    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family || 0
    resolve(hostname).then(
        (all) => {
            const matching = family ? all.filter((a) => a.family === family) : all
            if (matching.length === 0) {
                const err: NodeJS.ErrnoException = new Error(`No IPv${family} address for ${hostname}`)
                err.code = 'ENOTFOUND'
                callback(err, '')
            } else if (options.all) callback(null, matching)
            else callback(null, matching[0].address, matching[0].family)
        },
        (err) => callback(err, ''),
    )
}

const httpAgent = new http.Agent({ lookup })
const httpsAgent = new https.Agent({ lookup })

// For node-fetch's `agent` option.
export function agent(url: URL) {
    return url.protocol === 'http:' ? httpAgent : httpsAgent
}
