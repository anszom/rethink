import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'
import { Enum } from '@/util/enum'

const MODES = Enum.of({
    cool: 0,
    dry: 1,
    fan_only: 2,
})

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
 * LG Portable Air Conditioner Model LP1022FVSM
 * ThinQ model POT_056905_WW
 */
export default class Device extends TLVDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Portable AC' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    temperature_unit: 'C',
                    temp_step: 1,
                    precision: 1,
                    modes: ['off', 'cool', 'dry', 'fan_only'],
                    fan_modes: FAN_MODES.options,
                    swing_modes: SWING_MODES.options,
                },
            },
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
                const maxCel = 30

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
            read_callback: () => {
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (this.raw_clip_state[0x1f7] === 0) return 'off'
                return MODES.map(raw)
            },
            write_xform: (val) => {
                if (val === 'off') {
                    this.raw_clip_state[0x1f7] = 0
                    return this.raw_clip_state[0x1f9] ?? 0
                }

                this.raw_clip_state[0x1f7] = 1
                return MODES.unmap(val)
            },
            write_callback: () => {
                if (this.raw_clip_state[0x1f7] === 0) {
                    this.send([1, 1, 2, 1, 1], [{ t: 0x1f7, v: 0 }])
                    return false
                }

                return true
            },
            write_attach: [0x1f7, 0x1fa, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => FAN_MODES.map(raw),
            write_xform: (val) => FAN_MODES.unmap(val),
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x322,
            name: 'swing_mode',
            comp: 'climate',
            read_xform: (raw) => SWING_MODES.map(raw),
            write_xform: (val) => SWING_MODES.unmap(val),
            write_attach: [0x1f9, 0x1fa],
        })

        this.setConfig(config)
    }

    processData(buf: Buffer) {
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0x02 &&
            (buf[8] === 0x01 || buf[8] === 0x04) &&
            buf[10] === buf.length - 13
        ) {
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
            return
        }

        super.processData(buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }
}
