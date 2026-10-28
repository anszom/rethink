import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, ComponentInfo, DeviceDiscovery, tombstone, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import HADevice from './base'
import { Enum } from '@/util/enum'

// exported for the benefit of RAC_056905_WW_T1
export const MODES = Enum.of({
    cool: 0,
    dry: 1,
    fan_only: 2,
    heat: 4,
    auto: 6,
})

/**
 * HA's `climate` action vocabulary, keyed by the same TLV mode codes as MODES — but it is not MODES:
 * HA calls the action 'cooling' where it calls the mode 'cool'. Mode 6 (auto) is absent because the
 * running sub-mode cannot be read out of the unit; see updateClimateAction.
 */
const ACTIONS = Enum.of({
    cooling: 0,
    drying: 1,
    fan: 2,
    heating: 4,
})

export const FAN_MODES = Enum.of({
    'very low': 2,
    low: 3,
    medium: 4,
    high: 5,
    'very high': 6,
    auto: 8,
})

// Entry form rather than Enum.of: this order is the order HA lists the swing modes in, and an object
// literal would sort the numbered ones ahead of 'on'/'off'.
export const SWING_MODES = new Enum([
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
    ['6', 6],
    ['on', 100],
    ['off', 0],
])

export const SWING_H_MODES = new Enum([
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
    ['1-3', 13],
    ['3-5', 35],
    ['on', 100],
    ['off', 0],
])

/*
 * Mode reported by units with AC_RAC_AIRCLEAN_ONLY (0x2d2 bit 5, e.g. H09S1DA) after "Air Purify" is
 * started from off (remote: Mode 3 s, or 0x20f=1 written while off). It behaves like Fan mode with air
 * purify on - same fan speed, compressor off, same power - so it is shown as fan_only. The opMode 5
 * listed in the modelJSON is ignored by these units.
 */
const MODE_PURIFY_ONLY = 46

// 0x2d3 (modelJSON support.reserve) capability bits
const ONOFF_TIMER = 0x4
const TIMEBS_ONOFF = 0x10
const SLEEP_TIMER_12H = 0x4000

// 0x2d5 (modelJSON support.accumMode) capability bits
const MOMENTARY_INOUTDOOR = 0x2
const MOMENTARY_OUTDOOR = 0x4

// 0x20d on units with ACTIVE_ENERGY_CONTROL (0x34f bit 10): power limit in percent, 0 = off.
// On other units the same tag is the boolean "energy saving".
export const ENERGY_LIMITS = Enum.of({
    off: 0,
    '80%': 80,
    '60%': 60,
    '40%': 40,
})

// 0x1f2 auto dry fan speed, same codes as 0x1fa. The supported subset is advertised in 0x192.
export const AUTODRY_FAN_MODES = Enum.of({
    low: 2,
    medium: 4,
    high: 6,
})

// 0x21f is not shown in the official ThinQ app and is present on multiple RAC
// variants, but its polarity and writability differ between indoor units. Only
// expose it for hardware revisions verified to both report and accept the value
// with this polarity.
//
// Contributors: feel free to make single-line PR's to extend this list. The whole
// unit testing ceremony would be overkill here.
//
// EEPROM checksum -> the value that means "display on"
const DISPLAY_LIGHT_EEPROM_CHECKSUMS = new Map([
    [0x4e88, 1], // S4NW12JA31A, firmware 0x690441: 0=off, 1=on
    [0x551d, 1], // AP09RK, firmware 0x690474: 0=off, 1=on
    [0x4c19, 1], // S3NM07AA1MA, firmware  0x690457: 0=off, 1=on
    [0x4f58, 1], // S4NW24K231E, firmware 0x516701: 0=off, 1=on
    [0x4e95, 1], // firmware 0x690464: 0=off, 1=on
    [0x4eb9, 0], // H09S1D, firmware 0x55703: 0=on, 1=off (as the ThinQ app shows it)
])

// Negative cases: these versions don't support writing the light value
// 0x4dda / 0x690409
// 0x4d81 / 0x690409
// 0x4dfa / 0x690457
// 0x4d87 / 0x690409 (DC12RT)

type PowerModeChangeHook = () => void
type FeatureRequirement = { text: string; met: () => boolean }
type CheckMode = (arg: number) => boolean
export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    airClean: boolean | undefined
    jetMode: boolean | undefined
    energySave: boolean | undefined
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    filterDoReset: boolean = false
    // last value HA requested for settings the unit only accepts in some states, see addRunningOnlyField
    rememberedSettings: Record<string, string> = {}
    // manual-derived description and requirement per entity, see describeFeature
    featureInfo: Record<string, { description: string; requirement?: FeatureRequirement }> = {}

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

        this.log('sending filter reset')
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

            if (!(this.raw_clip_state[0x2f1] & 1 || this.raw_clip_state[0x2f1] & 0x200)) {
                // no mFilter, check basic filter management support
                this.initProbeForFilter()
            } else {
                // unsupported mFilter management support
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        this.log('sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            this.log('filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            this.log('filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
            this.log('received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }

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

        this.publishProperty('filterused', this.filterUsedTime)
        this.publishProperty('filterlife', this.filterLifeTime)
        this.publishProperty('filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            this.log('filter reset failed')
            return
        }

        this.log('filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const modeTLV = this.getModeTLV()

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if ((modeTLV === 0 || modeTLV === 1 || modeTLV === 4 || modeTLV === 6) && !iduRunning) {
            action = 'idle'
        } else if (modeTLV === MODE_PURIFY_ONLY) {
            // fan and purifier only, the compressor is off
            action = 'fan'
        } else if (modeTLV === 6) {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = ACTIONS.map(modeTLV)
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.publishProperty('climate-action', action)
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

    initMakeSetConfig() {
        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Air Conditioner' }),
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
                    min_temp: this.tempLimit(Math.min, [0x2e1, 0x2e3, 0x2eb]) ?? 18,
                    max_temp: this.tempLimit(Math.max, [0x2e2, 0x2e4, 0x2ec]) ?? 30,
                    /* TODO: get from 0x2c2 */
                    fan_modes: ['auto', 'very low', 'low', 'medium', 'high', 'very high'],
                    /* TODO: get allowed op modes from 0x2c1 */
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
                 * This means that power state change will effectively also
                 * call mode change hooks since mode will switch between 'off'
                 * and the actual set mode.
                 */
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])

                /*
                 * Call these hooks only after updating 'mode' in case
                 * they depend on it being correctly set.
                 */
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
                // behaves like fan mode with air purify on
                if (raw === MODE_PURIFY_ONLY) return 'fan_only'
                return MODES.map(raw)
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                // fan <-> MODE_PURIFY_ONLY is not a change here; nothing needs to tell them apart
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
                return MODES.unmap(val)
            },
            write_attach: [0x1fa, 0x1fe],
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
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            write_attach: [0x1f9, 0x1fa],
        })

        if (this.raw_clip_state[0x2cd] & 4) {
            config['components']['climate']['swing_modes'] = SWING_MODES.options
            this.addField(config, {
                id: 0x321,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => SWING_MODES.map(raw),
                write_xform: (val) => SWING_MODES.unmap(val),
            })
        }

        if (this.raw_clip_state[0x2cd] & 8) {
            config['components']['climate']['swing_horizontal_modes'] = SWING_H_MODES.options
            this.addField(config, {
                id: 0x322,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => SWING_H_MODES.map(raw),
                write_xform: (val) => SWING_H_MODES.unmap(val),
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

        if (this.raw_clip_state[0x2cc] & 1) {
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

        const jetCool: boolean = !!(this.raw_clip_state[0x2cd] & 1)
        const jetHeat: boolean = !!(this.raw_clip_state[0x2cd] & 2)
        if (jetCool || jetHeat) {
            this.addJetField(config, 0x323, 'jet', 'Jet', 'mdi:wind-power', jetCool, jetHeat)
        }

        if (this.raw_clip_state[0x2d3] & 1) {
            // 15h - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)
        }

        // ONOFF_TIMER (bit 2), or TIMEBS_ONOFF (bit 4): units advertising the latter (H09S1D) accept
        // the same relative timers
        if (this.raw_clip_state[0x2d3] & (ONOFF_TIMER | TIMEBS_ONOFF)) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24)
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24)
        }

        if (this.raw_clip_state[0x2cc] & 2) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === 0,
            )
        }

        // AIAUTODRY (0x350 bit 4): 0x20e is the user setting (0=off, 255=on), not a status
        const autoDrySetting = !!(this.raw_clip_state[0x350] & 0x10)

        if (this.raw_clip_state[0x2cc] & 4 && autoDrySetting) {
            config['components']['autodry'] = tombstone('binary_sensor')
            this.addConfigSwitchField(config, 0x20e, 'autodrysetting', 'Auto dry', 'mdi:hair-dryer', 255)

            this.addOptionalSensorField(
                config,
                0x225,
                'autodryremain',
                'Auto dry remaining',
                'mdi:hair-dryer-outline',
                { unit_of_measurement: '%', suggested_display_precision: 0 },
            )

            if (this.raw_clip_state[0x192]) {
                const supported = AUTODRY_FAN_MODES.options.filter(
                    (opt) => this.raw_clip_state[0x192] & (1 << AUTODRY_FAN_MODES.unmap(opt)!),
                )
                this.addSelectField(
                    config,
                    0x1f2,
                    'autodryfan',
                    'Auto dry fan',
                    'mdi:fan',
                    supported,
                    AUTODRY_FAN_MODES,
                )
            }
        } else if (this.raw_clip_state[0x2cc] & 4) {
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

        // 0x2d6 bit 1 = BRIGHTNESS_CONTROL; bit 15 = RAC_88_DISPLAY_CONTROL, the only display bit of the
        // H09S1DA, which also uses the inverted polarity (0 = on). If other bit 15 units turn out to behave
        // the same, they may not need the allowlist.
        const displayLightSupported =
            !!(this.raw_clip_state[0x2d6] & 0x8002) && DISPLAY_LIGHT_EEPROM_CHECKSUMS.has(this.raw_clip_state[0x2da])
        if (displayLightSupported) {
            const on = DISPLAY_LIGHT_EEPROM_CHECKSUMS.get(this.raw_clip_state[0x2da])!
            this.addConfigSwitchField(
                config,
                0x21f,
                'displaylight',
                'Display light',
                'mdi:lightbulb-outline',
                on,
                1 - on,
            )
        }

        this.addExtendedFeatures(config)

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
                        this.filterDoReset = true
                        // do a query first to get the most recent pre-reset values
                        this.sendFilterQuery()
                    }
                    return false
                },
            }
        }

        // accumMode (0x2d5) is what makes the ThinQ app show its energy widgets; units with a MOMENTARY mode
        // report their power in 0x2b3 (others, e.g. most multi-split IDUs, report 0)
        const accumMode = this.raw_clip_state[0x2d5]
        if (accumMode & (MOMENTARY_INOUTDOOR | MOMENTARY_OUTDOOR)) {
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

            // With MOMENTARY_OUTDOOR (e.g. H09S1DA on a multi-split system) the raw value matched a power meter on
            // the outdoor unit. Without it (single-split units, see #62), the measurements reported by AC appear to
            // be Watts, but they are not accurate in several aspects:
            // - the value is biased by +50
            // - idle consumption (around 4W) and the 4-way valve is not included
            // - fan modes' consumption appears to be approximated
            //
            // The formula below is expected to be within +/-10% of the actual power consumption. The discrepancy may
            // be highest in fan-only modes.
            this.addField(config, {
                id: 0x2b3,
                name: '',
                comp: 'energy_current',
                writable: false,
                read_xform: accumMode & MOMENTARY_OUTDOOR ? undefined : (raw) => Math.max(5, raw - 60),
            })
        }

        this.setConfig(config)
        this.publishFeatureInfo()

        if (this.filterLifeTime) {
            this.publishFilterData()

            /*
             * Refresh only once a day since a query might do an EEPROM
             * write.
             */
            this.filterQueryTimer = setInterval(
                () => {
                    this.log('sending periodic filter data refresh query')
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

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === 0) return 1
                if (jetHeat && this.getModeTLV() === 4) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === 0 && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === 4 && raw == 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))) return false

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
                    ((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))
                )
            },
        })

        /*
         * This value needs to be written at each power up in heat/cool mode,
         * but in a separate message.
         */
        this.modeChangeHooks.push(() => {
            if (this.jetMode === undefined) return
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

    addConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        onValue = 1,
        offValue = 0,
    ) {
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
            write_xform: (val) => (val === 'ON' ? onValue : offValue),
            read_xform: (raw) => (raw === offValue ? 'OFF' : 'ON'),
        })
    }

    addSelectField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: string[],
        values: Enum<string>,
    ) {
        config['components'][name] = allowExtendedType<ComponentInfo, ComponentInfo & Record<string, unknown>>({
            platform: 'select',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
            options: options,
        })

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => values.map(raw),
            write_xform: (val) => values.unmap(val),
        })
    }

    // Lowest/highest setpoint over the per-mode limits a unit reports (half-degrees), if any.
    tempLimit(pick: (...values: number[]) => number, tags: number[]) {
        const limits = tags.map((t) => this.raw_clip_state[t]).filter((v) => v)
        return limits.length ? pick(...limits) / 2 : undefined
    }

    /**
     * Attach what LG's owner's manual says about a feature to its HA entity: a `description` and
     * `requires` attribute, and, when the feature only works in some states, a per-entity
     * availability topic so HA greys it out while the requirement is not met.
     */
    describeFeature(config: DeviceDiscovery, name: string, description: string, requirement?: FeatureRequirement) {
        const comp = config['components'][name] as Record<string, unknown> | undefined
        if (!comp) return
        comp.json_attributes_topic = '$this/' + name + '-attributes'
        if (requirement) {
            comp.availability = [
                { topic: '$this/availability' },
                { topic: '$rethink/availability' },
                { topic: '$this/' + name + '-available' },
            ]
            comp.availability_mode = 'all'
        }
        this.featureInfo[name] = { description, requirement }
    }

    publishFeatureInfo() {
        for (const [name, { description, requirement }] of Object.entries(this.featureInfo)) {
            this.publishProperty(
                name + '-attributes',
                JSON.stringify({ description, requires: requirement?.text ?? 'nothing, always available' }),
            )
        }
        this.publishFeatureAvailability()
    }

    publishFeatureAvailability() {
        for (const [name, { requirement }] of Object.entries(this.featureInfo)) {
            if (requirement) this.publishProperty(name + '-available', requirement.met() ? 'online' : 'offline')
        }
    }

    // AC switched on, and (optionally) in one of the given modes. MODE_PURIFY_ONLY counts as fan mode.
    runningIn(text: string, modes?: number[]): FeatureRequirement {
        const mode = () => (this.getModeTLV() === MODE_PURIFY_ONLY ? 2 : this.getModeTLV())
        return {
            text,
            met: () => !!this.getPowerTLV() && (!modes || modes.includes(mode())),
        }
    }

    /**
     * A setting that the unit only accepts while its requirement is met. Reads outside that state
     * are ignored. With `remember`, the last requested value is re-sent when the unit enters a state
     * that accepts it (like airclean/energysave).
     */
    addRunningOnlyField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        component: Record<string, unknown>,
        xform: Pick<FieldDefinition, 'read_xform' | 'write_xform'>,
        remember: boolean,
        requirement: FeatureRequirement,
    ) {
        const accepted = () => requirement.met()

        config['components'][name] = allowExtendedType<ComponentInfo, ComponentInfo & Record<string, unknown>>({
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            entity_category: 'config',
            ...component,
            ...(remember ? { optimistic: true } : {}),
        })

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: xform.read_xform,
            write_xform: (val) => {
                if (remember) this.rememberedSettings[name] = val
                return xform.write_xform!(val)
            },
            read_callback: (val) => {
                if (!accepted()) return false
                if (remember) this.rememberedSettings[name] = String(val)
                return true
            },
            write_callback: () => accepted(),
        })

        if (remember) {
            this.modeChangeHooks.push(() => {
                const val = this.rememberedSettings[name]
                if (val !== undefined && accepted()) this.setProperty(name + '-', val)
            })
        }
    }

    /*
     * Features of newer indoor units (verified on H09S1D, firmware 0x55703). Each one is gated on
     * the capability bit LG's modelJSON names for it; the requirements and descriptions follow the
     * owner's manual (MFL72096416, wall mounted, 2024).
     */
    addExtendedFeatures(config: DeviceDiscovery) {
        const caps = (tag: number, mask: number) => !!(this.raw_clip_state[tag] & mask)
        const has = (tag: number) => this.raw_clip_state[tag] != null
        const onOff = {
            write_xform: (val: string) => (val === 'ON' ? 1 : 0),
            read_xform: (raw: number) => (raw ? 'ON' : 'OFF'),
        }

        // airPolution SENSOR_HUMID_SUPPORT
        if (caps(0x2dd, 0x20) && has(0x336)) {
            config['components']['humidity'] = allowExtendedType<
                ComponentInfo,
                ComponentInfo & Record<string, unknown>
            >({
                platform: 'sensor',
                unique_id: '$deviceid-humidity',
                state_topic: '$this/humidity',
                name: 'Humidity',
                device_class: 'humidity',
                unit_of_measurement: '%',
                state_class: 'measurement',
            })
            this.addField(config, {
                id: 0x336,
                name: 'current_humidity',
                comp: 'climate',
                state_topic: 'topic',
                writable: false,
                read_callback: (val) => {
                    this.publishProperty('humidity', val)
                    return true
                },
            })
        }

        // wMode AI_AIR cool/heat. 1 = on in either mode.
        if (caps(0x2ca, 0x30000)) {
            this.addRunningOnlyField(
                config,
                0x23e,
                'aiair',
                { name: 'AI Air', icon: 'mdi:robot-outline' },
                onOff,
                false,
                this.runningIn('AC on, in Cooling or Heating', [0, 4]),
            )
            this.describeFeature(
                config,
                'aiair',
                'AI Air: fan speed and airflow direction adjust automatically to reach the set temperature quickly. ' +
                    'Changing the mode or starting Jet ends it.',
                this.runningIn('AC on, in Cooling or Heating', [0, 4]),
            )
        }

        // racModeExt ACTIVE_ENERGY_CONTROL
        if (caps(0x34f, 0x400)) {
            const coolOnly = this.runningIn('AC on, in Cooling', [0])
            this.addRunningOnlyField(
                config,
                0x20d,
                'energylimit',
                {
                    platform: 'select',
                    name: 'Active energy control',
                    icon: 'mdi:flash',
                    options: ENERGY_LIMITS.options,
                },
                { write_xform: (val) => ENERGY_LIMITS.unmap(val), read_xform: (raw) => ENERGY_LIMITS.map(raw) },
                true,
                coolOnly,
            )
            this.describeFeature(
                config,
                'energylimit',
                'Energy Control: limits the power input to 80, 60 or 40 % of the rated input, which also reduces ' +
                    'cooling capacity. The choice is re-applied whenever the AC is back in Cooling.',
                coolOnly,
            )
        }

        // Soft Air: bit 16 of 0x351 (found with the remote; the other bits are kept). The unit drops
        // the fan to low while it is on and restores it afterwards.
        if (has(0x351)) {
            const req = this.runningIn('AC on, in Cooling or Fan', [0, 2])
            this.addRunningOnlyField(
                config,
                0x351,
                'softair',
                { name: 'Soft Air', icon: 'mdi:weather-windy' },
                {
                    write_xform: (val) => (this.raw_clip_state[0x351] & ~0x10000) | (val === 'ON' ? 0x10000 : 0),
                    read_xform: (raw) => (raw & 0x10000 ? 'ON' : 'OFF'),
                },
                false,
                req,
            )
            this.describeFeature(
                config,
                'softair',
                'Soft Air: directs the airflow upwards so you stay cool without feeling a draft. The fan runs low ' +
                    'while it is on. Changing the mode ends it.',
                req,
            )
        }

        // racModeExt WINDOW_DETECTION: bit 0 of 0x3c9, the other bits must be kept
        if (caps(0x34f, 0x100000) && has(0x3c9)) {
            this.addConfigSwitchField(config, 0x3c9, 'windowdetection', 'Window detection', 'mdi:window-open-variant')
            const def = this.fields_by_id[0x3c9]
            def.write_xform = (val) => (this.raw_clip_state[0x3c9] & ~1) | (val === 'ON' ? 1 : 0)
            def.read_xform = (raw) => (raw & 1 ? 'ON' : 'OFF')
            this.describeFeature(
                config,
                'windowdetection',
                'Window Open Detection: in Cooling or Heating, a sudden temperature change (an open window) switches ' +
                    'the AC to Energy Control (8O/6O/4O on the display) until the window is closed or the mode changes.',
            )
        }

        // racMode bit 9 (AC_MAIN_LH_TITLE_W): wMode.lowHeating
        if (caps(0x2cc, 0x200)) {
            const heatOnly = this.runningIn('AC on, in Heating', [4])
            this.addRunningOnlyField(
                config,
                0x22d,
                'lowheating',
                { name: 'Low heating', icon: 'mdi:snowflake-thermometer' },
                onOff,
                false,
                heatOnly,
            )
            this.describeFeature(
                config,
                'lowheating',
                'Low Heating (LH): keeps the room at about 10 °C so nothing freezes while you are away. ' +
                    'Changing the temperature, fan speed or mode cancels it.',
                heatOnly,
            )
        }

        // sacSubMode SUPPORT_SOUND_ON_OFF. bellSound.control: 0 = beep on, 1 = muted (as the ThinQ app shows it)
        if (caps(0x374, 0x4) && has(0x3a0)) {
            this.addConfigSwitchField(config, 0x3a0, 'beep', 'Beep', 'mdi:volume-high', 0, 1)
            this.describeFeature(config, 'beep', 'The beep when a setting changes. Off is the "Mute" function.')
        }

        // commonFunc GOODSLEEP (the manual's "Sleep+"). These are stored preferences the unit keeps while
        // switched off; they only act while the Sleep timer runs in Cooling. Greyed out while the AC is off,
        // but the stored value is always reported.
        if (caps(0x2f0, 0x8) && has(0x12d)) {
            const whileOn = this.runningIn('AC on')
            const options: [number, string, string, string][] = [
                [
                    0x12d,
                    'goodsleep',
                    'GoodSleep',
                    'Sleep+: while the Sleep timer runs in Cooling, the AC learns and adjusts the temperature and ' +
                        'fan speed for sleeping. Nothing changes until a Sleep timer is set.',
                ],
                [0x12f, 'goodsleepop', 'GoodSleep adjusts operation', 'Lets Sleep+ adjust the fan and operation.'],
                [0x133, 'goodsleeptemp', 'GoodSleep adjusts temperature', 'Lets Sleep+ adjust the set temperature.'],
            ]
            for (const [id, name, desc, description] of options) {
                if (!has(id)) continue
                this.addConfigSwitchField(config, id, name, desc, 'mdi:sleep')
                this.describeFeature(config, name, description, whileOn)
            }
        }

        // Absence detection (miscFuncState.absencePowerSaving / absenceDetectionTime, 0x1f0 / 0x1ef) is not
        // exposed: it needs the human detecting (radar) sensor, which units like the H09S1DA (modelJSON
        // support.vision = NON) lack, although they accept and report the values.

        // Auto Clean+ (auto dry) and its fan, see the 0x2cc bit 2 block
        this.describeFeature(
            config,
            'autodrysetting',
            'Auto Clean+: after Cooling or Dry, dries the inside of the indoor unit for up to 20 minutes to ' +
                'prevent moisture and odours. Can be set with the AC off.',
        )
        this.describeFeature(config, 'autodryfan', 'Fan speed used while Auto Clean+ dries the indoor unit.')

        if (this.featureInfo['displaylight'] === undefined && config['components']['displaylight'])
            this.describeFeature(
                config,
                'displaylight',
                'The indoor unit display. Off is the "Light Off" function; a remote button press lights it briefly.',
            )

        // Requirements of the long-standing features, per the owner's manuals (DC12RT and H09S1D)

        // the sleep timer can only be set while the AC is on
        if (this.fields_by_id[0x21a]) {
            const req = this.runningIn('AC on')
            const hours = this.raw_clip_state[0x2d3] & SLEEP_TIMER_12H ? 12 : 7
            this.fields_by_id[0x21a].write_callback = () => req.met()
            this.describeFeature(
                config,
                'sleeptimer',
                `Turns the AC off after the set time (the remote allows up to ${hours} h). In Cooling it raises the ` +
                    'temperature by up to 2 °C for a more comfortable sleep.',
                req,
            )
        }
        for (const name of ['starttimer', 'stoptimer'])
            this.describeFeature(config, name, 'Turns the AC on or off after the set time (up to 24 h).')

        // Jet: only in the modes the unit advertises it for (see addJetField)
        const jetModes = [this.raw_clip_state[0x2cd] & 1 ? 0 : -1, this.raw_clip_state[0x2cd] & 2 ? 4 : -1].filter(
            (m) => m >= 0,
        )
        if (jetModes.length)
            this.describeFeature(
                config,
                'jet',
                'Jet: strong airflow for 30 minutes to cool or heat the room quickly, then back to the previous setting.',
                this.runningIn(
                    jetModes.length === 2
                        ? 'AC on, in Cooling or Heating'
                        : jetModes[0] === 0
                          ? 'AC on, in Cooling'
                          : 'AC on, in Heating',
                    jetModes,
                ),
            )

        // Energy saving (DC12RT and similar, 0x2cc bit 1): Cooling only
        this.describeFeature(
            config,
            'energysave',
            'Energy saving: reduces the power input, which also reduces cooling capacity. The choice is re-applied ' +
                'whenever the AC is back in Cooling.',
            this.runningIn('AC on, in Cooling', [0]),
        )

        // Air purify (ionizer): can be set any time, applied once the AC runs
        this.describeFeature(
            config,
            'airclean',
            'Air purify: the ionizer reduces bacteria and other substances in the air. Set it any time; it is ' +
                'applied while the AC runs.',
        )

        if (Object.keys(this.featureInfo).length) this.modeChangeHooks.push(() => this.publishFeatureAvailability())
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'energySave',
        check_mode?: CheckMode,
    ) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
            optimistic: true,
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

        if (!!check_mode) {
            this.modeChangeHooks.push(() => {
                if (this[field_name] === undefined) return
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        } else {
            this.powerChangeHooks.push(() => {
                if (this[field_name] === undefined) return
                if (this.getPowerTLV() === 0) return
                /*
                 * This value needs to be written at each power up,
                 * but in a separate message.
                 */
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        }
    }
}
