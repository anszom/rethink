export type Config = {
    hostname: string,
    homeassistant: HAConfig,
    ca_key_file: string,
    ca_cert_file: string,
    https_port: number,
    mqtts_port: number,
    mqtt_port: number,
    thinq1_https_port?: number,
	thinq1_port?: number,
    mqtt?: boolean,
    log?: string[]
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
