import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fromCode, fromSignIn, refresh } from '@/bridge/oauth2'
import { captureLog } from '../helpers/mocks'

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

describe('Sign-in result', () => {
    const IAB_CLOSE = 'https://kr.m.lgaccount.com/login/iabClose?state=signin'
    const SIGN_IN_ACT = JSON.stringify({
        account: { loginSessionID: 'session-1', userID: 'user@example.com', userIDType: 'LGE', country: 'TH' },
    })

    type Received = { method?: string; path?: string; contentType?: string; form: [string, string][] }
    let received: Received[] = []
    let oauthAnswer: unknown
    let base = ''
    let server: Server

    // Plays the sign-in page's server (webUrl) and the token servers (authUrl, oauth2_backend_url), told apart by path
    before(async () => {
        server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
                const form = [...new URLSearchParams(Buffer.concat(chunks).toString())]
                received.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], form })
                const token = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify(req.url?.endsWith('/oauth/1.0/oauth2/token') ? token : oauthAnswer))
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })

    after(async () => {
        await new Promise((resolve) => server.close(resolve))
    })

    beforeEach(() => {
        received = []
    })

    const signIn = (pasted: string) =>
        fromSignIn({ webUrl: `${base}/front/`, authUrl: `${base}/gateway` }, 'TH', pasted)
    const paths = () => received.map((r) => r.path)

    // A post-login URL naming this server's /backend/ as the token server
    const postLoginUrl = () =>
        `${IAB_CLOSE}&code=Abc123&user_number=TH0000000000000&oauth2_backend_url=${encodeURIComponent(`${base}/backend/`)}`

    // The oauth step's answer: every field null but redirect_uri, the post-login URL percent-encoded once more
    function answer(redirect_uri: string | null) {
        return {
            access_token: null,
            code: null,
            errCode: null,
            lgoauth_error_code: null,
            message: null,
            oauth2_backend_url: null,
            redirect_uri,
            refresh_token: null,
            state: null,
            status: null,
            user_number: null,
        }
    }

    test("a signInAct answer goes to the sign-in page's oauth step", async () => {
        oauthAnswer = answer(encodeURIComponent(postLoginUrl()))
        await signIn(SIGN_IN_ACT)

        const [oauth] = received
        assert.equal(oauth.method, 'POST')
        assert.equal(oauth.path, '/lgacc/front/v1/signin/oauth', 'on the origin of webUrl')
        assert.match(oauth.contentType ?? '', /^application\/x-www-form-urlencoded/)
        assert.deepEqual(oauth.form, [
            ['loginSessionID', 'session-1'],
            ['clientId', 'LGAO221A02'],
            ['userName', 'user@example.com'],
            ['accountType', 'LGE'],
            ['countryCode', 'TH'],
            ['redirectUri', 'https://kr.m.lgaccount.com/login/iabClose'],
            ['state', 'signin'],
        ])
    })

    test('the code and oauth2_backend_url come out of the doubly encoded redirect_uri', async () => {
        oauthAnswer = answer(encodeURIComponent(postLoginUrl()))
        const token = await signIn(SIGN_IN_ACT)

        assert.equal(token?.refreshToken, 'refresh')
        assert.equal(received[1].path, '/backend/oauth/1.0/oauth2/token')
        assert.equal(new URLSearchParams(received[1].form).get('code'), 'Abc123')
    })

    test('without an oauth2_backend_url the code goes to the gateway', async () => {
        oauthAnswer = answer(encodeURIComponent(`${IAB_CLOSE}&code=Abc123`))
        await signIn(SIGN_IN_ACT)

        assert.equal(received[1].path, '/gateway/oauth/1.0/oauth2/token')
    })

    test('a pasted post-login URL skips the oauth step and keeps the gateway', async () => {
        const token = await signIn(postLoginUrl())

        assert.equal(token?.refreshToken, 'refresh')
        assert.deepEqual(paths(), ['/gateway/oauth/1.0/oauth2/token'])
        assert.equal(new URLSearchParams(received[0].form).get('code'), 'Abc123')
    })

    test('an oauth answer without redirect_uri or code fails the way an unusable URL does', async () => {
        // JSON without a loginSessionID is taken for a URL
        for (const pasted of ['not a URL', IAB_CLOSE, JSON.stringify({ account: { userID: 'user@example.com' } })]) {
            assert.equal(await signIn(pasted), undefined)
        }
        assert.deepEqual(received, [], 'LG is not asked')

        // each oauth answer with the reason logged for it
        const refused: [unknown, string][] = [
            // an expired loginSessionID, as LG answers it
            [
                { ...answer(null), lgoauth_error_code: 'LG.OAUTH.EC.2002', message: 'EMP processing error.' },
                'LG.OAUTH.EC.2002 EMP processing error.',
            ],
            [answer(null), 'no redirect_uri'],
            [answer(encodeURIComponent(IAB_CLOSE)), 'no code in redirect_uri'],
            [answer(`${encodeURIComponent(`${IAB_CLOSE}&code=Abc123`)}%E0%A4%A`), 'malformed redirect_uri'],
        ]
        const logged = captureLog()
        try {
            for (const [oauth] of refused) {
                oauthAnswer = oauth
                assert.equal(await signIn(SIGN_IN_ACT), undefined)
            }
            // exactly these lines: nothing from the pasted answer, nor the redirect_uri with its code
            assert.deepEqual(
                logged.calls.map((call) => call.arguments.slice(1)),
                refused.map(([, why]) => ['bridge', `sign-in oauth step gave no code: ${why}`]),
            )
        } finally {
            logged.restore()
        }
        assert.ok(!paths().some((path) => path?.endsWith('/oauth/1.0/oauth2/token')), 'no code exchanged')
    })
})
