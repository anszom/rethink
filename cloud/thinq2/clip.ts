export type ClipPayload<Cmd = string, Payload = unknown> = {
    cmd: Cmd
    data: Payload
    type: number
}

// cloud->device
export type ClipTxMessage<Cmd = string, Payload = unknown> = ClipPayload<Cmd, Payload> & {
    mid: number
    did: string
}

// device->cloud
export type ClipRxMessage<Cmd = string, Payload = unknown> = ClipTxMessage<Cmd, Payload> & {
    kind: string
    rssi?: number
    fs?: string
}

// Only the fields we name and rely on. A real deploy carries more; the bridge forwards the parsed
// object upstream as it came, so the extras ride along whether or not they appear here.
export type DeployAppInfo = {
    modelName: string
    modelLanguage: string
    softVer: string
    ruleVer: string
    countryCode: string
    subCountryCode: string
    appVersion: string
    modemType: string
    regionalCode: string
    timezone: string
    svcCode: string
    HomeApSsid: string
    DeviceType: string
    // decides how the cloud frames its reservation polls
    protocolVer?: string
    ruleEngine?: string
    oneshot?: string
    size?: number
    fwUpgradeInfo?: unknown
    packageId?: string
}

// Older firmware supposedly doesn't send this at all, so absence is part of the type: the key is
// forwarded upstream missing rather than invented.
export type DeployPlatformInfo =
    | undefined
    | {
          provisioningKey?: string
          version?: string
      }

export type DeployPayload = {
    appInfo: DeployAppInfo
    platformInfo: DeployPlatformInfo
}

export type ClipDeployMessage = ClipRxMessage<'preDeploy' | 'deploy', DeployPayload>

export function txPacket(data: Buffer) {
    return customPayload('packet', 1, data.toString('hex').toUpperCase())
}

export function txAck(data: Buffer) {
    return customPayload('ack', 1, data.toString('hex').toUpperCase())
}

export function rxPacket(data: Buffer) {
    return customPayload('device_packet', 1, data.toString('hex').toUpperCase())
}

export function customPayload(cmd: string, type: number, data: unknown): ClipPayload {
    return { cmd, type, data }
}

export function fromRxPacket(packet: ClipPayload) {
    if (packet.cmd === 'device_packet' && typeof packet.data === 'string') return Buffer.from(packet.data, 'hex')
}

export function fromTxPacket(packet: ClipPayload) {
    if (packet.cmd === 'packet' && typeof packet.data === 'string') return Buffer.from(packet.data, 'hex')
}

export function format(packet: ClipPayload) {
    if (packet.cmd === 'packet' || packet.cmd === 'device_packet' || packet.cmd === 'ack')
        return `${packet.cmd}:${packet.type}:${packet.data}`

    return JSON.stringify(packet)
}
