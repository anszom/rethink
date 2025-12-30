// base implementation for devices with a TLV-based payload format
import HADevice from './base.js'

import crc16 from '../../util/crc16.js'
import * as TLV from "../../util/tlv.js";
import { ClipDeployMessage } from "../../util/clip.js"
import { Device as ClipDevice } from "../devmgr.js"
import { type Config, type Connection } from '../homeassistant.js';

export type FieldDefinition = {
    id?: number;
    name?: string;
    readable?: boolean;
    writable?: boolean;
    write_xform?: (val: string) => string|number|null|undefined,
    write_attach?: number[] | ((val: unknown) => number[]),
    read_xform?: (val: number) => string|number,
    read_callback?: (val: string|number) => void,
    write_callback?: (val: number) => void,
}

export default class TLVDevice extends HADevice {
    fields_by_id: Record<number, FieldDefinition> = {}
    fields_by_ha: Record<string, FieldDefinition> = {}
    raw_clip_state: Record<number, number> = {}

    constructor(readonly HA: Connection, readonly ha_class, readonly config: Config, readonly clip: ClipDevice) {
        super(HA, ha_class, config, clip)
    }

    // we waste memory by storing the field set per-device, not per-class. Whatever.
	addField(options: FieldDefinition, autoreg?: boolean) {
		if(options.id)
			this.fields_by_id[options.id] = options

		if(options.name)
			this.fields_by_ha[options.name] = options

		if(autoreg !== false) {
			if(options.writable === false)
				this.config[options.name + '_topic'] = '$this/' + options.name
			else {
				if(options.readable !== false)
					this.config[options.name + '_state_topic'] = '$this/' + options.name

				this.config[options.name + '_command_topic'] = '$this/' + options.name + '/set'
			}
		}
	}

    // clip-side
    query() {
        this.send([1,1,2,2,1], [{t: 0x1f5, v: 2 }])
    }

    processData(buf: Buffer) {
        if(buf[2] == 0x04 && buf[3] == 0x00 && buf[4] == 0x00 && buf[5] == 0x00 && buf[6] == 0x87 && buf[7] == 0x02 && buf[8] == 0x04
            /* && buf[9] is a "sequence" number */ && buf[10] == buf.length-13) {

            // ignore the CRC, we assume that the modem verifies it :/
            this.processTLV(TLV.parse(buf.subarray(11, buf.length-2)))
        }
	}

    send(header: number[], tlv: TLV.TLV[]) {
		const [b0, b1, b2, b3, b4] = header
		const tlvArray = TLV.build(tlv)
		let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
		const result = crc16(buf)
		buf = [ b0, b1 ].concat(buf, [ result >> 8, result & 0xff])
        this.clip.send(Buffer.from(buf))
    }

    processTLV(tlvArray: TLV.TLV[]) {
        tlvArray.forEach(({t, v}) => this.processKeyValue(t, v))
    }

    processKeyValue(k: number, v: number) {
        this.raw_clip_state[k] = v

        const def = this.fields_by_id[k]
        if(!def) 
            return

        let processed: string|number = v

        if(def.read_xform)
            processed = def.read_xform.call(this, processed)

        if(def.read_callback)
            def.read_callback.call(this, processed)
        else {
            if(def.readable === false)
                return

            this.HA.publishProperty(this.id, def.name, processed)
        }
    }

    // HA-side
    setProperty(prop: string, mqttValue: string) {
        //console.log("HA write ", prop, value)
        const def = this.fields_by_ha[prop]
        if(!def || def.writable === false) {
            console.warn(`Attempting to set property ${prop} which is not writable`)
            return
        }

        let value: string|number|null|undefined
        if(def.write_xform)
            value = def.write_xform.call(this, mqttValue)

        if(value === null || value === undefined)
            return

        if(typeof(value) === 'string')
            value = Number(value)

        if(def.write_callback) {
            def.write_callback.call(this, value)
        } else {
            this.raw_clip_state[def.id] = value

            let attach: number[] = []
            if(Array.isArray(def.write_attach))
                attach = def.write_attach
            if(typeof(def.write_attach) === 'function')
                attach = def.write_attach(value)

            const write_fields = [ def.id ].concat(attach)
            const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
            //console.log("Sending ", tlvArray)
            this.send([1, 1, 2, 1, 1], tlvArray)
        }
    }
}
