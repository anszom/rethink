import { createHmac, randomBytes } from "node:crypto"
import fetch from 'node-fetch';

const OAUTH2_SECRET =  Buffer.from('c053c2a6ddeb7ad97cb0eed0dcb31cf8')

export async function signedRequest<T = unknown>(url: string, headers: Record<string,string> = {}, body: string | URLSearchParams | undefined = undefined): Promise<T> {
	const path = new URL(url).pathname
	const timestamp = new Date().toUTCString().replace('GMT', '+0000')
	let signed = path
	if(body !== undefined) {
        if(typeof(body) !== 'string')
            body = body.toString()
		signed += '?' + body
    }

	signed += "\n" + timestamp

	const resp = await fetch(url, { headers: { ...headers,
		'x-lge-oauth-signature': createHmac('sha1', OAUTH2_SECRET).update(signed).digest('base64'),
		'x-lge-oauth-date': timestamp,
		'Accept': 'application/json',
		'x-lge-appkey': 'LGAO221A02',
		'x-lge-app-os': 'ANDROID',
		'X-Application-Key': 'LGAO221A02',
		'lgemp-x-app-key': 'LGAO221A02',
	}, method: body !== undefined ? 'POST' : 'GET', body })
	return (await resp.json() as T)
}

type OAuth2Response = {
    access_token?: string,
    refresh_token?: string,
}

export async function fromCode(authUrl: string, code: string): Promise<{ accessToken: string, refreshToken: string}> {
    const params = new URLSearchParams
    params.set("code", code);
    params.set("grant_type", "authorization_code");
    params.set("redirect_uri", "https://kr.m.lgaccount.com/login/iabClose");
    params.set("sso_id", randomBytes(16).toString("hex"));

    const response = await signedRequest<OAuth2Response>(authUrl + '/oauth/1.0/oauth2/token', {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    }, params)

    if(typeof(response.access_token) === 'string' && typeof(response.refresh_token) === 'string') {
        return { accessToken: response.access_token, refreshToken: response.refresh_token };

    } else {
        throw new Error(`OAuth2 sign-in failed: ${JSON.stringify(response)}`)
    }
}

export async function refresh(authUrl: string, refreshToken: string): Promise<{ accessToken: string }> {
    const params = new URLSearchParams
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);

    const response = await signedRequest<OAuth2Response>(authUrl + '/oauth/1.0/oauth2/token', {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    }, params)

    if(typeof(response.access_token) === 'string') {
        return { accessToken: response.access_token };
    }

    throw new Error(`OAuth2 refresh failed: ${JSON.stringify(response)}`)
}
