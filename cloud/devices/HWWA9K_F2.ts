import { Device as Thinq2Device } from '../thinq2/device'
import log from '@/util/logging'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'

/*
 * LG CordZero A9 Stick Vacuum, ThinQ model HWWA9K_F2, deviceType 504.
 *
 * The byte layout was recovered by injecting single-byte-changed state frames through the
 * management API and reading LG cloud's decode back, one offset per observation:
 *
 *   byte[6]=3  -> monStatus CHARGING(3)        byte[7]=3  -> cleanMode HIGH(3)
 *   byte[8]=3  -> filterState 3               byte[9]=3  -> passageClogged 3
 *   byte[10]=3 -> nozzle WATER_MOP(3)         byte[11]=3 -> batteryLevel LOW(3)
 *   byte[12]=3 -> mopWithSucking 3            byte[13]=3 -> completeClean 3
 *   byte[14]=3 -> suctionForce TURBO(3)       byte[15]=3 -> chargingMelody MELODY_3(3)
 *   byte[16]=3 -> volume LOW(3)               byte[17]=2 -> brightness HIGH(2)
 *
 * Base frame (real, captured 2026-07-28):
 *   aa14d2eb00 0c 04 01 01 01 ff 00 01 01 02 01 01 03 c3bb
 *
 * byte[5] = 0x0c = 12 = the number of fields that follow, and twelve is exactly how many
 * `qmState.*` keys LG publishes for this unit. One byte per field, no padding.
 *
 * The other frame this appliance sends, `aa ff d2 0a 00 2c 00 …` (44 bytes), announces which
 * settings exist: a count of 4 followed by `[len]["VC-n"][value]` records, and modelJSON's own
 * comments name suctionForce, chargingMelody, volume and brightness as "VC-1".."VC-4". Its
 * values are NOT the live settings — every record reads 01 in captures where the state frame
 * says suction 2 and brightness 3 — so it is a capability list and is deliberately ignored.
 *
 * WRITE DIRECTION
 * ---------------
 * modelJSON declares five commands (MOP_SETTING, SUCTION_FORCE, CHARGING_MELODY, VOLUME,
 * BRIGHTNESS), each `controlDataValueLength: 1`, and all five were captured on 2026-07-28 —
 * every option of every one, seventeen frames.
 *
 * They came from LG's own cloud. `convert/control` converts a capability command into this
 * appliance's protocol and sends it down, and rethink relays it, so the frame below is LG's
 * encoding rather than this driver's guess:
 *
 *   aa 09 f0 24 <controlDataType> <valueLength = 1> <value> <ck> bb
 *
 *   01 MOP_SETTING     off -> 1   on -> 2
 *   02 SUCTION_FORCE   normal 1   high 2   turbo 3
 *   03 CHARGING_MELODY lucky 1    bead 2   ice 3   brisa 4   nebula 5
 *   04 VOLUME          high 1     medium 2 low 3
 *   05 BRIGHTNESS      veryHigh 1 high 2   medium 3 low 4   off 5
 *
 * THE VALUE IS THE READ MAP'S OWN CODE, in every case — so the write map and the read map
 * check each other, and the appliance's echo (below) confirms it a third time.
 *
 * The earlier note here said control was refused. It was: with the argument names the aircon
 * uses (`{"setOnOff":{"onOff":"on"}}`). This family wants what `convert/capabilitySchema`
 * declares, and answers CL-0000 once asked that way.
 *
 * `entity_category: 'config'` is used ONLY on the settings that are now selects.
 * Home Assistant accepts that category only on a platform that can change something. On a
 * sensor or binary_sensor it writes the entity into the registry and then never brings it up:
 * the first live rebuild of these drivers lost ten entities that way, across this model and the
 * styler, registered but missing from the state machine and silent in the log. Read-only
 * settings use 'diagnostic'. The test suite asserts it, because nothing on the add-on side can.
 */

/** processAABB receives the frame with its leading AA/length and trailing CRC/BB stripped,
 *  so byte 0 is the class tag and there are no leftover header/trailer bytes to skip. */
const HEADER_LEN = 2
const TRAILER_LEN = 0
/** buf[2] on the frames this appliance sends. */
const CLASS_TAG = 0xd2
/**
 * One state record: `<index> <field count> <12 field bytes>`.
 *
 * THE RECORD COUNT VARIES, SO IT IS COUNTED RATHER THAN ASSUMED.
 * At rest the appliance sends ONE record (20-byte frame, tag `d2 eb`). Right after a setting
 * changes it sends TWO (34-byte frame, tag `d2 ec`) — previous record, then current:
 *
 *   aa22d2ec00 0c 04 01 01 01 ff 00 02 01 01 03 03 04
 *              00 0c 04 01 01 01 ff 00 02 01 02 03 03 04 9ebb
 *
 * That is the same eb/ec convention the water purifier and the styler use in this repo, and
 * the same trap: a decoder keyed on "20 bytes, tag eb" ignores the echo and so goes blind at
 * exactly the moment a write lands. Measured 2026-07-28 — the frame above is the appliance's
 * answer to five commands this driver had just sent.
 */
const RECORD_LEN = 14
/** Fields start 2 bytes into the record, after its index and field-count bytes. */
const FIELDS_OFF = 2
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

/** LG's sentinel for "not reported": 0 on most of this model's enums, 255 on nozzle. */
const enumOf = (table: Record<number, string>, raw: number) =>
    table[raw] ?? (raw === 0 || raw === 0xff ? 'Unknown' : `Code ${raw}`)

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

        /** A setting the appliance takes a command for: the options are the English labels of
         *  its own read table, so the state it reports is always one of them. */
        const select = (id: string, name: string, table: Record<number, string>, extra: object = {}) => ({
            platform: 'select',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            options: Object.values(table),
            ...extra,
        })

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Stick Vacuum' }),
                components: {
                    status: sensor('status', 'State', { icon: 'mdi:robot-vacuum' }),
                    clean_mode: sensor('clean_mode', 'Operation level', { icon: 'mdi:fan' }),
                    suction_force: select('suction_force', 'Default suction power', SUCTION_FORCE, {
                        icon: 'mdi:weather-windy',
                    }),
                    battery: sensor('battery', 'Battery', { icon: 'mdi:battery' }),
                    nozzle: sensor('nozzle', 'Attached nozzle', { icon: 'mdi:vacuum' }),
                    filter_state: sensor('filter_state', 'Filter state', { icon: 'mdi:air-filter' }),
                    passage: sensor('passage', 'Inlet blocked', { icon: 'mdi:pipe-disconnected' }),
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

    /*
     * The base class strips the AA/length prefix before handing the body on, but every offset
     * above is stated against the whole frame, the way the probes recorded them, so the frame is
     * taken here unstripped.
     */
    // AABBDevice strips the leading AA/length and trailing CRC/BB, so byte 0 here is the class tag
    // and the record offsets are two less than the whole-frame positions.
    processAABB(buf: Buffer) {
        if (buf[0] !== CLASS_TAG) return
        const payload = buf.length - HEADER_LEN - TRAILER_LEN
        if (payload <= 0 || payload % RECORD_LEN !== 0) return

        // The trailing record is the current state; a leading one, when present, is the previous.
        const record = buf.length - TRAILER_LEN - RECORD_LEN
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

        // The five settings are selects, and a select's state has to be one of its options —
        // publishing 'Unknown' for a code outside the table would make Home Assistant reject
        // the state and log it, so an unreported code leaves the previous value standing.
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
            // The appliance echoes a two-record state frame within a second, so the entity
            // settles on what it actually took; this only keeps the UI from snapping back first.
            this.publishProperty(prop, mqttValue)
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
