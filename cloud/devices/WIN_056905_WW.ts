import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'
import { Enum } from '@/util/enum'

// 0x1f9 codes. 0x2c1 (opMode caps) has bit n set when the unit supports code n.
const MODES = Enum.of({
    cool: 0,
    dry: 1,
    fan_only: 2,
    heat: 4,
})

// Energy saver. HA has no such HVAC mode, so it is published as cool with preset 'eco'.
const MODE_ENERGY_SAVER = 8

// 0x1fa codes. 0x2c2 (fan caps) has bit n set when the unit supports code n.
const FAN_MODES = Enum.of({
    low: 2,
    medium: 4,
    high: 6,
})

const SWING_MODES = Enum.of({
    on: 100,
    off: 0,
})

/**
 * LG Air Conditioner Model LW1823HRSM
 */
export default class Device extends TLVDevice {
    meta: Metadata
    configured = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
    }

    // Swing support is known only from the values (0x322), so the config waits for the first values
    // response, then queries them again to publish them.
    valuesReceived() {
        if (this.configured) return
        this.configured = true
        this.makeConfig()
        this.query()
    }

    /** 0x1f9 as published: energy saver reads as cool, off while 0x1f7 says the unit is off. */
    haMode(raw: number) {
        if (this.raw_clip_state[0x1f7] === 0) return 'off'
        if (raw === MODE_ENERGY_SAVER) return 'cool'
        return MODES.map(raw)
    }

    supported(capsTag: number, code: number) {
        const caps = this.raw_clip_state[capsTag]
        return caps === undefined || !!(caps & (1 << code))
    }

    tempLimit(tag: number, fallback: number) {
        const raw = this.raw_clip_state[tag]
        return raw ? raw / 2 : fallback
    }

    makeConfig() {
        const hasSwing = this.raw_clip_state[0x322] !== undefined
        const hasEnergySaver = this.raw_clip_state[0x2c1] !== undefined && this.supported(0x2c1, MODE_ENERGY_SAVER)

        // Without 0x2c1 / 0x2c2 caps every known mode and fan speed is offered.
        const climate: ClimateComponent = {
            platform: 'climate',
            unique_id: '$deviceid-climate',
            name: null,
            temperature_unit: 'C',
            temp_step: 0.5,
            precision: 0.5,
            // 0x2e1 / 0x2e2: setpoint limits in half degrees
            min_temp: this.tempLimit(0x2e1, 16),
            max_temp: this.tempLimit(0x2e2, 30),
            modes: ['off', ...MODES.options.filter((opt) => this.supported(0x2c1, MODES.unmap(opt)!))],
            fan_modes: FAN_MODES.options.filter((opt) => this.supported(0x2c2, FAN_MODES.unmap(opt)!)),
        }
        if (hasSwing) climate.swing_modes = SWING_MODES.options
        if (hasEnergySaver) climate.preset_modes = ['eco']

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Air Conditioner' }),
            components: { climate },
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
                const minCel = climate.min_temp!
                const maxCel = climate.max_temp!
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
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (hasEnergySaver)
                    this.publishProperty('climate-preset_mode', raw === MODE_ENERGY_SAVER ? 'eco' : 'none')
                return this.haMode(raw)
            },
            // 'eco' is not an HA mode; the preset field below writes it through here
            write_xform: (val) => {
                // Call function power (0x1f7) with value OFF
                this.setProperty('climate-power', val === 'off' ? 'OFF' : 'ON')
                if (val === 'eco') return MODE_ENERGY_SAVER
                return MODES.unmap(val)
            },
            write_attach: hasSwing ? [0x1f7, 0x1fa, 0x1fe, 0x322] : [0x1f7, 0x1fa, 0x1fe],
        })

        if (hasEnergySaver) {
            this.addField(config, {
                name: 'preset_mode',
                comp: 'climate',
                readable: false,
                write_xform: (val) => (val === 'eco' ? MODE_ENERGY_SAVER : 0),
                write_callback: (raw) => {
                    const current = this.raw_clip_state[0x1f9]
                    if (raw === MODE_ENERGY_SAVER) this.setProperty('climate-mode', 'eco')
                    // leaving eco: back to plain cool; 'none' in any other mode changes nothing
                    else if (current === MODE_ENERGY_SAVER) this.setProperty('climate-mode', 'cool')
                    return false
                },
            })
            // readable: false skips the state topic; the mode field publishes it
            ;(config.components.climate as ClimateComponent).preset_mode_state_topic = '$this/climate-preset_mode'
        }

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => FAN_MODES.map(raw),
            write_xform: (val) => FAN_MODES.unmap(val),
            write_attach: [0x1f9, 0x1fe],
        })

        if (hasSwing) {
            this.addField(config, {
                id: 0x322,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => SWING_MODES.map(raw),
                write_xform: (val) => SWING_MODES.unmap(val),
                write_attach: [0x1f9, 0x1fa],
            })
        }

        this.setConfig(config)
    }
}
