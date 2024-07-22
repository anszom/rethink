/**
 * The HADevice class provides the base functionality for Home Assistant devices.
 */
class HADevice {
    /**
     * Initializes the device with Home Assistant instance, class, clipDevice, and provision message.
     * @param {Object} HA - Home Assistant instance.
     * @param {string} ha_class - Home Assistant device class (e.g., 'climate').
     * @param {Object} clipDevice - The device being controlled.
     * @param {Object} provisionMsg - Provisioning message.
     */
    constructor(HA, ha_class, clipDevice, provisionMsg) {
        this.HA = HA; // Store Home Assistant instance
        this.clip = clipDevice; // Store the device being controlled
        this.id = clipDevice.id; // Unique ID for the device
        this.ha_class = ha_class; // Home Assistant device class

        // Configuration for the device in Home Assistant
        this.config = {
            availability: [{ topic: '$this/availability' }, { topic: '$rethink/availability' }],
            optimistic: false,
            object_id: '$deviceid',
            unique_id: '$deviceid',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: provisionMsg.data?.appInfo?.modelName,
                sw_version: provisionMsg.data?.appInfo?.softVer,
            },
        };

        this.fields_by_id = {}; // Fields indexed by their ID
        this.fields_by_ha = {}; // Fields indexed by their Home Assistant name
        this.raw_clip_state = {}; // Raw state of the device
    }

    /**
     * Publishes the availability of the device as 'offline' to Home Assistant.
     */
    drop() {
        this.HA.publishProperty(this.id, 'availability', 'offline', { retain: false });
    }

	// we waste memory by storing the field set per-device, not per-class. Whatever.
    /**
     * Adds a function field to the device.
     * @param {Object} options - Field options.
     * @param {boolean} [autoreg=true] - Whether to automatically register the field.
     */
    addField(options, autoreg = true) {
        if (options.id) {
            this.fields_by_id[options.id] = options; // Store field by ID
        }

        if (options.name) {
            this.fields_by_ha[options.name] = options; // Store field by Home Assistant name
        }

        if (autoreg) {
            if (options.writable === false) {
                // Set topic for non-writable fields
                this.config[options.name + '_topic'] = '$this/' + options.name;
            } else {
                if (options.readable !== false) {
                    // Set state topic for writable fields
                    this.config[options.name + '_state_topic'] = '$this/' + options.name;
                }
                // Set command topic for writable fields
                this.config[options.name + '_command_topic'] = '$this/' + options.name + '/set';
            }
        }
    }

    /**
     * Sends a query to the device to request its state.
     */
    query() {
        this.clip.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 2 }]);
    }

    /**
     * Processes an array of TLV (Type-Length-Value) objects, updating the device state accordingly.
     * @param {Array} tlvArray - Array of TLV objects.
     */
    processTLV(tlvArray) {
        tlvArray.forEach((tv) => this.processKeyValue(tv.t, tv.v));
    }

    /**
     * Processes a single key-value pair.
     * @param {number} k - The key (field ID).
     * @param {*} v - The value associated with the key.
     */
    processKeyValue(k, v) {
        // Update the raw state with the key-value pair
        this.raw_clip_state[k] = v;

        // Retrieve the field definition by ID
        const def = this.fields_by_id[k];
        if (!def)
            return;

        // Apply read transformation if defined
        if (def.read_xform)
            v = def.read_xform.call(this, v);

        // Call the read callback if defined
        if (def.read_callback) {
                def.read_callback.call(this, v);
        } else {
            // Publish the property to Home Assistant if it's readable
            if (def.readable !== false) {
                this.HA.publishProperty(this.id, def.name, v);
            }
        }
    }

    /**
     * Publishes the device configuration to Home Assistant.
     */
    publishConfig() {
        // Publish the device configuration
        this.HA.publishConfig(this.id, this.ha_class, this.config);
        // Set the availability to 'online'
        this.HA.publishProperty(this.id, 'availability', 'online', { retain: false });
    }

    /**
     * Sets a property of the device.
     * @param {string} prop - The property name.
     * @param {*} value - The value to set.
     */
    setProperty(prop, value) {
		//console.log("HA write ", prop, value)
        // Retrieve the field definition by Home Assistant name
        const def = this.fields_by_ha[prop];
        if (!def || def.writable === false) {
            console.warn(`Attempting to set property ${prop} which is not writable`);
            return;
        }

        // Apply write transformation if defined
        if (def.write_xform) value = def.write_xform.call(this, value);

        if (value === null || value === undefined) 
            return;

        // Call the write callback if defined
        if (def.write_callback) {
            def.write_callback.call(this, value);
        } else {
            // Update the raw state and send the updated state to the device
            this.raw_clip_state[def.id] = value;

            let attach = [];
            if (Array.isArray(def.write_attach)) attach = def.write_attach;
            if (typeof def.write_attach === 'function')
                attach = def.write_attach(value);

            // Create a TLV array with the main field ID and attached fields
            const write_fields = [def.id].concat(attach);
            const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }));
            //console.log("Sending ", tlvArray)
			// Send the TLV array to the device
            this.clip.send([1, 1, 2, 1, 1], tlvArray);
        }
    }
}

module.exports = HADevice;
