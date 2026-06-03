import * as fs from 'node:fs'
import readline from 'node:readline'
import * as OAuth2 from '@/bridge/oauth2.js'
import { subprocess } from '@/bridge/util.js'
import { Client, IOT_BASE_URL, RouteCertResponse, RouteResponse, apiFetch, signInUrl } from '@/bridge/thinqApi.js'
import mqtt from 'mqtt'

const OAUTH_JSON = 'oauth.json'
const SUBSCRIPTION_JSON = 'subscription.json'

// login flow inspired by the 'wideq' project
async function oauth2SignIn(client: Client) {
    const base = await client.getUrls()
    console.log(`Use your browser to log in at ${signInUrl(base.webUrl, client.env.countryCode).toString()}`)

    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
    let code = ''

    while (1) {
        const outUrl = await new Promise<string>((resolve) =>
            terminal.question('Paste the post-login URL here: ', resolve),
        )

        try {
            const params = new URL(outUrl).searchParams
            code = params.get('code') ?? ''
            void params.get('user_number')
        } catch (err) {}

        if (code) break
        console.log(`This URL doesn't look right. It should contain a code= parameter.`)
    }
    terminal.close()

    console.log(`Found code: ${code}`)
    const tokens = await OAuth2.fromCode(base.authUrl, code)
    return tokens.refreshToken
}

type CertificateResponse = {
    certificatePem: string
    subscriptions: string[]
}

type Subscription = {
    key: string
    cert: string
    subscriptions: string[]
    clientId: string
}

async function generateSubscription(client: Client): Promise<Subscription> {
    // the client must be authenticated
    console.log('Generating RSA 2048 private key')
    const privateKey = await subprocess('openssl', ['genrsa', '2048'])

    console.log('Generating CSR')
    // bash+cat wrapper: openssl req can't read the key from node's socket-backed stdin directly.
    // Same trick as Device.pair() in thinq2api.ts.
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

    if (typeof response?.certificatePem !== 'string') {
        console.log(response)
        throw new Error('Invalid certificate returned')
    }

    return {
        clientId: client.clientId,
        key: privateKey,
        cert: response.certificatePem,
        subscriptions: response.subscriptions,
    }
}

async function openMQTT(client: Client, subscription: Subscription) {
    console.log('Fetching route + CA cert')
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
        console.log('mqtt: connected')
        for (const topic of subscription.subscriptions) {
            mqttClient.subscribe(topic, { qos: 1 }, (err, granted) => {
                if (err) console.error('mqtt: subscribe error', topic, err)
            })
        }
    })

    mqttClient.on('error', (err) => console.error('mqtt: error', err))
    mqttClient.on('close', () => console.log('mqtt: close'))
    mqttClient.on('reconnect', () => console.log('mqtt: reconnect'))
    mqttClient.on('offline', () => console.log('mqtt: offline'))
    return mqttClient
}

async function run(countryCode: string) {
    let subscription: Subscription | undefined
    let clientId: string | undefined
    try {
        subscription = JSON.parse(fs.readFileSync(SUBSCRIPTION_JSON).toString('utf-8')) as Subscription
        clientId = subscription.clientId
    } catch (err) {}

    const client = new Client({ countryCode }, clientId)
    let refreshToken = ''
    try {
        ;({ refreshToken } = JSON.parse(fs.readFileSync(OAUTH_JSON).toString('utf-8')))
    } catch (err) {}

    if (!refreshToken) {
        refreshToken = await oauth2SignIn(client)
        fs.writeFileSync(OAUTH_JSON, JSON.stringify({ refreshToken }))
    }

    await client.auth(refreshToken)

    if (!subscription) {
        subscription = await generateSubscription(client)
        fs.writeFileSync(SUBSCRIPTION_JSON, JSON.stringify(subscription))
    }

    const mqttClient = await openMQTT(client, subscription)
    mqttClient.on('message', (topic, payload) => {
        console.log('mqtt: message topic=', topic)
        try {
            const obj = JSON.parse(payload.toString('utf-8'))
            console.log(JSON.stringify(obj, null, 2))
        } catch {
            console.log('(non-json payload, hex):', payload.toString('hex'))
        }
    })
}

if (process.argv.length !== 3) usage()

let countryCode = process.argv[2]

if (!countryCode.match(/[A-Z]{2}/)) {
    usage()
}

run(countryCode)

function usage() {
    console.warn(
        `Usage: tsx lgcloud-monitor.ts <CC>
    <CC> is a 2-letter country code matching your Thinq account
`,
    )
    process.exit()
}
