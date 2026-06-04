// Reusable client for observing the real LG ThinQ cloud's MQTT notification feed.
//
// This module deals only with an in-memory `State` object (just the country code and
// OAuth refresh token):
//   - login()  performs the one-time interactive sign-in and returns a State
//   - connect(state, ...) streams notifications using a State
//
// The AWS-IoT subscription (key/cert/clientId) is NOT part of State and is never
// persisted: it is generated at runtime. This is deliberate — the subscription pins
// an MQTT clientId, and AWS IoT drops any earlier connection using the same clientId,
// so sharing one across concurrently-running tools (the MCP server, lgcloud-monitor,
// rethink-capture) makes them fight. A fresh per-process subscription gives each its
// own clientId.
//
// Persisting/loading the State (where, in what file, how to validate) is the caller's
// responsibility — see ./state.ts. The module itself does no file I/O.

import readline from 'node:readline'
import mqtt from 'mqtt'
import * as OAuth2 from '@/bridge/oauth2'
import { subprocess } from '@/bridge/util'
import { Client, IOT_BASE_URL, RouteCertResponse, RouteResponse, apiFetch, signInUrl } from '@/bridge/thinqApi'

type Subscription = { key: string; cert: string; subscriptions: string[] }
export type State = { countryCode: string; refreshToken: string }

type CertificateResponse = { certificatePem: string; subscriptions: string[] }

export type CloudMessage = { topic: string; payload: unknown | null; raw: string }
export type ConnectOptions = { onMessage: (msg: CloudMessage) => void; log?: (msg: string) => void }

// Interactive: print a sign-in URL, read the pasted post-login URL from stdin, exchange
// the code for a refresh token. Login flow inspired by 'wideq'.
async function oauth2Login(client: Client): Promise<string> {
    const base = await client.getUrls()
    console.log(`Use your browser to log in at ${signInUrl(base.webUrl, client.env.countryCode).toString()}`)

    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
    let code = ''
    while (true) {
        const outUrl = await new Promise<string>((resolve) =>
            terminal.question('Paste the post-login URL here: ', resolve),
        )
        try {
            code = new URL(outUrl).searchParams.get('code') ?? ''
        } catch {}
        if (code) break
        console.log(`This URL doesn't look right. It should contain a code= parameter.`)
    }
    terminal.close()

    const { refreshToken } = await OAuth2.fromCode(base.authUrl, code)
    return refreshToken
}

async function generateSubscription(client: Client): Promise<Subscription> {
    // non-interactive; requires an authenticated client
    const privateKey = await subprocess('openssl', ['genrsa', '2048'])
    // openssl req can't read the key from node's socket-backed stdin directly; pipe via cat.
    const csr = await subprocess(
        'bash',
        ['-c', `cat | openssl req -new -key /dev/stdin -subj '/CN=AWS IoT Certificate/O=Amazon'`],
        privateKey,
    )

    const { thinq2Uri } = await client.gateway
    const response = await apiFetch<CertificateResponse>(`${thinq2Uri}/service/users/client/certificate`, {
        headers: client.headers,
        method: 'POST',
        body: JSON.stringify({ csr }),
    })
    if (typeof response?.certificatePem !== 'string') throw new Error('Invalid certificate returned')

    return {
        key: privateKey,
        cert: response.certificatePem,
        subscriptions: response.subscriptions,
    }
}

async function openMQTT(client: Client, subscription: Subscription, opts: ConnectOptions): Promise<mqtt.MqttClient> {
    const log = opts.log ?? (() => {})
    const route = await apiFetch<RouteResponse>(`${IOT_BASE_URL}/route`, {
        headers: { 'x-country-code': client.env.countryCode, 'x-service-phase': 'OP', accept: 'application/json' },
    })
    const { certificatePem: caCert } = await apiFetch<RouteCertResponse>(
        `${IOT_BASE_URL}/route/certificate?name=aws-iot`,
        { headers: { accept: 'application/json' } },
    )

    const mqttUrl = route.mqttServer.replace(/^ssl:\/\//, 'mqtts://')
    const mqttClient = mqtt.connect(mqttUrl, {
        clientId: client.clientId,
        protocolVersion: 4,
        key: subscription.key,
        cert: subscription.cert,
        ca: caCert,
        ALPNProtocols: ['x-amzn-mqtt-ca'],
        rejectUnauthorized: true,
    })

    mqttClient.on('connect', () => {
        log('connected')
        for (const topic of subscription.subscriptions) {
            mqttClient.subscribe(topic, { qos: 1 }, (err) => {
                if (err) log(`subscribe error on ${topic}: ${err.message}`)
            })
        }
    })
    mqttClient.on('error', (err) => log(`error: ${err.message}`))
    mqttClient.on('close', () => log('close'))
    mqttClient.on('reconnect', () => log('reconnect'))
    mqttClient.on('offline', () => log('offline'))

    mqttClient.on('message', (topic, payload) => {
        const raw = payload.toString('utf-8')
        let parsed: unknown | null = null
        try {
            parsed = JSON.parse(raw)
        } catch {}
        opts.onMessage({ topic, payload: parsed, raw })
    })

    return mqttClient
}

async function promptCountryCode(): Promise<string> {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
        let cc = ''
        while (!/^[A-Z]{2}$/.test(cc)) {
            cc = (
                await new Promise<string>((resolve) =>
                    terminal.question('Enter the 2-letter country code (e.g. US) matching your LG account: ', resolve),
                )
            )
                .trim()
                .toUpperCase()
        }
        return cc
    } finally {
        terminal.close()
    }
}

// Interactive, run ONCE: prompt for the country code, sign in, and return the State
// (country code + refresh token) for the caller to persist. The subscription is generated
// later, by connect().
export async function login(): Promise<State> {
    const countryCode = await promptCountryCode()
    const client = new Client({ countryCode })
    const refreshToken = await oauth2Login(client)
    return { countryCode, refreshToken }
}

// Non-interactive: connect to the cloud MQTT feed using a State, deliver each message to
// opts.onMessage.
export async function connect(state: State, opts: ConnectOptions): Promise<mqtt.MqttClient> {
    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    const subscription = await generateSubscription(client)
    return openMQTT(client, subscription, opts)
}
