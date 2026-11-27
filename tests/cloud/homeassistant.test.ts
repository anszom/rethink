import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brokerTlsOptions } from '@/cloud/homeassistant'
import { HAConfig } from '@/util/config'

describe('brokerTlsOptions', () => {
    let dir: string
    const base: HAConfig = {
        mqtt_url: 'mqtts://10.0.0.5:8883',
        discovery_prefix: 'homeassistant',
        rethink_prefix: 'rethink',
        mqtt_user: '',
        mqtt_pass: '',
    }
    const write = (name: string, content: string) => {
        const p = join(dir, name)
        writeFileSync(p, content)
        return p
    }

    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-mqtt-tls-'))
    })
    after(() => rmSync(dir, { recursive: true, force: true }))

    test('nothing configured adds nothing to the connection', () => {
        assert.deepEqual(brokerTlsOptions(base), {})
    })

    test('a CA alone is enough, for a broker that only needs verifying', () => {
        const options = brokerTlsOptions({ ...base, mqtt_ca_file: write('ca.crt', 'CA') })
        assert.deepEqual(Object.keys(options), ['ca'])
        assert.equal(options.ca?.toString(), 'CA')
    })

    test('a client certificate and its key are read from their files', () => {
        const options = brokerTlsOptions({
            ...base,
            mqtt_ca_file: write('ca.crt', 'CA'),
            mqtt_cert_file: write('client.crt', 'CERT'),
            mqtt_key_file: write('client.key', 'KEY'),
        })
        assert.equal(options.ca?.toString(), 'CA')
        assert.equal(options.cert?.toString(), 'CERT')
        assert.equal(options.key?.toString(), 'KEY')
    })

    test('a certificate without its key, or a key without its certificate, is refused', () => {
        assert.throws(() => brokerTlsOptions({ ...base, mqtt_cert_file: write('only.crt', 'CERT') }), /set together/)
        assert.throws(() => brokerTlsOptions({ ...base, mqtt_key_file: write('only.key', 'KEY') }), /set together/)
    })
})
