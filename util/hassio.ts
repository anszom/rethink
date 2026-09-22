import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fetch from 'node-fetch'
import stripJsonComments from 'strip-json-comments'
import { PortDefinition, RawConfig } from './config'
import log from './logging'

// The Home Assistant Supervisor writes the add-on options to a JSON file in the
// container. The add-on manifest points RETHINK_HASSIO_OPTIONS at it, and that
// variable is what selects add-on mode in rethink-cloud.

// Rendered on every start, as a starting point for users who want to switch to a
// hand-written configuration file via the config_file option.
export const HASSIO_EXAMPLE = 'config.jsonc.example'

// User-facing options, as defined by the schema in the add-on manifest, which lives
// in the separate rethink-ha add-on repository. Everything is optional here; the
// defaults below have to stay in step with the ones declared there.
type Options = {
    hostname?: string
    discovery_prefix?: string
    rethink_prefix?: string
    mqtt_url?: string
    mqtt_user?: string
    mqtt_pass?: string
    https_advertise?: string
    mqtts_advertise?: string
    custom_root_cert_file?: string
    config_file?: string
    bridge_dns?: string[]
    log?: string[]
}

// DoH by IP address, like the example configuration file: the ThinQ names are redirected to
// this host, and the bridge has to get past that to reach the LG cloud.
const DEFAULT_BRIDGE_DNS = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query']

type MqttService = {
    data?: { host?: string; port?: number; ssl?: boolean; username?: string; password?: string }
}

// Resolve the MQTT broker: an explicit URL wins, otherwise ask the Supervisor for the
// Home Assistant MQTT service. There is nothing sensible to fall back to - the container
// has no broker of its own - so failing here beats starting up unable to publish anything.
async function resolveMqtt(opts: Options): Promise<{ url: string; user: string; pass: string }> {
    if (opts.mqtt_url) return { url: opts.mqtt_url, user: opts.mqtt_user ?? '', pass: opts.mqtt_pass ?? '' }

    // The Supervisor only knows about brokers published by another add-on. One that
    // was configured directly in the MQTT integration is not visible here, so the
    // user has to point mqtt_url at it.
    const token = process.env.SUPERVISOR_TOKEN
    if (token) {
        try {
            const resp = await fetch('http://supervisor/services/mqtt', {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (resp.ok) {
                const { data } = (await resp.json()) as MqttService
                if (data?.host && data?.port)
                    return {
                        url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port}`,
                        user: data.username ?? '',
                        pass: data.password ?? '',
                    }
            }
        } catch (err) {
            log('status', 'Could not ask the Supervisor for the MQTT service:', err)
        }
    }

    throw new Error(
        'No MQTT broker available: the Supervisor did not provide one. Install an MQTT broker add-on, ' +
            'or set the mqtt_url option to point at your own broker.',
    )
}

// The container always binds the default ports and the Supervisor maps them to the
// host side, so only the advertised value is configurable here. It is needed when
// that mapping is not 1:1, or when the appliances reach rethink through a proxy.
function port(bind: number, advertise: string | undefined): PortDefinition {
    if (!advertise) return bind
    return { bind, advertise: /^[0-9]+$/.test(advertise) ? Number(advertise) : advertise }
}

// The paths are written out already resolved, so that a hand-written copy of this
// file keeps using the add-on data directory for whatever the user does not override.
function writeExample(config: RawConfig, configDir: string) {
    const example: RawConfig = {
        ...config,
        ca_key_file: resolve(configDir, config.ca_key_file),
        ca_cert_file: resolve(configDir, config.ca_cert_file),
    }
    if (config.custom_root_cert_file) example.custom_root_cert_file = resolve(configDir, config.custom_root_cert_file)
    if (config.bridge)
        example.bridge = { ...config.bridge, storage_path: resolve(configDir, config.bridge.storage_path) }

    const path = resolve(configDir, HASSIO_EXAMPLE)
    try {
        writeFileSync(path, JSON.stringify(example, null, 4) + '\n')
    } catch (err) {
        log('status', `Could not write ${path}:`, err)
    }
}

// Build a RawConfig from the add-on options, or read the file that config_file
// points at. Relative paths are resolved against configDir by the caller.
export async function loadHassioConfig(configDir: string, optionsPath: string): Promise<RawConfig> {
    const opts = JSON.parse(readFileSync(optionsPath).toString('utf-8')) as Options

    if (opts.config_file) {
        const path = resolve(configDir, opts.config_file)
        log('status', `Ignoring the add-on options, reading the configuration from ${path}`)
        return JSON.parse(stripJsonComments(readFileSync(path).toString('utf-8'))) as RawConfig
    }

    const mqtt = await resolveMqtt(opts)

    const config: RawConfig = {
        hostname: opts.hostname ?? 'rethink.lan',
        homeassistant: {
            mqtt_url: mqtt.url,
            discovery_prefix: opts.discovery_prefix ?? 'homeassistant',
            rethink_prefix: opts.rethink_prefix ?? 'rethink',
            mqtt_user: mqtt.user,
            mqtt_pass: mqtt.pass,
        },
        ca_key_file: 'ca.key',
        ca_cert_file: 'ca.cert',
        custom_root_cert_file: opts.custom_root_cert_file || undefined,
        https_port: port(443, opts.https_advertise),
        mqtts_port: port(8883, opts.mqtts_advertise),
        mqtt_port: 1884,
        management_port: 44401,
        // Bridge mode stays inert until an LG account is linked in the management panel,
        // so it costs nothing to always have the storage ready.
        // An empty list selects the system resolver
        bridge: { storage_path: 'state', dns: opts.bridge_dns ?? DEFAULT_BRIDGE_DNS },
        log: opts.log ?? ['status', 'incoming', 'HTTPS', 'publish', 'MGMT'],
    }

    writeExample(config, configDir)
    return config
}
