export type ClipMessage<Cmd = string, Payload = unknown> = {
    mid: number
    did: string
    kind: string
    cmd: Cmd
    rssi?: number
    fs?: string
    data: Payload
    type: number
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

export type ClipDeployMessage = ClipMessage<'preDeploy' | 'deploy', DeployPayload>
