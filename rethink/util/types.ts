export type Config = {
    hostname: string,
    homeassistant: HAConfig,
    ca_key_file: string,
    ca_cert_file: string,
    https_port: number,
    mqtts_port: number,
    mqtt_port: number,
    mqtt?: boolean,
};

export type HAConfig = {
    mqtt_url: string,
    discovery_prefix: string,
    rethink_prefix: string,
    mqtt_user: string,
    mqtt_pass: string,
}

export type CA = {
    key: string;
    cert: string;
}

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