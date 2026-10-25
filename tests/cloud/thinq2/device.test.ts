import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Broker } from '@/cloud/mqtt-broker'
import { Device, DeviceAcceptor, deployMetadata } from '@/cloud/thinq2/device'
import type { ClipDeployMessage, DeployAppInfo } from '@/cloud/thinq2/clip'

function deploy(appInfo: Partial<DeployAppInfo>): ClipDeployMessage {
    return {
        mid: 1,
        did: 'device-id',
        kind: '2REBGLUB_2P__',
        cmd: 'deploy',
        type: 0,
        data: { appInfo: appInfo as DeployAppInfo, platformInfo: undefined },
    }
}

describe('deployMetadata', () => {
    test('uses softVer when the modem reports it', () => {
        const meta = deployMetadata(
            deploy({ modelName: 'M', softVer: '1.2.3', appVersion: 'clip_x', DeviceType: '101' }),
        )
        assert.deepEqual(meta, { modelId: '2REBGLUB_2P__', modelName: 'M', swVersion: '1.2.3', deviceType: '101' })
    })

    // captured from a 2REBGLUB_2P__ (GBBSJ2CCEP) deploy message
    test('falls back to appVersion when softVer is empty', () => {
        const meta = deployMetadata(
            deploy({ modelName: '2REBGLUB_2P__', softVer: '', appVersion: 'clip_bkn_v1.9.238', DeviceType: '101' }),
        )
        assert.equal(meta.swVersion, 'clip_bkn_v1.9.238')
    })
})
// Captured from a DLEX4200B on 2026-10-04. Device ID, SSID, BSSID, IP,
// boot ID and local server hostname are anonymized; other fields are unchanged.
const DEPLOY_CAPTURE: ClipDeployMessage = JSON.parse(
    '{"mid":432279,"did":"11111111-2222-3333-4444-555555555555","kind":"RV13D5JSD_D_US","cmd":"deploy","rssi":-61,"fs":"idle","br":4800,"pper":0,"data":{"appInfo":{"rollbackInfo":{"area_b":"clip_hna_v1.9.237","active":"area_b","area_a":"clip_hna_v1.9.229"},"modelName":"RV13D5JSD_D_US","modelLanguage":"02","softVer":"2.10.119","ruleVer":"2.10.119","countryCode":"US","subCountryCode":"US","appVersion":"clip_hna_v1.9.237","modemType":"RTK_RTL8711am","regionalCode":"aic","timezone":"-0500","svcCode":"SVC202","HomeApSsid":"test-network","DeviceType":"202","ruleEngine":"y","protocolVer":"7","oneshot":"y","size":1572864,"fwUpgradeInfo":{"upgSched":{"cmd":"none","upgUtc":"0"}},"modemConfig":{"online_check":"y","device_status":"y","boot_img_size":"1E540000"}},"platformInfo":{"provisioningKey":"RV13D5JSD_D_US","version":"clip_v2.00.15.05-SDK-8-RELEASE"},"extraProfile":{"resetDetails":{"reason":"POWER_ON","cnt":2},"bootId":"10000000000000000000","WifiReport":{"disconType":2,"disconReason":32,"wifiCnt":1,"wifiTime":431,"mqttCnt":2,"mqttTime":388,"bootTime":432,"liveCnt":87,"nACnt":0,"nBCnt":0,"nICnt":0,"nSCnt":0,"ssid":"test-network","bssid":"02:00:00:00:00:01","devAddr":"192.0.2.64","rssi":-61,"per":-1,"ch":11,"fs":"idle","heap":814024,"subErr":"W002"},"profiling":[{"st":14,"n":"PREF_wlan_connect_thread","s":1015,"e":3504,"d":2489,"c":1},{"st":16,"n":"PERF_association","s":1944,"e":3609,"d":1665,"c":1},{"st":17,"n":"PERF_4wayhs","s":3609,"e":3635,"d":26,"c":1},{"st":18,"n":"PERF_dhcp","s":3644,"e":4186,"d":542,"c":1},{"st":30,"n":"PERF_mqtt","s":429368,"e":432159,"d":2791,"c":2},{"st":31,"n":"PERF_cloudlet","s":7812,"e":8031,"d":219,"c":1},{"st":33,"n":"PERF_provisioning","s":432160,"e":7813,"d":118,"c":2}],"cctld":"","cctld_result":-79,"api-server":"https://rethink.example.invalid:443","mqtt-server":"ssl://rethink.example.invalid:8883","https-server":"","check_mfota_distYn":"N","check_mfota_period":4294967295,"check_mfota_offset":4294967295}},"type":0}',
)

// Status message from the same session; only the device ID is anonymized.
const STATUS_CAPTURE = {
    mid: 433182,
    did: DEPLOY_CAPTURE.did,
    kind: 'RV13D5JSD_D_US',
    cmd: 'device_packet',
    rssi: -60,
    fs: 'idle',
    br: 4800,
    pper: 0,
    data: 'AA2330EB001B010001000100000000000400000040A800000000000000CA000000E9BB',
    type: 1,
}
const deviceId = DEPLOY_CAPTURE.did

function connectDevice() {
    const acceptor = new DeviceAcceptor(new Broker())
    const client = {} as any
    let device: Device | undefined

    acceptor.once('newDevice', (newDevice) => (device = newDevice))
    acceptor.mqtt(`clip/provisioning/devices/${deviceId}`, structuredClone(DEPLOY_CAPTURE), client)

    assert.ok(device)
    return { acceptor, client, device }
}

describe('ThinQ2 device identity', () => {
    test('delivers the captured status message after captured provisioning', () => {
        const { acceptor, client, device } = connectDevice()
        let received: Buffer | undefined
        device.once('data', (data) => (received = data))

        acceptor.mqtt(`clip/message/devices/${deviceId}`, { ...STATUS_CAPTURE }, client)

        assert.deepEqual(received, Buffer.from(STATUS_CAPTURE.data, 'hex'))
    })

    test('accepts a malformed payload id from the provisioned device topic', () => {
        const { acceptor, client, device } = connectDevice()
        let received: Buffer | undefined
        device.once('data', (data) => (received = data))

        // Deliberate synthetic mutation of the captured message's ID.
        acceptor.mqtt(`clip/message/devices/${deviceId}`, { ...STATUS_CAPTURE, did: deviceId.slice(1) }, client)

        assert.deepEqual(received, Buffer.from(STATUS_CAPTURE.data, 'hex'))
    })

    test('rejects a wrong topic even when the payload id matches', () => {
        const { acceptor, client, device } = connectDevice()
        let received = false
        device.once('data', () => (received = true))

        // Deliberate synthetic topic mismatch.
        acceptor.mqtt('clip/message/devices/some-other-device', { ...STATUS_CAPTURE }, client)

        assert.equal(received, false)
    })

    test('rejects a wrong topic with a mismatched payload id', () => {
        const { acceptor, client, device } = connectDevice()
        let received = false
        device.once('data', () => (received = true))

        // Deliberate synthetic topic and payload-ID mismatches.
        acceptor.mqtt('clip/message/devices/some-other-device', { ...STATUS_CAPTURE, did: 'another-device' }, client)

        assert.equal(received, false)
    })
})
