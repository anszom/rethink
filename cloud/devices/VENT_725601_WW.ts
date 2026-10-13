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

        const deviceName = 'Ventilation'

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
                    preset_modes: ['auto', 'saving', 'bypass', 'ventilation'],
                    icon: 'mdi:hvac',
                },
                temp_controller: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-controller',
                    name: 'Room temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_controller',
                },
                temp_indoor: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-indoor',
                    name: 'Intake temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_indoor',
                    entity_category: 'diagnostic',
                },
                temp_exhaust: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-exhaust',
                    name: 'Exhaust temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_exhaust',
                    entity_category: 'diagnostic',
                },
                temp_outdoor: {
                    platform: 'sensor',
                    unique_id: '$deviceid-temp-outdoor',
                    name: 'Outdoor temperature',
                    device_class: 'temperature',
                    state_class: 'measurement',
                    unit_of_measurement: '°C',
                    state_topic: '$this/sensor-temp_outdoor',
                    entity_category: 'diagnostic',
                },
                filter_pre: {
                    platform: 'sensor',
                    unique_id: '$deviceid-filter-pre',
                    name: 'Pre-filter life',
                    state_class: 'measurement',
                    unit_of_measurement: '%',
                    state_topic: '$this/sensor-filter_pre',
                    icon: 'mdi:air-filter',
                },
                filter_life: {
                    platform: 'sensor',
                    unique_id: '$deviceid-filter-life',
                    name: 'Filter life',
                    state_class: 'measurement',
                    unit_of_measurement: '%',
                    state_topic: '$this/sensor-filter_life',
                    icon: 'mdi:air-filter',
                },
                air_quality: {
                    platform: 'sensor',
                    unique_id: '$deviceid-air-quality',
                    name: 'Air quality index',
                    state_topic: '$this/sensor-air_quality',
                    icon: 'mdi:air-filter',
                    entity_category: 'diagnostic',
                },
                co2: {
                    platform: 'sensor',
                    unique_id: '$deviceid-co2',
                    name: 'CO2',
                    device_class: 'carbon_dioxide',
                    state_class: 'measurement',
                    unit_of_measurement: 'ppm',
                    state_topic: '$this/sensor-co2',
                    icon: 'mdi:molecule-co2',
                },
                in_pm1: {
                    platform: 'sensor',
                    unique_id: '$deviceid-in-pm1',
                    name: 'Indoor PM1.0',
                    device_class: 'pm1',
                    state_class: 'measurement',
                    unit_of_measurement: 'µg/m³',
                    state_topic: '$this/sensor-in_pm1',
                    icon: 'mdi:blur',
                },
                in_pm25: {
                    platform: 'sensor',
                    unique_id: '$deviceid-in-pm25',
                    name: 'Indoor PM2.5',
                    device_class: 'pm25',
                    state_class: 'measurement',
                    unit_of_measurement: 'µg/m³',
                    state_topic: '$this/sensor-in_pm25',
                    icon: 'mdi:blur',
                },
                in_pm10: {
                    platform: 'sensor',
                    unique_id: '$deviceid-in-pm10',
                    name: 'Indoor PM10',
                    device_class: 'pm10',
                    state_class: 'measurement',
                    unit_of_measurement: 'µg/m³',
                    state_topic: '$this/sensor-in_pm10',
                    icon: 'mdi:blur',
                },
                in_air_quality_level: {
                    platform: 'sensor',
                    unique_id: '$deviceid-in-air-quality-level',
                    name: 'Indoor air quality',
                    state_topic: '$this/sensor-in_air_quality_level',
                    icon: 'mdi:air-filter',
                },
                out_pm1: {
                    platform: 'sensor',
                    unique_id: '$deviceid-out-pm1',
                    name: 'Outdoor PM1.0',
                    device_class: 'pm1',
                    state_class: 'measurement',
                    unit_of_measurement: 'µg/m³',
                    state_topic: '$this/sensor-out_pm1',
                    icon: 'mdi:blur',
                },
                out_pm25: {
                    platform: 'sensor',
                    unique_id: '$deviceid-out-pm25',
                    name: 'Outdoor PM2.5',
                    device_class: 'pm25',
                    state_class: 'measurement',
                    unit_of_measurement: 'µg/m³',
                    state_topic: '$this/sensor-out_pm25',
                    icon: 'mdi:blur',
                },
                out_pm10: {
                    platform: 'sensor',
                    unique_id: '$deviceid-out-pm10',
                    name: 'Outdoor PM10',
                    device_class: 'pm10',
                    state_class: 'measurement',
                    unit_of_measurement: 'µg/m³',
                    state_topic: '$this/sensor-out_pm10',
                    icon: 'mdi:blur',
                },
                out_air_quality_level: {
                    platform: 'sensor',
                    unique_id: '$deviceid-out-air-quality-level',
                    name: 'Outdoor air quality',
                    state_topic: '$this/sensor-out_air_quality_level',
                    icon: 'mdi:air-filter',
                },
                uv_nano: {
                    platform: 'switch',
                    unique_id: '$deviceid-uv_nano',
                    name: 'UVnano',
                    icon: 'mdi:shield-sun',
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

        // 0x1fa: Fan speed (ThinQ: Low = raw 2, High = raw 6, Turbo = raw 7)
        // HA speed steps: 1 (Low), 2 (High), 3 (Turbo)
        this.addField(
            config,
            {
                id: 0x1fa,
                name: 'speed',
                comp: 'fan',
                read_xform: (raw) => {
                    if (raw <= 2) return 1
                    if (raw <= 6) return 2
                    return 3
                },
                write_xform: (val) => {
                    const n = Number(val)
                    if (n === 1) return 2
                    if (n === 2) return 6
                    return 7
                },
            },
            false,
        )

        // 0x1f9: Mode (auto=0x27, bypass=0x26, saving=0x25, ventilation=0x26)
        this.addField(
            config,
            {
                id: 0x1f9,
                name: 'mode',
                comp: 'fan',
                read_xform: (raw) => {
                    const modes: Record<number, string> = {
                        0x27: 'auto',
                        0x26: 'bypass',
                        0x25: 'saving',
                    }
                    return modes[raw] ?? 'auto'
                },
                write_xform: (val) => {
                    const modes: Record<string, number> = {
                        auto: 0x27,
                        saving: 0x25,
                        bypass: 0x26,
                        ventilation: 0x26,
                    }
                    return modes[String(val).toLowerCase()] ?? 0x27
                },
            },
            false,
        )

        // 0x2a2: UVnano switch (0 = OFF, 1 = ON)
        this.addField(
            config,
            {
                id: 0x2a2,
                name: '',
                comp: 'uv_nano',
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
                write_xform: (val) => (val === 'ON' ? 1 : 0),
            },
            true,
        )

        // Temperatures & Air quality index from TLV
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

        // 0x1fd: Remote controller indoor temperature (raw / 2 = °C, e.g. 51 / 2 = 25.5°C)
        this.addField(
            config,
            {
                id: 0x1fd,
                name: 'temp_controller',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw / 2,
            },
            false,
        )

        // 0x355: Pre-filter life remaining (0..100%)
        this.addField(
            config,
            {
                id: 0x355,
                name: 'filter_pre',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw,
            },
            false,
        )

        // 0x38d: Filter life remaining (0..100%)
        this.addField(
            config,
            {
                id: 0x38d,
                name: 'filter_life',
                comp: 'sensor',
                writable: false,
                read_xform: (raw) => raw,
            },
            false,
        )

        this.setConfig(config)
    }

    processData(buf: Buffer) {
        super.processData(buf)

        // Parse Air Quality / Cleanliness packet (contains model Z-H0151B2SR)
        const modelIdx = buf.indexOf('Z-H0151B2SR')
        if (modelIdx >= 40) {
            const co2Idx = modelIdx - 40
            const co2 = buf.readUInt16BE(co2Idx)
            const inClean = buf[co2Idx + 2]
            const inPm10 = buf.readUInt16BE(co2Idx + 3)
            const inPm25 = buf.readUInt16BE(co2Idx + 5)
            const inPm1 = buf.readUInt16BE(co2Idx + 7)
            const outPm10 = buf.readUInt16BE(co2Idx + 9)
            const outPm25 = buf.readUInt16BE(co2Idx + 11)
            const outPm1 = buf.readUInt16BE(co2Idx + 13)
            const outClean = buf[co2Idx + 16]

            const cleanMap: Record<number, string> = {
                1: 'Good',
                2: 'Normal',
                3: 'Bad',
                4: 'Very Bad',
            }

            if (inClean >= 1 && inClean <= 4) {
                this.publishProperty('sensor-in_air_quality_level', cleanMap[inClean] ?? inClean)
                this.publishProperty('sensor-in_pm1', inPm1)
                this.publishProperty('sensor-in_pm25', inPm25)
                this.publishProperty('sensor-in_pm10', inPm10)
            }
            if (outClean >= 1 && outClean <= 4) {
                this.publishProperty('sensor-out_air_quality_level', cleanMap[outClean] ?? outClean)
                this.publishProperty('sensor-out_pm1', outPm1)
                this.publishProperty('sensor-out_pm25', outPm25)
                this.publishProperty('sensor-out_pm10', outPm10)
            }
            if (co2 >= 0 && co2 < 5000) {
                this.publishProperty('sensor-co2', co2)
            }
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fan-power') {
            if (mqttValue === 'ON') {
                this.raw_clip_state[0x1f7] = 1
                if (!this.raw_clip_state[0x1fa] || this.raw_clip_state[0x1fa] <= 0) {
                    this.raw_clip_state[0x1fa] = 2 // default to Low (speed 1)
                }
                if (this.raw_clip_state[0x1f9] === undefined) {
                    this.raw_clip_state[0x1f9] = 0x27 // default to auto
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
                const speedLvl = this.raw_clip_state[0x1fa] <= 2 ? 1 : this.raw_clip_state[0x1fa] <= 6 ? 2 : 3
                this.publishProperty('fan-speed', speedLvl)
            } else {
                this.raw_clip_state[0x1f7] = 0
                this.send([1, 1, 2, 1, 1], [{ t: 0x1f7, v: 0 }])
                this.publishProperty('fan-power', 'OFF')
            }
        } else if (prop === 'fan-speed') {
            const rawVal = Number(mqttValue)
            let step = Math.round(rawVal)
            if (step > 3) {
                if (step <= 0) step = 0
                else if (step <= 33) step = 1
                else if (step <= 66) step = 2
                else step = 3
            }

            if (step <= 0) {
                this.raw_clip_state[0x1f7] = 0
                this.send([1, 1, 2, 1, 1], [{ t: 0x1f7, v: 0 }])
                this.publishProperty('fan-power', 'OFF')
            } else {
                const rawSpeed = step === 1 ? 2 : step === 2 ? 6 : 7
                this.raw_clip_state[0x1fa] = rawSpeed
                this.raw_clip_state[0x1f7] = 1
                if (this.raw_clip_state[0x1f9] === undefined) {
                    this.raw_clip_state[0x1f9] = 0x27
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
                this.publishProperty('fan-speed', step)
            }
        } else if (prop === 'fan-mode') {
            const modes: Record<string, number> = {
                auto: 0x27,
                saving: 0x25,
                bypass: 0x26,
                ventilation: 0x26,
            }
            const rawMode = modes[String(mqttValue).toLowerCase()] ?? 0x27
            this.raw_clip_state[0x1f9] = rawMode
            this.raw_clip_state[0x1f7] = 1
            if (!this.raw_clip_state[0x1fa] || this.raw_clip_state[0x1fa] <= 0) {
                this.raw_clip_state[0x1fa] = 2
            }
            this.send(
                [1, 1, 2, 1, 1],
                [
                    { t: 0x1f7, v: 1 },
                    { t: 0x1f9, v: rawMode },
                    { t: 0x1fa, v: this.raw_clip_state[0x1fa] },
                ],
            )
            this.publishProperty('fan-power', 'ON')
            this.publishProperty('fan-mode', mqttValue)
        } else if (prop === 'uv_nano-') {
            const val = mqttValue === 'ON' ? 1 : 0
            this.raw_clip_state[0x2a2] = val
            this.send([1, 1, 2, 1, 1], [{ t: 0x2a2, v: val }])
            this.publishProperty('uv_nano-', mqttValue)
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
