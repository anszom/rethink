import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fromCode, refresh } from '@/bridge/oauth2'

async function withResponse<T>(body: unknown, run: (url: string) => Promise<T>): Promise<T> {
    const server = createServer((_req, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    try {
        return await run(`http://127.0.0.1:${address.port}`)
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => {
                if (error) reject(error)
                else resolve()
            }),
        )
    }
}

test('OAuth code exchange accepts positive numeric string and number expiries', async () => {
    for (const expires_in of ['3600', 3600]) {
        const before = Date.now()
        const token = await withResponse({ access_token: 'access', refresh_token: 'refresh', expires_in }, (url) =>
            fromCode(url, 'code'),
        )
        assert.equal(token.accessToken, 'access')
        assert.equal(token.refreshToken, 'refresh')
        assert(token.validUntil >= before + 3_600_000)
        assert(token.validUntil <= Date.now() + 3_600_000)
    }
})

test('OAuth code exchange rejects partial, malformed, and non-positive responses without exposing tokens', async () => {
    const invalid = [
        { access_token: 'access-secret', expires_in: 3600 },
        { refresh_token: 'refresh-secret', expires_in: 3600 },
        { access_token: 123, refresh_token: 'refresh-secret', expires_in: 3600 },
        { access_token: 'access-secret', refresh_token: 456, expires_in: 3600 },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 'not-a-number' },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 0 },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: Infinity },
        { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: Number.MAX_VALUE },
        null,
    ]

    for (const response of invalid) {
        await assert.rejects(
            withResponse(response, (url) => fromCode(url, 'code')),
            (error: Error) => {
                assert.match(error.message, /invalid response/)
                assert.doesNotMatch(error.message, /access-secret|refresh-secret/)
                return true
            },
        )
    }
})

test('OAuth refresh errors do not expose an invalid token response', async () => {
    await assert.rejects(
        withResponse({ access_token: 123, refresh_token: 'response-secret' }, (url) => refresh(url, 'request-secret')),
        (error: Error) => {
            assert.match(error.message, /invalid response/)
            assert.doesNotMatch(error.message, /response-secret|request-secret/)
            return true
        },
    )
})
