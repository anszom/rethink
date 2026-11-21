import { type ComponentInfo, type DeviceDiscovery } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import RV13D5JSD_D_US from './RV13D5JSD_D_US'

// Dryer half of the LG WashTower (ThinQ2 deviceType 222, model W3S1CVK2EVS_D_US); the washer half is
// F3S1CWK__. It sends the RV13D5JSD record under class 0x34 instead of 0x30, one byte longer
// (30-byte status blocks, marker 0x1c), with every offset unchanged relative to the marker. Course,
// time, dry level, temperature, Time Dry, Signal, option bits and the Drying/Pause phases were checked
// against the panel while walking the dial and buttons on a real unit.
//
// Differences from the RV13D5JSD handler:
// - FLAGS (rec[15]) bit 0x01 is Control Lock, and OPT2 (rec[16]) bit 0x01 is Remote Start. The panel
//   also sets the latter on its own for the length of a cycle, same as the ThinQ Remote indicator.
// - This panel has no Damp Dry Signal option, so that entity is dropped.
// - Power off is the family's F0 24 01 01 00 and power on is F0 24 01 01 01, both captured from the ThinQ
//   app. The unit stays on Wi-Fi while off and accepts power on without Remote Start armed; powering on
//   does not arm it. No status request has been captured for this model, so none is sent.
// - FLAGS bit 0x40 follows the drum light (Wrinkle Care long-press), not the run state; not exposed.
// - rec[18:20] is the energy used by the current cycle in Wh, restarting from 0 with each cycle. Two
//   20-minute Time Dry runs ended on 68 and 69, and the ThinQ app's energy monitor showed 137 Wh for the day.

const CLASS_BYTE = 0x34
const STATUS_LENGTH = 30
const MARKER = 0x1c

const FLAGS_OFFSET = 15
const OPT2_OFFSET = 16
const FLAG_CHILD_LOCK = 0x01
const OPT2_REMOTE_START = 0x01
const ENERGY_OFFSET = 18

// Courses the ThinQ app can download into the Downloaded dial position, by code. Captured by downloading
// each one from the app while bridged; names are the app's. rec[24] always holds the stored course;
// rec[21] holds it only while the Downloaded position is selected (0 on the dial courses), when rec[6]
// carries that course's base course instead of a dial course.
const DOWNLOADED_OFFSET = 24
const SELECTED_DOWNLOAD_OFFSET = 21
const DOWNLOADED_COURSE = Enum.of({
    'Super Dry': 0x64,
    Denim: 0x65,
    'Ultra Delicate': 0x68,
    'Low Temp Dry': 0x69,
    Blankets: 0x6c,
    'Blanket Refresh': 0x6d,
    Deodorization: 0x6f,
    Lingerie: 0x70,
    'Overnight Dry': 0x72,
    'Perm. Press': 0x74,
    Sportswear: 0x75,
    Antibacterial: 0x76,
    'Steam Sanitary': 0x77,
    'Speed Dry': 0x78,
    'Air Dry': 0x79,
    Towels: 0x97,
    'Easy Ironing': 0xc9,
    'Wrinkle Prevention': 0xca,
    'Static Reduce': 0xcc,
    'Half Load Dry': 0xcd,
    'Full Load Dry': 0xce,
    'Rack Dry': 0xd0,
})

type SensorInfo = ComponentInfo & { state_topic: string; icon: string; [key: string]: unknown }

const POWER_ON = {
    platform: 'button',
    unique_id: '$deviceid-power_on',
    command_topic: '$this/power_on/set',
    payload_press: 'PRESS',
    name: 'Power on',
    icon: 'mdi:power',
    availability: [{ topic: '$this/power', payload_available: 'OFF', payload_not_available: 'ON' }],
}

export default class Device extends RV13D5JSD_D_US {
    protected classByte = CLASS_BYTE
    protected statusLength = STATUS_LENGTH
    protected marker = MARKER

    // The parent's constructor publishes its discovery config through here, so adjusting it in this
    // override means Home Assistant never sees the RV13D5JSD-only entities.
    setConfig(config: DeviceDiscovery) {
        const components = { ...config.components }
        delete components.damp_dry_signal
        components.power_on = POWER_ON
        components.remote_start = allowExtendedType<ComponentInfo, SensorInfo>({
            platform: 'binary_sensor',
            unique_id: '$deviceid-remote_start',
            state_topic: '$this/remote_start',
            name: 'Remote start',
            icon: 'mdi:remote',
        })
        components.child_lock = allowExtendedType<ComponentInfo, SensorInfo>({
            platform: 'binary_sensor',
            unique_id: '$deviceid-child_lock',
            state_topic: '$this/child_lock',
            name: 'Control lock',
            icon: 'mdi:lock',
        })
        components.downloaded_course = allowExtendedType<ComponentInfo, SensorInfo>({
            platform: 'sensor',
            unique_id: '$deviceid-downloaded_course',
            state_topic: '$this/downloaded_course',
            name: 'Downloaded course',
            icon: 'mdi:download',
            device_class: 'enum',
            options: DOWNLOADED_COURSE.options,
        })
        components.energy = allowExtendedType<ComponentInfo, SensorInfo>({
            platform: 'sensor',
            unique_id: '$deviceid-energy',
            state_topic: '$this/energy',
            name: 'Energy',
            device_class: 'energy',
            state_class: 'total_increasing',
            unit_of_measurement: 'Wh',
            icon: 'mdi:lightning-bolt',
        })
        super.setConfig({ ...config, components })
    }

    setProperty(prop: string, mqttValue: string) {
        if (mqttValue !== 'PRESS') return
        // Captured verbatim from the ThinQ app; AABBDevice adds the envelope (AA09F02401010[0|1]..BB).
        if (prop === 'power_off') this.send(Buffer.from('F024010100', 'hex'))
        else if (prop === 'power_on') this.send(Buffer.from('F024010101', 'hex'))
    }

    // the downloaded course selected on the dial, while the parent decodes the course byte
    private selectedDownload = 0

    publishProperty(prop: string, value: string | number | undefined) {
        if (prop === 'damp_dry_signal') return
        // on the Downloaded position the course byte is only the downloaded course's base course
        if (prop === 'course' && this.selectedDownload) value = DOWNLOADED_COURSE.map(this.selectedDownload)
        super.publishProperty(prop, value)
    }

    start() {}

    protected processStatus(status: Buffer) {
        const rec = status.subarray(1)
        if (rec[0] !== this.marker) return

        // rec[1] is the phase; 0 = off
        this.selectedDownload = rec[1] !== 0 ? rec[SELECTED_DOWNLOAD_OFFSET] : 0
        super.processStatus(status)
        this.publishProperty('downloaded_course', DOWNLOADED_COURSE.map(rec[DOWNLOADED_OFFSET]))
        this.publishProperty('child_lock', (rec[FLAGS_OFFSET] & FLAG_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (rec[OPT2_OFFSET] & OPT2_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))
    }
}
