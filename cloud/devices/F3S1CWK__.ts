import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

// Washer half of the LG WashTower (ThinQ2 deviceType 221, model F3S1CWK__); the dryer half is
// W3S1CVK2EVS_D_US. Plain AABB framing under class 0x33:
//   0xEC        two stacked 45-byte status blocks (old, current); we read the current one.
//   0xEB        one status block, sent after the appliance (re)connects.
//   0x72        short frame announcing that remote control was enabled (C9) or disabled (C8). It fires
//               when Remote Start is armed and whenever a cycle starts, pauses or ends — not decoded.
//   0x31, 0xBD, 0xCD, 0xD8, 0xE2  identity, full dumps and keepalives — not decoded.
//
// Commands: power off and power on are key/value frames F0 E5 00 02 01 FF 01 02 00 / 01, captured from the
// ThinQ app (answered AA083300E5009FBB). The washer stays on Wi-Fi while off and accepts power on without
// Remote Start armed; powering on does not arm it.
//
// Inside the block, the record leads with a 0x2b marker and follows the washer half of
// WTL_FXU_BDV_NA_01's 95-byte state block field for field, shifted by one (that block has no marker),
// but carries only the washer half. The course codes are the WTL ones; the temperature and spin codes
// are not, so all tables here are this model's own. Every field below was checked against the control
// panel by walking the dial, stepping each setting through all of its positions, toggling each option,
// and running a Rinse+Spin cycle with a pause.

const CLASS_BYTE = 0x33
const STATUS_LENGTH = 45
const RECORD_MARKER = 0x2b

// Offsets below are relative to the record's own 0x2b marker (rec[0]).
const SOIL_OFFSET = 2
const TEMP_OFFSET = 3
// rec[4] is the extra rinse setting, 0x0e for none and counting up from there.
const EXTRA_RINSE_OFFSET = 4
const EXTRA_RINSE_NONE = 0x0e
const SPIN_OFFSET = 5
const COURSE_OFFSET = 6
// Both times are 16-bit minute counts. Initial time pins once a cycle starts while remaining counts down.
const REMAINING_TIME_OFFSET = 14
const INITIAL_TIME_OFFSET = 16
// Energy used by the current cycle in Wh, WTL's courseSpendPower. It restarts from 0 with each cycle
// and read 41 at the end of a Rinse+Spin the LG cloud reported as courseSpendPower 42.
const ENERGY_OFFSET = 18
// The course stored in the Downloaded dial position (always reported; it is what runs while COURSE_OFFSET
// reads 0xff).
const DOWNLOADED_COURSE_OFFSET = 24
const STATE_OFFSET = 22
// rec[25] is the load level: 0 while the washer will size the load itself (Normal), 7 otherwise.
const LOAD_LEVEL_OFFSET = 25
// rec[28]: the total number of rinses the cycle will do, extra rinses included.
const RINSE_COUNT_OFFSET = 28
// rec[29]: washes since the last Tub Clean; went up by one when the Rinse+Spin cycle ended.
const TCL_COUNT_OFFSET = 29
const SIGNAL_OFFSET = 30

const OPT1_OFFSET = 35
const OPT1_TURBO_WASH = 0x20
const OPT1_PRE_WASH = 0x40
const OPT2_OFFSET = 36
const OPT2_STEAM = 0x10
const OPT3_OFFSET = 38
// Lit by the panel's Remote indicator: set when Remote Start is armed, and by the washer itself for the
// length of a cycle. The door lock is not reported separately.
const OPT3_REMOTE_START = 0x10
const OPT3_CHILD_LOCK = 0x20
const OPT4_OFFSET = 40
const OPT4_EXTRA_RINSE = 0x40

const STATE_OFF = 0x00
const STATE_END = 0x10
const COURSE_DOWNLOADED = 0xff

// Off, Standby, Paused, Starting, Rinsing, Spinning and End were seen on this washer. The remaining codes
// are carried over from WTL_FXU_BDV_NA_01, which shares this record.
const STATUS = Enum.of({
    Off: 0x00,
    Standby: 0x01,
    Paused: 0x02,
    Detecting: 0x03,
    Delayed: 0x07,
    Soaking: 0x08,
    'Pre-wash': 0x09,
    Washing: 0x0b,
    Rinsing: 0x0c,
    'Rinse hold': 0x0d,
    Spinning: 0x0e,
    End: 0x10,
    Error: 0x16,
    Starting: 0x24,
})

// Each dial position and long-press course, named as printed on the panel. Spin Only (0x4e) was not
// selected during the capture; its code and name come from the modelJSON (SPIN_ONLY).
const COURSE = Enum.of({
    Bedding: 0x0d,
    Delicates: 0x16,
    'Heavy Duty': 0x23,
    Sanitary: 0x3c,
    Normal: 0x2e,
    'Speed Wash': 0x4a,
    'Spin Only': 0x4e,
    'Tub Clean': 0x55,
})

// Courses the ThinQ app can download into the Downloaded dial position (its Download Cycles list), by the
// code the washer reports at rec[24]. Captured by downloading each one from the app while bridged; the
// names are the app's. rec[21] holds the downloaded course's base course instead (0x2e Normal for Color
// Care, 0x37 for Rinse + Spin).
const DOWNLOADED_COURSE = Enum.of({
    'Sweat Stains': 0x65,
    'Small Load': 0x69,
    'Overnight Wash': 0x6a,
    'Color Care': 0x6f,
    Denim: 0x70,
    'Full Load Wash': 0x71,
    Beachwear: 0x73,
    'Sports Wear': 0x75,
    'Half Load Wash': 0x76,
    EconoWash: 0x78,
    'Delicate Dresses': 0x79,
    Blanket: 0x7c,
    'Juice and food stains': 0x7e,
    'Spin Only': 0x81,
    'Rinse + Spin': 0x90,
    'Bright Whites': 0xdc,
    'Hand Wash / Wool': 0xdd,
    Allergiene: 0xde,
    'Perm. Press': 0xdf,
    Towels: 0xe0,
})

// 0 reads as "not applicable": Rinse+Spin and Steam clear both soil and temperature.
const SOIL = Enum.of({
    Light: 0x01,
    'Light-Normal': 0x02,
    Normal: 0x03,
    'Normal-Heavy': 0x04,
    Heavy: 0x05,
})

// Names are this model's modelJSON labels (WM_KEPLER_*), matching the panel's Cold...Hot scale:
// FL27_TEMP_TAPCOLD reads "Cold" and FL27_TEMP_COLD "Cool" on this washer.
const TEMP = Enum.of({
    Cold: 0x0d,
    Cool: 0x0e,
    Warm: 0x10,
    'Very Warm': 0x12,
    Hot: 0x13,
})

// Also from the modelJSON labels; SPIN_DRAIN_ONLY is the panel's No Spin.
const SPIN = Enum.of({
    'No Spin': 0x0c,
    Low: 0x0d,
    Medium: 0x0e,
    'Medium High': 0x0f,
    High: 0x10,
})

const SIGNAL = Enum.of({
    Off: 0x00,
    High: 0x04,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, true)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    wash_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wash_completed',
                        state_topic: '$this/wash_completed',
                        name: 'Wash completed',
                        icon: 'mdi:check-circle',
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
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:liquid-spot',
                        device_class: 'enum',
                        options: SOIL.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMP.options,
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                        device_class: 'enum',
                        options: SPIN.options,
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse_count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinses',
                        icon: 'mdi:water-sync',
                        state_class: 'measurement',
                    },
                    extra_rinse: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-extra_rinse',
                        state_topic: '$this/extra_rinse',
                        name: 'Extra rinse',
                        icon: 'mdi:water-plus',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra_rinse_count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-plus',
                        state_class: 'measurement',
                    },
                    turbo_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_wash',
                        state_topic: '$this/turbo_wash',
                        name: 'TurboWash',
                        icon: 'mdi:fast-forward',
                    },
                    pre_wash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-pre_wash',
                        state_topic: '$this/pre_wash',
                        name: 'Pre-wash',
                        icon: 'mdi:water-sync',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start',
                        icon: 'mdi:remote',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child_lock',
                        state_topic: '$this/child_lock',
                        name: 'Control lock',
                        icon: 'mdi:lock-outline',
                    },
                    signal: {
                        platform: 'sensor',
                        unique_id: '$deviceid-signal',
                        state_topic: '$this/signal',
                        name: 'Signal',
                        icon: 'mdi:bell-outline',
                        device_class: 'enum',
                        options: SIGNAL.options,
                        entity_category: 'diagnostic',
                    },
                    load_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-load_level',
                        state_topic: '$this/load_level',
                        name: 'Load level',
                        icon: 'mdi:weight',
                        state_class: 'measurement',
                        entity_category: 'diagnostic',
                    },
                    energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-energy',
                        state_topic: '$this/energy',
                        name: 'Energy',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:lightning-bolt',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub_clean_count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Washes since Tub Clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    power_off: {
                        platform: 'button',
                        unique_id: '$deviceid-power_off',
                        command_topic: '$this/power_off/set',
                        payload_press: 'PRESS',
                        name: 'Power off',
                        icon: 'mdi:power-off',
                        availability: [{ topic: '$this/power', payload_available: 'ON', payload_not_available: 'OFF' }],
                    },
                    power_on: {
                        platform: 'button',
                        unique_id: '$deviceid-power_on',
                        command_topic: '$this/power_on/set',
                        payload_press: 'PRESS',
                        name: 'Power on',
                        icon: 'mdi:power',
                        availability: [{ topic: '$this/power', payload_available: 'OFF', payload_not_available: 'ON' }],
                    },
                    downloaded_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded_course',
                        state_topic: '$this/downloaded_course',
                        name: 'Downloaded course',
                        icon: 'mdi:download',
                        device_class: 'enum',
                        options: DOWNLOADED_COURSE.options,
                    },
                },
            }),
        )
    }

    setProperty(prop: string, mqttValue: string) {
        if (mqttValue !== 'PRESS') return
        if (prop === 'power_off') this.send(Buffer.from('F0E5000201FF010200', 'hex'))
        else if (prop === 'power_on') this.send(Buffer.from('F0E5000201FF010201', 'hex'))
    }

    processAABB(buf: Buffer) {
        this.processCommonStatus(buf, CLASS_BYTE, STATUS_LENGTH, this.processStatus)
    }

    private processStatus(status: Buffer) {
        const rec = status.subarray(1)
        if (rec[0] !== RECORD_MARKER) return

        const state = rec[STATE_OFFSET]
        const isOff = state === STATE_OFF
        const isEnd = state === STATE_END
        // Both timers park on stale values once there is no cycle in flight.
        const idle = isOff || isEnd

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS.map(state))

        const course = rec[COURSE_OFFSET]
        this.publishProperty(
            'course',
            course === COURSE_DOWNLOADED ? DOWNLOADED_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET]) : COURSE.map(course),
        )
        this.publishProperty('downloaded_course', DOWNLOADED_COURSE.map(rec[DOWNLOADED_COURSE_OFFSET]))
        this.publishProperty('remaining_time', idle ? 0 : rec.readUInt16BE(REMAINING_TIME_OFFSET))
        this.publishProperty('initial_time', idle ? 0 : rec.readUInt16BE(INITIAL_TIME_OFFSET))
        this.publishProperty('soil', SOIL.map(rec[SOIL_OFFSET]))
        this.publishProperty('temp', TEMP.map(rec[TEMP_OFFSET]))
        this.publishProperty('spin', SPIN.map(rec[SPIN_OFFSET]))
        this.publishProperty('rinse_count', rec[RINSE_COUNT_OFFSET])
        this.publishProperty('energy', rec.readUInt16BE(ENERGY_OFFSET))

        const extraRinse = rec[EXTRA_RINSE_OFFSET]
        this.publishProperty('extra_rinse_count', extraRinse >= EXTRA_RINSE_NONE ? extraRinse - EXTRA_RINSE_NONE : 0)
        this.publishProperty('extra_rinse', (rec[OPT4_OFFSET] & OPT4_EXTRA_RINSE) !== 0 ? 'ON' : 'OFF')

        this.publishProperty('turbo_wash', (rec[OPT1_OFFSET] & OPT1_TURBO_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('pre_wash', (rec[OPT1_OFFSET] & OPT1_PRE_WASH) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('steam', (rec[OPT2_OFFSET] & OPT2_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('remote_start', (rec[OPT3_OFFSET] & OPT3_REMOTE_START) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('child_lock', (rec[OPT3_OFFSET] & OPT3_CHILD_LOCK) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('signal', SIGNAL.map(rec[SIGNAL_OFFSET]))
        this.publishProperty('load_level', rec[LOAD_LEVEL_OFFSET])
        this.publishProperty('tub_clean_count', rec[TCL_COUNT_OFFSET])

        // Keep completion latched through the automatic power-off that follows End; any other
        // non-Off state clears it.
        if (isEnd) this.publishProperty('wash_completed', 'ON')
        else if (!isOff || !this.publishCache.has('wash_completed')) this.publishProperty('wash_completed', 'OFF')

        // Not published:
        //   * door position and door lock — opening the door produces no frame, and no lock bit separate
        //     from remote_start could be isolated.
        //   * rec[20] (error) — no fault occurred during the capture.
        //   * Drum Light (rec[38] 0x40) and the AI indicator (rec[41] 0x01), which are panel lights.
    }
}
