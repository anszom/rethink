import { ListenOptions } from 'node:net'

export type RawConfig = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    http_port?: PortDefinition
    https_port?: PortDefinition
    mqtts_port?: PortDefinition
    mqtt_port?: PortDefinition
    management_port?: PortDefinition
    thinq1_http_port?: PortDefinition
    thinq1_https_port?: PortDefinition
    thinq1_port?: PortDefinition
    mqtt?: boolean
    bridge?: {
        storage_path: string
    }
    log?: string[]
}

export type PortDefinition =
    | number
    | {
          bind?: number
          advertise?: number | string
          address?: string
      }

export type Config = {
    hostname: string
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    http_port: Port
    https_port: AdvertisedPort
    mqtts_port: AdvertisedPort
    mqtt_port: Port
    management_port: Port
    thinq1_http_port: Port
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
    bind?: ListenOptions
}

export type AdvertisedPort = Port & {
    advertise_url: string
}

function parsePort(input: PortDefinition | undefined): Port {
    const result: Port = {}
    if (input === undefined) return result

    if (typeof input === 'number') {
        result.bind = { port: input }
        return result
    }

    if ('bind' in input && input.bind) result.bind = { port: input.bind, host: input.address ?? undefined }
    return result
}

function parseAdvertisedPort(input: PortDefinition | undefined, urlBase: string, label: string): AdvertisedPort {
    const result = parsePort(input) as AdvertisedPort
    if (typeof input === 'object' && 'advertise' in input) {
        if (typeof input.advertise === 'string') result.advertise_url = input.advertise
        else result.advertise_url = urlBase + ':' + input.advertise
    } else if (result.bind?.port !== undefined) {
        result.advertise_url = urlBase + ':' + result.bind.port
    } else throw new Error(`The ${label} port must be advertised`)

    return result
}

export function normalize(config: RawConfig): Config {
    return {
        log: ['status', 'incoming', 'HTTPS'],
        mqtt: true,
        ...config,
        http_port: parsePort(config.http_port),
        https_port: parseAdvertisedPort(config.https_port, `https://${config.hostname}`, 'https'),
        mqtts_port: parseAdvertisedPort(config.mqtts_port, `ssl://${config.hostname}`, 'mqtts'),
        mqtt_port: parsePort(config.mqtt_port),
        management_port: parsePort(config.management_port),
        thinq1_http_port: parsePort(config.thinq1_http_port),
        thinq1_https_port: parsePort(config.thinq1_https_port ?? 46030),
        thinq1_port: parsePort(config.thinq1_port ?? 47878),
    }
}
