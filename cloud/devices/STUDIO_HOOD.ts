import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG STUDIO_HOOD range hood (thinq2 deviceType 304).
//
// Reverse engineered by capturing live wire traffic while cycling the light
// (off -> level 1 -> level 2 -> off) and the fan (off -> speed 1..5 -> off).
//
// toDevice status query (sent once on connect, see start()):
//   F0 ED 11 41 01 00 00 00 18 04 03 04 00 00
//   the device replies with a 43 EB initial-status frame (see below) - without
//   sending this, the device won't push its current status, so newly
//   (re)connected sessions see stale/incorrect state in Home Assistant until
//   some other event happens to trigger a delta report.
//
// toDevice set command, 9-byte inner body:
//   F0 43 22 05 [FanFlag] [FanSpeed] [LightFlag] [LightLevel] 00
//     FanFlag/LightFlag: 01 = that control is on, 00 = off
//     FanSpeed: 0-5, LightLevel: 0-2
//   The device appears to want the FULL desired combined state on every
//   command (not just the changed field) - e.g. setting the light while the
//   fan is off still sends FanFlag/FanSpeed = 00 00, and the dedicated "off"
//   command (00 00 00 00) reliably turns off whichever control was active.
//   examples:
//     light -> level 1:  F04322050000010100
//     light -> level 2:  F04322050000010200
//     light -> off:      F04322050000000000
//     fan -> speed 3:    F04322050103000000
//     fan -> off:        F04322050000000000
//
// fromDevice state report, 26-byte inner body:
//   43 EC [previous state: 12 bytes] [current state: 12 bytes]
//   each 12-byte state block:
//     [0]     power flag (01 = fan or light active, 00 = both off)
//     [1]     fan speed (0-5)
//     [2]     04 when fan active, 00 otherwise (mode/type tag)
//     [3-4]   reserved, always 00 observed
//     [5]     light level (0-2)
//     [6-10]  reserved, always 00 observed
//     [11]    07 constant
//   every set command also gets an immediate generic ack first: 43 00 43 00
//     (no state info, safe to ignore)
//
// fromDevice initial status, 14-byte inner body (reply to the F0ED11 query):
//   43 EB [current state: 12 bytes]  - same 12-byte block layout as above,
//   just without the "previous state" half since there's no transition to
//   report.

export default class Device extends AABBDevice {
    // locally tracked desired state, kept in sync with the device's own
    // reports so unrelated set commands (e.g. changing fan speed) don't
    // accidentally clobber the other control
    fanSpeed = 0
    lightLevel = 0

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Range Hood' }),
                components: {
                    fan_power: {
                        platform: 'fan',
                        unique_id: '$deviceid-fan',
                        state_topic: '$this/fan_power',
                        command_topic: '$this/fan_power/set',
                        // NB: despite the "percentage" naming, HA's MQTT fan integration
                        // publishes/expects raw device-native speed values here (1-5) once
                        // speed_range_min/max are declared, not a literal 0-100 percentage -
                        // HA does the percent<->raw conversion internally for the UI slider.
                        percentage_state_topic: '$this/fan_speed',
                        percentage_command_topic: '$this/fan_speed/set',
                        speed_range_min: 1,
                        speed_range_max: 5,
                        name: 'Fan',
                        icon: 'mdi:fan',
                    },
                    light_power: {
                        platform: 'light',
                        unique_id: '$deviceid-light',
                        state_topic: '$this/light_power',
                        command_topic: '$this/light_power/set',
                        brightness_state_topic: '$this/light_level',
                        brightness_command_topic: '$this/light_level/set',
                        brightness_scale: 2,
                        name: 'Light',
                        icon: 'mdi:lightbulb',
                    },
                },
            }),
        )
    }

    start() {
        this.send(Buffer.from('f0ed114101000000180403040000', 'hex'))
    }

    processAABB(buf: Buffer) {
        // generic command ack, no state - ignore
        if (buf.length === 4 && buf[0] === 0x43 && buf[1] === 0x00) return

        // 43 EB (initial status, reply to the start() query) - single state block
        if (buf.length === 14 && buf[0] === 0x43 && buf[1] === 0xeb) {
            this.processStatus(buf.subarray(2, 14))
            return
        }

        // 43 EC (previous state) (current state)
        if (buf.length === 26 && buf[0] === 0x43 && buf[1] === 0xec) {
            this.processStatus(buf.subarray(14, 26))
        }
    }

    processStatus(cur: Buffer) {
        const fanSpeed = cur[1]
        const lightLevel = cur[5]

        // keep our locally tracked desired state in sync, so a set command
        // for one control doesn't stomp on the other control's last known
        // value (e.g. physical panel changes, or app control from elsewhere)
        this.fanSpeed = fanSpeed
        this.lightLevel = lightLevel

        this.publishProperty('fan_power', fanSpeed > 0 ? 'ON' : 'OFF')
        this.publishProperty('fan_speed', fanSpeed)
        this.publishProperty('light_power', lightLevel > 0 ? 'ON' : 'OFF')
        this.publishProperty('light_level', lightLevel)
    }

    sendCommand() {
        this.send(
            Buffer.from([
                0xf0,
                0x43,
                0x22,
                0x05,
                this.fanSpeed > 0 ? 1 : 0,
                this.fanSpeed,
                this.lightLevel > 0 ? 1 : 0,
                this.lightLevel,
                0x00,
            ]),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fan_power') {
            this.fanSpeed = mqttValue === 'ON' ? this.fanSpeed || 1 : 0
            this.sendCommand()
        } else if (prop === 'fan_speed') {
            this.fanSpeed = Math.min(5, Math.max(0, Math.round(Number(mqttValue))))
            this.sendCommand()
        } else if (prop === 'light_power') {
            this.lightLevel = mqttValue === 'ON' ? this.lightLevel || 1 : 0
            this.sendCommand()
        } else if (prop === 'light_level') {
            this.lightLevel = Math.min(2, Math.max(0, Number(mqttValue)))
            this.sendCommand()
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
