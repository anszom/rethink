import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'
import { Enum } from '@/util/enum'

/**
 * TLV tags present in capability (0xA7/0x01) packets — store during the caps query phase
 * but do not publish as entity values.
 */
const CAPS_ONLY_TAGS = new Set([0x2c0, 0x2c3, 0x2c4, 0x2d2, 0x2d3, 0x2d5, 0x2da, 0x2db, 0x2dc, 0x2f1, 0x2f4, 0x2f5])

const MODES = Enum.of({
    heat_pump: 25,
    performance: 26,
    electric: 27,
    eco: 28,
})

/**
 * LG Heat Pump Water Heater WHT_056905_WW
 */
export default class Device extends TLVDevice {
    initialValuesReceived: boolean = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Water Heater' }),
            components: {
                water_heater: {
                    platform: 'water_heater',
                    unique_id: '$deviceid-water_heater',
                    name: null,
                    icon: 'mdi:water-boiler',
                    temperature_unit: 'C',
                    temp_step: 0.5,
                    min_temp: 35,
                    max_temp: 60,
                    modes: MODES.options,
                },
            },
        })

        this.addField(config, {
            id: 0x255,
            name: 'current_temperature',
            comp: 'water_heater',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'water_heater',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            write_attach: (raw) => (raw ? [0x1f9, 0x256] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'water_heater',
            read_xform: (raw) => {
                if (this.raw_clip_state[0x1f7] === 0) return 'off'
                return MODES.map(raw)
            },
            write_xform: (val) => {
                if (val === 'off') {
                    this.setProperty('water_heater-power', 'OFF')
                    return null
                }
                return MODES.unmap(val)
            },
            write_attach: [0x256],
        })

        this.addField(config, {
            id: 0x256,
            name: 'temperature',
            comp: 'water_heater',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => {
                let num = Number(val)
                if (num < 35) num = 35
                if (num > 60) num = 60
                return Math.round(num * 2)
            },
            write_attach: [0x1f9],
        })

        // Current power draw. Same tag as the RAC family (0x2B3); on this
        // 0xA7 device the raw value follows the same scaling (≈ +60 bias for
        // the AC convention), so idle reads ~5W via the RAC transform.
        const energySensor = {
            platform: 'sensor',
            unique_id: '$deviceid-energy_current',
            name: 'Power',
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        config['components']['energy'] = energySensor
        this.addField(config, {
            id: 0x2b3,
            name: '',
            comp: 'energy',
            writable: false,
            read_xform: (raw) => Math.max(5, raw - 60),
        })

        // Error/status code, same tag as the RAC family (0x221). 0 = no error.
        const errorSensor = {
            platform: 'sensor',
            unique_id: '$deviceid-error_code',
            name: 'Error code',
            icon: 'mdi:alert',
            entity_category: 'diagnostic',
        }
        config['components']['error'] = errorSensor
        this.addField(config, {
            id: 0x221,
            name: '',
            comp: 'error',
            writable: false,
        })

        // Hot water remaining (%). Maps to modelJS airState.waterTank.remain.
        const waterSensor = {
            platform: 'sensor',
            unique_id: '$deviceid-water_level',
            name: 'Hot water remaining',
            icon: 'mdi:water-percent',
            unit_of_measurement: '%',
            state_class: 'measurement',
            entity_category: 'diagnostic',
        }
        config['components']['water'] = waterSensor
        this.addField(config, {
            id: 0x229,
            name: '',
            comp: 'water',
            writable: false,
        })

        /*
         * Compressor frequency. Same tag as the RAC family (0x22a); reads 0
         * while the heat pump is idle.
         */
        const compressorSensor = {
            platform: 'sensor',
            unique_id: '$deviceid-compressor_frequency',
            name: 'Compressor frequency',
            icon: 'mdi:fan',
            device_class: 'frequency',
            unit_of_measurement: 'Hz',
            state_class: 'measurement',
            entity_category: 'diagnostic',
        }
        config['components']['compressor'] = compressorSensor
        this.addField(config, {
            id: 0x22a,
            name: '',
            comp: 'compressor',
            writable: false,
        })

        this.setConfig(config)
    }

    processKeyValue(k: number, v: number) {
        if (this.query_caps_timeout !== undefined && CAPS_ONLY_TAGS.has(k)) {
            this.raw_clip_state[k] = v
            return
        }
        // Mode-temperature capability rows (0x2d7/0x2d8) repeat once per mode — not global state.
        if (k === 0x2d7 || k === 0x2d8) return
        super.processKeyValue(k, v)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x1f7)
    }
}
