import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'

/**
 * LG Window Air Conditioner (e.g. LW6023IVSM, LW1522IVSM)
 *
 * Mode wire values: 0=cool, 1=dry, 2=fan_only, 8=eco("Energy Saver")
 * Fan wire values:  2=low, 4=medium, 6=high
 * Sleep timer (0x21a): value in minutes; exposed to HA in hours.
 */
export default class Device extends TLVDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const config: DeviceDiscovery = {
            ...HADevice.config(meta, { name: 'LG Air Conditioner' }),
            components: {
                climate: allowExtendedType({
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    temperature_unit: 'C',
                    temp_step: 0.5,
                    precision: 0.5,
                    modes: ['off', 'cool', 'dry', 'fan_only'],
                    fan_modes: ['low', 'medium', 'high'],
                    preset_modes: ['eco'],
                }),
            },
        }

        config['components']['sleeptimer'] = allowExtendedType({
            platform: 'number',
            unique_id: '$deviceid-sleeptimer',
            name: 'Sleep timer',
            icon: 'mdi:bed-clock',
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: 7,
            step: 1,
            mode: 'slider',
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (valStr) => {
                const val = Number(valStr)
                const minCel = 16
                const maxCel = 30.0
                if (val < minCel) return minCel * 2
                if (val > maxCel) return maxCel * 2
                return Math.round(val * 2)
            },
            write_attach: [0x1f9, 0x1fa],
        })

        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            write_attach: (raw) => (raw ? [0x1f9] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                const modes2ha = [
                    'cool', // 0
                    'dry', // 1
                    'fan_only', // 2
                    undefined, // 3
                    undefined, // 4 (heat — not supported on this unit)
                    undefined, // 5
                    undefined, // 6
                    undefined, // 7
                    'cool', // 8 — eco/Energy Saver; reported as cool, preset_mode carries 'eco'
                ]
                if (this.raw_clip_state[0x1f7] === 0) return 'off'
                return modes2ha[raw]
            },
            read_callback: (val) => {
                const isEco = this.raw_clip_state[0x1f9] === 8 && this.raw_clip_state[0x1f7] !== 0
                this.HA.publishProperty(this.id, 'climate-preset_mode', isEco ? 'eco' : 'none')
                return true
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { cool: 0, dry: 1, fan_only: 2 }
                if (val === 'off') {
                    this.setProperty('climate-power', 'OFF')
                    return undefined
                }
                this.raw_clip_state[0x1f7] = 1
                return modes2clip[val]
            },
            write_attach: [0x1f7, 0x1fa, 0x1fe],
        })

        this.addField(config, {
            name: 'preset_mode',
            comp: 'climate',
            write_xform: (val) => {
                const mode = val === 'eco' ? 8 : 0
                this.raw_clip_state[0x1f9] = mode
                this.raw_clip_state[0x1f7] = 1
                this.send(
                    [1, 1, 2, 1, 1],
                    [
                        { t: 0x1f7, v: 1 },
                        { t: 0x1f9, v: mode },
                        { t: 0x1fa, v: this.raw_clip_state[0x1fa] },
                        { t: 0x1fe, v: this.raw_clip_state[0x1fe] },
                    ],
                )
                return null
            },
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => {
                const modes2ha: Record<string, string> = { '2': 'low', '4': 'medium', '6': 'high' }
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { low: 2, medium: 4, high: 6 }
                return modes2clip[val]
            },
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x21a,
            name: '',
            comp: 'sleeptimer',
            read_xform: (raw) => raw / 60,
            write_xform: (val) => Math.round(Number(val) * 60),
        })

        this.setConfig(config)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }
}
