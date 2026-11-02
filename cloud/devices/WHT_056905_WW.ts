import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'
import { Enum } from '@/util/enum'

// LG names: 25 Heat Pump, 26 Auto (heat pump first, elements on high demand),
// 27 Turbo (elements always on), 28 Vacation (keeps the tank at a minimum
// temperature; HA has no vacation mode, so it is exposed as off).
const MODES = Enum.of({
    heat_pump: 25,
    eco: 26,
    performance: 27,
    off: 28,
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
            id: 0x1f9,
            name: 'mode',
            comp: 'water_heater',
            read_xform: (raw) => MODES.map(raw),
            write_xform: (val) => MODES.unmap(val),
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

        // Accumulated energy in Wh, confirmed against an external energy meter.
        const energyTotalSensor = {
            platform: 'sensor',
            unique_id: '$deviceid-energy_total',
            name: 'Energy total',
            device_class: 'energy',
            unit_of_measurement: 'Wh',
            state_class: 'total_increasing',
            entity_category: 'diagnostic',
        }
        config['components']['energy_total'] = energyTotalSensor
        this.addField(config, {
            id: 0x232,
            name: '',
            comp: 'energy_total',
            writable: false,
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
