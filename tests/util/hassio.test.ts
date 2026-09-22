import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHassioConfig, HASSIO_EXAMPLE } from '@/util/hassio'
import { RawConfig } from '@/util/config'

describe('loadHassioConfig', () => {
    let dir: string
    const write = (name: string, obj: unknown) => {
        const p = join(dir, name)
        writeFileSync(p, JSON.stringify(obj))
        return p
    }
    const readExample = () => JSON.parse(readFileSync(join(dir, HASSIO_EXAMPLE)).toString('utf-8')) as RawConfig
    // Without a broker from either the options or the Supervisor, loading fails outright,
    // so every test that is about something else has to supply one.
    const broker = { mqtt_url: 'mqtt://10.0.0.5:1883' }

    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-hassio-'))
        // Make sure the Supervisor lookup is never attempted in these tests.
        delete process.env.SUPERVISOR_TOKEN
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    test('an explicit mqtt_url is used verbatim', async () => {
        const path = write('explicit.json', {
            hostname: 'my.lan',
            mqtt_url: 'mqtt://10.0.0.5:1883',
            mqtt_user: 'u',
            mqtt_pass: 'p',
            log: ['status', 'all'],
        })
        const c = await loadHassioConfig(dir, path)

        assert.equal(c.hostname, 'my.lan')
        assert.equal(c.homeassistant.mqtt_url, 'mqtt://10.0.0.5:1883')
        assert.equal(c.homeassistant.mqtt_user, 'u')
        assert.equal(c.homeassistant.mqtt_pass, 'p')
        assert.equal(c.https_port, 443)
        assert.equal(c.mqtts_port, 8883) // default applied
        assert.equal(c.management_port, 44401)
        assert.equal(c.bridge?.storage_path, 'state')
        assert.deepEqual(c.log, ['status', 'all'])
    })

    test('no broker from the options or the Supervisor is a hard failure', async () => {
        const path = write('nobroker.json', {})
        await assert.rejects(loadHassioConfig(dir, path), /No MQTT broker available/)
    })

    test('empty options fall back to defaults', async () => {
        const path = write('empty.json', broker)
        const c = await loadHassioConfig(dir, path)

        assert.equal(c.hostname, 'rethink.lan')
        assert.equal(c.homeassistant.discovery_prefix, 'homeassistant')
        assert.equal(c.homeassistant.rethink_prefix, 'rethink')
        assert.equal(c.thinq1_https_port, undefined)
        assert.equal(c.thinq1_port, undefined)
        assert.equal(c.custom_root_cert_file, undefined)
        // Bridge mode is always set up in add-on mode, with no option to turn it off
        assert.deepEqual(c.bridge, {
            storage_path: 'state',
            dns: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
        })
        assert.deepEqual(c.log, ['status', 'incoming', 'HTTPS', 'publish', 'MGMT'])
    })

    test('bridge DNS servers are taken verbatim, an empty list included', async () => {
        for (const bridge_dns of [['192.168.1.1', 'https://9.9.9.9/dns-query'], []]) {
            const c = await loadHassioConfig(dir, write('bridge-dns.json', { ...broker, bridge_dns }))
            assert.deepEqual(c.bridge?.dns, bridge_dns)
        }
    })

    test('an advertised port is taken as a number, anything else as a verbatim URL', async () => {
        const path = write('advertise.json', {
            ...broker,
            https_advertise: '443',
            mqtts_advertise: 'ssl://proxy.lan:8883',
        })
        const c = await loadHassioConfig(dir, path)

        assert.deepEqual(c.https_port, { bind: 443, advertise: 443 })
        assert.deepEqual(c.mqtts_port, { bind: 8883, advertise: 'ssl://proxy.lan:8883' })
    })

    test('the rendered example carries paths resolved against the data directory', async () => {
        const path = write('example.json', broker)
        await loadHassioConfig(dir, path)
        const example = readExample()

        assert.equal(example.ca_key_file, join(dir, 'ca.key'))
        assert.equal(example.ca_cert_file, join(dir, 'ca.cert'))
        assert.deepEqual(example.bridge, {
            storage_path: join(dir, 'state'),
            dns: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
        })
    })

    test('a custom root certificate is passed through, and resolved in the example', async () => {
        const path = write('root-cert.json', { ...broker, custom_root_cert_file: 'proxy-root.pem' })
        const c = await loadHassioConfig(dir, path)

        assert.equal(c.custom_root_cert_file, 'proxy-root.pem')
        assert.equal(readExample().custom_root_cert_file, join(dir, 'proxy-root.pem'))
    })

    test('config_file wins over the options and is read relative to the data directory', async () => {
        writeFileSync(
            join(dir, 'custom.jsonc'),
            '{ /* hand-written */ "hostname": "custom.lan", "https_port": { "bind": 4443, "advertise": 443 } }',
        )
        const path = write('custom-options.json', { hostname: 'ignored.lan', config_file: 'custom.jsonc' })
        const c = await loadHassioConfig(dir, path)

        assert.equal(c.hostname, 'custom.lan')
        assert.deepEqual(c.https_port, { bind: 4443, advertise: 443 })
    })
})
