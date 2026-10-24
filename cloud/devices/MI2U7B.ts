import HADevice from './base'
import type { Device as Thinq2Device } from '../thinq2/device'
import type { Connection } from '../homeassistant'
import type { Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import { parseSideKickFrame } from './MI2U7B_status'

// Passive model support: never poll, acknowledge or send appliance commands.
export default class Device extends HADevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq.id, meta.modelId)
        thinq.on('data', (frame) => {
            const update = parseSideKickFrame(frame)
            if (!update) return
            if (update.kind === 'drawer') this.publishProperty('drawer', update.drawer)
            else {
                this.publishProperty('status', update.status)
                this.publishProperty('course', update.course)
                this.publishProperty('remaining_time', update.remaining_time)
            }
        })
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG SideKick' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    drawer: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drawer',
                        state_topic: '$this/drawer',
                        name: 'Drawer',
                        device_class: 'opening',
                    },
                },
            }),
        )
    }

    override setProperty(_prop: string, _value: string) {}
}
