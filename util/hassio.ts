import { readFileSync } from 'node:fs'
import fetch from 'node-fetch'
import { RawConfig } from './config'

// The Home Assistant Supervisor writes the add-on options to /data/options.json
// and mounts the persistent data volume at /data. The presence of the options
// file is what marks "add-on mode" in rethink-cloud.
export const HASSIO_OPTIONS = '/data/options.json'

// User-facing options as defined by the add-on schema (config.yaml). Everything
// is optional here; sensible defaults are applied below.
type Options = {
    hostname?: string
    discovery_prefix?: string
    rethink_prefix?: string
    bridge?: boolean
    mqtt_url?: string
    mqtt_user?: string
    mqtt_pass?: string
    log?: string[]
}

type MqttService = {
    data?: { host?: string; port?: number; username?: string; password?: string }
}

// Resolve the MQTT broker: an explicit URL wins, otherwise ask the Supervisor
// for the Home Assistant MQTT service, otherwise fall back to localhost.
async function resolveMqtt(opts: Options): Promise<{ url: string; user: string; pass: string }> {
    if (opts.mqtt_url) return { url: opts.mqtt_url, user: opts.mqtt_user ?? '', pass: opts.mqtt_pass ?? '' }

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
                        url: `mqtt://${data.host}:${data.port}`,
                        user: data.username ?? '',
                        pass: data.password ?? '',
                    }
            }
        } catch {
            // Supervisor unreachable or MQTT service not provided: use the fallback.
        }
    }

    return { url: 'mqtt://localhost:1883', user: opts.mqtt_user ?? '', pass: opts.mqtt_pass ?? '' }
}

// Build a RawConfig from the add-on options. File paths (ca_*, storage_path)
// are left relative and resolved against HASSIO_DATA by the caller.
export async function loadHassioConfig(optionsPath: string = HASSIO_OPTIONS): Promise<RawConfig> {
    const opts = JSON.parse(readFileSync(optionsPath).toString('utf-8')) as Options
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
        https_port: 443,
        mqtts_port: 8883,
        mqtt_port: 1884,
        management_port: 44401,
        log: opts.log ?? ['status', 'incoming', 'HTTPS', 'publish', 'MGMT'],
    }

    if (opts.bridge) config.bridge = { storage_path: 'state' }
    return config
}
