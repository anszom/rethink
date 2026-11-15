import { type ComponentInfo, type Tombstone } from '../homeassistant'
import { allowExtendedType } from '@/util/casting'
import { Enum } from '@/util/enum'
import F3L7CYK5W_US_WIFI from './F3L7CYK5W_US_WIFI'

// LG WM3500CW front-load washer — matched on modelId "VIC2_799_US_FACTORY". Same record layout and option
// bits as F3L7CYK5W_US_WIFI, each confirmed against the LG cloud, with these differences:
//   * its own course table;
//   * rec[7] is the error code, numbered as in its modelJSON (dE1 seen as 0x11);
//   * rec[16] bit 0x01 is Fresh Care;
//   * rec[21] holds the ID of the cycle loaded in the Downloaded position.

const COURSE_OFFSET = 6
const ERROR_OFFSET = 7
const OPT2_OFFSET = 16
const OPT2_FRESH_CARE = 0x01
const DOWNLOADED_ID_OFFSET = 21

const COURSE_DOWNLOADED = 0x0a

// Derived from the capture by pairing rec[6] with the cloud's apCourseFLUpper25inchBaseUS.
const COURSE = Enum.of({
    'Tub Clean': 0x01,
    'Bright Whites': 0x02,
    Bedding: 0x03,
    'Heavy Duty': 0x04,
    Normal: 0x05,
    'Perm Press': 0x06,
    Delicates: 0x07,
    Towels: 0x08,
    'Speed Wash': 0x09,
    Downloaded: COURSE_DOWNLOADED,
})

// rec[21] against the cloud's downloadedCourseFLUpper25inchBaseUS. The modelJSON carries no numeric IDs
// for its downloadable cycles, so only the ones loaded during the capture are known.
const DOWNLOADED = Enum.of({
    'Small Load': 0x33,
    Denim: 0x37,
    'Econo Wash': 0x6a,
})

// The modelJSON's error indices, labelled as in F3P2CYUBE__; only OK and dE1 were seen on the wire, and
// the wire carried the modelJSON index for every other enum of this washer.
const ERRORS = Enum.of({
    OK: 0,
    'Door open error (dE2)': 1,
    'Water supply error (IE)': 2,
    'Water drain error (OE)': 3,
    'Out of balance error (UE)': 4,
    'Overfill error (FE)': 5,
    'Water pressure error (PE)': 6,
    'Thermistor error (tE)': 7,
    'BLDC error (LE)': 8,
    'Unknown error (CE)': 9,
    'SVC call (dHE)': 10,
    'Power failure error (PF)': 11,
    'Freeze error (FF)': 12,
    'Unknown error (dCE)': 13,
    'Unknown error (AE)': 14,
    'EEPROM error (EE)': 15,
    'Unknown error (sud)': 16,
    'Door open error (DE1)': 17,
    'Sliding Lid Open error (LOE)': 18,
    'Unknown error (PS)': 19,
})

export default class Device extends F3L7CYK5W_US_WIFI {
    protected components(): Record<string, ComponentInfo | Tombstone> {
        return allowExtendedType({
            ...super.components(),
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
                options: ERRORS.options,
            },
            fresh_care: {
                platform: 'binary_sensor',
                unique_id: '$deviceid-fresh_care',
                state_topic: '$this/fresh_care',
                name: 'Fresh Care',
                icon: 'mdi:fan',
            },
        })
    }

    protected course(rec: Buffer) {
        const course = rec[COURSE_OFFSET]
        if (course !== COURSE_DOWNLOADED) return COURSE.map(course)
        const name = DOWNLOADED.map(rec[DOWNLOADED_ID_OFFSET])
        return name ? `Downloaded (${name})` : 'Downloaded'
    }

    protected processRecord(rec: Buffer) {
        super.processRecord(rec)

        const error = rec[ERROR_OFFSET]
        this.publishProperty('error_message', ERRORS.map(error)) // publish message before set error state
        this.publishProperty('error', error ? 'ON' : 'OFF')
        this.publishProperty('fresh_care', (rec[OPT2_OFFSET] & OPT2_FRESH_CARE) !== 0 ? 'ON' : 'OFF')
    }
}
