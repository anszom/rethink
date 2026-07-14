export type RawConfig = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port | number
    mqtts_port: Port | number
    mqtt_port: Port | number
    management_port?: Port | number
    thinq1_https_port?: Port | number
    thinq1_port?: Port | number
    mqtt?: boolean
    bridge?: {
        storage_path: string
    }
    log?: string[]
}

export type Config = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port
    mqtts_port: Port
    mqtt_port: Port
    management_port?: Port
    thinq1_https_port: Port
    thinq1_port: Port
    mqtt: boolean
    bridge?: {
        storage_path: string
    }
    log: string[]
}

export type HAConfig = {
    mqtt_url: string
    discovery_prefix: string
    rethink_prefix: string
    mqtt_user: string
    mqtt_pass: string
}

export type CA = {
    key: string
    cert: string
}

export type Port = {
    bind: number
    advertise: number
}

function parsePort(port: Port | number): Port
function parsePort(port: Port | number | undefined): Port | undefined
function parsePort(port: Port | number | undefined): Port | undefined {
    return typeof port === 'number' ? { bind: port, advertise: port } : port
}

export function normalize(config: RawConfig): Config {
    return {
        log: ['status', 'incoming', 'HTTPS'],
        mqtt: true,
        ...config,
        https_port: parsePort(config.https_port),
        mqtts_port: parsePort(config.mqtts_port),
        mqtt_port: parsePort(config.mqtt_port),
        management_port: parsePort(config.management_port),
        thinq1_https_port: parsePort(config.thinq1_https_port ?? 46030),
        thinq1_port: parsePort(config.thinq1_port ?? 47878),
    }
}
