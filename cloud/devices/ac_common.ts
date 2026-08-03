import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import log from '@/util/logging'
import HADevice from './base'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

/*
 * Shared implementation for LG air conditioners speaking the DualCool TLV scheme: standard tags
 * 0x1f7 power, 0x1f9 operation mode, 0x1fa fan speed, 0x1fd current temperature, 0x1fe target
 * temperature, the 0x2cc / 0x2cd / 0x2d3 capability bitmaps, the diagnostic pipe/ODU temperatures
 * and the basic-filter priv-command.
 *
 * What is here is the protocol, not any one unit's behaviour: nothing below is tuned to a
 * particular model, and where units are known to differ the difference is stated by the subclass
 * as an override rather than translated into some other model's wire format. The corrections the
 * residential units need (their setpoint range, their power reading bias, their filter counter)
 * live in RAC_056905_WW, not here.
 *
 *   modeTable / modeToWire / haModes    0x1f9 wire values are not the same everywhere - e.g. auto
 *                                       is wire 6 on DualCool wall units but wire 3 on the ceiling
 *                                       cassettes, which have no heat at all
 *   fanTable / fanToWire / haFanModes   the 0x1fa scale and the number of steps differ
 *   featureCaps / jetSwingCaps / timerCaps    which tag carries a given capability bitmap
 *   hasAirPurify / hasEnergySave / hasAutoDry / hasJetCool / hasJetHeat / hasSwing*
 *                                       the semantic capabilities, derived from the bitmaps above
 *   hasSwingOnOff / hasAutoDrySelect / hasValueTagFilter
 *                                       which of two implementations of a feature the unit has
 *   temperatureRange / powerReadXform / hasPowerSensor / hasPrivFilter
 *                                       what the unit reports and how it has to be corrected
 *   powerOnWithModeWrite                whether a mode write must carry 0x1f7=1 to power the unit on
 *   addModelFields                      entities that no other model has been seen to report
 */
export default abstract class ACDevice extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    airClean: boolean = false
    jetMode: boolean = false
    energySave: boolean = false
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    /* A reset waiting for the query that reads the counter one last time; see the reset button. */
    filterDoReset: boolean = false

    /* --- per-model description of the protocol; see the class comment --- */

    /* HA device name */
    readonly haDeviceName: string = 'LG Air Conditioner'

    /* 0x1f9 operation mode: wire value -> HA hvac mode, and back */
    abstract readonly modeTable: (string | undefined)[]
    abstract readonly modeToWire: Record<string, number>
    /* hvac modes advertised to HA; undefined lets HA derive them from what is published */
    readonly haModes: string[] | undefined = undefined

    /* 0x1fa fan speed: wire value -> HA fan mode, and back */
    abstract readonly fanTable: (string | undefined)[]
    abstract readonly fanToWire: Record<string, number>
    abstract readonly haFanModes: string[]

    /*
     * Whether selecting a mode while the unit is off has to turn it on. Units that ignore a
     * standalone mode write need 0x1f7=1 sent along with it.
     */
    readonly powerOnWithModeWrite: boolean = false

    /*
     * The mode-dependent switches (air purify, energy saving) are reported only while the unit
     * runs in the matching mode. On models where that makes the read-back unreliable, marking them
     * optimistic gets HA to show two assumed-state buttons rather than a switch that snaps back.
     */
    readonly modeDependentSwitchOptimistic: boolean = false

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
    }

    drop() {
        if (this.tlvBlacklistDisableTimer != undefined) {
            clearTimeout(this.tlvBlacklistDisableTimer)
            this.tlvBlacklistDisableTimer = undefined
        }

        if (this.increasedQueryIntervalTimeout != undefined) {
            clearTimeout(this.increasedQueryIntervalTimeout)
            this.increasedQueryIntervalTimeout = undefined
        }

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

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x2) this.processFilterCmdResp(success, data)
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

        log('status', this.id, 'sending filter reset')
        this.sendPrivCommand(0x02, 0x01, buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            if (this.hasPrivFilter()) {
                this.initProbeForFilter()
            } else {
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        log('status', this.id, 'sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            log('status', this.id, 'filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
            log('status', this.id, 'received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }

        /* The answer to the query the reset button sent. Now the counter is current, clear it. */
        if (this.filterDoReset) {
            this.filterDoReset = false
            this.sendFilterReset()
        }
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

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const mode = this.modeTable[this.getModeTLV()]

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha: Record<string, string> = {
            cool: 'cooling',
            dry: 'drying',
            fan_only: 'fan',
            heat: 'heating',
        }
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if (mode != null && mode !== 'fan_only' && !iduRunning) {
            action = 'idle'
        } else if (mode === 'auto') {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = mode != null ? modes2ha[mode] : undefined
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout != undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[0x1f7]
    }

    getModeTLV() {
        return this.raw_clip_state[0x1f9]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[0x189] != null) {
            return 0x189 // IDUThermoOnOff
        }
        if (this.raw_clip_state[0x6c] != null) {
            return 0x6c
        }

        return undefined
    }

    /* --- capabilities --- */

    /* Feature bitmap: bit 0 air purify, bit 1 energy saving, bit 2 auto dry */
    featureCaps() {
        return this.raw_clip_state[0x2cc]
    }

    /* Jet and positional swing bitmap: bit 0 jet cool, bit 1 jet heat, bit 2 swing V, bit 3 swing H */
    jetSwingCaps() {
        return this.raw_clip_state[0x2cd]
    }

    /* Timer bitmap: bit 0 sleep timer, bit 2 turn-on / turn-off timers */
    timerCaps() {
        return this.raw_clip_state[0x2d3]
    }

    hasAirPurify() {
        return !!(this.featureCaps() & 1)
    }

    hasEnergySave() {
        return !!(this.featureCaps() & 2)
    }

    hasAutoDry() {
        return !!(this.featureCaps() & 4)
    }

    hasJetCool() {
        return !!(this.jetSwingCaps() & 1)
    }

    hasJetHeat() {
        return !!(this.jetSwingCaps() & 2)
    }

    hasSwingVertical() {
        return !!(this.jetSwingCaps() & 4)
    }

    hasSwingHorizontal() {
        return !!(this.jetSwingCaps() & 8)
    }

    hasSleepTimer() {
        return !!(this.timerCaps() & 1)
    }

    hasStartStopTimers() {
        return !!(this.timerCaps() & 4)
    }

    /*
     * The three tests below select between different implementations of a feature this class
     * already owns, rather than turning an independent one on. They have no capability bit
     * identified yet, so they default to the variant the residential units use and a model with
     * the other one says so. Entities that this class has no notion of at all are not declared
     * here - a model adds those from addModelFields() using the helpers at the end of this file.
     */

    /* Plain on/off swing on 0x205 (vertical) / 0x206 (horizontal), replacing the positional pair. */
    hasSwingOnOff() {
        return false
    }

    /*
     * Auto dry as a writable duration select on 0x20e with 0x225 counting the cycle down in
     * minutes, instead of the binary sensor plus remaining percentage of hasAutoDry().
     */
    hasAutoDrySelect() {
        return false
    }
    readonly autoDryLevels: ReadonlyArray<readonly [string, number]> = [
        ['off', 0],
        ['10 min', 1],
        ['30 min', 2],
        ['60 min', 3],
        ['smart', 255],
    ]

    /*
     * Filter usage in plain value tags - 0x356 rated life (constant), 0x355 remaining hours -
     * instead of the basic-filter priv-command of hasPrivFilter().
     */
    hasValueTagFilter() {
        return false
    }

    /*
     * Filter counters read through the basic-filter priv-command (0x02/0x02), whose handling is
     * below. Whether the counter it returns is populated is a per-model matter, so a model that
     * wants it says so - it is off here.
     */
    hasPrivFilter() {
        return false
    }

    /* Instantaneous power on 0x2b3, in watts unless powerReadXform() says otherwise. */
    hasPowerSensor() {
        return this.raw_clip_state[0x2b3] != null
    }

    powerReadXform(raw: number): number {
        return raw
    }

    /*
     * Setpoint range in degC. Read from the cooling range the unit advertises in its capabilities;
     * a model that does not report it, or reports one that does not match the unit, overrides this.
     * When it is undefined the range is left out of the discovery config and HA falls back to its
     * own default.
     * TODO: 0x2e3 - 0x2ec carry the ranges of the other modes
     */
    temperatureRange(): { min: number; max: number } | undefined {
        const min = this.raw_clip_state[0x2e1]
        const max = this.raw_clip_state[0x2e2]
        if (min == null || max == null) return undefined
        return { min: min / 2, max: max / 2 }
    }

    /* Entities that only a particular model has. Called just before the config is installed. */
    addModelFields(config: DeviceDiscovery) {
        /* To be overridden if necessary */
    }

    initMakeSetConfig() {
        const range = this.temperatureRange()
        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: this.haDeviceName }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    /* TODO: detect 0.5 C vs 1 C step */
                    temp_step: 0.5,
                    precision: 0.5,
                    ...(range != null ? { min_temp: range.min, max_temp: range.max } : {}),
                    fan_modes: this.haFanModes,
                    ...(this.haModes != null ? { modes: this.haModes } : {}),
                } satisfies ClimateComponent,
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
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                /*
                 * Update 'mode' instead.
                 *
                 * This is also why a hook that is already on modeChangeHooks does not belong on
                 * powerChangeHooks: mode reads as 'off' while the unit is off and as its actual
                 * mode otherwise, so every power change is a mode change too and a hook on both
                 * lists runs twice for one event.
                 */
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])

                const powerState = val === 'ON'
                if (this.powerStatePrev !== powerState) for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (this.getPowerTLV() === 0) return 'off'
                return this.modeTable[raw]
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                // Some units ignore a mode write while powered off - the app turns them on by
                // sending 0x1f7=1 together with the mode, so do the same.
                if (this.powerOnWithModeWrite) this.raw_clip_state[0x1f7] = 1
                return this.modeToWire[val]
            },
            write_attach: this.powerOnWithModeWrite ? [0x1f7, 0x1fa, 0x1fe] : [0x1fa, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => this.fanTable[raw],
            write_xform: (val) => this.fanToWire[val],
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            write_attach: [0x1f9, 0x1fa],
        })

        if (this.hasSwingOnOff()) {
            /* the plain on/off variant, which takes the place of the positional pair below */
            config['components']['climate']['swing_modes'] = ['on', 'off']
            this.addField(config, {
                id: 0x205,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => (raw ? 'on' : 'off'),
                write_xform: (val) => (val === 'on' ? 1 : 0),
            })
            config['components']['climate']['swing_horizontal_modes'] = ['on', 'off']
            this.addField(config, {
                id: 0x206,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => (raw ? 'on' : 'off'),
                write_xform: (val) => (val === 'on' ? 1 : 0),
            })
        }

        if (!this.hasSwingOnOff() && this.hasSwingVertical()) {
            config['components']['climate']['swing_modes'] = ['1', '2', '3', '4', '5', '6', 'on', 'off']
            this.addField(config, {
                id: 0x321,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => {
                    const modes2ha = ['off', '1', '2', '3', '4', '5', '6']
                    modes2ha[100] = 'on'
                    return modes2ha[raw]
                },
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        '1': 1,
                        '2': 2,
                        '3': 3,
                        '4': 4,
                        '5': 5,
                        '6': 6,
                        on: 100,
                    }
                    return modes2clip[val]
                },
            })
        }

        if (!this.hasSwingOnOff() && this.hasSwingHorizontal()) {
            config['components']['climate']['swing_horizontal_modes'] = [
                '1',
                '2',
                '3',
                '4',
                '5',
                '1-3',
                '3-5',
                'on',
                'off',
            ]
            this.addField(config, {
                id: 0x322,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => {
                    const modes2ha = ['off', '1', '2', '3', '4', '5']
                    modes2ha[13] = '1-3'
                    modes2ha[35] = '3-5'
                    modes2ha[100] = 'on'
                    return modes2ha[raw]
                },
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        '1': 1,
                        '2': 2,
                        '3': 3,
                        '4': 4,
                        '5': 5,
                        '1-3': 13,
                        '3-5': 35,
                        on: 100,
                    }
                    return modes2clip[val]
                },
            })
        }

        this.addOptionalSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')
        this.addOptionalSensorField(
            config,
            0x32e,
            'capacity',
            'Capacity nominal',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'kW',
                suggested_display_precision: 1,
            },
            (raw) => (raw !== 0 ? Math.round(raw * 0.293 * 10) / 10 : undefined),
        ) // raw is in kBTU / hour

        /*
         * Whether the IDU will report its EEV opening correctly during its
         * active operation is highly inconsistent between IDUs.
         * For example, from two Standard2 IDUs with 0x690409 software version
         * connected to common ODU one IDU works as expected while the other
         * one reports the EEV opening value of the other Standard2 IDU (?).
         * This may be an ODU firmware bug. On the other hand, another Deluxe
         * IDU connected to the same ODU always reports correct EEV values.
         * None of tested IDUs seem to usually notify by itself when this value changes.
         */
        this.addOptionalSensorField(config, 0x330, 'eev', 'EEV opening', 'mdi:valve', {
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        /*
         * IDUs send notifications about the updates of the temperatures below
         * at their own pace, sometimes in clusters with other attributes.
         * Deluxe IDUs send notifications noticeably more often than Standard2 IDUs.
         *
         * Pipe temps are sometimes reported as 0 (-100 C) for a moment after a shutdown.
         * Make sure to filter out such updates.
         */
        this.addOptionalSensorTempField(
            config,
            0x2f9,
            'pipeintemp',
            'Pipe liquid temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x2fa,
            'pipeouttemp',
            'Pipe gas temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )

        this.addOptionalSensorTempField(
            config,
            [0x7a, 0x32c],
            'oduhextemp',
            'ODU HEX temperature', // "HEX" = "heat exchanger"
            'mdi:heating-coil',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x332,
            'oduairtemp',
            'ODU air temperature',
            'mdi:thermometer-lines',
            (raw) => racAirTemp[255 - raw],
        )

        /*
         * [ 0x22a, 0x32f ] - ODU compressor Hz
         * Standard2 IDUs even notify about the former
         * tag changes.
         *
         * But the value seems to be capped at 15 Hz
         * regardless of the actual compressor speed,
         * which makes it of limited usability.
         */

        // 0x2fb is the target fan RPM, while this is the current RPM
        this.addOptionalSensorField(
            config,
            0x331,
            'fanrpm',
            'Fan RPM',
            'mdi:fan',
            {
                state_class: 'measurement',
                unit_of_measurement: 'rpm',
                suggested_display_precision: 0,
            },
            (raw) => raw * 10,
        )

        if (this.hasAirPurify()) {
            this.addModeDependentConfigSwitchField(
                config,
                0x20f,
                'airclean',
                /* Same desc as in lg_thinq */
                'Air purify',
                'mdi:air-purifier',
                'airClean',
            )
        }

        const jetCool = this.hasJetCool()
        const jetHeat = this.hasJetHeat()
        if (jetCool || jetHeat) {
            this.addJetField(config, 0x323, 'jet', 'Jet', 'mdi:wind-power', jetCool, jetHeat)
        }

        if (this.hasSleepTimer()) {
            // 15h - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)
        }

        if (this.hasStartStopTimers()) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24)
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24)
        }

        if (this.hasEnergySave()) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === this.modeToWire['cool'],
            )
        }

        if (this.hasAutoDrySelect()) {
            /*
             * The select variant: 0x20e picks the drying duration (255 = smart) and 0x225 is the
             * number of minutes left in the running cycle - independent of 0x20e, it only changes
             * while drying runs.
             */
            this.addValueSelect(config, 'autodry_setting', 0x20e, 'Auto dry', 'mdi:hair-dryer', this.autoDryLevels)

            if (this.raw_clip_state[0x225] != null) {
                config['components']['autodryremain'] = allowExtendedType({
                    platform: 'sensor',
                    unique_id: '$deviceid-autodryremain',
                    name: 'Auto dry remaining',
                    icon: 'mdi:hair-dryer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    suggested_display_precision: 0,
                    entity_category: 'diagnostic',
                })
                this.addField(config, { id: 0x225, name: '', comp: 'autodryremain', writable: false })
            }
        } else if (this.hasAutoDry()) {
            const compADry = {
                platform: 'binary_sensor',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'diagnostic',
            }
            const compADryRem = {
                platform: 'sensor',
                unique_id: '$deviceid-autodryremain',
                name: 'Auto dry remaining',
                icon: 'mdi:hair-dryer-outline',
                unit_of_measurement: '%',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            }
            config['components']['autodry'] = compADry
            config['components']['autodryremain'] = compADryRem

            this.addField(config, {
                id: 0x20e,
                name: '',
                comp: 'autodry',
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })

            this.addField(config, {
                id: 0x225,
                name: '',
                comp: 'autodryremain',
                writable: false,
            })
        }

        if (this.getIDUActionRunningTLVNum() != null) {
            this.addField(
                config,
                {
                    id: this.getIDUActionRunningTLVNum(),
                    name: 'action',
                    comp: 'climate',
                    read_callback: (val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })

        // 0x21f - "display light" value is inverted in some devices,
        // but in some devices it is not - not shown in ThinQ app either

        if (this.filterLifeTime) {
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
            config['components']['filterused'] = filterUsed
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
            config['components']['filterlife'] = filterLife
            const filterChanged = {
                platform: 'sensor',
                unique_id: '$deviceid-filterchangeddate',
                state_topic: '$this/filterchangeddate',
                name: 'Filter usage last reset',
                icon: 'mdi:calendar-refresh-outline',
                device_class: 'date',
                entity_category: 'diagnostic',
            }
            config['components']['changeddate'] = filterChanged

            const filterReset = {
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            }
            config['components']['filterreset'] = filterReset
            this.fields_by_ha['filterreset'] = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 1 : 0),
                write_callback: (val) => {
                    if (val === 1) {
                        /*
                         * Query first, reset when the answer arrives. These counters are only
                         * refreshed once a day - a query may do an EEPROM write - so resetting
                         * straight away records a usage figure up to 24 hours short of what the
                         * filter actually ran.
                         */
                        this.filterDoReset = true
                        this.sendFilterQuery()
                    }
                    return false
                },
            }
        }

        if (this.hasValueTagFilter() && this.raw_clip_state[0x356]) {
            /*
             * Both entities are published from a read hook on 0x355, the live counter (0x356 is
             * the constant rated life); used = life - remaining, remaining % = remaining / life.
             * There is no reset here - the value tags are read-only.
             */
            config['components']['filter_remaining'] = allowExtendedType({
                platform: 'sensor',
                unique_id: '$deviceid-filter_remaining',
                name: 'Filter remaining',
                icon: 'mdi:air-filter',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
                state_topic: '$this/filter_remaining',
            })
            config['components']['filter_used'] = allowExtendedType({
                platform: 'sensor',
                unique_id: '$deviceid-filter_used',
                name: 'Filter used time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
                state_topic: '$this/filter_used',
            })
            this.addField(
                config,
                {
                    id: 0x355,
                    name: '',
                    comp: 'filter_remaining',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        const life = this.raw_clip_state[0x356]
                        const remaining = this.raw_clip_state[0x355]
                        if (life) {
                            this.HA.publishProperty(this.id, 'filter_remaining', Math.round((remaining / life) * 100))
                            this.HA.publishProperty(this.id, 'filter_used', life - remaining)
                        }
                        return false
                    },
                },
                false,
            )
        }

        if (this.hasPowerSensor()) {
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

            config['components']['energy_current'] = energyCurrent

            this.addField(config, {
                id: 0x2b3,
                name: '',
                comp: 'energy_current',
                writable: false,
                read_xform: (raw) => this.powerReadXform(raw),
            })
        }

        this.addModelFields(config)

        this.setConfig(config)

        if (this.filterLifeTime) {
            this.publishFilterData()

            /*
             * Refresh only once a day since a query might do an EEPROM
             * write.
             */
            this.filterQueryTimer = setInterval(
                () => {
                    log('status', this.id, 'sending periodic filter data refresh query')
                    this.sendFilterQuery()
                },
                24 * 60 * 60 * 1000,
            )
        }

        this.query()
    }

    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, max: number) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: 0.25,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => Math.ceil(raw / 60 / 0.25) * 0.25,
            write_xform: (val) => Math.round(Number(val) * 60),
        })
    }

    addJetField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        jetCool: boolean,
        jetHeat: boolean,
    ) {
        const descFull =
            desc + ' ' + (jetCool ? 'cool' : '') + (jetCool && jetHeat ? '/' : '') + (jetHeat ? 'heat' : '')

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: descFull,
            icon: icon,
            entity_category: 'config',
            optimistic: true,
        }
        config['components'][name] = comp

        const coolWire = this.modeToWire['cool']
        const heatWire = this.modeToWire['heat']

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === coolWire) return 1
                if (jetHeat && this.getModeTLV() === heatWire) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === coolWire && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === heatWire && raw == 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!((jetCool && this.getModeTLV() === coolWire) || (jetHeat && this.getModeTLV() === heatWire)))
                    return false

                this.jetMode = val === 'ON'
                return true
            },
            write_callback: (val) => {
                /*
                 * Writing '1' in OFF state seem to immediately
                 * power on into the cooling mode, while writing
                 * '2' in the OFF state is ignored.
                 * Be consistent and only allow enabling Jet mode
                 * when running in the right mode.
                 */
                return (
                    this.getPowerTLV() !== 0 &&
                    ((jetCool && this.getModeTLV() === coolWire) || (jetHeat && this.getModeTLV() === heatWire))
                )
            },
        })

        /*
         * This value needs to be written at each power up in heat/cool mode,
         * but in a separate message. The mode hook covers power-up as well - see the power field's
         * read callback - so registering the same write on both lists only sends it twice.
         */
        this.modeChangeHooks.push(() => {
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        let id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }

        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    addOptionalSensorTempField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        this.addOptionalSensorField(
            config,
            ids,
            name,
            desc,
            icon,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 2,
            },
            read_xform,
        )
    }

    addConfigSwitchField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
        })
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'jetMode' | 'energySave',
        check_mode?: CheckMode,
    ) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
            ...(this.modeDependentSwitchOptimistic ? { optimistic: true } : {}),
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!!check_mode && !check_mode(this.getModeTLV())) return false

                this[field_name] = val === 'ON'
                return true
            },
            write_callback: (val) => {
                this[field_name] = val === 1

                // No need to write the value if not running in the right mode
                return this.getPowerTLV() !== 0 && (!check_mode || check_mode(this.getModeTLV()))
            },
        })

        /*
         * This value needs to be written at each power up, but in a separate message.
         *
         * One list or the other, never both: a mode-dependent switch already gets its write on
         * every power change, because power changes the mode too - see the power field's read
         * callback. A switch that has no check_mode has no mode hook to ride, so it keeps the
         * power one.
         */
        if (!!check_mode) {
            this.modeChangeHooks.push(() => {
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        } else {
            this.powerChangeHooks.push(() => {
                if (this.getPowerTLV() === 0) return
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        }
    }

    /*
     * Register a writable HA select whose options map one-to-one to wire values. The
     * [label, wire] list is the single source of truth - the option list and both the read and
     * write transforms are derived from it, so they can't drift out of sync.
     */
    addValueSelect(
        config: DeviceDiscovery,
        comp: string,
        id: number,
        name: string,
        icon: string,
        levels: ReadonlyArray<readonly [string, number]>,
    ) {
        if (this.raw_clip_state[id] == null || config.components[comp]) return
        const toLabel = new Map(levels.map(([label, raw]) => [raw, label]))
        const toRaw = new Map(levels.map(([label, raw]) => [label, raw]))
        config.components[comp] = allowExtendedType({
            platform: 'select',
            unique_id: `$deviceid-${comp}`,
            name,
            icon,
            entity_category: 'config',
            options: levels.map(([label]) => label),
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => toLabel.get(raw),
            write_xform: (val) => toRaw.get(val),
        })
    }
}
