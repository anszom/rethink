import { type ComponentInfo, type Tombstone } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import RV13B6ES_D_US_WIFI from './RV13B6ES_D_US_WIFI'

// LG DLE3500W electric dryer — matched on modelId "RV13B6AM_D_US_WIFI". Same record layout as
// RV13B6ES_D_US_WIFI, confirmed field by field against the LG cloud, with these differences:
//   * its own course table (Small Load, Rack Dry; no Antibacterial or steam courses);
//   * its panel has no Reduce Static, Damp Dry Signal, Turbo Steam or Load Items, so those entities are
//     dropped (their bits never set in any capture);
//   * rec[10] carries the Time Dry setting, published as RV13D5JSD_D_US publishes the same byte;
//   * rec[22] is Flow Sense, the restricted-exhaust flag, which the LG cloud does not report at all;
//   * rec[21] holds the downloaded cycle's ID while the Downloaded position is selected (0 otherwise),
//     and rec[6] then holds that cycle's base course.

const COURSE_OFFSET = 6
const TIME_DRY_SETTING_OFFSET = 10
const DOWNLOADED_ID_OFFSET = 21
// Not cloud-confirmed (the cloud has no such field): tied to the duct itself. The Installation Test (the
// dryer's 3-minute duct check) set it about 63 s in with the duct connected, twice, and never with the
// duct disconnected at the dryer. In normal use it sets a few minutes into drying, stays set through
// power-off and clears at the next power-on.
const FLOW_SENSE_OFFSET = 22

// Derived from the capture by pairing rec[6] with the cloud's courseDryer27inchBase.
const COURSE = Enum.of({
    'Heavy Duty': 0x01,
    Towels: 0x02,
    Normal: 0x03,
    'Perm Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    'Small Load': 0x09,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    'Time Dry': 0x12,
    'Rack Dry': 0x13,
})

// rec[21] against the cloud's smartCourseDryer27inchBase. The modelJSON carries no numeric IDs for its
// downloadable cycles, so only the ones loaded during the capture are known.
const DOWNLOADED = Enum.of({
    'Super Dry': 100,
    'Gym Clothes': 107,
})

const COURSE_TIME_DRY = 0x12

const OMITTED = ['reduce_static', 'damp_dry_signal', 'turbo_steam', 'load_item']

export default class Device extends RV13B6ES_D_US_WIFI {
    protected components(): Record<string, ComponentInfo | Tombstone> {
        const components = Object.entries(super.components()).filter(([key]) => !OMITTED.includes(key))
        return allowExtendedType({
            ...Object.fromEntries(components),
            time_dry_setting: {
                platform: 'sensor',
                unique_id: '$deviceid-time_dry_setting',
                state_topic: '$this/time_dry_setting',
                name: 'Time Dry setting',
                icon: 'mdi:timer-cog-outline',
                unit_of_measurement: 'min',
                entity_category: 'diagnostic',
            },
            flow_sense: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-flow_sense',
                state_topic: '$this/flow_sense',
                name: 'Flow Sense',
                icon: 'mdi:air-filter',
                device_class: 'problem',
            },
        })
    }

    protected course(rec: Buffer) {
        const downloaded = rec[DOWNLOADED_ID_OFFSET]
        if (!downloaded) return COURSE.map(rec[COURSE_OFFSET])
        const name = DOWNLOADED.map(downloaded)
        return name ? `Downloaded (${name})` : 'Downloaded'
    }

    // The inherited decoding still reads the options this panel lacks; they have no entity here
    publishProperty(prop: string, value: string | number | undefined) {
        if (!OMITTED.includes(prop)) super.publishProperty(prop, value)
    }

    protected processRecord(rec: Buffer) {
        super.processRecord(rec)

        // rec[10] against the cloud's timeDry: the modelJSON's TIMEDRY_20..TIMEDRY_60 are codes 1 to 5
        const timeDry = rec[TIME_DRY_SETTING_OFFSET]
        this.publishProperty(
            'time_dry_setting',
            rec[COURSE_OFFSET] === COURSE_TIME_DRY && timeDry >= 1 && timeDry <= 5 ? (timeDry + 1) * 10 : 0,
        )
        this.publishProperty('flow_sense', rec[FLOW_SENSE_OFFSET] ? 'ON' : 'OFF')
    }
}
