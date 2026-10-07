import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { type Metadata } from '../thinq'
import { Enum } from '@/util/enum'
import log from '@/util/logging'
import { FAN_MODES, MODES, SWING_H_MODES, SWING_MODES } from './RAC_056905_WW'

type Status = Record<string, string>

export default class Device extends HADevice {
    lastStatus: Status | undefined
    private readonly reported = new Set<string>()

    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Air Conditioner' }),
                components: {
                    climate: {
                        platform: 'climate',
                        unique_id: '$deviceid-climate',
                        name: null,
                        temperature_unit: 'C',
                        temp_step: 1,
                        precision: 0.5,
                        min_temp: 18,
                        max_temp: 30,
                        modes: ['off', ...MODES.options],
                        mode_state_topic: '$this/mode',
                        mode_command_topic: '$this/mode/set',
                        current_temperature_topic: '$this/current_temperature',
                        temperature_state_topic: '$this/temperature',
                        temperature_command_topic: '$this/temperature/set',
                        fan_modes: FAN_MODES.options,
                        fan_mode_state_topic: '$this/fan_mode',
                        fan_mode_command_topic: '$this/fan_mode/set',
                        swing_modes: SWING_MODES.options,
                        swing_mode_state_topic: '$this/swing_mode',
                        swing_mode_command_topic: '$this/swing_mode/set',
                        swing_horizontal_modes: SWING_H_MODES.options,
                        swing_horizontal_mode_state_topic: '$this/swing_horizontal_mode',
                        swing_horizontal_mode_command_topic: '$this/swing_horizontal_mode/set',
                    },
                    jet: {
                        platform: 'switch',
                        unique_id: '$deviceid-jet',
                        state_topic: '$this/jet',
                        command_topic: '$this/jet/set',
                        name: 'Jet',
                        icon: 'mdi:wind-power',
                        entity_category: 'config',
                        optimistic: true,
                    },
                    airclean: {
                        platform: 'switch',
                        unique_id: '$deviceid-airclean',
                        state_topic: '$this/airclean',
                        command_topic: '$this/airclean/set',
                        /* Same desc as in lg_thinq */
                        name: 'Air purify',
                        icon: 'mdi:air-purifier',
                        entity_category: 'config',
                        optimistic: true,
                    },
                },
            }),
        )

        this.thinq.on('data', (packet) => this.onStatus(packet))
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    private onStatus(packet: Buffer) {
        let status: Status
        try {
            status = JSON.parse(packet.toString('utf-8'))
        } catch {
            return
        }
        if (typeof status?.Operation !== 'string') return
        // The first pushes after subscribing have every field zeroed; a setpoint of 0 cannot occur otherwise.
        if (status.TempCfg === '0') return
        this.lastStatus = status

        const running = status.Operation !== '0'
        this.publishProperty('mode', running ? this.label(MODES, status.OpMode, 'OpMode') : 'off')
        this.publishProperty('current_temperature', Number(status.TempCur))
        this.publishProperty('temperature', Number(status.TempCfg))
        this.publishProperty('fan_mode', this.label(FAN_MODES, status.WindStrength, 'WindStrength'))
        this.publishProperty('swing_mode', this.label(SWING_MODES, status.WDirVStep, 'WDirVStep'))
        this.publishProperty('swing_horizontal_mode', this.label(SWING_H_MODES, status.WDirHStep, 'WDirHStep'))
        this.publishProperty('jet', status.Jet === '1' ? 'ON' : 'OFF')
        this.publishProperty('airclean', status.AirClean === '1' ? 'ON' : 'OFF')
    }

    private label(table: Enum<string>, raw: string | undefined, field: string) {
        if (raw === undefined) return undefined
        const mapped = table.map(Number(raw))
        if (mapped === undefined && !this.reported.has(field + raw)) {
            this.reported.add(field + raw)
            log('status', this.id, `unmapped ${field} value ${raw}`)
        }
        return mapped
    }

    private control(key: string, value: number | string) {
        this.thinq.send({ Cmd: 'Control', CmdOpt: 'Set', Value: { [key]: String(value) }, Format: 'B64', Data: '' })
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'mode': {
                if (mqttValue === 'off') return this.control('Operation', 0)
                const mode = MODES.unmap(mqttValue)
                if (mode === undefined) return
                // OpMode alone is ignored while the unit is off
                if (this.lastStatus?.Operation === '0') this.control('Operation', 1)
                return this.control('OpMode', mode)
            }
            case 'temperature':
                return this.control('TempCfg', Math.round(Number(mqttValue)))
            case 'fan_mode': {
                const fan = FAN_MODES.unmap(mqttValue)
                if (fan !== undefined) this.control('WindStrength', fan)
                return
            }
            case 'swing_mode': {
                const step = SWING_MODES.unmap(mqttValue)
                if (step !== undefined) this.control('WDirVStep', step)
                return
            }
            case 'swing_horizontal_mode': {
                const step = SWING_H_MODES.unmap(mqttValue)
                if (step !== undefined) this.control('WDirHStep', step)
                return
            }
            case 'jet':
                return this.control('Jet', mqttValue === 'ON' ? 1 : 0)
            case 'airclean':
                return this.control('AirClean', mqttValue === 'ON' ? 1 : 0)
            default:
                console.warn(`Unknown property ${prop}`)
        }
    }
}
