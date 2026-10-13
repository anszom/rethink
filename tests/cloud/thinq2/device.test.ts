import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Broker } from '@/cloud/mqtt-broker'
import { Device, DeviceAcceptor } from '@/cloud/thinq2/device'

const deviceId = 'c5f4dc9d-451e-10e5-90ba-acf108caf1c3'
const malformedDeviceId = 'c5f4dc9-451e-10e5-90ba-acf108caf1c3'

function connectDevice() {
    const acceptor = new DeviceAcceptor(new Broker())
    const client = {}
    let device: Device | undefined

    acceptor.once('newDevice', (newDevice) => (device = newDevice))
    acceptor.mqtt(
        `clip/provisioning/devices/${deviceId}`,
        {
            did: deviceId,
            kind: 'RV13D5JSD_D_US',
            cmd: 'preDeploy',
            data: {
                appInfo: {
                    modelName: 'RV13D5JSD_D_US',
                    softVer: '2.10.119',
                    DeviceType: '202',
                },
            },
        } as never,
        client as never,
    )

    assert.ok(device)
    return { acceptor, client, device }
}

describe('ThinQ2 device identity', () => {
    it('accepts a malformed payload id from the provisioned device topic', () => {
        const { acceptor, client, device } = connectDevice()
        let received: Buffer | undefined
        device.once('data', (data) => (received = data))

        acceptor.mqtt(
            `clip/message/devices/${deviceId}`,
            {
                did: malformedDeviceId,
                cmd: 'device_packet',
                data: 'AA2330EB001B',
            } as never,
            client as never,
        )

        assert.equal(received?.toString('hex'), 'aa2330eb001b')
    })

    it('rejects a packet when neither identity source matches the provisioned device', () => {
        const { acceptor, client, device } = connectDevice()
        let received = false
        device.once('data', () => (received = true))

        acceptor.mqtt(
            'clip/message/devices/some-other-device',
            {
                did: 'another-device',
                cmd: 'device_packet',
                data: 'AA2330EB001B',
            } as never,
            client as never,
        )

        assert.equal(received, false)
    })
})
