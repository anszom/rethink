class HADevice {
	constructor(HA, ha_class, clipDevice, provisionMsg) {
		this.HA = HA
		this.clip = clipDevice
		this.id = clipDevice.id
		this.ha_class = ha_class
		this.config = {
			availability: [ { topic: '$this/availability' }, { topic: '$rethink/availability' } ],
			optimistic: false,
			object_id: '$deviceid',
			unique_id: '$deviceid',
			device: {
				identifiers: '$deviceid',
				manufacturer: 'LG',
				model: provisionMsg.data?.appInfo?.modelName,
				sw_version: provisionMsg.data?.appInfo?.softVer,
			},
		}

		this.fields_by_id={}
		this.fields_by_ha={}
		this.raw_clip_state={}
	}

	drop() {
		this.HA.publishProperty(this.id, 'availability', 'offline', {retain: false})
	}

	// we waste memory by storing the field set per-device, not per-class. Whatever.
	addField(options, autoreg) {
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
		this.clip.send([1,1,2,2,1], [{t: 0x1f5, v: 2 }])
	}

	processTLV(tlvArray) {
		tlvArray.forEach((tv) => this.processKeyValue(tv.t, tv.v))
	}

	processKeyValue(k,v) {
		this.raw_clip_state[k] = v

		const def = this.fields_by_id[k]
		if(!def) 
			return

		if(def.read_xform)
			v = def.read_xform.call(this, v)

		if(def.read_callback)
			def.read_callback.call(this, v)
		else {
			if(def.readable === false)
				return

			this.HA.publishProperty(this.id, def.name, v)
		}
	}

	// HA-side
	publishConfig() {
		this.HA.publishConfig(this.id, this.ha_class, this.config)
		this.HA.publishProperty(this.id, 'availability', 'online', {retain: false})
	}

	setProperty(prop, value) {
		//console.log("HA write ", prop, value)
		const def = this.fields_by_ha[prop]
		if(!def || def.writable === false) {
			console.warn(`Attempting to set property ${prop} which is not writable`)
			return
		}

		if(def.write_xform)
			value = def.write_xform.call(this, value)

		if(value === null || value === undefined)
			return

		if(def.write_callback) {
			def.write_callback.call(this, value)
		} else {
			this.raw_clip_state[def.id] = value

			let attach = []
			if(Array.isArray(def.write_attach))
				attach = def.write_attach
			if(typeof(def.write_attach) === 'function')
				attach = def.write_attach(value)

			const write_fields = [ def.id ].concat(attach)
			const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
			//console.log("Sending ", tlvArray)
			this.clip.send([1, 1, 2, 1, 1], tlvArray)
		}
	}
}
module.exports = HADevice
