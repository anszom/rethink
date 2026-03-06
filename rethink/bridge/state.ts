import { Environment, Thinq1DeviceState, Thinq2DeviceState } from "./thinqApi.js"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"

export type Credentials = {
    refreshToken: string
    env: Environment
}

export type BridgeState = {
    getCredentials(): Credentials | undefined
    setCredentials(credentials: Credentials | undefined)
    getDeviceState(id: string): Thinq1DeviceState|Thinq2DeviceState|undefined
    setDeviceState(id: string, state:Thinq1DeviceState|Thinq2DeviceState|undefined)
}

export class JSONStorage implements BridgeState {
    constructor(readonly basePath: string) {}

    oauth2Path() {
        return `${this.basePath}/oauth2.json`
    }

    devicePath(id: string) {
        return `${this.basePath}/device_${id}.json`
    }

    getCredentials() {
        try {
            return JSON.parse(readFileSync(this.oauth2Path()).toString('utf-8')) as Credentials
        } catch(err) {
            return undefined
        }
    }

    setCredentials(credentials: Credentials | undefined) {
        if(credentials)
            writeFileSync(this.oauth2Path(), JSON.stringify(credentials))
        else
            unlinkSync(this.oauth2Path())
    }

    getDeviceState(id: string) {
        try {
            return JSON.parse(readFileSync(this.devicePath(id)).toString('utf-8')) as Thinq1DeviceState|Thinq2DeviceState
        } catch(err) {
            return undefined
        }
    }

    setDeviceState(id: string, state: Thinq1DeviceState | Thinq2DeviceState | undefined) {
        if(state)
            writeFileSync(this.devicePath(id), JSON.stringify(state))
        else
            unlinkSync(this.devicePath(id))
    }
}