import { Device as Thinq2Device } from '../thinq2/device'
import log from '@/util/logging'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'

/*
 * LG CordZero A9 Stick Vacuum, ThinQ model HWWA9K_F2, deviceType 504.
 *
 * State packets use class 0xd2 followed by one or two 14-byte records. Each record contains
 * an index, a field count, and twelve one-byte fields; the trailing record is current. The
 * separate 0xd2/0x0a packet contains capabilities rather than live values and does not match
 * this record shape.
 *
 * The five writable settings use captured one-byte commands of the form
 * `aa 09 f0 24 <controlDataType> 01 <value> <checksum> bb`.
 */

const CLASS_TAG = 0xd2
const RECORDS_OFF = 2
const RECORD_LEN = 14
const FIELD_COUNT = 12

/** Offsets WITHIN a record. On the 20-byte single-record frame the record starts at 4, which
 *  is why the header comment states these as byte[6]..byte[17] — that is how the probes
 *  recorded them. */
const OFF = {
    monStatus: 2,
    cleanMode: 3,
    filterState: 4,
    passageClogged: 5,
    nozzle: 6,
    batteryLevel: 7,
    mopWithSucking: 8,
    completeClean: 9,
    suctionForce: 10,
    chargingMelody: 11,
    volume: 12,
    brightness: 13,
} as const

/** Command frame opcode: `aa 09 f0 24 <type> 01 <value> <ck> bb`. See the header note. */
const SET_STATE = [0xf0, 0x24]

/** modelJSON `ControlWifi` controlDataType ids, as the captured frames carry them. */
const CTRL = {
    mopSetting: 0x01,
    suctionForce: 0x02,
    chargingMelody: 0x03,
    volume: 0x04,
    brightness: 0x05,
} as const

// Every table below is modelJSON `MonitoringValue.<field>.valueMapping`, code for code, with
// English labels for the text resolved from this model's ko-KR language pack. Where LG's `label` is blank
// or points at another field's key (cleanMode OFF and NORMAL share @HS_TREM_NOR_W; filterState
// and passageClogged and batteryLevel have literal English labels), the mapping's own
// `_comment` is used instead — that is LG's text either way.

/** qmState.monStatus */
const MON_STATUS: Record<number, string> = { 1: 'Standby', 2: 'Cleaning', 3: 'Charging', 4: 'Charging complete' }

/** qmState.cleanMode — the suction level actually running right now. */
const CLEAN_MODE: Record<number, string> = { 1: 'Off', 2: 'Standard', 3: 'High', 4: 'Turbo', 5: 'Mop', 6: 'Auto' }

/** qmState.filterState */
const FILTER_STATE: Record<number, string> = { 1: 'Normal', 2: 'Cleaning needed' }

/** qmState.passageClogged */
const PASSAGE: Record<number, string> = { 1: 'Normal', 2: 'Check for debris' }

/** qmState.nozzle — which head is attached. */
const NOZZLE: Record<number, string> = {
    0: 'Auxiliary inlet',
    1: 'PowerDrive Floor',
    2: 'PowerDrive Carpet',
    3: 'PowerDrive Mop',
}

/** qmState.batteryLevel. This unit reports 0 while docked, which LG surfaces as NOT_USE. */
const BATTERY: Record<number, string> = { 0: 'Off', 1: 'High', 2: 'Mid', 3: 'Low', 4: 'Warning' }

/** qmState.mopWithSucking */
const MOP_WITH_SUCKING: Record<number, string> = { 1: 'Mop only', 2: 'Mop and suction together' }

/** qmState.suctionForce — the default suction level the product starts at (LG's "VC-1"). */
const SUCTION_FORCE: Record<number, string> = { 1: 'Standard', 2: 'High', 3: 'Turbo' }

/** qmState.chargingMelody (LG's "VC-2"); names from @HS_UX30_CHARGING_MELODY_n_W. */
const CHARGING_MELODY: Record<number, string> = {
    1: 'Lucky',
    2: 'Marble',
    3: 'Ice',
    4: 'Breeze',
    5: 'Nebula',
}

/** qmState.volume (LG's "VC-3") */
const VOLUME: Record<number, string> = { 1: 'High', 2: 'Normal', 3: 'Low' }

/** qmState.brightness (LG's "VC-4"). Code 5 is OFF; LG's own label key for it is missing
 *  from this model's pack, so the mapping's `_comment` ("LED Brightness off") supplies the text. */
const BRIGHTNESS: Record<number, string> = {
    1: 'Very bright',
    2: 'Bright',
    3: 'Normal',
    4: 'Dim',
    5: 'Off',
}

const enumOf = (table: Record<number, string>, raw: number) => table[raw] ?? 'unknown'

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const sensor = (id: string, name: string, extra: object = {}) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            name,
            ...extra,
        })

        const enumSensor = (id: string, name: string, table: Record<number, string>, extra: object = {}) =>
            sensor(id, name, {
                device_class: 'enum',
                options: Object.values(table),
                ...extra,
            })

        /** A setting the appliance takes a command for: the options are the English labels of
         *  its own read table, so the state it reports is always one of them. */
        const select = (id: string, name: string, table: Record<number, string>, extra: object = {}) => ({
            platform: 'select',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            options: Object.values(table),
            optimistic: true,
            ...extra,
        })

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG CordZero A9 Stick Vacuum' }),
                components: {
                    status: enumSensor('status', 'Status', MON_STATUS, { icon: 'mdi:robot-vacuum' }),
                    clean_mode: enumSensor('clean_mode', 'Operation level', CLEAN_MODE, { icon: 'mdi:fan' }),
                    suction_force: select('suction_force', 'Default suction power', SUCTION_FORCE, {
                        icon: 'mdi:weather-windy',
                    }),
                    battery: enumSensor('battery', 'Battery', BATTERY, { icon: 'mdi:battery' }),
                    nozzle: enumSensor('nozzle', 'Attached nozzle', NOZZLE, { icon: 'mdi:vacuum' }),
                    filter_state: enumSensor('filter_state', 'Filter state', FILTER_STATE, {
                        icon: 'mdi:air-filter',
                    }),
                    passage: enumSensor('passage', 'Inlet blocked', PASSAGE, { icon: 'mdi:pipe-disconnected' }),
                    mop_with_sucking: select('mop_with_sucking', 'Mop usage mode', MOP_WITH_SUCKING, {
                        icon: 'mdi:water',
                    }),
                    charging_melody: select('charging_melody', 'Charging melody', CHARGING_MELODY, {
                        icon: 'mdi:music-note',
                        entity_category: 'config',
                    }),
                    volume: select('volume', 'Volume', VOLUME, {
                        icon: 'mdi:volume-high',
                        entity_category: 'config',
                    }),
                    brightness: select('brightness', 'LED Brightness', BRIGHTNESS, {
                        icon: 'mdi:brightness-6',
                        entity_category: 'config',
                    }),
                    complete_clean: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-complete-clean',
                        state_topic: '$this/complete_clean',
                        name: 'Cleaning complete',
                        icon: 'mdi:check-circle-outline',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== CLASS_TAG) return
        const payload = buf.length - RECORDS_OFF
        if (payload <= 0 || payload % RECORD_LEN !== 0) return

        // The trailing record is the current state; a leading one, when present, is the previous.
        const record = buf.length - RECORD_LEN
        // A different count would mean a different record shape; decoding it with this map would
        // publish nonsense, so leave the previous values standing instead.
        if (buf[record + 1] !== FIELD_COUNT) return

        const at = (o: number) => buf[record + o]

        this.publishProperty('status', enumOf(MON_STATUS, at(OFF.monStatus)))
        this.publishProperty('clean_mode', enumOf(CLEAN_MODE, at(OFF.cleanMode)))
        this.publishProperty('battery', enumOf(BATTERY, at(OFF.batteryLevel)))
        this.publishProperty('nozzle', enumOf(NOZZLE, at(OFF.nozzle)))
        this.publishProperty('filter_state', enumOf(FILTER_STATE, at(OFF.filterState)))
        this.publishProperty('passage', enumOf(PASSAGE, at(OFF.passageClogged)))
        // completeClean: 1 = not finished, 2 = finished (LG's own polarity, not a 0/1 flag).
        this.publishProperty('complete_clean', at(OFF.completeClean) === 2 ? 'ON' : 'OFF')

        // Select states must be listed in their options, so an unrecognized code leaves the
        // previous value standing.
        this.publishOption('suction_force', SUCTION_FORCE, at(OFF.suctionForce))
        this.publishOption('mop_with_sucking', MOP_WITH_SUCKING, at(OFF.mopWithSucking))
        this.publishOption('charging_melody', CHARGING_MELODY, at(OFF.chargingMelody))
        this.publishOption('volume', VOLUME, at(OFF.volume))
        this.publishOption('brightness', BRIGHTNESS, at(OFF.brightness))
    }

    private publishOption(prop: string, table: Record<number, string>, raw: number) {
        const label = table[raw]
        if (label !== undefined) this.publishProperty(prop, label)
    }

    /**
     * Build and send a command frame: `aa 09 f0 24 <type> 01 <value> <ck> bb`.
     *
     * The base class's `send` supplies the AA/length prefix and the checksum, so what goes in is
     * `f0 24` plus the three-byte body — which reproduces the captured frames byte for byte.
     */
    private setField(type: number, value: number) {
        this.send(Buffer.from([...SET_STATE, type, 0x01, value]))
    }

    setProperty(prop: string, mqttValue: string) {
        const write = (type: number, table: Record<number, string>, what: string) => {
            const code = Object.entries(table).find(([, label]) => label === mqttValue)?.[0]
            if (code === undefined) return log('status', this.id, `Unknown ${what} ${mqttValue}`)
            this.setField(type, Number(code))
        }

        switch (prop) {
            case 'suction_force':
                return write(CTRL.suctionForce, SUCTION_FORCE, 'Default suction power')
            case 'mop_with_sucking':
                return write(CTRL.mopSetting, MOP_WITH_SUCKING, 'Mop usage mode')
            case 'charging_melody':
                return write(CTRL.chargingMelody, CHARGING_MELODY, 'Charging melody')
            case 'volume':
                return write(CTRL.volume, VOLUME, 'Volume')
            case 'brightness':
                return write(CTRL.brightness, BRIGHTNESS, 'LED Brightness')
            default:
                log('status', this.id, `Item does not support writing ${prop}`)
        }
    }
}
