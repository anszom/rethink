import HADevice from './base'
import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Metadata } from '../thinq'

// LG F3L2CNV4W_WIFI front-load washer (ThinQ1, deviceType 201).
//
// Field layout and enums below come from LG's own modelJson for this model - see
// cloud/thinq1/http.ts for how a device's modelId is matched to this class. The 24-byte
// Monitoring.protocol block maps 1:1 to the buffer `thinq.on('data')` delivers here (each
// field is exactly one byte, at the startByte given below).
//
// PowerOff and pause/stop are implemented, matching WTDN3.ts's wire shape
// ({Cmd:'Control', CmdOpt:..., Value:...}). Remote power-ON and starting a cycle
// (OperationStart) are not implemented yet: the modelJson defines no PowerOn action at all
// (this model's physical dial is presumably the only way to arm remote start).

const STATES: Record<number, string> = {
    0: 'Off',
    5: 'Initial',
    6: 'Paused',
    7: 'Error auto-off',
    10: 'Reserved',
    20: 'Detecting',
    21: 'Add drain',
    22: 'Load display',
    23: 'Running',
    30: 'Rinsing',
    31: 'Rinse hold',
    40: 'Spinning',
    50: 'Drying',
    60: 'End',
    61: 'Fresh care',
    79: 'Smart diagnosis',
    81: 'Tub clean count alarm',
    101: 'Smart diagnosis data',
}

const ERRORS: Record<number, string> = {
    0: 'OK',
    1: 'Door lock error (DE2)',
    2: 'No fill error (IE)',
    3: 'Not draining error (OE)',
    4: 'Out of balance error (UE)',
    5: 'Overfill error (FE)',
    6: 'Water sensor error (PE)',
    7: 'Thermistor error (tE)',
    8: 'Locked motor error (LE)',
    9: 'CE error',
    10: 'dHE error',
    11: 'Power failure error (PF)',
    12: 'Freeze error (FF)',
    13: 'dCE error',
    14: 'AE error',
    15: 'EEPROM error (EE)',
    16: 'Suds error (Sud)',
    17: 'Door open error (DE1)',
    18: 'Sliding lid open error (LOE)',
    19: 'PS error',
}

const SOIL: Record<number, string> = {
    0: '-',
    1: 'Light',
    2: 'Light-Normal',
    3: 'Normal',
    4: 'Normal-Heavy',
    5: 'Heavy',
}

const SPIN: Record<number, string> = {
    0: '-',
    1: 'No spin',
    2: 'Low',
    3: 'Medium',
    4: 'High',
    5: 'Extra high',
}

const TEMP: Record<number, string> = {
    0: '-',
    1: 'Tap cold',
    2: 'Cold',
    3: 'Semi warm',
    4: 'Warm',
    5: 'Warm',
    6: 'Hot',
    7: 'Extra hot',
}

const DRY_LEVEL: Record<number, string> = {
    0: '-',
    5: 'Turbo',
    6: 'Wind',
    7: '30 min',
    8: '60 min',
    9: '90 min',
    10: '120 min',
    11: '150 min',
}

const RINSE_COUNT: Record<number, string> = {
    0: '0',
    1: '1',
    2: '2',
    3: '3',
}

// Physical-dial ("AP") courses; ids beyond this table (smart/downloaded courses) fall
// back to their raw numeric id.
const AP_COURSE: Record<number, string> = {
    1: 'Tub Clean',
    2: 'Bright Whites',
    3: 'Bedding',
    4: 'Heavy Duty',
    5: 'Normal',
    6: 'Perm Press',
    7: 'Delicates',
    8: 'Towels',
    9: 'Speed Wash',
    10: 'Download Course',
    11: 'Spin Only',
}

export default class Device extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: Object.values(STATES),
                    },
                    pre_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-pre-state',
                        state_topic: '$this/pre_state',
                        name: 'Previous status',
                        icon: 'mdi:history',
                        entity_category: 'diagnostic',
                        device_class: 'enum',
                        options: Object.values(STATES),
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        icon: 'mdi:check-circle',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: {
                        platform: 'sensor',
                        unique_id: '$deviceid-error-message',
                        state_topic: '$this/error_message',
                        name: 'Error message',
                        icon: 'mdi:alert-circle-outline',
                        device_class: 'enum',
                        entity_category: 'diagnostic',
                        options: Object.values(ERRORS),
                    },
                    course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        name: 'Course',
                        icon: 'mdi:pin-outline',
                    },
                    soil: {
                        platform: 'sensor',
                        unique_id: '$deviceid-soil',
                        state_topic: '$this/soil',
                        name: 'Soil level',
                        icon: 'mdi:water-opacity',
                    },
                    spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        name: 'Spin',
                        icon: 'mdi:autorenew',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Water temperature',
                        icon: 'mdi:thermometer',
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry-level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:tumble-dryer',
                    },
                    rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse-count',
                        state_topic: '$this/rinse_count',
                        name: 'Rinse count',
                        icon: 'mdi:water-sync',
                        entity_category: 'diagnostic',
                    },
                    extra_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-extra-rinse-count',
                        state_topic: '$this/extra_rinse_count',
                        name: 'Extra rinse count',
                        icon: 'mdi:water-plus-outline',
                        entity_category: 'diagnostic',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child-lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        device_class: 'lock',
                        entity_category: 'diagnostic',
                    },
                    steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    prewash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-prewash',
                        state_topic: '$this/prewash',
                        name: 'Prewash',
                        icon: 'mdi:water-outline',
                    },
                    turbowash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        name: 'TurboWash',
                        icon: 'mdi:speedometer',
                    },
                    coldwash: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-coldwash',
                        state_topic: '$this/coldwash',
                        name: 'Cold wash',
                        icon: 'mdi:snowflake',
                    },
                    fresh_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-fresh-care',
                        state_topic: '$this/fresh_care',
                        name: 'Fresh care',
                        icon: 'mdi:air-filter',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote_start',
                        state_topic: '$this/remote_start',
                        name: 'Remote start armed',
                        icon: 'mdi:play-circle-outline',
                    },
                    tub_clean_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-tub-clean-count',
                        state_topic: '$this/tub_clean_count',
                        name: 'Cycles since tub clean',
                        icon: 'mdi:counter',
                        entity_category: 'diagnostic',
                    },
                    reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-reserve-time',
                        state_topic: '$this/reserve_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Delay wash time',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Initial time',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Remaining time',
                    },
                },
            }),
        )

        thinq.on('data', (buf) => {
            if (buf.length < 24) return

            const state = buf[0]
            const timeRemain = buf[1] * 60 + buf[2]
            const timeInitial = buf[3] * 60 + buf[4]
            const apCourse = buf[5]
            const error = buf[6]
            const soil = buf[7]
            const spin = buf[8]
            const temp = buf[9]
            const rinseOption = buf[10]
            const dryLevel = buf[11]
            const reserveH = buf[12]
            const reserveM = buf[13]
            const option1 = buf[14]
            const option2 = buf[15]
            const preState = buf[19]
            const tclCount = buf[21]

            const rinseCount = rinseOption & 0x0f
            const extraRinseCount = (rinseOption >> 4) & 0x0f

            this.publishProperty('power', state > 0 ? 'ON' : 'OFF')
            this.publishProperty('error_message', ERRORS[error] ?? 'unknown')
            this.publishProperty('error', error ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[state] ?? 'unknown')
            this.publishProperty('pre_state', STATES[preState] ?? 'unknown')
            this.publishProperty('course', AP_COURSE[apCourse] ?? String(apCourse))
            this.publishProperty('soil', SOIL[soil] ?? 'unknown')
            this.publishProperty('spin', SPIN[spin] ?? 'unknown')
            this.publishProperty('temp', TEMP[temp] ?? 'unknown')
            this.publishProperty('dry_level', DRY_LEVEL[dryLevel] ?? 'unknown')
            this.publishProperty('rinse_count', RINSE_COUNT[rinseCount] ?? String(rinseCount))
            this.publishProperty('extra_rinse_count', RINSE_COUNT[extraRinseCount] ?? String(extraRinseCount))
            this.publishProperty('child_lock', option1 & 0x01 ? 'ON' : 'OFF')
            this.publishProperty('steam', option1 & 0x04 ? 'ON' : 'OFF')
            this.publishProperty('prewash', option1 & 0x08 ? 'ON' : 'OFF')
            this.publishProperty('turbowash', option1 & 0x80 ? 'ON' : 'OFF')
            this.publishProperty('fresh_care', option2 & 0x01 ? 'ON' : 'OFF')
            this.publishProperty('coldwash', option2 & 0x10 ? 'ON' : 'OFF')
            this.publishProperty('remote_start', option2 & 0x80 ? 'ON' : 'OFF')
            this.publishProperty('tub_clean_count', tclCount)
            this.publishProperty('reserve_time', reserveH * 60 + reserveM)
            this.publishProperty('initial_time', timeInitial)
            this.publishProperty('remaining_time', timeRemain)
        })
    }

    start() {
        this.thinq.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }

    publishCache: Record<string, string | number> = {}

    publishProperty(prop: string, value: string | number) {
        if (this.publishCache[prop] === value) return

        this.publishCache[prop] = value
        this.HA.publishProperty(this.id, prop, value)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power' && mqttValue === 'OFF') {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Power', Value: 'Off', Format: 'B64', Data: '' })
        }
        // power=ON is intentionally not implemented: the modelJson defines no PowerOn
        // action for this model, only PowerOff/OperationStart/OperationStop.
        if (prop === 'pause') {
            this.thinq.send({ Cmd: 'Control', CmdOpt: 'Operation', Value: 'Stop', Format: 'B64', Data: '' })
        }
        // Starting a cycle (OperationStart) needs a base64-encoded 21-byte course-parameter
        // array per the modelJson's ControlWifi.action.OperationStart — not implemented
        // until the exact byte encoding is confirmed against a real captured command.
    }
}
