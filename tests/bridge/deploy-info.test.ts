import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deployInfo } from '@/bridge/thinq2connection'
import { Thinq2Device, type Thinq2DeviceState } from '@/bridge/thinqApi'
import type { Metadata } from '@/cloud/thinq'

const DEVICE_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
const META: Metadata = { modelId: 'CST_570004_WW', modelName: 'CST_570004_WW', swVersion: '249003' }

// What a real appliance reports, cut down to the fields that matter here.
const LIVE_APP_INFO = { modelName: 'CST_570004_WW', softVer: '249003', protocolVer: '7' }
const LIVE_PLATFORM_INFO = { provisioningKey: 'CST_570004_WW', version: 'clip_v2.00.20.01-RTK_RTL8720cm' }
const REGISTERED_APP_INFO = { modelName: 'CST_570004_WW', softVer: '248001', protocolVer: '7' }
const REGISTERED_PLATFORM_INFO = { provisioningKey: 'CST_570004_WW', version: 'clip_v2.00.19.00-RTK_RTL8720cm' }

function device(state: Partial<Thinq2DeviceState> = {}) {
    return new Thinq2Device(DEVICE_ID, META, {
        countryCode: 'KR',
        apiServer: 'https://example.invalid',
        mqttServer: 'ssl://example.invalid:8883',
        caCertificate: '',
        privateKey: '',
        certificate: '',
        pubTopic: 'pub',
        provTopic: 'prov',
        subTopic: 'sub',
        ...state,
    })
}

describe('deployInfo', () => {
    test('reports what the appliance says right now', () => {
        const info = deployInfo(device(), LIVE_APP_INFO, LIVE_PLATFORM_INFO)

        assert.deepEqual(info.appInfo, LIVE_APP_INFO)
        assert.deepEqual(info.platformInfo, LIVE_PLATFORM_INFO)
    })

    test('prefers what it says now over what it said at registration', () => {
        const state = { deployAppInfo: REGISTERED_APP_INFO, deployPlatformInfo: REGISTERED_PLATFORM_INFO }
        const info = deployInfo(device(state), LIVE_APP_INFO, LIVE_PLATFORM_INFO)

        assert.deepEqual(info.appInfo, LIVE_APP_INFO)
        assert.deepEqual(info.platformInfo, LIVE_PLATFORM_INFO)
    })

    test('falls back to what it said at registration', () => {
        // The window this covers: rethink has restarted and the appliance has not deployed to us
        // again yet, so there is nothing live to report.
        const state = { deployAppInfo: REGISTERED_APP_INFO, deployPlatformInfo: REGISTERED_PLATFORM_INFO }
        const info = deployInfo(device(state))

        assert.deepEqual(info.appInfo, REGISTERED_APP_INFO)
        assert.deepEqual(info.platformInfo, REGISTERED_PLATFORM_INFO)
    })

    test('a state written before any of this was recorded behaves as it did before', () => {
        const info = deployInfo(device())

        // The placeholders describe an HNA device, not the appliance. protocolVer '1' is the one
        // that mattered: it made the cloud frame its reservation polls in an encoding a
        // protocolVer 7 firmware ignores. Kept unchanged so an old state is not altered by an
        // upgrade - it is corrected as soon as the appliance deploys again.
        assert.equal((info.appInfo as Record<string, unknown>).protocolVer, '1')
        assert.equal((info.appInfo as Record<string, unknown>).modemType, 'RTK_RTL8711am')
        assert.equal((info.appInfo as Record<string, unknown>).modelName, META.modelName)
        assert.equal(
            (info.platformInfo as Record<string, unknown>).version,
            'clip_v2.00.15.05-RTK_RTL8711am-SDK-8-RELEASE',
        )
    })

    test('the two halves fall back independently', () => {
        // A deploy carrying appInfo but no platformInfo is what the older firmware sends.
        const info = deployInfo(device({ deployPlatformInfo: REGISTERED_PLATFORM_INFO }), LIVE_APP_INFO)

        assert.deepEqual(info.appInfo, LIVE_APP_INFO)
        assert.deepEqual(info.platformInfo, REGISTERED_PLATFORM_INFO)
    })
})
