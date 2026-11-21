import RACDevice, { FAN_MODES } from './RAC_056905_WW'
import { DeviceDiscovery } from '../homeassistant'
import { Enum } from '@/util/enum'

const CSL_FAN_MODES = Enum.of({
    'very low': 1,
    low: 2,
    medium: 4,
    high: 6,
    'very high': 7,
    auto: 8,
}) as typeof FAN_MODES

const MODE_COOL = 0
const MODE_HEAT = 4

/**
 * LG console air conditioner. It speaks the same TLV protocol as the RAC wall units, but does not
 * advertise most of its features in the capability tags, so they are added here.
 */
export default class Device extends RACDevice {
    protected override fanModes() {
        return CSL_FAN_MODES
    }

    protected override hasJetFlag() {
        return false
    }

    override addExtendedFeatures(config: DeviceDiscovery) {
        this.powerOnWithMode()

        // 0x21f is lightingState.displayControl in the model file: 11 = LED off, 12 = LED on, 13 = auto
        this.addConfigSwitchField(config, 0x21f, 'displaylight', 'Display light', 'mdi:lightbulb-outline', 12, 11)

        // 0 = beeps on, 1 = muted
        this.addConfigSwitchField(config, 0x3a7, 'beep', 'Beep', 'mdi:volume-high', 0, 1)
        this.describeFeature(config, 'beep', 'The beep when a setting changes. Off is the "Mute" function.')

        this.addConfigSwitchField(config, 0x20f, 'plasma', 'Plasma ionizer', 'mdi:air-purifier', 1, 0)
        this.addConfigSwitchField(config, 0x20e, 'autodrysetting', 'Auto dry', 'mdi:hair-dryer', 255)

        this.addFilterSensors(config)
        this.addJetButton(config)

        super.addExtendedFeatures(config)
    }

    /* This unit ignores a mode write while off, so selecting a mode must also send power on. */
    powerOnWithMode() {
        const modeField = this.fields_by_ha['climate-mode']
        if (!modeField) return
        modeField.write_attach = () => {
            if (this.getPowerTLV()) return [0x1fa, 0x1fe]
            this.raw_clip_state[0x1f7] = 1
            return [0x1f7, 0x1fa, 0x1fe]
        }
    }

    /*
     * 0x356 is the total filter life (2400 h) and 0x355 the remaining hours, as in the ThinQ app's Filter
     * manager. The used time is derived from both, so whichever tag arrives last updates it.
     */
    addFilterSensors(config: DeviceDiscovery) {
        this.addOptionalSensorField(config, 0x356, 'filterlifetime', 'Filter life time', 'mdi:air-filter', {
            device_class: 'duration',
            unit_of_measurement: 'h',
            suggested_display_precision: 0,
        })
        const filterLife = this.fields_by_id[0x356]
        if (!filterLife || this.raw_clip_state[0x355] === undefined) return

        const filterUsedTime = {
            platform: 'sensor',
            unique_id: '$deviceid-filterusedtime',
            name: 'Filter used time',
            icon: 'mdi:air-filter',
            device_class: 'duration',
            unit_of_measurement: 'h',
            suggested_display_precision: 0,
            entity_category: 'diagnostic',
            state_topic: '$this/filterusedtime-',
        }
        config['components']['filterusedtime'] = filterUsedTime

        const publishUsed = () => {
            const total = this.raw_clip_state[0x356]
            const remaining = this.raw_clip_state[0x355]
            if (total !== undefined && remaining !== undefined)
                this.publishProperty('filterusedtime-', total - remaining)
        }
        filterLife.read_callback = () => {
            publishUsed()
            return true
        }
        this.addField(config, {
            id: 0x355,
            name: '',
            comp: 'filterusedtime',
            writable: false,
            readable: false,
            read_callback: () => {
                publishUsed()
                return false
            },
        })
    }

    /*
     * The remote's Jet button is only a shortcut: the unit shows no Jet state, it just switches to the
     * strongest fan and to 30 C (heating) or the lowest target (cooling) and then runs as usual.
     */
    addJetButton(config: DeviceDiscovery) {
        const jetButton = {
            platform: 'button',
            unique_id: '$deviceid-jet',
            command_topic: '$this/jet/set',
            name: 'Jet',
            icon: 'mdi:wind-power',
        }
        config['components']['jet'] = jetButton
        this.fields_by_ha['jet'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 1 : 0),
            write_callback: (val) => {
                if (val === 1) this.runJet()
                return false
            },
        }
    }

    runJet() {
        const mode = this.getModeTLV()
        if (!this.getPowerTLV() || (mode !== MODE_HEAT && mode !== MODE_COOL)) return

        const limit =
            mode === MODE_HEAT
                ? (this.tempLimit(Math.max, [0x2e2, 0x2e4, 0x2ec]) ?? 30)
                : (this.tempLimit(Math.min, [0x2e1, 0x2e3, 0x2eb]) ?? 18)

        this.raw_clip_state[0x1fa] = CSL_FAN_MODES.unmap('very high')!
        this.raw_clip_state[0x1fe] = Math.round(limit * 2)
        this.send(
            [1, 1, 2, 1, 1],
            [0x1f9, 0x1fa, 0x1fe].map((t) => ({ t, v: this.raw_clip_state[t] })),
        )
    }
}
