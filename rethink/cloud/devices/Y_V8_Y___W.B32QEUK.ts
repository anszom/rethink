import HADevice from './base.js'
import { Device as ClipDevice } from "../devmgr.js"
import { type Connection } from '../homeassistant.js'
import { ClipDeployMessage } from '../../util/clip.js'
import { allowExtendedType } from '../../util/util.js'
import AABBDevice from './aabb_device.js'

/* official integration exposes these:

event.device_201_notification
Device 201 Notification 
event_types: washing_is_complete, error_during_washing

number.device_201_delayed_end
Device 201 Delayed end
min: 0
max: 19
step: 1
mode: box
unit_of_measurement: h

sensor.device_201_delayed_end
Device 201 Delayed end
device_class: timestamp

sensor.device_201_total_time
Device 201 Total time 
unit_of_measurement: min
device_class: duration
friendly_name: Device 201 Total time

*/

// Names are based on the official ThinQ integration, the missing ones - on the values returned by the backend.
const ERRORS = [
    'ok',
    'door_lock_error', // DE2
    'door_open_error', // DE1
    'water_supply_error', // IE
    'water_drain_error', // OE
    'out_of_balance_error', // UE
    'overfill_error', // FE
    'water_level_sensor_error', // PE
    'temperature_sensor_error', // TE
    'locked_motor_error', // LE
    undefined,  
    'dHE_error',
    'power_fail_error', // PF
    'FF_error',
    'DCE_error',
    'AE_error',
    'eeprom_error',
    'PS_error',
    'door_sensor_error', // DE4
    'vibration_sensor_error',  // VS
    'LE8_error',
    'LE9_error',
    'ED1_error',
    'ED2_error',
    'ED3_error',
    'ED4_error',
    'ED5_error',
]

const STATES = [
    'power_off',
    'initial',
    'pause',
    undefined,
    'detecting',
    undefined,
    'running',
    'rinsing',
    'spinning',
    'drying',
    'end',
    'cool_down',
    'rinse_hold',
    undefined,
    'refreshing',
    'steam_softening',
    'demo',
    undefined,
    'error',
    'auto_dt_open_pause'
]

export default class Device extends AABBDevice {
    constructor(HA: Connection, clipDevice: ClipDevice, provisionMsg: ClipDeployMessage) {
        super(HA, 'device', allowExtendedType({
            ...HADevice.deviceConfig(provisionMsg, { name: "LG Washer" }),
            components: {
                power: {
                    platform: 'switch',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    command_topic: '$this/power/set',
                    name: 'Power',
                },
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Current status',
                    options: [ ...STATES.filter((a) => a !== undefined), 'unknown_status' ]
                },
                error: {
                    platform: 'sensor',
                    unique_id: '$deviceid-error',
                    state_topic: '$this/error',
                    name: 'Error',
                    options: [ ...ERRORS.filter((a) => a !== undefined), 'unknown_error' ]
                },
                operation: {
                    platform: 'select',
                     unique_id: '$deviceid-operation',
                     command_topic: '$this/operation/set',
                     name: 'Operation',
                     options: [ 'start', 'stop', 'pause', 'power_off', 'wake_up' ]
                },
                cycles: {
                    platform: 'sensor',
                    unique_id: '$deviceid-cycles',
                    state_topic: '$this/cycles',
                    name: 'Cycle count',
                },
                remote_start: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-remote_start',
                    state_topic: '$this/remote_start',
                    name: 'Remote start'
                },
                door_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-door_lock',
                    state_topic: '$this/door_lock',
                    name: 'Door lock',
                    device_class: 'lock' // inverted logic, off=locked
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    name: 'Remaining time'
                }
            }
        }), clipDevice)
    }

    query() {
        // this is only *slightly* different to the init string for the fridge                       
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    processAABB(buf: Buffer) {
        if(buf.length === 53 && buf[0] == 0x20) {
            //  0                   1                   2                   3                   4                   5
            //  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2
            // 200A0039000390000100EB0027ee0001002080010500040505000141428002ff000101000300710101010001010101010101000100
            // ??????????????????????????????
            //                               ..                                                                                state 01=INITIAL
            //                                 ....                                                                            time remaining
            //                                     ....                                                                        initial time HH:MM
            //                                         ..                                                                      courseFL24inchBaseTitan
            //                                           ..                                                                    error
            //                                             ..                                                                  soilWash
            //                                               ..                                                                spin
            //                                                 ..                                                              temp
            //                                                   ..                                                            rinse
            //                                                     ..                                                          dryLevel
            //                                                       ....                                                      reserve time HH:MM
            //                                                           ..                                                    flags 1=turboWash 2=creaseCare 4=steamSoftener 8=ecoHybrid 10=medicRinse 20=rinseSpin 40=preWash 80=steam
            //                                                             ..                                                  flags 1=initialBit 2=remoteStart 20=wrinkleCare 40=doorLock 80=childLock
            //                                                               ..                                                flags 1=AIDDLed
            //                                                                 ????
            //                                                                     ..                                          preState
            //                                                                       ..                                        smartCourseFL24inchBaseTitan
            //                                                                         ..                                      cycle count
            //                                                                           ..                                    
            //                                                                             ..                                  downloadedCourseFL24inchBaseTitan
            //                                                                               ??????
            //                                                                                     ..                          standby
            //                                                                                       ????
            //                                                                                           ..                    ezCSDetergentSetVal
            //                                                                                             ..                  ezCSSoftenerSetVal
            //                                                                                               ..                ezDetergentAmount
            //                                                                                                 ..              ezSoftenerAmount
            //                                                                                                   ..            ezDispenseType
            //                                                                                                     ..          flags 1=ezDetergentEmpty 2=ezSoftenerEmpty 4=ezDispenseDrawerOpen 8=ezDispenseNotationOz 10=ezLinkDetergentEmpty 20=ezDispenseSetting
            //                                                                                                       ..        mlStep
            //                                                                                                         ??      
            const status = buf[15]
            const tremain = buf[16] * 60 + buf[17]
            const tinitial = buf[18] * 60 + buf[19]
            const error = buf[21];
            const flags1 = buf[30];
            const cycles = buf[36];

            this.publishProperty('power', status > 0 ? 'ON' : 'OFF')
            this.publishProperty('status', STATES[status] ?? 'unknown_status')
            this.publishProperty('error', ERRORS[error] ?? 'unknown_error')
            this.publishProperty('cycles', cycles)
            this.publishProperty('remote_start', (flags1 & 2) ? 'ON': 'OFF')
            this.publishProperty('door_lock', !(flags1 & 0x40) ? 'ON': 'OFF') // inverted logic, off=locked
            this.publishProperty('remaining_time', tremain)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        if(prop === 'power' && mqttValue === 'OFF') {
            // only power-off is supported
            this.send(Buffer.from('f024010100', 'hex'))
        }

        if(prop === 'operation') {
            // options: [ 'start', 'stop', 'power_off', 'wake_up' ]
            if(mqttValue === 'start') {
                // this op. is complex, it needs to supply the full configuration
                console.warn('not supported yet')
            }

            // this is actually 'pause'
            if(mqttValue === 'stop')
                this.send(Buffer.from('F024040100', 'hex'))

            if(mqttValue === 'power_off')
                this.send(Buffer.from('f024010100', 'hex'))

            if(mqttValue === 'wake_up')
                this.send(Buffer.from('F02A0100', 'hex'))
        }
    }
}