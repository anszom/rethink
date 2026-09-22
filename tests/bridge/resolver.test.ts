import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeQuery, parseResponse, lookup, setServers } from '@/bridge/resolver'

test('DNS query encodes the hostname as labels with type and class', () => {
    const query = encodeQuery('common.lgthinq.com', 1)
    assert.equal(query.readUInt16BE(0), 0) // ID
    assert.equal(query.readUInt16BE(2), 0x0100) // RD
    assert.equal(query.readUInt16BE(4), 1) // QDCOUNT
    assert.deepEqual(
        query.subarray(12),
        Buffer.from('06636f6d6d6f6e076c677468696e7103636f6d00' + '0001' + '0001', 'hex'),
    )
    assert.throws(() => encodeQuery('bad..name', 1))
})

// Builds a response to `query` with a CNAME followed by the given records, using compression
// pointers the way real servers do.
function response(query: Buffer, answers: { type: number; data: Buffer; ttl: number }[], rcode = 0) {
    const header = Buffer.from(query.subarray(0, 12))
    header.writeUInt16BE(0x8180 | rcode, 2)
    header.writeUInt16BE(answers.length + 1, 6)

    const cnameTarget = Buffer.from('0463646e73c00c', 'hex') // "cdns." + pointer to the question name
    const rr = (type: number, ttl: number, data: Buffer, name: Buffer) => {
        const fixed = Buffer.alloc(10)
        fixed.writeUInt16BE(type, 0)
        fixed.writeUInt16BE(1, 2)
        fixed.writeUInt32BE(ttl, 4)
        fixed.writeUInt16BE(data.length, 8)
        return Buffer.concat([name, fixed, data])
    }

    const questionEnd = query.length
    const cnameRdataOffset = questionEnd + 2 + 10
    const pointerToCname = Buffer.from([0xc0 | (cnameRdataOffset >> 8), cnameRdataOffset & 0xff])

    return Buffer.concat([
        header,
        query.subarray(12),
        rr(5, 300, cnameTarget, Buffer.from('c00c', 'hex')),
        ...answers.map((a) => rr(a.type, a.ttl, a.data, pointerToCname)),
    ])
}

test('DNS response parsing follows compression and skips CNAMEs', () => {
    const a = encodeQuery('common.lgthinq.com', 1)
    assert.deepEqual(
        parseResponse(
            response(a, [
                { type: 1, ttl: 120, data: Buffer.from([52, 1, 2, 3]) },
                { type: 1, ttl: 90, data: Buffer.from([52, 1, 2, 4]) },
            ]),
            1,
        ),
        [
            { address: '52.1.2.3', family: 4, ttl: 120 },
            { address: '52.1.2.4', family: 4, ttl: 90 },
        ],
    )

    const aaaa = encodeQuery('common.lgthinq.com', 28)
    assert.deepEqual(
        parseResponse(
            response(aaaa, [{ type: 28, ttl: 60, data: Buffer.from('20010db8000000000000000000000001', 'hex') }]),
            28,
        ),
        [{ address: '2001:db8::1', family: 6, ttl: 60 }],
    )
})

test('DNS response parsing handles NXDOMAIN and errors', () => {
    const q = encodeQuery('nope.example', 1)
    assert.deepEqual(parseResponse(response(q, [], 3), 1), [])
    assert.throws(() => parseResponse(response(q, [], 2), 1), /code 2/)
})

test('lookup passes IP literals through without querying', async () => {
    setServers(['https://192.0.2.1/dns-query']) // unreachable, must not be used
    const single = await new Promise((resolve, reject) =>
        lookup('127.0.0.1', {}, (err, address, family) => (err ? reject(err) : resolve([address, family]))),
    )
    assert.deepEqual(single, ['127.0.0.1', 4])

    const all = await new Promise((resolve, reject) =>
        lookup('::1', { all: true }, (err, address) => (err ? reject(err) : resolve(address))),
    )
    assert.deepEqual(all, [{ address: '::1', family: 6 }])
    setServers()
})

test('setServers rejects entries that are not servers', () => {
    assert.throws(() => setServers(['not a server']))
    assert.throws(() => setServers(['system']))
    setServers()
})

test('lookup falls back to the system resolver without servers', async () => {
    setServers([])
    const address = await new Promise((resolve, reject) =>
        lookup('localhost', { family: 4 }, (err, address) => (err ? reject(err) : resolve(address))),
    )
    assert.equal(address, '127.0.0.1')
})
