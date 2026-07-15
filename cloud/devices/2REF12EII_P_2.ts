import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { convertFreezerTemperature, convertFridgeTemperature, freezerRange, fridgeRange } from './fridge_common'

// 2REF12EII_P_2 - LG ThinQ Refrigerator (Skeleton implementation)
// TODO: Replace with actual byte offsets and logic after performing a capture.
// This template is based on the 2REF11EBIVPC4 implementation.

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        ...fridgeRange('C'),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        ...freezerRange('C'),
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    // TODO: Add other components like express_freeze or shabbat_mode if discovered in capture
                },
            }),
        )
    }

    start() {
        // TODO: Implement startup query if the device requires it (e.g., fetching initial state)
    }

    processAABB(buf: Buffer) {
        // TODO: Replace with actual buffer length checks and command IDs for this model.
        // Example logic from 2REF11EBIVPC4 (Check if it uses 10EC/10EB):
        if (buf.length === 2 + 43 * 2 && buf[0] == 0x10 && buf[1] == 0xec) {
            // 10EC: [prev status 43 bytes] [cur status 43 bytes]
            this.processStatus(buf.subarray(2 + 43, 2 + 43 + 43))
        }
        if (buf.length === 2 + 43 && buf[0] == 0x10 && buf[1] == 0xeb) {
            // 10EB: [initial status 43 bytes]
            this.processStatus(buf.subarray(2, 2 + 43))
        }
    }

    processStatus(curStatus: Buffer) {
        // TODO: Replace these with actual byte offsets and formulas derived from your capture!
        // Example logic (do not rely on this without verification):
        const setpointFridge = (13 - curStatus[1]) / 2
        const setpointFreezer = -(curStatus[2] + 29) / 2
        const anyDoorOpen = curStatus[7] === 1 // 0=closed, 1=open

        this.publishProperty('door', anyDoorOpen ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
    }

    setProperty(prop: string, mqttValue: string) {
        // TODO: Replace with the actual hex payload structure for this model.
        // This is currently a placeholder from 2REF11EBIVPC4.
        const baseMessage = Buffer.from(
            'F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
            'hex',
        )

        if (prop === 'fridge_setpoint') {
            baseMessage[2 + 1] = convertFridgeTemperature('C', Number(mqttValue))
            baseMessage[2 + 8] = 1
            this.send(baseMessage)
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
