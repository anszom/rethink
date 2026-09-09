import TLVDevice from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import HADevice from './base'
import { Enum } from '@/util/enum'

const FAN_MODES = Enum.of({
    low: 2,
    medium: 4,
    high: 6,
})

const SWING_MODES = Enum.of({
    on: 100,
    off: 0,
})

/**
 * LG Air Conditioner Models LW1822HRSM, LW1822IVSM
 *
 * The two share this handler (same reported modelId, WIN_056905_WW), but are not a trivial
 * alias of each other — real differences were found and fixed against a real LW1822IVSM
 * (2026-09-09): the 'dry' mode's raw value was wrong (was 8, actually Energy Saver; corrected to
 * 1), 'medium' fan speed was missing, and Energy Saver/filter tracking/off timer/power
 * measurement were entirely unimplemented. 'heat' (raw mode 4) remains unconfirmed on either
 * model — kept from the original HRSM-only implementation, but IVSM has no heat option at all
 * and its own supported modes (from the device's own capability advertisement) are only
 * cool/dry/fan_only/Energy Saver.
 *
 * Not yet implemented, confirmed against a real LW1822IVSM (2026-09-09):
 *   - 'Sleep' button: cycles a 1-24 display value on the panel, but produced no corresponding change
 *     on the wire in testing — likely panel-local only, not reported over the cloud protocol.
 */
export default class Device extends TLVDevice {
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    filterDoReset: boolean = false
    energySensorAdded: boolean = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    temperature_unit: 'C',
                    temp_step: 0.5,
                    precision: 0.5,
                    modes: ['off', 'cool', 'dry', 'fan_only', 'heat'],
                    fan_modes: FAN_MODES.options,
                    swing_modes: SWING_MODES.options,
                    // 'Energy Saver' (raw mode 8) is mutually exclusive with cool/dry/fan_only/heat
                    // at the protocol level, but HA's hvac_mode vocabulary has no equivalent — expose
                    // it as a preset instead. See the mode field's write_xform/read_callback below.
                    // 'none' must NOT be listed here — HA's MQTT climate schema reserves it and
                    // rejects the whole climate component if it's present in preset_modes, even
                    // though 'none' is a valid state to report via preset_mode_state_topic.
                    preset_modes: ['eco'],
                },
                // Off timer. Panel sets/reads this in whole-hour steps only (tag 0x21b is raw
                // minutes, always a multiple of 60 when set from the panel); confirmed live
                // (2026-09-09) that writing an arbitrary value here via the cloud is honored
                // exactly like a panel button press (the unit dings and updates its display),
                // including 0 to cancel. Exposed in hours to match the panel's own granularity —
                // finer values were not tested and may not display sensibly on the panel.
                offtimer: {
                    platform: 'number',
                    unique_id: '$deviceid-offtimer',
                    name: 'Off timer',
                    icon: 'mdi:timer-outline',
                    min: 0,
                    max: 24,
                    step: 1,
                    unit_of_measurement: 'h',
                    state_topic: '$this/offtimer',
                    command_topic: '$this/offtimer/set',
                },
            },
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (valStr) => {
                const val = Number(valStr)
                // set val to min: 61F, max: 86F
                const minCel = 16
                const maxCel = 30.0
                if (val < minCel) return minCel * 2
                if (val > maxCel) return maxCel * 2
                return Math.round(val * 2)
            },
            write_attach: [0x1f9, 0x1fa],
        })

        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            write_attach: (raw) => (raw ? [0x1f9] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                // Confirmed against a real LW1822IVSM (2026-09-09): 0=cool, 1=dry, 2=fan_only,
                // 8=Energy Saver (not a valid HA hvac_mode — reported via preset_mode instead, see
                // below). 4=heat is unconfirmed on this unit (it has no heat option) but is kept for
                // the sibling LW1823HRSM model this handler also serves.
                const modes2ha = ['cool', 'dry', 'fan_only', undefined, 'heat']
                if (this.raw_clip_state[0x1f7] === 0) return 'off'
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { cool: 0, dry: 1, fan_only: 2, heat: 4 }
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                } else {
                    this.setProperty('climate-power', 'ON')
                }
                return modes2clip[val]
            },
            write_attach: [0x1f7, 0x1fa, 0x1fe, 0x322],
        })

        this.addField(config, {
            name: 'preset_mode',
            comp: 'climate',
            write_xform: (val) => (val === 'eco' ? 8 : undefined),
            write_callback: (val) => {
                this.setProperty('climate-power', 'ON')
                this.raw_clip_state[0x1f9] = val
                const attach = [0x1f9, 0x1f7, 0x1fa, 0x1fe, 0x322]
                const tlvArray = attach.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
                this.send([1, 1, 2, 1, 1], tlvArray)
                return false
            },
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => FAN_MODES.map(raw),
            write_xform: (val) => FAN_MODES.unmap(val),
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x322,
            name: 'swing_mode',
            comp: 'climate',
            read_xform: (raw) => SWING_MODES.map(raw),
            write_xform: (val) => SWING_MODES.unmap(val),
            write_attach: [0x1f9, 0x1fa],
        })

        // Off timer write path. `id` is safe to set here (unlike preset_mode's field) since no
        // other field in this handler reads/writes tag 0x21b, so there's no fields_by_id clobber
        // risk — this lets setProperty's generic single-field send path handle it, matching the
        // exact minimal write ([1,1,2,1,1] header, no other tags attached) confirmed live.
        this.fields_by_ha['offtimer'] = {
            id: 0x21b,
            name: '',
            comp: '',
            write_xform: (val) => Math.max(0, Math.min(24, Number(val))) * 60,
        }

        this.setConfig(config)
    }

    drop() {
        if (this.filterInitialQueryTimeout != undefined) {
            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined
        }
        if (this.filterQueryTimer != undefined) {
            clearInterval(this.filterQueryTimer)
            this.filterQueryTimer = undefined
        }
        super.drop()
    }

    valuesReceived() {
        // Confirmed against a real LW1822IVSM (2026-09-09): private command 0x02/0x02 queries filter
        // usage (used hours, life hours, last-reset date) — same sub-protocol as RAC_056905_WW.
        this.initProbeForFilter()
    }

    initProbeForFilter() {
        this.sendFilterQuery()
        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined
            // no response within 5s: assume this unit doesn't support filter tracking
        }, 5 * 1000)
    }

    sendFilterQuery() {
        this.sendPrivCommand(0x02, 0x02)
    }

    sendFilterReset() {
        if (!this.filterLifeTime) throw new Error('Filter lifetime not known')

        const now = new Date()
        const date = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()

        const buf = Buffer.alloc(4 * 3)
        // yes, it's opposite endianness vs read cmd
        buf.writeUInt32BE(this.filterLifeTime, 1 * 4)
        buf.writeUInt32BE(date, 2 * 4)

        this.sendPrivCommand(0x02, 0x01, buf)
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterCmdResp(success)
    }

    processFilterData(data: Buffer) {
        if (data.length < 1 + 3 * 4) return

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        if (this.filterInitialQueryTimeout != undefined) {
            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.addFilterEntities()
            this.publishFilterData()

            // Refresh only once a day since a query might do an EEPROM write.
            this.filterQueryTimer = setInterval(() => this.sendFilterQuery(), 24 * 60 * 60 * 1000)
        } else {
            this.publishFilterData()
        }

        if (this.filterDoReset) {
            this.filterDoReset = false
            this.sendFilterReset()
        }
    }

    addFilterEntities() {
        if (!this.config) return

        const filterUsed = {
            platform: 'sensor',
            unique_id: '$deviceid-filterused',
            state_topic: '$this/filterused',
            name: 'Filter used time',
            icon: 'mdi:air-filter',
            device_class: 'duration',
            unit_of_measurement: 'h',
            state_class: 'total_increasing',
            entity_category: 'diagnostic',
        }
        this.config.components['filterused'] = filterUsed

        const filterLife = {
            platform: 'sensor',
            unique_id: '$deviceid-filterlife',
            state_topic: '$this/filterlife',
            name: 'Filter life time',
            icon: 'mdi:air-filter',
            device_class: 'duration',
            unit_of_measurement: 'h',
            entity_category: 'diagnostic',
        }
        this.config.components['filterlife'] = filterLife

        const filterChanged = {
            platform: 'sensor',
            unique_id: '$deviceid-filterchangeddate',
            state_topic: '$this/filterchangeddate',
            name: 'Filter usage last reset',
            icon: 'mdi:calendar-refresh-outline',
            device_class: 'date',
            entity_category: 'diagnostic',
        }
        this.config.components['changeddate'] = filterChanged

        const filterReset = {
            platform: 'button',
            unique_id: '$deviceid-filterreset',
            command_topic: '$this/filterreset/set',
            name: 'Reset filter usage',
            icon: 'mdi:calendar-refresh-outline',
            entity_category: 'diagnostic',
        }
        this.config.components['filterreset'] = filterReset
        this.fields_by_ha['filterreset'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 1 : 0),
            write_callback: (val) => {
                if (val === 1) {
                    this.filterDoReset = true
                    // do a query first to get the most recent pre-reset values
                    this.sendFilterQuery()
                }
                return false
            },
        }

        this.setConfig(this.config)
    }

    publishFilterData() {
        const changedDate =
            Math.floor(this.filterChangedDate / 10000)
                .toString()
                .padStart(4, '0') +
            '-' +
            (Math.floor(this.filterChangedDate / 100) % 100).toString().padStart(2, '0') +
            '-' +
            (this.filterChangedDate % 100).toString().padStart(2, '0')

        this.HA.publishProperty(this.id, 'filterused', this.filterUsedTime)
        this.HA.publishProperty(this.id, 'filterlife', this.filterLifeTime)
        this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean) {
        if (!success) return
        this.sendFilterQuery()
    }

    processKeyValue(k: number, v: number) {
        // Publish preset_mode from tag 0x1f9 unconditionally: the 'mode' field's own read_xform
        // returns undefined for raw 8 (not a valid hvac_mode), which would otherwise short-circuit
        // before any read_callback runs — see tlv_device.ts processKeyValue.
        if (k === 0x1f9) this.HA.publishProperty(this.id, 'climate-preset_mode', v === 8 ? 'eco' : 'none')

        // Off timer (tag 0x21b): raw minutes remaining, counts down once armed. See the
        // 'offtimer' config component above for how writes work.
        if (k === 0x21b) this.HA.publishProperty(this.id, 'offtimer', Math.round(v / 60))

        // Live power draw (tag 0x2b3, same as RAC_056905_WW.ts's 'energy_current'). This is
        // whole-unit power (compressor + fans + electronics), not compressor-only — confirmed
        // against a real LW1822IVSM (2026-09-09) by listening to the compressor cycle on/off while
        // watching this value: idle reads ~80W (fans/electronics, compressor off), not ~0W, and it
        // tracks the inverter's ramp up/down smoothly and in real time — unlike the compressor
        // Hz/IDU-thermo tags, which only ever appear once at connection time on this unit and never
        // update (see the class docstring). Per RAC_056905_WW.ts's own notes, expect ~+/-10%
        // accuracy: standby-only consumption (~4W) and the 4-way valve aren't included, and
        // fan-only mode readings are the least accurate. RAC's handler guards this behind
        // `if (this.raw_clip_state[0x2b3])` since some multi-split units always report zero; added
        // dynamically here for the same reason, once a real value is seen.
        if (k === 0x2b3 && v) {
            if (!this.energySensorAdded) {
                this.energySensorAdded = true
                this.addEnergySensorEntity()
            }
            this.HA.publishProperty(this.id, 'energy_current', Math.max(5, v - 60))
        }

        super.processKeyValue(k, v)
    }

    addEnergySensorEntity() {
        if (!this.config) return

        const energyCurrent = {
            platform: 'sensor',
            unique_id: '$deviceid-energy_current',
            state_topic: '$this/energy_current',
            name: 'Power',
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        this.config.components['energy_current'] = energyCurrent

        this.setConfig(this.config)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
    }
}
