import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deployMetadata } from '@/cloud/thinq2/device'
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
