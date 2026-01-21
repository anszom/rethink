export type ClipMessage<Cmd = string, Payload = unknown> = {
    mid: number,
    did: string,
    kind: string,
    cmd: Cmd,
    rssi?: number,
    fs?: string,
    data: Payload,
    type: number
}

export type DeployPayload = {
    appInfo: {
        modelName: string,
        modelLanguage: string,
        softVer: string,
        ruleVer: string,
        countryCode: string,
        subCountryCode: string,
        appVersion: string,
        modemType: string,
        regionalCode: string,
        timezone: string,
        svcCode: string,
        HomeApSsid: string,
        DeviceType: string,
        // and some other fields yadda yadda
    }
}

export type ClipDeployMessage = ClipMessage<"preDeploy"|"deploy", DeployPayload>