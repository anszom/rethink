import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:tls'
import { test } from 'node:test'
import { Response } from 'node-fetch'
import { Connection, type Thinq1ConnectionOptions } from '@/bridge/thinq1connection'
import { Thinq1Device } from '@/bridge/thinqApi'
import type { TLSSocket } from 'node:tls'
import { Agent } from 'node:https'

class FakeTlsSocket extends EventEmitter {
    destroyed = false
    writes: Buffer[] = []

    write(data: Buffer) {
        this.writes.push(data)
        return true
    }

    destroy(error?: Error) {
        if (this.destroyed) return this
        this.destroyed = true
        if (error) this.emit('error', error)
        queueMicrotask(() => this.emit('close'))
        return this
    }
}

function device(rtiServer = 'rti.example:443') {
    return new Thinq1Device(
        '48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53',
        { modelId: 'model', modelName: 'model', deviceType: '101' },
        { httpServer: 'https://http.example', rtiServer },
    )
}

const okFetch: NonNullable<Thinq1ConnectionOptions['fetchTransport']> = async () =>
    new Response('<lgedmRoot/>', { status: 200 })

function waitForClose(connection: Connection) {
    return new Promise<void>((resolve) => connection.once('close', resolve))
}

/**
 * The connection's own deadlines are unref'd so a pending timer never holds the add-on open. A test
 * that waits for one of them is then the only thing left on the loop, and the runner would cancel it
 * as "still pending" before the timer fires. Hold one ref'd handle for exactly that wait.
 */
async function awaitingUnrefedTimer<T>(work: Promise<T>): Promise<T> {
    const keepAlive = setInterval(() => {}, 1)
    try {
        return await work
    } finally {
        clearInterval(keepAlive)
    }
}

test('HTTP startup refusal is observed through ready, error, and close', async () => {
    const refusal = new Error('refused')
    const connection = new Connection(device(), {
        fetchTransport: async () => {
            throw refusal
        },
    })
    const error = once(connection, 'error')
    const close = waitForClose(connection)
    await assert.rejects(connection.ready, refusal)
    assert.equal((await error)[0], refusal)
    await close
})

test('HTTP startup timeout aborts the request and closes without creating TLS', async () => {
    let tlsCalls = 0
    const connection = new Connection(device(), {
        httpTimeoutMs: 5,
        fetchTransport: async (_url, options) =>
            await new Promise<Response>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
            }),
        tlsConnector: () => {
            tlsCalls++
            return new FakeTlsSocket() as unknown as TLSSocket
        },
    })
    connection.on('error', () => {})
    const close = waitForClose(connection)
    await awaitingUnrefedTimer(assert.rejects(connection.ready, /timed out/))
    assert.equal(tlsCalls, 0)
    await close
})

test('destroy during HTTP startup prevents a later RTI connection', async () => {
    let resolveFetch!: (response: Response) => void
    let tlsCalls = 0
    const connection = new Connection(device(), {
        fetchTransport: () =>
            new Promise<Response>((resolve) => {
                resolveFetch = resolve
            }),
        tlsConnector: () => {
            tlsCalls++
            return new FakeTlsSocket() as unknown as TLSSocket
        },
    })
    connection.destroy()
    resolveFetch(new Response('<lgedmRoot/>', { status: 200 }))
    await assert.rejects(connection.ready, /destroyed during startup/)
    assert.equal(tlsCalls, 0)
})

test('a shared HTTP agent is not destroyed with an individual connection', async () => {
    const agent = new Agent({ keepAlive: true })
    let destroyCalls = 0
    const originalDestroy = agent.destroy.bind(agent)
    agent.destroy = () => {
        destroyCalls++
        originalDestroy()
    }
    const connection = new Connection(device(), {
        httpsAgent: agent,
        fetchTransport: async (_url, options) => {
            assert.equal(options.agent, agent)
            return await new Promise<Response>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
            })
        },
    })

    connection.destroy()
    await assert.rejects(connection.ready, /destroyed/)
    assert.equal(destroyCalls, 0)
    agent.destroy()
})

test('destroy during TLS handshake settles startup and cancels its deadline', async () => {
    const socket = new FakeTlsSocket()
    const errors: Error[] = []
    const connection = new Connection(device(), {
        fetchTransport: okFetch,
        tlsConnectTimeoutMs: 10,
        tlsConnector: () => socket as unknown as TLSSocket,
    })
    connection.on('error', (error) => errors.push(error))
    await new Promise((resolve) => setImmediate(resolve))
    connection.destroy()
    await assert.rejects(connection.ready, /destroyed during startup/)
    assert.equal(socket.destroyed, true)
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.deepEqual(errors, [])
})

test('heartbeat is stopped when the RTI socket closes', async () => {
    const socket = new FakeTlsSocket()
    const connection = new Connection(device(), {
        fetchTransport: okFetch,
        heartbeatIntervalMs: 5,
        tlsConnector: (options) => {
            assert.equal(options.rejectUnauthorized, true)
            assert.equal(options.servername, 'rti.example')
            queueMicrotask(() => socket.emit('secureConnect'))
            return socket as unknown as TLSSocket
        },
    })
    connection.on('error', () => {})
    await connection.ready
    connection.isLive = true
    connection.send(Buffer.from([0x01, 0x02]))
    const status = JSON.parse(socket.writes.at(-1)!.subarray(4).toString())
    assert.equal(status.Body.CmdWId, `n-${device().deviceId}`)
    assert.equal(status.Body.ReturnCode, '0000')
    await new Promise((resolve) => setTimeout(resolve, 12))
    assert.ok(socket.writes.length >= 2)
    socket.destroy()
    await once(connection, 'close')
    const writesAfterClose = socket.writes.length
    await new Promise((resolve) => setTimeout(resolve, 12))
    assert.equal(socket.writes.length, writesAfterClose)
})

// A throwaway self-signed localhost pair (CN=localhost), so the test needs no openssl at runtime.
const UNTRUSTED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC2vSCPqg12AQrp
vTeRmQU7KMij304KhO9R6EMTwuiPXMjr5GVLB1HNdL8MqYBsmcJTwvxq4gbQQWAG
9gw8Gm5xJAx2On/95/NlubLKl+ZAgRhKLB4mHQjjjGoy/NL3Mu8+z+odK0N61jmn
EX+fAB69MSM+HbmBWe2AdyVguJv5bYnRjw3z0oThKFo/9N1j2FFsDX9LywNdeqaM
aefoCzNV4ISzUB4/uPaG9rqOn+J8/ePC+gPocmqUG4THKVb+qW88HuHIqnCZWeCg
kBE5AhABQYouIBafMxFc+EeXEPIPIhSxJSCTZ4EROZ50Lh6MOGsl3hxdgcQeIOWU
rjlIZJ9TAgMBAAECggEACVeWyB3kzyrsQXWDLKRce+EbcM4nvFUMXVC45g0Qn/AZ
u7dTAewNpsYt1G+qY/9iIQTIczgtKlRpuQa3Kr4chDStlmsU/OwNN+XodkcDgqvP
xPkyNAyc1iqTwm8a47jQcsud4JzEDUbt/PE29ijfolFWVegs5ag7go7qHn8RnAy7
zk0ztR2iZn04V5GwYdBnGhqI6/VzGHT4YMZk5WA+zrBZZrqVwpKnqKLulV2kcg9L
L+JLQqtcTYSdq+j6ssZQx1VMLhfvL8+d/nqfZZUhJ9Ot3GBzb0VwZFM6xnQAe3bw
9LwkLwr2tGPuQ4I50J2kr9dBHUBVLwrq8r7MFA240QKBgQD+2Nw6YQfz4weKiO1P
x25UwXoMlMb7fVtkfZcrCdhC+mzMRL4GgkGazKzLFhv3p3PCeub/svFXCZpsaCPj
j9SGG0PJxrKIx3TwfYBcgSwId+sj7O/reGsdCl5N3L0wn7pCPkdXXbIUuJYiq/pi
gLXwOysXC1l4halFjd1Cndsv3QKBgQC3kMIFvZQ3zpBJR2MK33CoaMYwfbcrO+Qs
aVmQLbHYwJQX7VuRchRZoBy6SQGhihXpcqXI5NaLd9MVTwLFyQ0c7PpFeXHFgb2T
1Dq1IH3QwWQXf9pInXxngz4iWZ7V3kq0O6IRGG7o31KLDjSEL52U71J8u60kxvdl
hiXmZxew7wKBgACXUCtyfio6pJHVr3c35zGbIUVWMv/yUnvxLqCS7UV6fzYaErbB
JpXNU7lE29u/L62Ly21cZOLmyszlkO++LagB+C5Hn7JhhAvqvpl4UznRzWHP8t6A
8P6oP3++u1GZjT0KF/BD713M78w0yefglItyF699/z8gUDwxEApPg2qhAoGBALSN
OJnG31uI3FiHU76lCb1L2OxnKtvme8bHFGYA2/YTbVafizpjF+sT1k3Qcz89f9Hv
h2sy0me5wzApV9PMrg4udPgSvLoEo8ActmXjgHztSxLmGYDlDjEOYPYOanF3xMjE
AuOHwcdhqWHG5hbCct/ECcFQI7yRy1LbgLm/2wiXAoGBAPA7i5UL2aqZp6Ldf8Iq
6iUpPlayeDeRj2XkApOZkfmpG3oSrYi+YB22zhu5dJ2K+aFG/GLwl5qxZWb2iyL2
y9KXrHLFesOQSZKwTOT70dz2Ka5j1y6r5YVFPwr/ohddi8OALyn0/naavO/9/Wme
O5SzWRLjbnyT9RbXsjbG0zVd
-----END PRIVATE KEY-----
`
const UNTRUSTED_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUdoSSCvb4x4La7hZn22LYzBR5LMcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgwMjE1MTEwNFoXDTM2MDcz
MDE1MTEwNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtr0gj6oNdgEK6b03kZkFOyjIo99OCoTvUehDE8Loj1zI
6+RlSwdRzXS/DKmAbJnCU8L8auIG0EFgBvYMPBpucSQMdjp//efzZbmyypfmQIEY
SiweJh0I44xqMvzS9zLvPs/qHStDetY5pxF/nwAevTEjPh25gVntgHclYLib+W2J
0Y8N89KE4ShaP/TdY9hRbA1/S8sDXXqmjGnn6AszVeCEs1AeP7j2hva6jp/ifP3j
wvoD6HJqlBuExylW/qlvPB7hyKpwmVngoJAROQIQAUGKLiAWnzMRXPhHlxDyDyIU
sSUgk2eBETmedC4ejDhrJd4cXYHEHiDllK45SGSfUwIDAQABo1MwUTAdBgNVHQ4E
FgQUyyit3FlAGBHI/K51Sq4ZMmuxVCEwHwYDVR0jBBgwFoAUyyit3FlAGBHI/K51
Sq4ZMmuxVCEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEArGrP
HoerIAAOt8/PrmSLfUI/UfGjF+aEKTSG5pe7U8/xhCLYtVyZTVloEnRqeHDR2AUp
9dczc0AdZQty1YQLWcd49DkFN090sNqvyrEUNC4O68zNbR6O/MeIkbXstRDMIYqv
PDUuPz4kaJp2GQlCgcdXI1Yql3qVvQnqjxixNDjyFVVvymf4IxLQeZ49VZKLefxb
c9AcvRPUc2Xm+cIoTFfPIMBSTbXNKe8jeY/SI5r/gVAEkdVMizTE/yqIV0xbOhww
rHP7WDzFAv0AYsDiNMTwWJy7J/AdDbobIbbVb8jvrD6ZylVFesr8Vgjc482nI5br
MJ9w4TIPy66jDSA12w==
-----END CERTIFICATE-----
`

test('RTI TLS rejects an untrusted certificate by default', async (t) => {
    const server = createServer({ key: UNTRUSTED_KEY, cert: UNTRUSTED_CERT })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    t.after(() => server.close())

    const connection = new Connection(device(`localhost:${address.port}`), {
        fetchTransport: okFetch,
        tlsConnectTimeoutMs: 1000,
    })
    connection.on('error', () => {})
    const close = waitForClose(connection)
    await assert.rejects(connection.ready, /self-signed certificate|certificate/i)
    await close
})
