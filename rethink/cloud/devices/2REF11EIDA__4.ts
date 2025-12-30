import HADevice from './base.js'
import { Device as ClipDevice } from "../devmgr.js"
import { type Connection } from '../homeassistant.js'
import { ClipDeployMessage } from '../../util/clip.js'
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'

const FLEX_OPTIONS = [ 'Chilled Wine', 'Deli/Snacks', 'Cold Drink', 'Meat/Seafood', 'Freezer' ]

export default class Device extends AABBDevice {
	constructor(HA: Connection, clipDevice: ClipDevice, provisionMsg: ClipDeployMessage) {
		super(HA, 'device', allowExtendedType({
            ...HADevice.deviceConfig(provisionMsg, { name: "LG Fridge" }),
            components: {
                "fridge_setpoint": {
                    platform: "number",
                    device_class: "temperature",
                    unique_id: '$deviceid-fridge_setpoint',
                    state_topic: '$this/fridge_setpoint',
                    command_topic: '$this/fridge_setpoint/set',
                    name: 'Fridge temperature',
                    unit_of_measurement: '°F',
                    min: 33,
                    max: 43,
                },
                "freezer_setpoint": {
                    platform: "number",
                    device_class: "temperature",
                    unique_id: '$deviceid-freezer_setpoint',
                    state_topic: '$this/freezer_setpoint',
                    command_topic: '$this/freezer_setpoint/set',
                    name: 'Freezer temperature',
                    unit_of_measurement: '°F',
                    min: -7,
                    max: 5
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
        }), clipDevice)
	}

	query() {
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        // I'm not sure what is the proper way to identify packet types, so let's match
        // on the length and a few initial bytes
        if(buf.length === 138 && buf[0] == 0x10 && buf[1] == 0xEC) {
            // main status message, example:
            // 10EC0209060202020400000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000102FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF00000209060202020400000001FFFF0300FFFF00FFFFFFFFFFFFFF020001010100000101FF6161FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000
            const anyDoorOpen = buf[77] // ['F]
            const setpointFridge = 44 - buf[71] // ['F]
            const setpointFreezer = 6 - buf[72] // ['F]
            const setpointFlex = buf[83] // 1 - chilled wine. 2 - deli/snacks. 3 - cold drink. 4 - meat/seafood. 5 - freezer
            console.log(anyDoorOpen, setpointFreezer, setpointFlex, setpointFridge)
            
            this.publishProperty('door', anyDoorOpen ? 'ON' : 'OFF')
            this.publishProperty('fridge_setpoint', setpointFridge)
            this.publishProperty('freezer_setpoint', setpointFreezer)
            this.publishProperty('flex_setpoint', FLEX_OPTIONS[setpointFlex-1])
            
            const icePlus = buf[73] // 1=off 2=on
            const iceCube = buf[103] // 0=off 1=on 2=full
            const iceDoor = buf[102] // 0=off 1=on 2=full
            const smartGrid = buf[75] // 0=off 1=? 2=on
            const panelLock = buf[80] // 2=locked 1=unlocked
        }
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
        if(prop === 'fridge_setpoint') {
            baseMessage[3] = 44 - Number(mqttValue)
            this.send(baseMessage)

        } else if(prop === 'freezer_setpoint') {
            baseMessage[4] = 6 - Number(mqttValue)
            this.send(baseMessage)

        } else if(prop === 'flex_setpoint') {
            const index = FLEX_OPTIONS.indexOf(mqttValue)
            if(index < 0)
                console.warn(`Unexpected value ${mqttValue}`)
            else {
                baseMessage[15] = 1 + index
                this.send(baseMessage)
            }
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}