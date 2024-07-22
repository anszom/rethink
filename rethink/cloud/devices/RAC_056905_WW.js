const HADevice = require('./base.js')

class Device extends HADevice {
    constructor(HA, clipDevice, provisionMsg) {
        super(HA, 'climate', clipDevice, provisionMsg)

        this.addField({
            id: 0x1fd, name: 'current_temperature', writable: false,
            read_xform: (raw) => raw/2
        })

        this.addField({
            id: 0x1f7, name: 'power', readable: false,
            write_xform: (val) => val === 'ON' ? 1 : 0, 
            write_attach: (raw) => raw ? [0x1f9, 0x1fa] : [], 
            read_xform: (raw) => raw ? 'ON' : 'OFF', 
            read_callback: (val) => {
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
            }
        })

        this.addField({
            id: 0x1f9, name: 'mode',
            read_xform: (raw) => {
                const modes2ha = [ 'cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto' ]
                if (this.raw_clip_state[0x1f7] === 0)
                    return 'off'
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip = { cool: 0, dry: 1, fan_only: 2, heat: 4, auto: 6, off: -1 }
                return modes2clip[val]
            },
            write_attach: [0x1fa, 0x1fe]
        })

        this.addField({
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

        this.addField({
            id: 0x1fe, name: 'temperature',
            read_xform: (raw) => raw/2,
            write_xform: (val) => Math.round(val*2),
            write_attach: [0x1f9, 0x1fa]
        })

        this.addField({
            id: 0x321, name: 'vertical_swing_mode',
            read_xform: (raw) => {
                const modes2ha = ["Vertical Off", "Vertical 1", "Vertical 2", "Vertical 3", "Vertical 4", "Vertical 5", "Vertical 6"]
                modes2ha[100] = "Vertical On"
                const mode = modes2ha[raw];
                        this.processKeyValue(0x1234, mode)
                return mode; 
            },
            write_xform: (val) => {
                const modes2clip = { "Vertical Off": 0, "Vertical 1": 1, "Vertical 2": 2, "Vertical 3": 3, "Vertical 4": 4, "Vertical 5": 5, "Vertical 6": 6, "Vertical On": 100 }
                return modes2clip[val]
            },
            write_attach: [0x1f9, 0x1fa]
        }, false)

        this.addField({
            id: 0x322, name: 'horizontal_swing_mode',
            read_xform: (raw) => {
                const modes2ha = ["Horizontal Off", "Horizontal 1", "Horizontal 2", "Horizontal 3", "Horizontal 4", "Horizontal 5"]
                modes2ha[13] = "Horizontal 1-3"
                modes2ha[35] = "Horizontal 3-5"
                modes2ha[100] = "Horizontal On"
                const mode = modes2ha[raw];
                        this.processKeyValue(0x1234, mode)
                return mode; 
            },
            write_xform: (val) => {
                const modes2clip = { "Horizontal Off": 0, "Horizontal 1": 1, "Horizontal 2": 2, "Horizontal 3": 3, "Horizontal 4": 4, "Horizontal 5": 5, "Horizontal 1-3": 13, "Horizontal 3-5": 35, "Horizontal On": 100 }
                return modes2clip[val]
            },
            write_attach: [0x1f9, 0x1fa]
        }, false)

        // Adding swing_mode field to manage combined swing modes
        this.addField({
            id: 0x1234, name: 'swing_mode',
            read_xform: (raw) => {
                return raw; // Returns the last updated swing mode
            },
            write_xform: (val) => {
                // Sets the appropriate swing mode based on the input value
                if (val.includes("Horizontal")) {
                    this.setProperty('horizontal_swing_mode', val);
                } else if (val.includes("Vertical")) {
                    this.setProperty('vertical_swing_mode', val);
                } else {
                    console.error('Invalid swing mode');
                }
                return val; // Returns the input value
            }
        })

        Object.assign(this.config, {
            name: 'LG Air Conditioner',
            temperature_unit: 'C',
            temp_step: 0.5,
            precision: 0.5,
            fan_modes: ['auto', 'very low', 'low', 'medium', 'high', 'very high'],
            swing_modes: [
                'Horizontal Off', 'Horizontal 1', 'Horizontal 2', 'Horizontal 3', 'Horizontal 4', 'Horizontal 5', 
                'Horizontal 1-3', 'Horizontal 3-5', 'Horizontal On', 
                'Vertical Off', 'Vertical 1', 'Vertical 2', 'Vertical 3', 'Vertical 4', 'Vertical 5', 'Vertical 6', 'Vertical On'
            ]
        })
    }
}

module.exports = Device
