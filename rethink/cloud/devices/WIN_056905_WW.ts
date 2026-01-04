import TLVDevice from './tlv_device.js'
import { Device as ClipDevice } from "../devmgr.js"
import { Config, type Connection }  from '../homeassistant.js'
import { ClipDeployMessage } from '../../util/clip.js'
import { allowExtendedType } from '../../util/util.js';
import HADevice from './base.js';

/**
 * LG Air Conditioner Model LW1823HRSM
 */
export default class Device extends TLVDevice {
  constructor(HA: Connection, clipDevice: ClipDevice, provisionMsg: ClipDeployMessage) {
    super(HA, "climate", clipDevice)
    const config: Config = allowExtendedType({
      ...HADevice.componentConfig(provisionMsg),
      name: "LG Air Conditioner",
      temperature_unit: "C",
      temp_step: 0.5,
      precision: 0.5,
      modes: ["off", "cool", "fan_only", "heat"],
      fan_modes: ["low", "high"],
      swing_modes: ["on", "off"],
    });

    this.addField(config, {
      id: 0x1fd,
      name: "current_temperature",
      writable: false,
      read_xform: (raw) => raw / 2,
    });

    this.addField(config, {
      id: 0x1fe,
      name: "temperature",
      read_xform: (raw) => raw / 2,
      write_xform: (valStr) => {
        const val = Number(valStr)
        // set val to min: 61F, max: 86F
        const minCel = 16;
        const maxCel = 30.0;
        if (val < minCel) return minCel * 2;
        if (val > maxCel) return maxCel * 2;
        return Math.round(val * 2);
      },
      write_attach: [0x1f9, 0x1fa],
    });

    this.addField(config, {
      id: 0x1f7,
      name: "power",
      readable: false,
      write_xform: (val) => (val === "ON" ? 1 : 0),
      write_attach: (raw) => (raw ? [0x1f9] : []),
      read_xform: (raw) => (raw ? "ON" : "OFF"),
      read_callback: (val) => {
        // update 'mode' instead
        this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9]);
      },
    });

    this.addField(config, {
      id: 0x1f9,
      name: "mode",
      read_xform: (raw) => {
        const modes2ha = [
          "cool",
          undefined,
          "fan_only",
          undefined,
          "heat",
          undefined,
          undefined,
          undefined,
          undefined, // 'eco'
        ];
        if (this.raw_clip_state[0x1f7] === 0) return "off";
        return modes2ha[raw];
      },
      write_xform: (val) => {
        const modes2clip = { cool: 0, fan_only: 2, heat: 4, dry: 8 };
        if (val === "off") {
          // Call function power (0x1f7) with value OFF
          this.setProperty("power", "OFF");
        } else {
          this.setProperty("power", "ON");
        }
        return modes2clip[val];
      },
      write_attach: [0x1f7, 0x1fa, 0x1fe, 0x322],
    });

    this.addField(config, {
      id: 0x1fa,
      name: "fan_mode",
      read_xform: (raw) => {
        const modes2ha = [];
        modes2ha[2] = "low";
        modes2ha[6] = "high";
        return modes2ha[raw];
      },
      write_xform: (val) => {
        const modes2clip = {
          low: 2,
          high: 6,
        };
        return modes2clip[val];
      },
      write_attach: [0x1f9, 0x1fe],
    });

    this.addField(config, {
      id: 0x322,
      name: "swing_mode",
      read_xform: (raw) => {
        const modes2ha = [];
        modes2ha[100] = "on";
        modes2ha[0] = "off";
        return modes2ha[raw];
      },
      write_xform: (val) => {
        const modes2clip = {
          off: 0,
          on: 100,
        };
        return modes2clip[val];
      },
      write_attach: [0x1f9, 0x1fa],
    });

    this.setConfig(config)
  }
}