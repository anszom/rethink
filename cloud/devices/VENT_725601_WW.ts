import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

export default class VENT_725601_WW extends TLVDevice {
    initialValuesReceived = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const deviceName = '\uD658\uAE30'

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: deviceName }),
            components: {
                fan: {
                    platform: 'fan',
                    unique_id: '$deviceid-fan',
                    name: null,
                    state_topic: '$this/fan-power',
                    command_topic: '$this/fan-power/set',
                    percentage_state_topic: '$this/fan-speed',
                    percentage_command_topic: '$this/fan-speed/set',
                    speed_range_min: 1,
                    speed_range_max: 3,
                    preset_mode_state_topic: '$this/fan-mode',
                    preset_mode_command_topic: '$this/fan-mode/set',
                    preset_modes: ['ventilation', 'auto', 'bypass', 'saving'],
                    icon: 'mdi:hvac',
                },
                temp_indoor: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-indoor',
                    name: 'Indoor temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_indoor',
                },
                temp_exhaust: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-exhaust',
                    name: 'Exhaust temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_exhaust',
                },
                temp_outdoor: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-outdoor',
                    name: 'Outdoor temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_outdoor',
                },
                air_quality: {
                    platform: 'sensor',
                    unique_id: '$deviceid-air-quality',
                    name: 'Air quality',
                    state_topic: '$this/sensor-air_quality',
                    icon: 'mdi:air-filter',
                },
            },
        })

        // 0x1f7: Power (0 = OFF, 1 = ON)
        this.addField(
            config,
            {
                id: 0x1f7,
                name: 'power',
                comp: 'fan',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
            },
            false,
        )

        // 0x1fa: Fan speed (raw 2 = 약, 4 = 중, 6 = 강)
        this.addField(
            config,
            {
                id: 0x1fa,
                name: 'speed',
                comp: 'fan',
                read_xform: (raw) => {
                    if (raw <= 2) return 1
                    if (raw <= 4) return 2
                    return 3
                },
                write_xform: (val) => {
                    const n = Number(val)
                    if (n === 1) return 2
                    if (n === 2) return 4
                    return 6
                },
            },
            false,
        )

        // 0x1f9: Mode (0 = ventilation, 1 = auto, 2 = bypass, 3 = saving)
        this.addField(
            config,
            {
                id: 0x1f9,
                name: 'mode',
                comp: 'fan',
                read_xform: (raw) => {
                    const modes: Record<number, string> = {
                        0: 'ventilation',
                        1: 'auto',
                        2: 'bypass',
                        3: 'saving',
                    }
                    return modes[raw] ?? 'auto'
                },
                write_xform: (val) => {
                    const modes: Record<string, number> = {
                        ventilation: 0,
                        auto: 1,
                        bypass: 2,
                        saving: 3,
                    }
                    return modes[String(val).toLowerCase()] ?? 0
                },
            },
            false,
        )

        // Temperatures
        this.addField(
            config,
            {
                id: 0x34c,
                name: 'temp_indoor',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw,
            },
            false,
        )

        this.addField(
            config,
            {
                id: 0x34b,
                name: 'temp_exhaust',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw,
            },
            false,
        )

        this.addField(
            config,
            {
                id: 0x34a,
                name: 'temp_outdoor',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw,
            },
            false,
        )

        this.addField(
            config,
            {
                id: 0x334,
                name: 'air_quality',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw,
            },
            false,
        )

        this.setConfig(config)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fan-power') {
            if (mqttValue === 'ON') {
                this.raw_clip_state[0x1f7] = 1
                if (!this.raw_clip_state[0x1fa] || this.raw_clip_state[0x1fa] <= 0) {
                    this.raw_clip_state[0x1fa] = 2 // default to 약 (level 1)
                }
                if (this.raw_clip_state[0x1f9] === undefined) {
                    this.raw_clip_state[0x1f9] = 1 // default to auto
                }
                this.send(
                    [1, 1, 2, 1, 1],
                    [
                        { t: 0x1f7, v: 1 },
                        { t: 0x1f9, v: this.raw_clip_state[0x1f9] },
                        { t: 0x1fa, v: this.raw_clip_state[0x1fa] },
                    ],
                )
                this.publishProperty('fan-power', 'ON')
                const speedLvl = this.raw_clip_state[0x1fa] <= 2 ? 1 : this.raw_clip_state[0x1fa] <= 4 ? 2 : 3
                this.publishProperty('fan-speed', speedLvl)
            } else {
                this.raw_clip_state[0x1f7] = 0
                this.send([1, 1, 2, 1, 1], [{ t: 0x1f7, v: 0 }])
                this.publishProperty('fan-power', 'OFF')
            }
        } else if (prop === 'fan-speed') {
            const num = Math.round(Number(mqttValue))
            if (num <= 0) {
                // User chose 0 / 꺼짐
                this.raw_clip_state[0x1f7] = 0
                this.send([1, 1, 2, 1, 1], [{ t: 0x1f7, v: 0 }])
                this.publishProperty('fan-power', 'OFF')
            } else {
                const rawSpeed = num === 1 ? 2 : num === 2 ? 4 : 6
                this.raw_clip_state[0x1fa] = rawSpeed
                this.raw_clip_state[0x1f7] = 1 // Ensure power turns on
                if (this.raw_clip_state[0x1f9] === undefined) {
                    this.raw_clip_state[0x1f9] = 1
                }
                this.send(
                    [1, 1, 2, 1, 1],
                    [
                        { t: 0x1f7, v: 1 },
                        { t: 0x1fa, v: rawSpeed },
                        { t: 0x1f9, v: this.raw_clip_state[0x1f9] },
                    ],
                )
                this.publishProperty('fan-power', 'ON')
                this.publishProperty('fan-speed', num)
            }
        } else if (prop === 'fan-mode') {
            const modes: Record<string, number> = {
                ventilation: 0,
                auto: 1,
                bypass: 2,
                saving: 3,
            }
            const modeVal = modes[mqttValue.toLowerCase()] ?? 1
            this.raw_clip_state[0x1f9] = modeVal
            if (this.raw_clip_state[0x1f7] === 1) {
                this.send(
                    [1, 1, 2, 1, 1],
                    [
                        { t: 0x1f7, v: 1 },
                        { t: 0x1f9, v: modeVal },
                        { t: 0x1fa, v: this.raw_clip_state[0x1fa] || 2 },
                    ],
                )
            }
            this.publishProperty('fan-mode', mqttValue)
        } else {
            super.setProperty(prop, mqttValue)
        }
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return true
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return true
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true
    }
}
