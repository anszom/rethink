const HADevice = require('./base.js')

class Device extends HADevice {
    constructor(HA, clipDevice, provisionMsg) {
        super(HA, 'climate', clipDevice, provisionMsg)

        // Adding current_temperature field with read transformation to divide raw value by 2
        this.addField({
            id: 0x1fd, name: 'current_temperature', writable: false,
            read_xform: (raw) => raw / 2 // Converts raw temperature data to actual temperature
        })

        // Adding power field with read/write transformations and callbacks
        this.addField({
            id: 0x1f7, name: 'power', readable: false,
            /**
             * 
             * @param val 
             * @returns Transforms human-readable data into Int format so that the device can understand.
             */
            write_xform: (val) => val === 'ON' ? 1 : 0, // Converts power state to binary
            write_attach: (raw) => raw ? [0x1f9, 0x1fa] : [], // Attaches additional fields based on power state
            read_xform: (raw) => raw ? 'ON' : 'OFF', // Converts binary power state to human-readable form
            read_callback: (val) => {
                // Process mode field when power state is read
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
            }
        })

        // Adding mode field with transformations based on power state and raw values
        this.addField({
            id: 0x1f9, name: 'mode',
            read_xform: (raw) => {
                const modes2ha = ['cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto']
                if (this.raw_clip_state[0x1f7] === 0)
                    return 'off' // If power is off, mode is 'off'
                return modes2ha[raw] // Converts raw mode data to human-readable mode
            },
            write_xform: (val) => {
                const modes2clip = { cool: 0, dry: 1, fan_only: 2, heat: 4, auto: 6, off: -1 }
                return modes2clip[val] // Converts human-readable mode to raw data
            },
            write_attach: [0x1fa, 0x1fe] // Attaches fan mode and temperature fields
        })

        // Adding fan_mode field with read/write transformations
        this.addField({
            id: 0x1fa, name: 'fan_mode',
            read_xform: (raw) => {
                const modes2ha = [undefined, undefined, 'very low', 'low', 'medium', 'high', 'very high', undefined, 'auto']
                return modes2ha[raw] // Converts raw fan mode data to human-readable form
            },
            write_xform: (val) => {
                const modes2clip = { 'very low': 2, 'low': 3, 'medium': 4, 'high': 5, 'very high': 6, auto: 8 }
                return modes2clip[val] // Converts human-readable fan mode to raw data
            },
            write_attach: [0x1f9, 0x1fe] // Attaches mode and temperature fields
        })

        // Adding temperature field with read and write transformations
        this.addField({
            id: 0x1fe, name: 'temperature',
            read_xform: (raw) => raw / 2, // Converts raw temperature data to actual temperature
            write_xform: (val) => Math.round(val * 2), // Converts actual temperature to raw data
            write_attach: [0x1f9, 0x1fa] // Attaches mode and fan mode fields
        })

        // Adding vertical_swing_mode field with read/write transformations
        this.addField({
            id: 0x321, name: 'swing_mode',
            read_xform: (raw) => {
                const modes2ha = ["Vertical Off", "Vertical 1", "Vertical 2", "Vertical 3", "Vertical 4", "Vertical 5", "Vertical 6"]
                modes2ha[100] = "Vertical On"
                const mode = modes2ha[raw];
                this.processKeyValue(0x1234, mode)
                return mode; // Converts raw vertical swing mode data to human-readable form
            },
            write_xform: (val) => {
                const modes2clip = { "Vertical Off": 0, "Vertical 1": 1, "Vertical 2": 2, "Vertical 3": 3, "Vertical 4": 4, "Vertical 5": 5, "Vertical 6": 6, "Vertical On": 100 }
                return modes2clip[val] // Converts human-readable vertical swing mode to raw data
            },
            write_attach: [0x1f9, 0x1fa] // Attaches mode and fan mode fields
        })

        // Adding horizontal_swing_mode field with read/write transformations
        this.addField({
            id: 0x322, name: 'horizontal_swing_mode',
            read_xform: (raw) => {
                const modes2ha = ["Horizontal Off", "Horizontal 1", "Horizontal 2", "Horizontal 3", "Horizontal 4", "Horizontal 5"]
                modes2ha[13] = "Horizontal 1-3"
                modes2ha[35] = "Horizontal 3-5"
                modes2ha[100] = "Horizontal On"
                const mode = modes2ha[raw];
                this.processKeyValue(0x1234, mode)
                return mode; // Converts raw horizontal swing mode data to human-readable form
            },
            write_xform: (val) => {
                const modes2clip = { "Horizontal Off": 0, "Horizontal 1": 1, "Horizontal 2": 2, "Horizontal 3": 3, "Horizontal 4": 4, "Horizontal 5": 5, "Horizontal 1-3": 13, "Horizontal 3-5": 35, "Horizontal On": 100 }
                return modes2clip[val] // Converts human-readable horizontal swing mode to raw data
            },
            write_attach: [0x1f9, 0x1fa] // Attaches mode and fan mode fields
        }, false)

        // Configuring the device with additional properties
        Object.assign(this.config, {
            name: 'LG Air Conditioner',
            temperature_unit: 'C',
            temp_step: 0.5,
            precision: 0.5,
            fan_modes: ['auto', 'very low', 'low', 'medium', 'high', 'very high'],
            swing_modes: [ '1', '2', '3', '4', '5', '1-3', '3-5', 'on', 'off' ],
			vertical_swing_modes: [ '1', '2', '3', '4', '5', '6', 'on', 'off' ] // not supported by HA
        })
    }
}

module.exports = Device

// Explanation of methods:
// read_xform: Transforms raw data from the device into a human-readable format.
// write_xform: Transforms human-readable data into a format that the device can understand.
// processKeyValue: Processes and updates the value of a specific field based on raw data.
// setProperty: Sets a property of the device and triggers any attached fields to update.
