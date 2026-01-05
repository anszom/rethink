import HADevice from './base.js'
import { Device as ClipDevice } from "../devmgr.js"
import { DeviceDiscovery, type Connection } from '../homeassistant.js'
import { ClipDeployMessage } from '../../util/clip.js'
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'
import { convertFreezerTemperature, convertFridgeTemperature, freezerRange, fridgeRange, TemperatureUnit } from './fridge_common.js'

const FLEX_OPTIONS = [ 'Chilled Wine', 'Deli/Snacks', 'Cold Drink', 'Meat/Seafood', 'Freezer' ]

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

	constructor(HA: Connection, clipDevice: ClipDevice, provisionMsg: ClipDeployMessage) {
		super(HA, 'device', clipDevice)
        this.deviceConfig = HADevice.deviceConfig(provisionMsg, { name: "LG Fridge" })

        // HomeAssistant configuration will be ready once we find out the temperature unit
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if(this.temperatureUnit === unit)
            return

        this.temperatureUnit = unit
        // set or re-set the temperature unit
        this.setConfig(allowExtendedType({
            ...this.deviceConfig,
            components: {
                "fridge_setpoint": {
                    platform: "number",
                    device_class: "temperature",
                    unique_id: '$deviceid-fridge_setpoint',
                    state_topic: '$this/fridge_setpoint',
                    command_topic: '$this/fridge_setpoint/set',
                    name: 'Fridge temperature',
                    ...fridgeRange(unit)
                },
                "freezer_setpoint": {
                    platform: "number",
                    device_class: "temperature",
                    unique_id: '$deviceid-freezer_setpoint',
                    state_topic: '$this/freezer_setpoint',
                    command_topic: '$this/freezer_setpoint/set',
                    name: 'Freezer temperature',
                    ...freezerRange(unit)
                },
                "flex_setpoint": {
                    platform: "select",
                    //device_class: "temperature",
                    icon: "mdi:thermometer",
                    unique_id: '$deviceid-flex_setpoint',
                    state_topic: '$this/flex_setpoint',
                    command_topic: '$this/flex_setpoint/set',
                    name: 'Convertible',
                    options: FLEX_OPTIONS
                },
                "door": {
                    platform: "binary_sensor",
                    device_class: "door",
                    unique_id: '$deviceid-door',
                    state_topic: '$this/door',
                    name: "Door"
                }
            }
        }))
	}

	query() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // I'm not sure what is the proper way to identify packet types, so let's match
        // on the length and a few initial bytes

        if(buf.length === 2 + 68 * 2 && buf[0] == 0x10 && buf[1] == 0xEC) {
            // 10EC (prev status) (cur status)
            this.processStatus(buf.subarray(2 + 68, 2+68+68))
        }

        if(buf.length === 2 + 68 && buf[0] == 0x10 && buf[1] == 0xEB) {
            // 10EB (initial status)
            this.processStatus(buf.subarray(2, 2+68+68))
        }
    }

    processStatus(curStatus: Buffer) {
        // status block example:
        // 0209060202020400000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000101FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000
        const unit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const setpointFridge = convertFridgeTemperature(unit, curStatus[1])
        const setpointFreezer = convertFreezerTemperature(unit, curStatus[2])
        const icePlus = curStatus[3] // 1=off 2=on
        const smartGrid = curStatus[5] // 0=off 1=? 2=on
        const anyDoorOpen = curStatus[7]
        const panelLock = curStatus[10] // 2=locked 1=unlocked
        const setpointFlex = curStatus[13] // 1 - chilled wine. 2 - deli/snacks. 3 - cold drink. 4 - meat/seafood. 5 - freezer
        const iceDoor = curStatus[32] // 0=off 1=on 2=full
        const iceCube = curStatus[33] // 0=off 1=on 2=full

        this.publishProperty('door', anyDoorOpen ? 'ON' : 'OFF')
        this.publishProperty('fridge_setpoint', setpointFridge)
        this.publishProperty('freezer_setpoint', setpointFreezer)
        this.publishProperty('flex_setpoint', FLEX_OPTIONS[setpointFlex-1])
    }

    //  0                   1                   2                   3                   4                   5                   6                   7                   8                   9                  10
    //  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4
    // express freeze off
    // AA69F017FFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBCBB
    // fridge 38F
    // AA69F017FF06FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBABB
    // fridge 36F
    // AA69F017FF08FFFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA4BB
    // freezer -7F
    // AA69F017FFFF0DFFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA3BB
    // freezer +5F
    // AA69F017FFFF01FFFFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB
    // convertible freezer
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF05FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBBBB
    // convertible wine=41
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF01FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBFBB
    // convertible deli=37
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF02FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFBEBB
    // convertible meat/seafood=30
    // AA69F017FFFFFFFFFFFFFFFF00FFFFFFFF04FFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFB8BB
    setProperty(prop: string, mqttValue: string) {
        const baseMessage = Buffer.from("F017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0AFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "hex")
        baseMessage[2+8] = this.temperatureUnit === 'C' ? 1 : 0

        if(prop === 'fridge_setpoint') {
            baseMessage[2+1] = convertFridgeTemperature(this.temperatureUnit, Number(mqttValue))
            this.send(baseMessage)

        } else if(prop === 'freezer_setpoint') {
            baseMessage[2+2] = convertFreezerTemperature(this.temperatureUnit, Number(mqttValue))
            this.send(baseMessage)

        } else if(prop === 'flex_setpoint') {
            const index = FLEX_OPTIONS.indexOf(mqttValue)
            if(index < 0)
                console.warn(`Unexpected value ${mqttValue}`)
            else {
                baseMessage[2+13] = 1 + index
                this.send(baseMessage)
            }
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}