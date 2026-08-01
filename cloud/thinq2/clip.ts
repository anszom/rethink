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

export type DeployPayload = {
    appInfo: {
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
        protocolVer?: string
        // and some other fields yadda yadda
        [key: string]: unknown
    }
    // present in real device deploys alongside appInfo; carries provisioningKey/version
    platformInfo?: { provisioningKey?: string; version?: string; [key: string]: unknown }
    // boot/wifi diagnostics the device tacks on; we don't forward these upstream
    [key: string]: unknown
}

export type ClipDeployMessage = ClipMessage<'preDeploy' | 'deploy', DeployPayload>
