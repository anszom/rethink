import { createHmac, randomBytes } from 'node:crypto'
import fetch from 'node-fetch'

const OAUTH2_SECRET = Buffer.from('c053c2a6ddeb7ad97cb0eed0dcb31cf8')

export async function signedRequest<T = unknown>(
    url: string,
    headers: Record<string, string> = {},
    body: string | URLSearchParams | undefined = undefined,
): Promise<T> {
    const path = new URL(url).pathname
    const timestamp = new Date().toUTCString().replace('GMT', '+0000')
    let signed = path
    if (body !== undefined) {
        if (typeof body !== 'string') body = body.toString()
        signed += '?' + body
    }

    signed += '\n' + timestamp

    const resp = await fetch(url, {
        headers: {
            ...headers,
            'x-lge-oauth-signature': createHmac('sha1', OAUTH2_SECRET).update(signed).digest('base64'),
            'x-lge-oauth-date': timestamp,
            Accept: 'application/json',
            'x-lge-appkey': 'LGAO221A02',
            'x-lge-app-os': 'ANDROID',
            'X-Application-Key': 'LGAO221A02',
            'lgemp-x-app-key': 'LGAO221A02',
        },
        method: body !== undefined ? 'POST' : 'GET',
        body,
    })
    return (await resp.json()) as T
}

type OAuth2Response = {
    access_token?: string
    refresh_token?: string
    expires_in?: string | number
}

function invalidOAuthResponse(operation: string): Error {
    return new Error(`OAuth2 ${operation} failed: invalid response`)
}

export type Token = {
    accessToken: string
    refreshToken: string
    validUntil: number
}

export async function fromCode(authUrl: string, code: string): Promise<Token> {
    const params = new URLSearchParams()
    params.set('code', code)
    params.set('grant_type', 'authorization_code')
    params.set('redirect_uri', 'https://kr.m.lgaccount.com/login/iabClose')
    params.set('sso_id', randomBytes(16).toString('hex'))

    const rawResponse = await signedRequest<unknown>(
        authUrl + '/oauth/1.0/oauth2/token',
        {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        params,
    )
    const response =
        rawResponse && typeof rawResponse === 'object' ? (rawResponse as OAuth2Response) : ({} as OAuth2Response)

    const expiresIn =
        typeof response.expires_in === 'string' || typeof response.expires_in === 'number'
            ? Number(response.expires_in)
            : NaN
    if (
        typeof response.access_token === 'string' &&
        response.access_token.length > 0 &&
        typeof response.refresh_token === 'string' &&
        response.refresh_token.length > 0 &&
        Number.isFinite(expiresIn) &&
        expiresIn > 0 &&
        Number.isFinite(Date.now() + expiresIn * 1000)
    ) {
        return {
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            validUntil: Date.now() + expiresIn * 1000,
        }
    } else {
        throw invalidOAuthResponse('sign-in')
    }
}

export async function refresh(authUrl: string, refreshToken: string): Promise<{ accessToken: string }> {
    const params = new URLSearchParams()
    params.set('grant_type', 'refresh_token')
    params.set('refresh_token', refreshToken)

    const rawResponse = await signedRequest<unknown>(
        authUrl + '/oauth/1.0/oauth2/token',
        {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        params,
    )
    const response =
        rawResponse && typeof rawResponse === 'object' ? (rawResponse as OAuth2Response) : ({} as OAuth2Response)

    if (typeof response.access_token === 'string' && response.access_token.length > 0) {
        return { accessToken: response.access_token }
    }

    throw invalidOAuthResponse('refresh')
}
