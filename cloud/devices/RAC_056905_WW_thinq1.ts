import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { type Metadata } from '../thinq'

const MODE_TO_CODE: Record<string, string> = {
    cool: '0',
    dry: '1',
    fan_only: '2',
    heat: '4',
    auto: '6',
}

const CODE_TO_MODE: Record<string, string> = {
    '0': 'cool',
    '1': 'dry',
    '2': 'fan_only',
    '4': 'heat',
    '6': 'auto',
}

const FAN_TO_CODE: Record<string, string> = {
    'very low': '2',
    low: '3',
    medium: '4',
    high: '5',
    'very high': '6',
    auto: '8',
}

const CODE_TO_FAN: Record<string, string> = {
    '2': 'very low',
    '3': 'low',
    '4': 'medium',
    '5': 'high',
    '6': 'very high',
    '8': 'auto',
}

interface ACState {
    Operation?: string
    OpMode?: string
    WindStrength?: string
    TempCur?: string
    TempCfg?: string
    [key: string]: string | undefined
}

export default class Device extends HADevice {
    private state: ACState = {}

    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        readonly meta: Metadata,
    ) {
        super(HA, thinq.id)

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Air Conditioner' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        name: 'Power',
                        icon: 'mdi:power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                    },

                    climate: {
                        platform: 'climate',
                        unique_id: '$deviceid-climate',
                        name: null,

                        temperature_unit: 'C',
                        temp_step: 0.5,
                        precision: 0.5,
                        min_temp: 18,
                        max_temp: 30,

                        modes: ['off', 'cool', 'dry', 'fan_only', 'heat', 'auto'],

                        fan_modes: ['auto', 'very low', 'low', 'medium', 'high', 'very high'],

                        mode_state_topic: '$this/climate-mode',
                        mode_command_topic: '$this/climate-mode/set',

                        current_temperature_topic: '$this/climate-current_temperature',

                        temperature_state_topic: '$this/climate-temperature',

                        temperature_command_topic: '$this/climate-temperature/set',

                        fan_mode_state_topic: '$this/climate-fan_mode',

                        fan_mode_command_topic: '$this/climate-fan_mode/set',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => this.processData(buf))
    }

    start() {
        // Start the ThinQ1 status monitor. The device will then periodically
        // report its current state.
        this.thinq.send({
            Cmd: 'Mon',
            CmdOpt: 'Start',
        })
    }

    private processData(buf: Buffer) {
        let text = buf.toString('utf8').trim()

        // Status frames may have a trailing "!".
        if (text.endsWith('!')) text = text.slice(0, -1)

        // DevInfo and other ThinQ1 messages are delivered through the same
        // data event but are not JSON status snapshots.
        if (!text.startsWith('{')) return

        try {
            const state = JSON.parse(text) as ACState
            this.state = state

            if (state.Operation === '0') {
                this.HA.publishProperty(this.id, 'power', 'OFF')
                this.HA.publishProperty(this.id, 'climate-mode', 'off')
            } else if (state.Operation === '1') {
                this.HA.publishProperty(this.id, 'power', 'ON')

                if (state.OpMode !== undefined) {
                    const mode = CODE_TO_MODE[state.OpMode]

                    if (mode) {
                        this.HA.publishProperty(this.id, 'climate-mode', mode)
                    }
                }
            }

            if (state.TempCur !== undefined) {
                const currentTemp = Number(state.TempCur)

                if (!Number.isNaN(currentTemp)) {
                    this.HA.publishProperty(this.id, 'climate-current_temperature', currentTemp)
                }
            }

            if (state.TempCfg !== undefined) {
                const targetTemp = Number(state.TempCfg)

                if (!Number.isNaN(targetTemp)) {
                    this.HA.publishProperty(this.id, 'climate-temperature', targetTemp)
                }
            }

            if (state.WindStrength !== undefined) {
                const fan = CODE_TO_FAN[state.WindStrength]

                if (fan) {
                    this.HA.publishProperty(this.id, 'climate-fan_mode', fan)
                }
            }
        } catch (err) {
            console.warn(`RAC_056905_WW ThinQ1 status parse error: ${err}`)
        }
    }

    private control(values: Record<string, string>) {
        this.thinq.send({
            Cmd: 'Control',
            CmdOpt: 'Set',
            Value: values,
        })
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                this.control({ Operation: '1' })
            } else if (mqttValue === 'OFF') {
                this.control({ Operation: '0' })
            }

            return
        }

        if (prop === 'climate-mode') {
            if (mqttValue === 'off') {
                this.control({ Operation: '0' })
                return
            }

            const code = MODE_TO_CODE[mqttValue]

            if (code === undefined) return

            if (this.state.Operation !== '1') {
                this.control({ Operation: '1' })

                setTimeout(() => {
                    this.control({ OpMode: code })
                }, 300)
            } else {
                this.control({ OpMode: code })
            }

            return
        }

        if (prop === 'climate-temperature') {
            const temperature = Number(mqttValue)

            if (Number.isNaN(temperature) || temperature < 18 || temperature > 30) {
                return
            }

            this.control({
                TempCfg: temperature.toString(),
            })

            return
        }

        if (prop === 'climate-fan_mode') {
            const code = FAN_TO_CODE[mqttValue]

            if (code === undefined) return

            this.control({
                WindStrength: code,
            })
        }
    }
}
