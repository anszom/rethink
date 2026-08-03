import ACDevice, { type SwingAxis, type SwitchOptions, type WireLevels } from './ac_common'
import { DeviceDiscovery } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import log from '@/util/logging'

/**
 * LG stand (floor-standing) air conditioner, ThinQ model PAC_910604_WW, deviceType 401.
 *
 * The protocol handling is ac_common's. What is below is what this unit does differently, and
 * every number in it comes from kkqq9320's four hand-operated capture sessions of the physical
 * appliance (557 wire frames, none injected) reported in issue #105, or from its own capability
 * reply. Where a value is not measured, it says so.
 *
 * Its capability bitmaps are unusually empty: 0x2cc is absent entirely and 0x2cd reads 0, so the
 * derivations in ac_common answer "no" for every feature this unit actually has. Each of those is
 * therefore stated here instead - which is what the per-model hooks are for, but it is worth
 * knowing that on this model the bitmaps are not the source of truth the wall units make them.
 */

/* Cool, dry and air-clean. 0x2c1 = 35 - bits 0, 1 and 5 - says the same, and a write of 2
 * (fan_only on the wall units) was injected and ignored, so the scale genuinely differs. */
const MODES: WireLevels = [
    ['cool', 0],
    ['dry', 1],
    ['fan_only', 5],
]

/*
 * 2..6 are the five speeds the panel offers, named as on the wall units.
 *
 * 7 and 8 are not selections: they are the appliance reporting that it is driving the fan itself,
 * 8 while dry runs and 7 while jet runs, with the fan control greyed out on the panel and in the
 * app. Both read back as 'auto'; dropping 7 would leave HA showing the speed picked before jet was
 * switched on. Writing 'auto' sends 8, which is what the app sends on entering dry - HA has no way
 * to publish a read-only member of fan_modes, so this is the closest honest thing.
 */
const FANS: WireLevels = [
    ['very low', 2],
    ['low', 3],
    ['medium', 4],
    ['high', 5],
    ['very high', 6],
    ['auto', 8],
    ['auto', 7],
]

/*
 * 0x2a3 aims the airflow sideways. It is not oscillation, and this model has no vertical louvre
 * control at all, so it goes on swing_horizontal_mode - where RAC puts its left/right vane - and
 * swing_modes is left undeclared rather than misused.
 */
const WIND_DIRECTIONS: WireLevels = [
    ['focus', 1],
    ['wide', 2],
    ['left', 3],
    ['right', 4],
    ['split', 5],
]

/* AI dry strength: the appliance's 1단..5단 on 0x1f2. */
const AUTO_DRY_LEVELS: WireLevels = [
    ['1', 2],
    ['2', 3],
    ['3', 4],
    ['4', 5],
    ['5', 6],
]

const TAG_TEMP_STEP = 0x1fb
const TAG_AUTO_DRY_REMAIN = 0x225
const TAG_HUMIDITY = 0x336

/*
 * The 0xa8 telemetry record: NOT TLV, a fixed-offset binary struct, and therefore model- and
 * firmware-specific in a way nothing else here is. Everywhere else a tag carries its own identity,
 * so a firmware that moves a field simply stops sending the tag; here a firmware that inserts one
 * byte silently makes the offset below mean something else. The evidence is four captures of ONE
 * appliance on swVersion 310917.
 *
 * Hence the exact length test rather than a lower bound: 66 of the 67 0xa8 frames on file are
 * exactly 307 bytes, and buf[10] is 0xff instead of the payload length every other frame kind puts
 * there - which is why they fail the state-frame test and reach this branch at all. The 67th is 15
 * bytes and carries a TLV-shaped payload; both extra tests are what keep it out, so neither is
 * redundant.
 */
const A8_FRAME_LENGTH = 307

/*
 * Byte offset of the outdoor compressor running flag inside that record, measured against an
 * annotated experiment: the owner set cooling to 18 C, raised the setpoint so the compressor would
 * stop, lowered it again, then switched to dry, metering the outdoor unit throughout.
 *
 * Of the 307 offsets, exactly @160, @173 and @198 are strictly 0-or-1 across all 66 long frames and
 * reproduce all five present-tense observations. @198 disagrees with the compressor-Hz byte @177 in
 * 21 of the 66. @160 and @173 differ on exactly two frames, both of which the owner predicted
 * rather than watched - and at both the telemetry says nothing was being cooled: at one the unit
 * had just been switched on and 0x2b3 was ramping through a fan curve for another 73 s before it
 * stepped to 943 W. So @173 leads the machine by up to a minute; it is a demand, not a report, and
 * hvac_action asks what the appliance IS doing.
 *
 * @160 is not an arbitrary survivor either: five offsets - 148, 153, 160, 165, 177 - are non-zero
 * in exactly the frames where the Hz byte is, without exception, and @160 is that group's only
 * strictly boolean member. Read as `!== 0` anyway, so a firmware reporting a stage still works.
 */
const COMPRESSOR_RUNNING_OFFSET = 160

export default class Device extends ACDevice {
    readonly haDeviceName = 'LG Stand Air Conditioner'

    /*
     * Last reading of the compressor flag. `undefined` is a third state, not a synonym for "not
     * running": it suppresses the cooling/idle publish entirely until the appliance has said. It
     * is cleared on every power-on, because a reading from before an off period says nothing about
     * the run that is starting - the flag really does still read 1 seconds after a switch-off.
     */
    compressorRunning: boolean | undefined = undefined

    /* This unit sends its state frames with header byte 6 of 0xa7. Widened, never replaced. */
    isHeaderByte6(byte: number): boolean {
        return byte === 0x87 || byte === 0xa7
    }

    readonly modeLevels = MODES
    readonly fanLevels = FANS

    /*
     * Not narrowed by 0x2c2. It reads 127100 - bits 2..6 for the speeds above, then bits 12..16,
     * which are further named wind modes in the same enum rather than a second field. Neither 7 nor
     * 8 is advertised, correctly: they are machine-driven states, and letting the bitmap narrow the
     * list would drop the 'auto' the appliance reports while drying.
     */
    fanCaps() {
        return undefined
    }

    /* The panel steps in half degrees by default, but 0x1fb can change it - see addModelFields. */
    readonly tempStep = 0.5

    /* A mode write while off is what the app uses to start the unit in that mode. */
    readonly powerOnWithModeWrite = true

    /* Sideways aim only; there is no vertical vane on this model. */
    swingAxes(): SwingAxis[] {
        return [{ tag: 0x2a3, name: 'swing_horizontal_mode', levels: WIND_DIRECTIONS }]
    }

    /*
     * 0x2b3 is in tenths of a watt here, unlike the wall units' whole watts: taken raw the
     * appliance would claim 10085 W at full load, which no single indoor unit draws, and a tenth of
     * that is right for a stand unit. There is no additive bias to remove - RAC subtracts one
     * because it never reports a true zero, whereas this one reports exactly 0 when switched off.
     * The figure includes the indoor fan: with the compressor stopped and the outdoor unit metered
     * at 0 W, this tag still read 48.8 W.
     */
    powerReadXform(raw: number) {
        return raw / 10
    }

    /*
     * The filter is the plain value-tag pair, and it resets: the app writes 0 to 0x355 and the
     * appliance answers with 0x355 = 0x356. Its private-channel filter counter answers too, with a
     * different 720 h part that appears nowhere in the app - a convincing trap, and the reason this
     * is a per-model answer rather than something probed at runtime.
     */
    filterStyle() {
        return 'valueTagsReset' as const
    }

    /*
     * Auto dry is three tags here: 0x20e enables it and reads 0 or 255 and nothing else, 0x1f2
     * carries the 1..5 strength, and 0x225 counts the running cycle down in minutes - transcribed
     * three times from the appliance's own display, and decrementing once every 60 s over ten
     * readings. Unconditional: 0x2cc, the bit ac_common would gate this on, is absent here.
     */
    autoDryStyle() {
        return 'switchLevel' as const
    }

    readonly autoDryEnableOptions: SwitchOptions = { onValue: 255 }
    readonly autoDryLevels = AUTO_DRY_LEVELS

    autoDryLevelTag() {
        return 0x1f2
    }

    /*
     * Sleep timer, on the unit's own word: 0x2d3 = 282643 has the sleep bit set. The minute scale
     * and the 15 h ceiling are inherited from the wall units and NOT measured here - 0x21a reads 0
     * in both comprehensive dumps and was never seen to move.
     */
    hasSleepTimer() {
        return true
    }

    /*
     * Everything the capability bitmaps do not describe on this unit. Jet and air purify are plain
     * on/off tags here - 0x236 rather than the wall units' mode-dependent 0x323 - so they are
     * ordinary switches rather than ac_common's jet field.
     */
    addModelFields(config: DeviceDiscovery) {
        this.addConfigSwitchField(config, 0x236, 'jet', 'Jet cool', 'mdi:wind-power')
        this.addConfigSwitchField(config, 0x29d, 'quiet', 'Quiet mode', 'mdi:volume-off')
        this.addConfigSwitchField(config, 0x2a2, 'uvnano', 'UVnano', 'mdi:bacteria')
        this.addConfigSwitchField(config, 0x3a9, 'childlock', 'Child lock', 'mdi:lock')
        /* the appliance mirrors this into 0x25e, which needs no entity of its own */
        this.addConfigSwitchField(config, 0x23e, 'smartcare', 'Smart care', 'mdi:auto-fix')

        /*
         * No entity_category, so HA files these under Controls next to the climate card rather
         * than under Configuration: they aim or clean the airflow, and are reached for as often as
         * the fan speed.
         */
        const control: SwitchOptions = { entityCategory: undefined }
        this.addConfigSwitchField(config, 0x1be, 'spacefit', 'Space-fit wind', 'mdi:arrow-expand-horizontal', control)
        this.addConfigSwitchField(config, 0x20f, 'airclean', 'Air purify', 'mdi:air-purifier', control)

        /*
         * Inverted, as on the wall units: the appliance stores 1 for display-off and for muted.
         * Confirmed by the annotated capture, where turning the panel display off produced
         * 0x21f = 1 and silencing it produced 0x3a0 = 1.
         */
        this.addConfigSwitchField(config, 0x21f, 'display', 'Display Light', 'mdi:television-ambient-light', {
            onValue: 0,
            offValue: 1,
        })
        this.addConfigSwitchField(config, 0x3a0, 'beep', 'Beep Sound', 'mdi:volume-high', {
            onValue: 0,
            offValue: 1,
        })

        /*
         * The cleaning cycles are start/stop pairs with a readable running state, so switches
         * rather than buttons; both drive power, fan and wind direction by themselves while they
         * run. 0x3a2 reads 1 while the heat-exchanger clean runs and 255 while the all-clean cycle
         * does, hence the exact comparison the switch options give rather than a truthiness test.
         * Diagnostic: occasional maintenance, not everyday settings.
         */
        const maintenance: SwitchOptions = { entityCategory: 'diagnostic' }
        this.addConfigSwitchField(
            config,
            0x3a2,
            'hxclean',
            'Cleaning - Heat exchanger',
            'mdi:heating-coil',
            maintenance,
        )
        this.addConfigSwitchField(config, 0x165, 'allclean', 'Cleaning - ALL', 'mdi:spray-bottle', {
            ...maintenance,
            onValue: 100,
            readOnValue: 2,
        })

        this.addValueSelect(config, 'onesidewind', 0x2a8, 'One-side wind', 'mdi:arrow-left-right', [
            ['off', 0],
            ['left', 1],
            ['right', 2],
        ])

        /*
         * 0x336 is the indoor relative humidity, a plain integer percentage - confirmed over 30
         * samples spanning 55..70, falling while cooling and rising during air-clean. 0x337 is the
         * panel's display option for it. The app changes 0x337 over the private command channel,
         * but a TLV write was tried against the appliance and does take effect, so it is a select.
         */
        this.addSensorField(config, TAG_HUMIDITY, 'humidity', 'Humidity', undefined, {
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
            /* a room measurement, not a diagnostic */
            entity_category: undefined,
        })
        this.addValueSelect(config, 'humiditydisplay', 0x337, 'Humidity display', 'mdi:water-percent', [
            ['while running', 0],
            ['always', 1],
        ])

        this.addTempStepSelect(config)
        this.addAutoDryRunning(config)
    }

    /*
     * 0x1fb selects the resolution of the setpoint: 0 => 0.5 C, 1 => 1 C. It has two jobs and
     * exactly ONE field, because addField registers fields_by_id[0x1fb] and a second registration
     * would silently replace the first - it keeps the climate component's temp_step in sync, and
     * it publishes a select so the resolution can be changed from HA.
     *
     * WRITE CAVEAT, unattested. The app never writes 0x1fb alone: both writes in the capture pair
     * it with 0x1fc = 0, whose meaning is unknown and which this appliance never reports, so
     * write_attach cannot source it and inventing a value would be a guess. What goes out is a
     * bare 0x1fb; if a report ever arrives that HA moved this and the appliance did not follow,
     * 0x1fc is the first thing to try. The reads and the temp_step sync are unaffected either way.
     */
    addTempStepSelect(config: DeviceDiscovery) {
        const options = ['0.5', '1']
        config['components']['tempstep'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-tempstep',
            name: 'Temperature step',
            icon: 'mdi:thermometer-lines',
            entity_category: 'diagnostic',
            options,
        })
        this.addField(config, {
            id: TAG_TEMP_STEP,
            name: '',
            comp: 'tempstep',
            /* total on purpose: an undefined read would skip the callback below */
            read_xform: (raw) => (raw === 1 ? '1' : '0.5'),
            read_callback: () => {
                this.updateTempStep(this.raw_clip_state[TAG_TEMP_STEP])
                return true
            },
            write_xform: (val) => {
                const index = options.indexOf(val)
                /* null cancels the write rather than sending a bogus resolution */
                return index < 0 ? null : index
            },
        })
    }

    updateTempStep(raw: number) {
        const step = raw === 1 ? 1 : 0.5
        const climate = this.config?.components['climate'] as { temp_step?: number; precision?: number } | undefined
        if (!climate || climate.temp_step === step) return

        log('status', this.id, 'temperature step changed to', step)
        climate.temp_step = step
        climate.precision = step
        this.setConfig(this.config!)
    }

    /*
     * Whether a dry cycle is running now, derived from the same 0x225 ac_common publishes the
     * remaining minutes from - so it has NO field of its own, which would replace that one. The tag
     * reads 0 in every other capture, including a long cooling run, and jumps to 32 in the very
     * frame reporting the unit switched off with AI dry enabled.
     *
     * NOT the same as the 'autodry' switch: that is the standing preference that makes a cycle
     * start at the next power-off and stays on across a cancel. This is the cycle itself.
     *
     * The cancel is captured, not inferred - a plain TLV write of 0 to 0x225, which the app was
     * caught doing four seconds before the operator wrote down that they pressed stop. It goes
     * through fields_by_ha rather than addField for the same reason, and its callback sends the
     * frame itself and returns false: the appliance's own reply is what moves the sensors, so a
     * press it ignores leaves HA showing the cycle still running, which is the truth. There is no
     * captured way to START one on demand, so there is no start button.
     */
    addAutoDryRunning(config: DeviceDiscovery) {
        config['components']['autodryrunning'] = allowExtendedType({
            platform: 'binary_sensor',
            unique_id: '$deviceid-autodryrunning',
            state_topic: '$this/autodryrunning',
            name: 'Auto dry running',
            icon: 'mdi:hair-dryer',
            entity_category: 'diagnostic',
        })

        config['components']['autodrycancel'] = allowExtendedType({
            platform: 'button',
            unique_id: '$deviceid-autodrycancel',
            command_topic: '$this/autodrycancel/set',
            name: 'Cancel auto dry',
            icon: 'mdi:hair-dryer-outline',
            entity_category: 'diagnostic',
        })
        this.fields_by_ha['autodrycancel'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 0 : null),
            write_callback: () => {
                log('status', this.id, 'cancelling the auto dry cycle')
                this.send([1, 1, 2, 1, 1], [{ t: TAG_AUTO_DRY_REMAIN, v: 0 }])
                return false
            },
        }
    }

    processKeyValue(k: number, v: number) {
        super.processKeyValue(k, v)
        if (k === TAG_AUTO_DRY_REMAIN) {
            this.HA.publishProperty(this.id, 'autodryrunning', v > 0 ? 'ON' : 'OFF')
        }
    }

    /*
     * The 0xa8 branch is this model's own; everything else goes to the base class, whose state
     * branch already accepts 0xa7 through isHeaderByte6 above. Note it cannot be folded into that
     * branch: buf[10] is 0xff here, so the base's length test is false by construction.
     */
    processData(buf: Buffer) {
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            buf[6] === 0xa8 &&
            buf[10] === 0xff &&
            buf.length === A8_FRAME_LENGTH
        ) {
            this.compressorRunning = buf[COMPRESSOR_RUNNING_OFFSET] !== 0
            this.updateClimateAction()
            return
        }

        const powerBefore = this.raw_clip_state[0x1f7]
        super.processData(buf)
        this.forgetCompressorOnPowerUp(powerBefore)
    }

    /*
     * The HA-side half of the same. Both routes that turn the appliance on arrive here: the power
     * switch, and a mode select made while the entity reads 'off', which reaches it through the
     * mode field's write_attach.
     */
    setProperty(prop: string, mqttValue: string) {
        const powerBefore = this.raw_clip_state[0x1f7]
        super.setProperty(prop, mqttValue)
        this.forgetCompressorOnPowerUp(powerBefore)
    }

    /*
     * The rising edge, not the falling one. 0xa8 records keep arriving while the unit is off, so
     * clearing on switch-off would only re-latch the flag a second later and produce the same wrong
     * 'cooling' at the next power-on. Only the rising edge is a moment after which no earlier
     * reading can describe the run that is starting.
     */
    forgetCompressorOnPowerUp(powerBefore: number | undefined) {
        if (powerBefore === 0 && this.raw_clip_state[0x1f7] === 1) this.compressorRunning = undefined
    }

    /*
     * ORDER IS LOAD-BEARING:
     *   power off        -> 'off'. Tested first because the compressor coasts down and the flag
     *        lags: there are real frames with the unit off and the flag still set.
     *   mode air-clean   -> 'fan'. Also before the flag: six captured frames have this mode with
     *        the flag still set, the compressor winding down from the mode before it.
     *   flag set         -> 'cooling' or 'drying'.
     *   flag clear, on   -> 'idle'.
     *
     * While the flag is unknown nothing is published for a running cool or dry - there is no
     * evidence either way and HA goes on showing what it last saw, until a 0xa8 record lands,
     * within 100 s in every observed session. The wall units default their equivalent flag to
     * "running"; that is not copied, because here the flag genuinely exists and assuming it would
     * mean claiming 'cooling' through the minute a compressor takes to start.
     */
    updateClimateAction() {
        const power = this.raw_clip_state[0x1f7]
        const mode = this.raw_clip_state[0x1f9]
        const running: Record<number, string> = { 0: 'cooling', 1: 'drying' }

        let action: string | undefined = undefined
        if (power === 0) {
            action = 'off'
        } else if (power === 1) {
            if (mode === 5) action = 'fan'
            else if (this.compressorRunning === false) action = 'idle'
            else if (this.compressorRunning === true) action = running[mode]
        }

        /* undefined means "not known yet", published as silence rather than as a string */
        if (action !== undefined) this.HA.publishProperty(this.id, 'climate-action', action)
    }
}
