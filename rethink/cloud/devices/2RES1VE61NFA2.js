const HADevice = require("./base.js");

/**
 * LG Refrigerator/Freezer Model 2RES1VE61NFA2
 * Protocol: AA LEN TYPE CMD [DATA...] CHECKSUM BB
 *
 * Known commands:
 * - 0x10A8 (TYPE=0x10, CMD=0xA8): Door status
 *   - Sub-register 0x01: Door sensor state (0x00=closed, 0x01=open)
 */
class Device extends HADevice {
  constructor(HA, clipDevice, provisionMsg) {
    super(HA, "binary_sensor", clipDevice, provisionMsg);

    // Door sensor: tag 0x10A8, value is (sub_register << 8) | state
    // Sub-register 0x01 = door sensor
    this.addField({
      id: 0x10A8,
      name: "state",
      writable: false,
      read_xform: (raw) => {
        // raw = (sub_register << 8) | door_state
        const subReg = (raw >> 8) & 0xFF;
        const doorState = raw & 0xFF;

        // Only process if sub-register is 0x01 (door sensor)
        if (subReg === 0x01) {
          return doorState === 0x01 ? "ON" : "OFF"; // ON = open, OFF = closed
        }
        return null; // Ignore other sub-registers
      },
    });

    Object.assign(this.config, {
      name: "LG Refrigerator Door",
      device_class: "door",
      payload_on: "ON",
      payload_off: "OFF",
    });
  }

  // Override query since this device doesn't use TLV protocol
  query() {
    // The fridge uses a different protocol, so we don't send TLV queries
    // Just wait for the device to send status updates
  }
}

module.exports = Device;
