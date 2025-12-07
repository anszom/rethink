import { createHash, publicEncrypt, randomBytes } from 'node:crypto';
import * as OAuth2 from './oauth2.js'
import { RSA_PKCS1_PADDING } from 'node:constants';
import { subprocess } from './util.js';
import fetch, { type RequestInit } from 'node-fetch';

const IOT_BASE_URL = 'https://common.lgthinq.com'
const GATEWAY_URL = 'https://route.lgthinq.com:46030/v1/service/application/gateway-uri'

export function signInUrl(baseUrl: string, countryCode: string) {
    const url = new URL(baseUrl + "signin")
    url.searchParams.set("callback_url", "https://kr.m.lgaccount.com/login/iabClose");
    url.searchParams.set("redirect_url", "https://kr.m.lgaccount.com/login/iabClose");
    url.searchParams.set("client_id", "LGAO221A02");
    url.searchParams.set("country", countryCode);
    url.searchParams.set("language", "en");
    url.searchParams.set("svc_integrated", "Y");
    url.searchParams.set("state", "signin");
    url.searchParams.set("svc_code", "SVC202");
    return url;
}

export async function apiFetch<T = unknown>(url: string, options: RequestInit): Promise<T> {
	let out: { resultCode: string, result: T }
	for(let i=0;;i++) {
		try {
			const resp = await fetch(url, {
                ...options,
                headers: {
                    ...(options.headers ?? {}),
                    "x-message-id": randomBytes(16).toString('hex'),
                }
            })
			out = await resp.json() as { resultCode: string, result: T }
			break;

		} catch(err) {
			if(i>=3)
				throw err;
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
	}

	if(out.resultCode !== '0000') {
		console.log(url, options, out)
		throw new RemoteError(url, out.resultCode, out.result)
	}

	return out.result
}

export class RemoteError extends Error {
    constructor(readonly url: string, readonly resultCode: string, readonly result: unknown) {
        super(ErrorStrings[resultCode] ?? `Unknown thinq error ${resultCode}`)
    }
}

type GatewayResponse = {
    thinq2Uri: string;
    uris: {
        empOauthBaseUri: string;
        empFrontBaseUri2: string;
    }
}

type ProfileResponse = {
    status: number,
    account: {
        userID: string,
        userNo: string,
    }
}

type HomesResponse = {
    item: {
        homeId: string,
        currentHomeYn: "Y"|"N"
    }[]
}

type HomeResponse = {
    homeId: string,
    devices: {
        deviceId: string,
        deviceType: number,
        modelName: string,
        alias: string,
        snapshot: unknown,
        online: boolean,
    }[]
}

type OtpResponse = { otp: string, publicKey: string }

export type Environment = {
    countryCode: string,
}

export class Client {
    headers: Record<string,string> = {
        "content-type": "application/json;charset=UTF-8",
        "accept": "application/json",
        "x-thinq-app-ver": "4.1.5000",
        "x-thinq-app-type": "NUTS",
        "x-thinq-app-level": "PRD",
        "x-thinq-app-os": "ANDROID",
        "x-service-code": "SVC202",
        // x-country-code
        // x-language-code
        "x-service-phase": "OP",
        "x-client-id": "988fb08af011479f04d91bfd24c80771697fd416697c036114c995b6ad09f5b6",
        "x-origin": "app-web-ANDROID",
        "x-thinq-app-logintype": "LGE",
        // x-user-no
        // x-emp-token
        "x-api-key": "VGhpblEyLjAgU0VSVklDRQ==",
    }

    gateway: Promise<GatewayResponse>
    homeId: string | undefined

    constructor(readonly env: Environment) {
        this.headers['x-country-code'] = env.countryCode
        this.headers["x-language-code"] = "en-" + env.countryCode,

        this.gateway = apiFetch<GatewayResponse>(GATEWAY_URL, { headers: this.headers })
    }

    async getUrls() {
        const gw = await this.gateway
        return {
            webUrl: gw.uris.empFrontBaseUri2,
            authUrl: gw.uris.empOauthBaseUri
        }
    }

    async auth(refreshToken: string) {
        const { thinq2Uri, uris: { empOauthBaseUri: authUrl } }  = (await this.gateway)
        const { accessToken } = await OAuth2.refresh(authUrl, refreshToken)

        const profile = await OAuth2.signedRequest<ProfileResponse>(authUrl + '/users/profile', {
            'Authorization': `Bearer ${accessToken}`,
            'X-Device-Type': 'M01',
            'X-Device-Platform': 'ADR',
        });

        if(profile.status !== 1) {
            console.log(profile)
            throw new Error("Can't query user information");
        }

        console.log(`Welcome ${profile.account.userID}!`)

        this.headers['x-user-no'] = profile.account.userNo
        this.headers['x-emp-token'] = accessToken

        // I'm not sure what this call means, but without it, the otp/certificate call returns "access denied"
        await apiFetch(`${thinq2Uri}/service/users/client`, { headers: { ...this.headers, 'x-device-type': '601' }, method: 'POST' })

        const { item: homes } = await apiFetch<HomesResponse>(`${thinq2Uri}/service/homes`, { headers: this.headers })
        for(const home of homes) {
            if(home.currentHomeYn === 'Y')
                this.homeId = home.homeId
        }
    }

    async listDevices() {
        if(!this.homeId)
            throw new Error("Current home is not set")

        const { thinq2Uri }  = (await this.gateway)
        const home = await apiFetch<HomeResponse>(`${thinq2Uri}/service/homes/${this.homeId}`, { headers: this.headers })
    	return home.devices
    }

    async removeDevice(deviceId: string) {
        if(!this.homeId)
            throw new Error("Current home is not set")

        const { thinq2Uri }  = (await this.gateway)
        try {
            await apiFetch(`${thinq2Uri}/service/homes/${this.homeId}/devices/delete`, { headers: this.headers, method: 'POST', body: JSON.stringify({
			    homeId: this.homeId, item: [ { deviceId } ]
		    })})
        } catch(err) {
            if(err instanceof RemoteError && err.resultCode === ErrorCodes.ERROR_NO_REGISTERED_DEVICES)
                return; // no such device
            
            throw err;
        }
    }

    async prepareNewDevice() {
        const { thinq2Uri }  = (await this.gateway)
        return await apiFetch<OtpResponse>(`${thinq2Uri}/service/devices/otp/certificate`, { headers: this.headers, body: '{}', method: 'POST'})
    }

    // setting initDevice to true allows the device to be removed from the current account, but it triggers a failure if the device is not currently registered
    async addDevice(device: Device, alias: string, ciphertext: Buffer) {
        if(!this.homeId)
            throw new Error("Current home is not set")

        const { thinq2Uri }  = (await this.gateway)
        const body = {
            deviceId: device.deviceId,
            countryCode: this.env.countryCode,
            deviceType: device.deviceType,
            modelName: device.modelName,
            aliasPrefix: alias,
            platformType: "thinq2",
            ciphertext: ciphertext.toString('base64'),
            initDevice: false
        }

        try {
            await apiFetch(`${thinq2Uri}/service/homes/${this.homeId}/devices`, { headers: this.headers, method: 'POST', body: JSON.stringify(body)})   
        } catch (err) {
            if(err instanceof RemoteError && err.resultCode === ErrorCodes.ERROR_ALREADY_DEVICES_REGISTERED_IN_HOME) {
                console.log('Device already registered, retrying with initDevice=true')
                body.initDevice = true
                await apiFetch(`${thinq2Uri}/service/homes/${this.homeId}/devices`, { headers: this.headers, method: 'POST', body: JSON.stringify(body)})   
            } else {
                throw err;
            }
        }
    }

    async getDeviceStatus(deviceId: string) {
        const { thinq2Uri }  = (await this.gateway)
        return await apiFetch(`${thinq2Uri}/service/devices/${deviceId}`, { headers: this.headers })
    }
}

type RouteResponse = { apiServer: string, mqttServer: string }
type RouteCertResponse = {certificatePem: string}
type CertResponse = {
	certificatePem: string;
	publication: {
		message: string;
		provisioning: string;
		control: string;
		service: {
			appliance: string;
			appupdate: string;
		}
	},
	subscription: {
		message: string;
		service: {
			appliance: string;
			appupdate: string;
		}
	}
}

export type DeviceState = {
    apiServer: string;
    mqttServer: string;
    caCertificate: string;
    privateKey: string;
    certificate: string;
    pubTopic: string;
    provTopic: string;
    subTopic: string;
}

export class Device {
    nonce = randomBytes(8)
    state: DeviceState | undefined

    constructor(
        readonly env: Environment,
        readonly deviceId: string,
        readonly deviceType: string,
        readonly modelName: string,
        state?: DeviceState,
    )
    {
        this.state = state
    }

    async pair(otpResponse: OtpResponse): Promise<Buffer> {
        console.log('Fetching API urls')
        const servers = await apiFetch<RouteResponse>(`${IOT_BASE_URL}/route`, { headers: { 'x-country-code': this.env.countryCode, 'x-service-phase': 'OP', accept: 'application/json'}})

        console.log('Fetching CA cert')
        // DEV call
        const { certificatePem: ca } = await apiFetch<RouteCertResponse>(`${IOT_BASE_URL}/route/certificate?name=aws-iot`, { headers: { accept: 'application/json'}})

        console.log('Trying to generate a certificate with otp', otpResponse.otp)

        const privateKey = await subprocess('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-noout', '-out', '-'])
        const publicKey = await subprocess('openssl', ['ec', '-pubout', '-out', '-'], privateKey)

        // we need to involve `cat`, because:
        // 1. openssl req can't read the private key from stdin directly
        // 2. nodejs passes a socket into the subprocess' stdin
        // 3. opening a socket via /dev/stdin doesn't work on Linux
        const csr = await subprocess('bash', ['-c', `cat | openssl req -new -key /dev/stdin -subj '/CN=*.clip.com/O=LGE/C=KR'`], privateKey)

        const ciphertext = publicEncrypt({key: otpResponse.publicKey, padding: RSA_PKCS1_PADDING}, Buffer.concat([
            this.nonce, 
            Buffer.from(otpResponse.otp, 'utf-8'), 
            createHash('sha256').update(this.deviceId).digest(),
            createHash('sha256').update(csr).digest(),
            createHash('sha256').update(publicKey).digest()
        ]))

        const deviceConfig = await apiFetch<CertResponse>(`${servers.apiServer}/device/${this.deviceId}/certificate`, {
            method: 'POST',
            headers: { 'x-provide-type': 'immediate', 'Content-type': 'application/json' },
            body: JSON.stringify({
                otp: otpResponse.otp,
                csr: csr,
                publickey: publicKey,
                ciphertext: ciphertext.toString('base64')
            })
        });

        this.state = {
            ...servers,
            caCertificate: ca,
            privateKey,
            certificate: deviceConfig.certificatePem,
            pubTopic: deviceConfig.publication.message,
            provTopic: deviceConfig.publication.provisioning,
            subTopic: deviceConfig.subscription.message
        }

        return publicEncrypt({key: otpResponse.publicKey, padding: RSA_PKCS1_PADDING}, Buffer.concat([
            this.nonce,
            createHash('sha256').update(this.deviceId).digest()
        ]))
    }
}

export const ErrorStrings = {
    "0000": "SUCCESS_OK", 
    "0004": "ERROR_DUPLICATED_LOGIN", 
    "0007": "ERROR_NO_SERVICE", 
    "0008": "ERROR_EXIST_DUPLICATED_DATA", 
    "0009": "ERROR_NO_DEVICES", 
    "0010": "ERROR_NO_DATA", 
    "0011": "ERROR_NO_PERMISSIONS", 
    "0101": "ERROR_NO_REGISTERED_DEVICES", // or "ERROR_DELETED_PRODUCT", 
    "0102": "ERROR_FAILED_LOGIN", 
    "0018": "ERROR_ANOTHER_USER_IN_USE", 
    "0110": "ERROR_DISAGREED_TERMS", 
    "0112": "ERROR_MAXIMUM_ROOM", 
    "0125": "ERROR_ALREADY_DEVICES_REGISTERED_IN_HOME", 
    "0128": "ERROR_UPDATING_FOTA", 
    "0129": "ERROR_MANAGER_NO_PERMISSIONS", 
    "9016": "ERROR_DUPLICATED_REQUEST", 
    "9995": "ERROR_NO_INTERNET", 
    "9996": "ERROR_NO_DOCUMENT", 
    "9997": "ERROR_NO_COLLECTION", 
    "9998": "ERROR_NO_USER", 
    "9999": "ERROR_UNKNOWN", 
}

export const ErrorCodes = {
    "SUCCESS_OK": "0000",
    "ERROR_DUPLICATED_LOGIN": "0004",
    "ERROR_NO_SERVICE": "0007",
    "ERROR_EXIST_DUPLICATED_DATA": "0008",
    "ERROR_NO_DEVICES": "0009",
    "ERROR_NO_DATA": "0010",
    "ERROR_NO_PERMISSIONS": "0011",
    "ERROR_NO_REGISTERED_DEVICES": "0101",
    "ERROR_DELETED_PRODUCT": "0101",
    "ERROR_FAILED_LOGIN": "0102",
    "ERROR_ANOTHER_USER_IN_USE": "0018",
    "ERROR_DISAGREED_TERMS": "0110",
    "ERROR_MAXIMUM_ROOM": "0112",
    "ERROR_ALREADY_DEVICES_REGISTERED_IN_HOME": "0125",
    "ERROR_UPDATING_FOTA": "0128",
    "ERROR_MANAGER_NO_PERMISSIONS": "0129",
    "ERROR_DUPLICATED_REQUEST": "9016",
    "ERROR_NO_INTERNET": "9995",
    "ERROR_NO_DOCUMENT": "9996",
    "ERROR_NO_COLLECTION": "9997",
    "ERROR_NO_USER": "9998",
    "ERROR_UNKNOWN": "9999",
}