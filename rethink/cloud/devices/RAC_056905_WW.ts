import TLVDevice from './tlv_device.js'
import { Device as Thinq2Device } from "../thinq2/devmgr.js"
import { Config, type Connection } from '../homeassistant.js'
import { type Metadata } from '../thinq.js'
import { allowExtendedType } from '../../util/util.js'
import HADevice from './base.js'

export default class Device extends TLVDevice {
	constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
		super(HA, 'climate', thinq)
		const config: Config = allowExtendedType({
			...HADevice.componentConfig(meta, { name: 'LG Air Conditioner' }),
			temperature_unit: 'C',
			temp_step: 0.5,
			precision: 0.5,
			fan_modes: [ 'auto', 'very low', 'low', 'medium', 'high', 'very high' ],
			swing_modes: [ '1', '2', '3', '4', '5', '1-3', '3-5', 'on', 'off' ],
			vertical_swing_modes: [ '1', '2', '3', '4', '5', '6', 'on', 'off' ] // not supported by HA (FIXME: now supported!)
		})

		this.addField(config, {
			id: 0x1fd, name: 'current_temperature', writable: false,
			read_xform: (raw) => raw/2
		})
		this.addField(config, {
			id: 0x1f7, name: 'power', readable: false,
			write_xform: (val) => val === 'ON' ? 1 : 0,
			write_attach: (raw) => raw ? [0x1f9, 0x1fa] : [],
			read_xform: (raw) => raw ? 'ON' : 'OFF',
			read_callback: (val) => {
				// update 'mode' instead
				this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
			}
		})

		this.addField(config, {
			id: 0x1f9, name: 'mode',
			read_xform: (raw) => {
				const modes2ha = [ 'cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto' ]
				if(this.raw_clip_state[0x1f7] === 0)
					return 'off'
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { cool: 0, dry: 1, fan_only:2, heat:4, auto:6 }
				if (val === 'off') {
		                    // Call function power (0x1f7) with value OFF
		                    this.setProperty('power', 'OFF')
		                }
				return modes2clip[val]
			},
			write_attach: [0x1fa, 0x1fe]
		})

		this.addField(config, {
			id: 0x1fa, name: 'fan_mode',
			read_xform: (raw) => {
				const modes2ha = [ undefined, undefined, 'very low', 'low', 'medium', 'high', 'very high', undefined, 'auto' ]
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { 'very low': 2, 'low': 3, 'medium': 4, 'high': 5, 'very high': 6, auto: 8 }
				return modes2clip[val]
			},
			write_attach: [0x1f9, 0x1fe]
		})

		this.addField(config, {
			id: 0x1fe, name: 'temperature', read_xform: (raw) => raw/2, write_xform: (val) => Math.round(Number(val)*2),
			write_attach: [0x1f9, 0x1fa]
		})

		this.addField(config, {
			id: 0x321, name: 'vertical_swing_mode', 
			read_xform: (raw) => {
				const modes2ha = [ "off", "1", "2", "3", "4", "5", "6" ]
				modes2ha[100] = "on"
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { "off": 0, "1":1, "2":2, "3":3, "4":4, "5":5, "6":6, "on":100 }
				return modes2clip[val]
			},
			write_attach: [0x1f9, 0x1fa]
		}, false)

		this.addField(config, {
			id: 0x322, name: 'swing_mode', 
			read_xform: (raw) => {
				const modes2ha = [ "off", "1", "2", "3", "4", "5" ]
				modes2ha[13] = "1-3"
				modes2ha[35] = "3-5"
				modes2ha[100] = "on"
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { "off": 0, "1":1, "2":2, "3":3, "4":4, "5":5, "1-3":13, "3-5":35, "on":100 }
				return modes2clip[val]
			},
			write_attach: [0x1f9, 0x1fa]
		})

		this.setConfig(config)
	}
}