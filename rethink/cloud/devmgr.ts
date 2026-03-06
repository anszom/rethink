import { TypedEmitter } from "tiny-typed-emitter";
import { Device as T1Device } from "./thinq1/device.js";
import { Device as T2Device } from "./thinq2/device.js";

export type AnyDevice = T1Device | T2Device

type DeviceManagerEvents = {
    newDevice: (dev: AnyDevice) => void;
    dropDevice: (id: string) => void;
}

export class DeviceManager extends TypedEmitter<DeviceManagerEvents> {
    allDevices: Record<string, AnyDevice> = {}

    accept(device: AnyDevice) {
        this.allDevices[device.id] = device
        device.on('close', () => {
            if(this.allDevices[device.id] === device) {
                delete this.allDevices[device.id]
                this.emit('dropDevice', device.id)
            }
        })
        this.emit('newDevice', device)
    }
}