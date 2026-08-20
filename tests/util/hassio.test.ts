import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHassioConfig } from '@/util/hassio'

describe('loadHassioConfig', () => {
    let dir: string
    const write = (name: string, obj: unknown) => {
        const p = join(dir, name)
        writeFileSync(p, JSON.stringify(obj))
        return p
    }

    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-hassio-'))
        // Make sure the Supervisor lookup is never attempted in these tests.
        delete process.env.SUPERVISOR_TOKEN
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    test('an explicit mqtt_url is used verbatim and bridge maps to a state dir', async () => {
        const path = write('explicit.json', {
            hostname: 'my.lan',
            bridge: true,
            mqtt_url: 'mqtt://10.0.0.5:1883',
            mqtt_user: 'u',
            mqtt_pass: 'p',
            log: ['status', 'all'],
        })
        const c = await loadHassioConfig(path)

        assert.equal(c.hostname, 'my.lan')
        assert.equal(c.homeassistant.mqtt_url, 'mqtt://10.0.0.5:1883')
        assert.equal(c.homeassistant.mqtt_user, 'u')
        assert.equal(c.homeassistant.mqtt_pass, 'p')
        assert.equal(c.https_port, 443)
        assert.equal(c.mqtts_port, 8883) // default applied
        assert.equal(c.management_port, 44401)
        assert.deepEqual(c.bridge, { storage_path: 'state' })
        assert.deepEqual(c.log, ['status', 'all'])
    })

    test('empty options fall back to defaults and a localhost broker, with no bridge', async () => {
        const path = write('empty.json', {})
        const c = await loadHassioConfig(path)

        assert.equal(c.hostname, 'rethink.lan')
        assert.equal(c.homeassistant.mqtt_url, 'mqtt://localhost:1883')
        assert.equal(c.homeassistant.discovery_prefix, 'homeassistant')
        assert.equal(c.homeassistant.rethink_prefix, 'rethink')
        assert.equal(c.advertise_requested_host, false)
        assert.equal(c.thinq1_https_port, undefined)
        assert.equal(c.thinq1_port, undefined)
        assert.equal(c.bridge, undefined)
        assert.deepEqual(c.log, ['status', 'incoming', 'HTTPS', 'publish', 'MGMT'])
    })
})
