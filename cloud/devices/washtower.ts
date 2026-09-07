import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import crc16 from '@/util/crc16'
import HADevice from './base'
import log from '@/util/logging'

/*
 * LG Korean WashTower washer (FAKPK21021, deviceType 221) and dryer (BDH_D39301_KR, 222).
 * These speak a dedicated 0xEB/0xEC extended-frame protocol, not the AA..BB or clip/TLV forms.
 *
 * The field maps below (offset, length, and the raw->label enums) come from LG's own protocol
 * and convert maps for each model (named at each MODEL constant) cross-checked against the
 * appliance's capability dump; a field is included only where both agree. Each MODEL is a table
 * of what byte holds what and how its raw values decode — the washer and dryer share all the
 * decode/control code below and differ only in these two tables.
 */
type Field = {
    key: string
    offset: number
    length: number
    bit?: number
    bits?: number
    label: string
    values?: Record<string, string>
}
export type WashTowerModel = {
    tag: number
    /** Full 0xEC record length declared by the official protocol map. */
    recordLength: number
    /** CRC-valid 0xEB record length emitted by this installed firmware. */
    liveRecordLength: number
    deviceName: string
    fields: readonly Field[]
}

/*
 * Read-only Course enums from the official converter maps. Labels are resolved
 * from the installed Korean model/langpack data; these maps intentionally do
 * not define which courses are writable.
 */
const WASHER_COURSE_LABELS: Record<string, string> = {
    '0': 'None',
    '1': 'Wash/Dry Refresh',
    '2': 'Add prewash',
    '3': 'Air Cleaning',
    '4': 'Allergy Spa Steam',
    '5': 'Allergy Care',
    '6': 'Safe Cold Wash',
    '7': 'Baby Steam Care',
    '8': 'Baby clothes',
    '9': 'Bedding Care',
    '10': 'Boil',
    '11': 'White Wash',
    '12': 'Large Wash',
    '13': 'Large load',
    '14': 'Everyday wear',
    '15': 'Cold Care',
    '16': 'Cold Clean',
    '17': 'Cold Wash',
    '18': 'Color Care',
    '19': 'Eco Standard',
    '20': 'Closet Dry',
    '21': 'Dark Wash',
    '22': 'Delicate Dry',
    '23': 'Ready to wear',
    '24': 'Double Rinse',
    '25': 'Drain/Spin',
    '26': 'Dry only',
    '27': 'Bedding',
    '28': 'Bedding wash',
    '29': 'Easy Care',
    '30': 'Favorite',
    '31': 'Soft Care',
    '32': 'Half load',
    '33': 'Handwash',
    '34': 'Handwash/Wool',
    '35': 'Heavy soil',
    '36': 'Focus 60min',
    '37': 'Iron Dry',
    '38': 'Jeans',
    '39': 'Kids clothes',
    '40': 'Large Wash',
    '41': 'Wool/Delicate',
    '42': 'Low-temp Dry',
    '43': 'Mixed Wash',
    '44': 'Sanitary 40°',
    '45': 'Sterilize 60°',
    '46': 'Standard',
    '47': 'Quiet',
    '48': 'Wrinkle Prevent',
    '49': 'Intensive Wash',
    '50': 'Prewash+Standard',
    '51': 'Quick Deodorize',
    '52': 'Quick 30min',
    '53': 'Quiet',
    '54': 'Refresh',
    '55': 'Rinse/Spin',
    '56': 'Rinse only',
    '57': 'Durable garments',
    '58': 'Safe',
    '59': 'Safe Standard',
    '60': 'Sterilize',
    '61': 'Oxygen Sterilize',
    '62': 'Eco Wash',
    '63': 'School uniform',
    '64': 'Shoes',
    '65': 'Quiet',
    '66': 'Quiet Wash',
    '67': 'Thorough Rinse',
    '68': 'Small Wash',
    '69': 'Smart power-save',
    '70': 'Soak',
    '71': 'Spa Refresh',
    '72': 'Quick Dry',
    '73': 'Quick Tub Clean',
    '74': 'Small Quick',
    '75': 'Quick 14min',
    '76': 'Eco Boil',
    '77': 'Quick Wash/Dry',
    '78': 'Spin only',
    '79': 'Functional garments',
    '80': 'Stain Care',
    '81': 'Steam Standard',
    '82': 'Intensive Dry',
    '83': 'Timed Dry',
    '84': 'Towels',
    '85': 'Tub Sterilize',
    '86': 'Tub Dry',
    '87': 'Turbo Wash',
    '88': 'Wash/Dry',
    '89': 'Wash only',
    '90': 'White',
    '91': 'Air Spin 120min',
    '92': 'Air Spin 60min',
    '93': 'Air Spin 90min',
    '94': 'Wool',
    '95': 'Single shirt',
    '96': 'Cotton underwear',
    '97': 'Light Boil',
    '98': 'Light soil',
    '99': 'Activewear',
    '100': 'Underwear',
    '101': 'Static prevent',
    '102': 'Fabric protect',
    '103': 'Deodorize',
    '104': 'Eco Wash',
    '105': 'Kids clothes',
    '106': 'Rainy-season Wash',
    '107': 'School uniform',
    '108': 'Shirt',
    '109': 'Single-item Wash',
    '110': 'Thorough Rinse',
    '111': 'Safe Rinse',
    '112': 'Spin only',
    '113': 'Sweat stain removal',
    '114': 'AI Wash',
    '115': 'Down jacket',
    '116': 'Eco Standard Large',
    '117': 'Eco Standard Small',
    '118': 'Standard 20°',
    '119': 'Pet Care',
    '120': 'Outdoor',
    '121': 'Water repellent',
    '122': 'Turbo 39min',
    '123': 'Turbo 59min',
    '124': 'Quick Wash/Dry',
    '125': 'Boil Wash',
    '126': 'Disinfectant Safe Wash',
    '127': 'Standard Plus',
    '128': 'Detergent tray clean',
    '129': 'Duvet cover',
    '130': 'Swimwear',
    '131': 'Dress',
    '132': 'Large',
    '133': 'Extra Large',
    '134': 'Quick Tub Rinse',
    '135': 'Quick Steam Sterilize',
    '136': 'Microplastic Care',
    '137': 'Timed Wash',
    '138': 'Timed Dry',
    '139': 'Steam Sterilize Dry',
    '140': 'Steam Refresh Dry',
    '141': 'Rainy-season Dry',
    '142': 'Padding Dry',
    '143': 'Air Dry',
    '144': 'Bedding Care Dry',
    '145': 'Soak',
    '146': 'Light soil',
    '147': 'Intensive Wash',
    '148': 'Fresh Care',
    '149': 'Towel Boil Wash',
    '150': 'New clothes',
    '151': 'Intensive Spin',
    '152': 'Custom Dry',
    '153': 'Denim',
    '154': 'Cotton underwear',
    '155': 'Soak Boil',
    '156': 'Bedding rinse/spin',
    '157': 'Heavy-soil Soak',
    '158': 'Heavy-soil Prewash',
    '159': 'Socks',
    '160': 'Double Rinse/Spin',
    '161': 'Cold Intensive Wash',
    '162': 'Baby Prewash',
    '163': 'Yoga wear',
    '164': 'Golf wear',
    '165': 'Summer bedding',
    '166': 'AI Wash/Dry',
    '167': 'Delicate Dry',
    '168': 'Wrinkle Prevent Dry',
    '169': 'Cuffs & collar',
    '255': 'Downloaded course',
}

const DRYER_COURSE_LABELS: Record<string, string> = {
    '0': 'None',
    '1': 'Steam Refresh',
    '2': 'Towels',
    '3': 'Jeans',
    '4': 'Bedding',
    '5': 'Shirt',
    '6': 'Mixed garments',
    '7': 'Standard',
    '8': 'Functional garments',
    '9': 'Small Quick',
    '10': 'Delicate Dry',
    '11': 'Wool/Delicate',
    '12': 'Shelf Dry',
    '13': 'Air blow',
    '14': 'Warm air',
    '15': 'Bedding shake',
    '16': 'Steam Sterilize',
    '17': 'Intensive Dry',
    '18': 'Condenser Care',
    '19': 'Tub Sterilize',
    '20': 'Padding Refresh',
    '21': 'Timed Dry',
    '22': 'Outdoor Refresh',
    '23': 'Baby clothes',
    '24': 'Small Dry',
    '25': 'Standard Plus',
    '26': 'Wrinkle Prevent',
    '27': 'Pet Care',
    '28': 'Single shirt',
    '29': 'Heavy soil',
    '30': 'Ultra Delicate',
    '31': 'Kids clothes',
    '32': 'Low-temp Dry',
    '33': 'Large Dry',
    '34': 'Quick Dry',
    '35': 'Air Dry',
    '36': 'Spot clean',
    '37': 'Steam Refresh',
    '38': 'Steam Sterilize',
    '39': 'Refresh',
    '40': 'Garment Refresh',
    '41': 'Mist Refresh',
    '42': 'Intensive Dry',
    '43': 'Low-temp Dry Plus',
    '44': 'AI Dry',
    '45': 'Quiet',
    '46': 'Shrink ease',
    '47': 'Wrinkle Ease',
    '48': 'Thin bedding',
    '49': 'Sportswear',
    '50': 'Rainy-season Dry',
    '51': 'Iron Dry',
    '52': 'Duvet cover',
    '53': 'Blanket warm',
    '54': 'Night Dry',
    '55': 'Half-load Dry',
    '56': 'Full-load Dry',
    '57': 'Room Dehumidify',
    '58': 'Turbo Dry',
    '114': 'Wrinkle Ease Dry',
    '255': 'Downloaded course',
}

/* LG official maps: FAKPK21021 WASHER_PROTOCOL_EX 8.3 / WASHER_CONVERT_EX 2.3;
 * BDH_D39301_KR DRYER_PROTOCOL_EX 4.1 / DRYER_CONVERT_EX 7.8. */
export const WASHER_MODEL: WashTowerModel = {
    tag: 51,
    recordLength: 72,
    liveRecordLength: 67,
    deviceName: 'LG WashTower Washer',
    fields: [
        { key: 'protocolVersion', offset: 0, length: 1, label: 'Protocol version' },
        {
            key: 'soilWash',
            offset: 1,
            length: 1,
            label: 'Wash strength',
            values: {
                '0': 'Off',
                '1': 'Light soil',
                '3': 'Standard',
                '5': 'Intensive',
                '6': 'Prewash',
                '7': 'Soak',
            },
        },
        {
            key: 'temp',
            offset: 2,
            length: 1,
            label: 'Temperature',
            values: {
                '0': 'Off',
                '1': '20 ℃',
                '2': '30 ℃',
                '3': '40 ℃',
                '4': '50 ℃',
                '5': '60 ℃',
                '6': '95 ℃',
                '8': 'Cold water',
                '20': '27 ℃',
                '21': '35 ℃',
                '22': '38 ℃',
                '23': '90 ℃',
            },
        },
        {
            key: 'rinse',
            offset: 3,
            length: 1,
            label: 'Rinse',
            values: {
                '0': 'Off',
                '1': '1x',
                '2': '2x',
                '3': '3x',
                '4': '4x',
                '5': '5x',
                '6': 'Rinse 6x',
                '7': 'Rinse 7x',
                '8': 'Rinse 8x',
            },
        },
        {
            key: 'spin',
            offset: 4,
            length: 1,
            label: 'Spin strength',
            values: {
                '0': 'Off',
                '1': 'Delicate',
                '2': 'Low',
                '3': '700 rpm',
                '4': 'Mid',
                '5': '900 rpm',
                '6': 'High',
                '7': '1100 rpm',
                '8': 'Max',
                '9': '1400 rpm',
                '10': '1600 rpm',
                '19': 'On',
            },
        },
        {
            key: 'course',
            offset: 5,
            length: 1,
            label: 'Course',
            values: WASHER_COURSE_LABELS,
        },
        {
            key: 'dryLevel',
            offset: 6,
            length: 1,
            label: 'Dryness',
            values: {
                '0': 'Off',
                '11': 'Timed Dry 30min',
                '12': 'Timed Dry 60min',
                '13': 'Timed Dry 90min',
                '14': 'Timed Dry 120min',
                '15': 'Timed Dry 150min',
                '19': '20min',
                '20': '40min',
                '21': '180min',
                '22': '240min',
            },
        },
        {
            key: 'soak',
            offset: 7,
            length: 1,
            label: 'Soak',
            values: {},
        },
        {
            key: 'washTime',
            offset: 8,
            length: 1,
            label: 'Wash time',
            values: {},
        },
        {
            key: 'waterLevel',
            offset: 9,
            length: 1,
            label: 'Water level',
            values: {
                '0': '1Level',
                '1': '2Level',
                '2': '3Level',
                '3': '4Level',
                '4': '5Level',
                '5': '6Level',
                '6': '7Level',
                '7': '8Level',
                '8': '9Level',
                '9': '10Level',
            },
        },
        {
            key: 'loadItemWasher',
            offset: 10,
            length: 1,
            label: 'Laundry amount',
            values: { '0': 'Off', '1': '1Level', '2': '2Level', '3': '3Level' },
        },
        { key: 'reserveTimeMinute', offset: 11, length: 2, label: 'Reserved time' },
        { key: 'remainTimeMinute', offset: 13, length: 2, label: 'Time remaining' },
        { key: 'initialTimeMinute', offset: 15, length: 2, label: 'Total time' },
        { key: 'courseSpendPower', offset: 17, length: 2, label: 'Course power usage' },
        {
            key: 'error',
            offset: 19,
            length: 1,
            label: 'Error',
            values: {
                '0': 'No error',
                '2': 'Not filling',
                '3': 'Not draining',
                '4': 'Not spinning',
                '5': 'Water level high',
                '7': 'Water level not detected',
                '8': 'Temp not detected',
                '9': 'Motor rotation fault',
                '13': 'Freeze detected',
                '20': 'Door not closed',
                '21': 'Door not locked',
                '23': 'Vibration sensor fault',
                '33': 'Off',
                '43': 'Check detergent tank',
                '44': 'Detergent not dosed',
                '45': 'Check softener tank',
                '46': 'Softener not dosed',
                '47': 'Detergent tank fault',
                '48': 'Turbidity not detected',
            },
        },
        {
            key: 'baseDownloadCourseData',
            offset: 20,
            length: 1,
            label: 'Downloaded course basis',
            values: {
                '0': 'None',
                '27': 'Bedding',
                '46': 'Standard',
                '74': 'Small Quick',
                '76': 'Eco Boil',
                '85': 'Tub Sterilize',
                '114': 'AI Wash',
            },
        },
        {
            key: 'state',
            offset: 21,
            length: 1,
            label: 'Current state',
            values: {
                '0': 'Power off',
                '1': 'On',
                '2': 'Pause',
                '3': 'Detecting weight',
                '5': 'Filling',
                '6': 'Detecting weight',
                '8': 'Soaking',
                '9': 'Prewashing',
                '11': 'Washing',
                '12': 'Rinsing',
                '13': 'Awaiting rinse',
                '14': 'Spinning',
                '15': 'Drying',
                '16': 'Wash complete',
                '21': 'Wrinkle preventing',
                '23': 'Error occurred',
                '27': 'Anti-freeze standby',
                '28': 'Pause',
                '29': 'Running',
                '35': 'Pause',
                '36': 'Setting',
                '37': 'Recognizing garment',
                '38': 'Auto detergent dosing',
                '39': 'Auto softener dosing',
                '40': 'Detecting soil level',
                '41': 'Cleaning',
                '42': 'Wash complete',
                '43': 'Steaming',
                '47': 'Laundry care running',
                '48': 'Cleaning',
                '49': 'Awaiting completion',
            },
        },
        {
            key: 'preState',
            offset: 22,
            length: 1,
            label: 'Previous state',
            values: {
                '0': 'Power off',
                '1': 'On',
                '2': 'Pause',
                '3': 'Detecting weight',
                '5': 'Filling',
                '6': 'Detecting weight',
                '8': 'Soaking',
                '9': 'Prewashing',
                '11': 'Washing',
                '12': 'Rinsing',
                '13': 'Awaiting rinse',
                '14': 'Spinning',
                '15': 'Drying',
                '16': 'Wash complete',
                '21': 'Wrinkle preventing',
                '23': 'Error occurred',
                '27': 'Anti-freeze standby',
                '28': 'Pause',
                '29': 'Running',
                '35': 'Pause',
                '36': 'Setting',
                '37': 'Recognizing garment',
                '38': 'Auto detergent dosing',
                '39': 'Auto softener dosing',
                '40': 'Detecting soil level',
                '41': 'Cleaning',
                '42': 'Wash complete',
                '43': 'Steaming',
                '47': 'Laundry care running',
                '48': 'Cleaning',
                '49': 'Awaiting completion',
            },
        },
        {
            key: 'downloadCourse',
            offset: 23,
            length: 1,
            label: 'Downloaded course',
            values: {
                '0': 'None',
                '97': 'Single shirt',
                '101': 'Sweat stain removal',
                '102': 'Shirt',
                '104': 'Baby clothes',
                '107': 'Single-item Wash',
                '109': 'Rainy-season Wash',
                '111': 'Color Care',
                '117': 'Functional garments',
                '122': 'Fabric protect',
                '123': 'Kids clothes',
                '127': 'Thorough Rinse',
                '128': 'School uniform',
                '129': 'Spin only',
                '131': 'Cold Wash',
                '154': 'Wool/Delicate',
                '192': 'Quiet',
                '197': 'Heavy soil',
                '224': 'Towels',
                '236': 'Wash only',
                '237': 'Rinse only',
            },
        },
        {
            key: 'loadLevel',
            offset: 24,
            length: 1,
            label: 'Detected load',
            values: {
                '1': '1Level',
                '2': '2Level',
                '3': '3Level',
                '4': '4Level',
                '5': '5Level',
                '6': '6Level',
                '7': '7Level',
                '8': '8Level',
                '9': '9Level',
                '10': '10Level',
            },
        },
        { key: 'courseSpendWater', offset: 25, length: 2, label: 'Course water usage' },
        {
            key: 'rinseCount',
            offset: 27,
            length: 1,
            label: 'Rinses remaining',
            values: {
                '1': 'Rinse 1x',
                '2': 'Rinse 2x',
                '3': 'Rinse 3x',
                '4': 'Rinse 4x',
                '5': 'Rinse 5x',
                '6': 'Rinse 6x',
                '7': 'Rinse 7x',
                '8': 'Rinse 8x',
            },
        },
        { key: 'TCLCount', offset: 28, length: 1, label: 'Tub-clean count' },
        {
            key: 'buzzer',
            offset: 29,
            length: 1,
            label: 'Alert sound',
            values: {
                '0': 'Mute',
                '1': 'Small',
                '2': 'Normal',
                '3': 'Large',
                '4': 'Very large',
                '15': 'On',
            },
        },
        {
            key: 'ezCSDetergentSetVal',
            offset: 30,
            length: 1,
            label: 'Auto detergent level',
            values: {
                '0': 'Off',
                '1': 'Low',
                '2': 'Normal',
                '3': 'High',
            },
        },
        {
            key: 'ezCSSoftenerSetVal',
            offset: 31,
            length: 1,
            label: 'Auto softener level',
            values: {
                '0': 'Off',
                '1': 'Low',
                '2': 'Normal',
                '3': 'High',
            },
        },
        { key: 'ezDetergentAmount', offset: 32, length: 1, label: 'Detergent amount' },
        { key: 'ezSoftenerAmount', offset: 33, length: 1, label: 'Softener amount' },
        {
            key: 'waterPlus',
            offset: 34,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Add water',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'multiStain',
            offset: 34,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Mixed soil',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'coldWash',
            offset: 34,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Cold Wash',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'intensive',
            offset: 34,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Intensive Wash',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'timeSave',
            offset: 34,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Time save',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'turboWash',
            offset: 34,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Turbo Wash',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'preWash',
            offset: 34,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Prewash',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'autoSoak',
            offset: 34,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Auto soak',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ecoHybrid',
            offset: 35,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Eco mode',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'steamSoftener',
            offset: 35,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Steam Softener',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'fabricSoftener',
            offset: 35,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Softener',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'sterilize',
            offset: 35,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Sterilize',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'steam',
            offset: 35,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Steam',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'rinseSpin',
            offset: 35,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Rinse/Spin',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'rinseHold',
            offset: 35,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Rinse stop',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'medicRinse',
            offset: 35,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Safe Rinse',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'smartGridEnable',
            offset: 36,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Smart Grid',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'favorite',
            offset: 36,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Favorite',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'smartCare_onOff',
            offset: 36,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Smart Care',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'warmWater',
            offset: 36,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Hot water',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'saveEnergy',
            offset: 36,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Energy saving',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'wrinkleCare',
            offset: 36,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Wrinkle Prevent',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'freshCare',
            offset: 36,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Status info 052',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'creaseCare',
            offset: 36,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Status info 053',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'doorClose',
            offset: 37,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Door closed',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'wifiSDS',
            offset: 37,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Wireless smart diagnosis',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'voiceState',
            offset: 37,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Voice state',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'activeStandbyEnable',
            offset: 37,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Standby mode',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'remoteStart',
            offset: 37,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Remote start',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'childLock',
            offset: 37,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Button lock',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'drumLight',
            offset: 37,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Drum light',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'addGarment',
            offset: 37,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Add laundry',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'doorLock',
            offset: 38,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Door lock',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'coolDown',
            offset: 38,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Cooling',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'rinseDefault',
            offset: 38,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Basic Rinse',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'autoDetection',
            offset: 38,
            length: 1,
            bit: 3,
            bits: 2,
            label: 'Auto detect',
            values: {},
        },
        {
            key: 'washLoadDisplay',
            offset: 38,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Show load',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'speechRecognitionMode',
            offset: 38,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Voice recognition',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'standby',
            offset: 38,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Standby',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ezSoftenerState',
            offset: 39,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Softener level',
            values: { '1': 'Refill needed' },
        },
        {
            key: 'ezDetergentState',
            offset: 39,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Detergent level',
            values: { '1': 'Refill needed' },
        },
        {
            key: 'ezDispenseDrawerState',
            offset: 39,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Auto-dispenser state',
        },
        {
            key: 'ezDispenseNotation',
            offset: 39,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Auto-dose unit',
        },
        {
            key: 'smallUE',
            offset: 39,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Small-load imbalance',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'audibleSDS',
            offset: 39,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Sound smart diagnosis',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'extraRinse',
            offset: 39,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Extra Rinse',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'delay',
            offset: 39,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Reservation',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'AIDDLed',
            offset: 40,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'AI indicator',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'dnnReady',
            offset: 40,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'AI ready',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'remoteMaintain',
            offset: 40,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Remote control lock',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'autoCourseArrange',
            offset: 40,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Auto sort courses',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyBuzzer',
            offset: 40,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Alert sound supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyRemoteMaintain',
            offset: 40,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Remote-control lock supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'isBlePairing',
            offset: 40,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Bluetooth connect',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'dryReady_state',
            offset: 40,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Status info 084',
            values: { '0': 'Off', '1': 'On' },
        },
        { key: 'laundryTexture', offset: 41, length: 1, label: 'Fabric type' },
        {
            key: 'cloudCourse',
            offset: 42,
            length: 1,
            label: 'Cloud course',
            values: {
                '0': 'None',
                '97': 'Single shirt',
                '101': 'Sweat stain removal',
                '102': 'Shirt',
                '104': 'Baby clothes',
                '107': 'Single-item Wash',
                '109': 'Rainy-season Wash',
                '111': 'Color Care',
                '117': 'Functional garments',
                '122': 'Fabric protect',
                '123': 'Kids clothes',
                '127': 'Thorough Rinse',
                '128': 'School uniform',
                '129': 'Spin only',
                '131': 'Cold Wash',
                '154': 'Wool/Delicate',
                '192': 'Quiet',
                '197': 'Heavy soil',
                '224': 'Towels',
                '236': 'Wash only',
                '237': 'Rinse only',
            },
        },
        {
            key: 'masterCard',
            offset: 43,
            length: 1,
            label: 'Featured card',
            values: {},
        },
        {
            key: 'RecentlyDownloadedCourse',
            offset: 44,
            length: 1,
            label: 'Recent downloaded course',
        },
        {
            key: 'endMelody',
            offset: 45,
            length: 1,
            label: 'Done sound',
            values: {
                '0': 'Default sound',
                '1': 'Vivaldi Winter',
            },
        },
        {
            key: 'initLCD',
            offset: 46,
            length: 1,
            label: 'Screen initial state',
            values: {},
        },
        {
            key: 'aquaReserve',
            offset: 47,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Keep water',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'addScent',
            offset: 47,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Add fragrance',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyLaundryCollection',
            offset: 47,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Laundry pickup alert supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'laundryCare',
            offset: 47,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Laundry care after finish',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'noti_OverSudsing',
            offset: 47,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Excess foam alert',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'detergentNozzleCleaning',
            offset: 47,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Detergent nozzle clean',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'softenerNozzleCleaning',
            offset: 47,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Softener nozzle clean',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'currentTimeDisplay',
            offset: 47,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Show current time',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ezDispenseType',
            offset: 48,
            length: 1,
            label: 'Auto-dispenser type',
            values: {},
        },
        {
            key: 'endReserveTime',
            offset: 49,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'End reservation',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'currentDisplay_12_24',
            offset: 49,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Time format',
        },
        {
            key: 'currentDateDisplay',
            offset: 49,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Date display',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'powerCableOnOff',
            offset: 49,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Power cord connected',
        },
        {
            key: 'ezDetergentSelect',
            offset: 49,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Detergent select',
        },
        {
            key: 'ctrCmdAvail',
            offset: 49,
            length: 1,
            bit: 5,
            bits: 2,
            label: 'Controllable state',
            values: { '0': 'Off', '3': 'On' },
        },
        {
            key: 'noti3MinEnd',
            offset: 49,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'End 3Alert minutes before',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ucDampDryBeep',
            offset: 50,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Ironing alert',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ucSteamForDry',
            offset: 50,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Dry Steam',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ucQuickLoadSense',
            offset: 50,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Quick load detect',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'enableAutoDoorOpen',
            offset: 50,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Auto door open',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'drumlightAutoOn',
            offset: 50,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Drum light when door opens',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'drumlightOpt',
            offset: 50,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Drum light setting',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ucWashMode',
            offset: 51,
            length: 1,
            label: 'Operation mode',
            values: {},
        },
        {
            key: 'speedEco',
            offset: 52,
            length: 1,
            label: 'Eco speed',
            values: {},
        },
        {
            key: 'timeDry',
            offset: 53,
            length: 1,
            label: 'Dry time',
            values: {
                '20': '20min',
                '30': '30min',
                '40': '40min',
                '50': '50min',
                '60': '60min',
                '80': '80min',
                '100': '100min',
                '120': '120min',
                '150': '150min',
                '180': '180min',
                '210': '210min',
                '240': '240min',
            },
        },
        {
            key: 'changeView',
            offset: 54,
            length: 1,
            label: 'Screen switch',
            values: {},
        },
        {
            key: 'doorOpenImpossibleReason',
            offset: 55,
            length: 1,
            label: 'Reason door cannot open',
            values: {},
        },
        {
            key: 'aiDetergentInput',
            offset: 56,
            length: 1,
            label: 'AI detergent amount',
            values: {},
        },
        {
            key: 'laundryCareSettingTime',
            offset: 57,
            length: 2,
            label: 'Laundry care time',
        },
        { key: 'drumlightBright', offset: 59, length: 2, label: 'Drum light brightness' },
        { key: 'drumlightOnTime', offset: 61, length: 2, label: 'Drum light time' },
        {
            key: 'detergentIdxShowBeforeStart',
            offset: 63,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Show detergent index before wash',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'spinAvailableDryOnlyCourse',
            offset: 63,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Spin before dry supported',
        },
        {
            key: 'ushLaundryCareSettingOnOff',
            offset: 63,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Auto laundry care',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyExtendedIcontrol',
            offset: 63,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Extended control supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'energySavingAvailable',
            offset: 63,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Energy saving supported',
        },
        {
            key: 'energySavingEnabled',
            offset: 63,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Energy saving setting',
        },
        {
            key: 'energySavingRunning',
            offset: 63,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Energy saving active',
        },
        {
            key: 'veryAvailableDryLevel',
            offset: 63,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Intensive Dry supported',
        },
        {
            key: 'drumlightPreview',
            offset: 64,
            length: 2,
            label: 'Drum light preview',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'endMonitoringCase',
            offset: 66,
            length: 1,
            label: 'Completion type',
        },
        {
            key: 'endMelodyOnOff',
            offset: 69,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Done sound setting',
        },
        {
            key: 'notiOptBeforeRinseOnOff',
            offset: 69,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Alert before rinse (setting)',
        },
        {
            key: 'notiOptBeforeSpinOnOff',
            offset: 69,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Alert before spin (setting)',
        },
        {
            key: 'notiOptBeforeRinseUsing',
            offset: 69,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Alert before rinse (active)',
        },
        {
            key: 'notiOptBeforeSpinUsing',
            offset: 69,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Alert before spin (active)',
        },
        {
            key: 'laundryCollectionPushSetting',
            offset: 69,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Laundry pickup alert setting',
        },
        {
            key: 'childSafetyModeOnOff',
            offset: 69,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Child safety mode',
        },
        {
            key: 'smartReadyOnOff',
            offset: 69,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Smart ready mode',
        },
        {
            key: 'notiOptBeforeSpinRinseOnOff',
            offset: 70,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Alert before rinse/spin',
        },
        {
            key: 'optDryAutoApply',
            offset: 70,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Auto dry applied',
        },
        {
            key: 'optDryAutoAvailable',
            offset: 70,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Auto dry supported',
        },
        {
            key: 'optDryOnOff',
            offset: 70,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Dry select',
        },
        {
            key: 'optWashOnOff',
            offset: 70,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Wash select',
        },
        {
            key: 'optPreDrySpin',
            offset: 70,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Spin before dry',
        },
        {
            key: 'dryStartSignal',
            offset: 70,
            length: 1,
            bit: 6,
            bits: 2,
            label: 'Dry start signal',
        },
        {
            key: 'startReserveTime',
            offset: 71,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Reserved start time',
        },
        {
            key: 'dryOnOffAvailable',
            offset: 71,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Dry select supported',
        },
    ],
} as const
export const DRYER_MODEL: WashTowerModel = {
    tag: 52,
    recordLength: 51,
    liveRecordLength: 50,
    deviceName: 'LG WashTower Dryer',
    fields: [
        { key: 'protocolVersion', offset: 0, length: 1, label: 'Protocol version' },
        {
            key: 'dryLevel',
            offset: 1,
            length: 1,
            label: 'Dryness',
            values: {
                '0': 'Off',
                '1': 'Delicate',
                '2': 'Low',
                '3': 'Standard',
                '4': 'Standard+',
                '5': 'Intensive',
            },
        },
        {
            key: 'ecoHybrid',
            offset: 2,
            length: 1,
            label: 'Eco mode',
            values: { '0': 'Off', '1': 'Energy', '2': 'Auto', '3': 'Speed' },
        },
        {
            key: 'temp',
            offset: 3,
            length: 1,
            label: 'Temperature',
            values: {
                '0': 'No temp set',
            },
        },
        {
            key: 'timeDry',
            offset: 4,
            length: 1,
            label: 'Dry time',
            values: {
                '0': 'Off',
                '1': '20min',
                '2': '30min',
                '3': '40min',
                '4': '50min',
                '5': '60min',
                '6': '70min',
                '7': '80min',
            },
        },
        {
            key: 'course',
            offset: 5,
            length: 1,
            label: 'Course',
            values: DRYER_COURSE_LABELS,
        },
        { key: 'reserveTimeMinute', offset: 7, length: 2, label: 'Reserved time' },
        { key: 'remainTimeMinute', offset: 9, length: 2, label: 'Time remaining' },
        { key: 'initialTimeMinute', offset: 11, length: 2, label: 'Total time' },
        {
            key: 'state',
            offset: 13,
            length: 1,
            label: 'Current state',
            values: {
                '0': 'Power off',
                '1': 'On',
                '2': 'Drying',
                '3': 'Pause',
                '4': 'Dry complete',
                '5': 'Error occurred',
                '6': 'Smart diagnosing',
                '7': 'Drying',
                '8': 'Blowing',
                '9': 'Wrinkle preventing',
                '11': 'Detecting weight',
                '12': 'Reserved',
                '14': 'Detecting weight',
                '15': 'Steaming',
                '16': 'Recognizing garment',
                '17': 'Condenser auto-clean running',
                '18': 'Bedding shake running',
                '19': 'Refreshing',
                '20': 'Sterilizing',
                '21': 'Condenser Care running',
                '22': 'Dry complete',
                '23': 'Preparing to dry',
                '24': 'Laundry care running',
                '25': 'Dehumidifying',
                '26': 'Dry complete',
                '27': 'Awaiting completion',
            },
        },
        {
            key: 'preState',
            offset: 14,
            length: 1,
            label: 'Previous state',
            values: {
                '0': 'Power off',
                '1': 'On',
                '2': 'Drying',
                '3': 'Pause',
                '4': 'Dry complete',
                '5': 'Error occurred',
                '6': 'Smart diagnosing',
                '7': 'Drying',
                '8': 'Blowing',
                '9': 'Wrinkle preventing',
                '11': 'Detecting weight',
                '12': 'Reserved',
                '14': 'Detecting weight',
                '15': 'Steaming',
                '16': 'Recognizing garment',
                '17': 'Condenser auto-clean running',
                '18': 'Bedding shake running',
                '19': 'Refreshing',
                '20': 'Sterilizing',
                '21': 'Condenser Care running',
                '22': 'Dry complete',
                '23': 'Preparing to dry',
                '24': 'Laundry care running',
                '25': 'Dehumidifying',
                '26': 'Dry complete',
                '27': 'Awaiting completion',
            },
        },
        {
            key: 'error',
            offset: 15,
            length: 1,
            label: 'Error',
            values: {
                '0': 'No error',
                '1': 'Temp sensor fault 1',
                '2': 'Temp sensor fault 2',
                '4': 'Temp sensor fault 4',
                '5': 'Temp sensor fault 5',
                '6': 'Temp sensor fault 6',
                '10': 'Steam not operating',
                '11': 'Steam water refill',
                '12': 'Steam not operating',
                '14': 'Not draining',
                '15': 'Drain check notice',
                '16': 'Door not closed',
                '18': 'Filter installed',
                '20': 'Drum temp fault',
                '21': 'Compressor fault 1',
                '22': 'Compressor fault 2',
                '31': 'Drum motor fault',
                '38': 'Door not closed',
                '40': 'Fan motor fault',
                '43': 'Door not locked',
                '49': 'IR sensor fault',
                '50': 'Internal fan fault',
                '52': 'Door closed',
                '53': 'Dehumidify kit not detected',
                '54': 'Low-temp detected',
            },
        },
        { key: 'courseSpendPower', offset: 17, length: 2, label: 'Course power usage' },
        {
            key: 'buzzer',
            offset: 19,
            length: 1,
            label: 'Alert sound',
            values: {
                '0': 'Mute',
                '1': 'Small',
                '2': 'Normal',
                '3': 'Large',
                '4': 'Very large',
                '15': 'On',
            },
        },
        {
            key: 'baseDownloadCourseData',
            offset: 20,
            length: 1,
            label: 'Downloaded course basis',
            values: {
                '0': 'None',
                '1': 'Steam Refresh',
                '4': 'Bedding',
                '7': 'Standard',
                '9': 'Small Quick',
                '15': 'Bedding shake',
                '16': 'Steam Sterilize',
                '18': 'Condenser Care',
                '19': 'Tub Sterilize',
                '21': 'Timed Dry',
                '44': 'AI Dry',
            },
        },
        {
            key: 'loadItem',
            offset: 21,
            length: 1,
            label: 'Load amount',
            values: {
                '0': 'Off',
                '1': '1Level',
                '2': '2Level',
                '3': '3Level',
                '4': '4Level',
                '5': '5Level',
                '6': '6Level',
            },
        },
        {
            key: 'ductClogging',
            offset: 22,
            length: 1,
            label: 'Exhaust blocked',
            values: {},
        },
        {
            key: 'downloadCourse',
            offset: 23,
            length: 1,
            label: 'Downloaded course',
            values: {
                '0': 'None',
                '101': 'Baby clothes',
                '102': 'Sportswear',
                '105': 'Rainy-season Dry',
                '110': 'Iron Dry',
                '114': 'Wrinkle Ease Dry',
                '119': 'Outdoor Refresh',
                '126': 'Quiet',
                '129': 'Functional garments',
                '135': 'Towels',
                '140': 'Shelf Dry',
                '142': 'Shrink ease',
                '143': 'Wool/Delicate',
                '145': 'Single shirt',
                '146': 'Shirt',
                '147': 'Air blow',
                '148': 'Intensive Dry',
                '149': 'Padding Refresh',
            },
        },
        {
            key: 'handIron',
            offset: 24,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Ironing alert',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'dampDryBeep',
            offset: 24,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Ironing alert sound',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'drumLight',
            offset: 24,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Drum light',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'favorite',
            offset: 24,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Favorite',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'wrinkleCare',
            offset: 24,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Wrinkle Prevent',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'dnnReady',
            offset: 24,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'AI ready',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'reduceStatic',
            offset: 24,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Static reduce',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'antiBacterial',
            offset: 24,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Antibacterial',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'energySaver',
            offset: 25,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Energy saving',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'energySaverDefault',
            offset: 25,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Default energy saving',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'turboSteam',
            offset: 25,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Turbo Steam',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'smartGridEnable',
            offset: 25,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Smart Grid',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'ductSensingOnOff',
            offset: 25,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Exhaust detect',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'steam',
            offset: 25,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Steam',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'AIDDLed',
            offset: 25,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'AI indicator',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'smartPairing',
            offset: 26,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Smart pairing',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'remoteStart',
            offset: 26,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Remote start',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'selfCleaning',
            offset: 26,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Self Clean',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'childLock',
            offset: 26,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Button lock',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'reservation',
            offset: 26,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Status info 038',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'detectLoad',
            offset: 26,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Load detect',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'standby',
            offset: 26,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Standby',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'doorLock',
            offset: 26,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Door lock',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'wifiConnected',
            offset: 27,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Wireless connect',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'wifiSetting',
            offset: 27,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Wireless setup',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'voiceState',
            offset: 27,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Voice state',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'addItem',
            offset: 27,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Add load',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'smartCare_onOff',
            offset: 27,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Smart Care',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'remoteMaintain',
            offset: 27,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Remote control lock',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'autoCourseArrange',
            offset: 27,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Auto sort courses',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'currentDateDisplay',
            offset: 28,
            length: 1,
            bit: 7,
            bits: 1,
            label: 'Date display',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'currentDisplay_12_24',
            offset: 28,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Time format',
        },
        {
            key: 'currentTimeDisplay',
            offset: 28,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Show current time',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'laundryCare',
            offset: 28,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Laundry care after finish',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'BLEOnOff',
            offset: 28,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Bluetooth',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyLaundryCollection',
            offset: 28,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Laundry pickup alert supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyRemoteMaintain',
            offset: 28,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Remote-control lock supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'applyBuzzer',
            offset: 28,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Alert sound supported',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'setDownloadedCourse',
            offset: 29,
            length: 1,
            label: 'Recent downloaded course',
            values: {
                '0': 'None',
                '101': 'Baby clothes',
                '102': 'Sportswear',
                '105': 'Rainy-season Dry',
                '110': 'Iron Dry',
                '114': 'Wrinkle Ease Dry',
                '119': 'Outdoor Refresh',
                '126': 'Quiet',
                '129': 'Functional garments',
                '135': 'Towels',
                '140': 'Shelf Dry',
                '142': 'Shrink ease',
                '143': 'Wool/Delicate',
                '145': 'Single shirt',
                '146': 'Shirt',
                '147': 'Air blow',
                '148': 'Intensive Dry',
                '149': 'Padding Refresh',
            },
        },
        {
            key: 'masterCard',
            offset: 30,
            length: 1,
            label: 'Featured card',
            values: {},
        },
        {
            key: 'cloudCourse',
            offset: 31,
            length: 1,
            label: 'Cloud course',
            values: {
                '0': 'None',
                '101': 'Baby clothes',
                '102': 'Sportswear',
                '105': 'Rainy-season Dry',
                '110': 'Iron Dry',
                '114': 'Wrinkle Ease Dry',
                '119': 'Outdoor Refresh',
                '126': 'Quiet',
                '129': 'Functional garments',
                '135': 'Towels',
                '140': 'Shelf Dry',
                '142': 'Shrink ease',
                '143': 'Wool/Delicate',
                '145': 'Single shirt',
                '146': 'Shirt',
                '147': 'Air blow',
                '148': 'Intensive Dry',
                '149': 'Padding Refresh',
            },
        },
        {
            key: 'endMelody',
            offset: 32,
            length: 1,
            label: 'Done sound',
            values: {
                '0': 'Default sound',
                '1': 'Vivaldi Winter',
            },
        },
        {
            key: 'initLCD',
            offset: 33,
            length: 1,
            label: 'Screen initial state',
            values: {},
        },
        {
            key: 'drylevelSubDamp',
            offset: 34,
            length: 1,
            label: 'Delicate Dry sub-level',
            values: { '0': 'Default', '2': 'High' },
        },
        {
            key: 'drylevelSubLess',
            offset: 35,
            length: 1,
            label: 'Low Dry sub-level',
            values: { '0': 'Default', '1': 'Low', '2': 'High' },
        },
        {
            key: 'drylevelSubIron',
            offset: 36,
            length: 1,
            label: 'Standard Dry sub-level',
            values: { '0': 'Default', '1': 'Low', '2': 'High' },
        },
        {
            key: 'drylevelSubCup',
            offset: 37,
            length: 1,
            label: 'Standard Plus sub-level',
            values: { '0': 'Default', '1': 'Low', '2': 'High' },
        },
        {
            key: 'drylevelSubVery',
            offset: 38,
            length: 1,
            label: 'Intensive Dry sub-level',
            values: { '0': 'Default', '1': 'Low' },
        },
        { key: 'moreLessTime', offset: 39, length: 2, label: 'Dry time adjust' },
        {
            key: 'applyExtendedIcontrol',
            offset: 41,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Extended control supported',
        },
        {
            key: 'ushLaundryCareSettingOnOff',
            offset: 41,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Auto laundry care',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'drumlightOpt',
            offset: 41,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Drum light setting',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'drumlightAutoOn',
            offset: 41,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Drum light when door opens',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'noti3MinEnd',
            offset: 41,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'End 3Alert minutes before',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'endReserveTime',
            offset: 41,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'End reservation',
            values: { '0': 'Off', '1': 'On' },
        },
        { key: 'drumlightBright', offset: 42, length: 2, label: 'Drum light brightness' },
        { key: 'drumlightOnTime', offset: 44, length: 2, label: 'Drum light time' },
        {
            key: 'laundryCareSettingTime',
            offset: 46,
            length: 2,
            label: 'Laundry care time',
        },
        {
            key: 'drumlightPreview',
            offset: 48,
            length: 2,
            label: 'Drum light preview',
            values: { '0': 'Off', '1': 'On' },
        },
        {
            key: 'energySavingAvailable',
            offset: 50,
            length: 1,
            bit: 0,
            bits: 1,
            label: 'Energy saving supported',
        },
        {
            key: 'energySavingEnabled',
            offset: 50,
            length: 1,
            bit: 1,
            bits: 1,
            label: 'Energy saving setting',
        },
        {
            key: 'energySavingRunning',
            offset: 50,
            length: 1,
            bit: 2,
            bits: 1,
            label: 'Energy saving active',
        },
        {
            key: 'endMelodyOnOff',
            offset: 50,
            length: 1,
            bit: 3,
            bits: 1,
            label: 'Done sound setting',
        },
        {
            key: 'laundryCollectionPushSetting',
            offset: 50,
            length: 1,
            bit: 4,
            bits: 1,
            label: 'Laundry pickup alert setting',
        },
        {
            key: 'childSafetyModeOnOff',
            offset: 50,
            length: 1,
            bit: 5,
            bits: 1,
            label: 'Child safety mode',
        },
        {
            key: 'smartReadyOnOff',
            offset: 50,
            length: 1,
            bit: 6,
            bits: 1,
            label: 'Smart ready mode',
        },
    ],
} as const

const componentKey = (key: string) =>
    key
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .toLowerCase()

/*
 * FAKPK21021/BDH_D39301_KR are the Korean split-device WashTower models.
 * Unlike WTL_FXU_BDV_NA_01, they use separate AA FF extended records (0xEB/
 * 0xEC) for the washer and dryer, so the WTL handler cannot be reused.  Keep
 * the Home Assistant surface aligned with WTL's useful entities, however:
 * publish appliance state, cycle/time, errors and operator-facing flags only.
 * The large protocol maps remain an internal codec/control description.
 */
const COMMON_PUBLIC_FIELDS = [
    'state',
    'course',
    'reserveTimeMinute',
    'remainTimeMinute',
    'initialTimeMinute',
    'error',
    'childLock',
    'doorLock',
    'remoteStart',
] as const

const publicFieldKeys = (model: WashTowerModel) =>
    new Set<string>(model.tag === 0x33 ? [...COMMON_PUBLIC_FIELDS, 'doorClose'] : COMMON_PUBLIC_FIELDS)

const publicEntityKey = (fieldKey: string) =>
    ({
        reserveTimeMinute: 'reserve_time',
        remainTimeMinute: 'remaining_time',
        initialTimeMinute: 'initial_time',
        doorClose: 'door',
    })[fieldKey] ?? componentKey(fieldKey)

const trackedFieldKeys = (model: WashTowerModel) =>
    new Set<string>([
        ...publicFieldKeys(model),
        ...(model.tag === 0x33 ? WASHER_SETTING_KEYS : DRYER_SETTING_KEYS),
        'remoteMaintain',
        'baseDownloadCourseData',
        'downloadCourse',
        'moreLessTime',
        'dryLevel',
    ])

function fieldComponent(field: Field): DeviceDiscovery['components'][string] {
    const key = publicEntityKey(field.key)
    const component: Record<string, unknown> = {
        platform: 'sensor',
        unique_id: '$deviceid-' + key,
        state_topic: '$this/' + key,
        name: field.label,
    }
    if (field.key.endsWith('TimeMinute')) {
        component.device_class = 'duration'
        component.unit_of_measurement = 'min'
    } else if (field.key === 'state' || field.key === 'course' || field.key === 'error') {
        component.device_class = 'enum'
        component.options = [...new Set([...Object.values(field.values ?? {}), 'unknown'])]
    } else if (field.key === 'doorClose') {
        component.platform = 'binary_sensor'
        component.device_class = 'door'
        // The record bit means "closed"; HA's door binary sensor is ON when open.
        component.payload_on = 'Off'
        component.payload_off = 'On'
        component.name = 'Door'
    } else if (field.key === 'childLock' || field.key === 'doorLock' || field.key === 'remoteStart') {
        component.platform = 'binary_sensor'
        component.payload_on = 'On'
        component.payload_off = 'Off'
        component.icon = field.key === 'remoteStart' ? 'mdi:remote' : 'mdi:lock-outline'
    }
    return component as DeviceDiscovery['components'][string]
}

const DECLARED_NON_PACKET_FIELDS: Record<'221' | '222', string[]> = {
    '221': [
        'extendedControlTest',
        'cycleTimeShowBeforeStart',
        'laundryCollection',
        'endMelody_201_1_1',
        'endMelody_201_1_2',
        'endMelody_201_1_3',
        'endMelody_201_1_4',
        'initialBit',
        'reserveTimeHour',
        'remainTimeHour',
        'initialTimeHour',
        'alarmSignal',
    ],
    '222': [
        'laundryCollection',
        'endMelody_202_1_1',
        'endMelody_202_1_2',
        'endMelody_202_1_3',
        'endMelody_202_1_4',
        'initialBit',
        'reserveTimeHour',
        'remainTimeHour',
        'initialTimeHour',
        'moreLessTimeDefault',
        'moreLessTimeEcoHybridOff',
        'moreLessTimeEcoHybridTurbo',
        'moreLessTimeEcoHybridEcoOrNormal',
        'timeSetting',
        'ecoHybridDefault',
        'ecoHybridCottonVery',
        'ecoHybridCottonCup',
        'ecoHybridCottonIron',
        'ecoHybridEasyCareCup',
        'ecoHybridEasyCareIron',
        'selfClean',
        'productType',
        'reqDevType',
        'cmd',
        'type',
        'alarmSignal',
        'voiceVolume',
        'voiceAssistantCmd',
    ],
}

type ImplementationIdentity = {
    model: string
    deviceType: '221' | '222'
    role: 'washer' | 'dryer'
    packetMappedFields: string[]
    packetMappings: {
        key: string
        byteOffset: number
        byteLength: number
        bitOffset?: number
        bitLength?: number
    }[]
    excludedFields: string[]
    entities: { key: string; label: string }[]
    enumOptions: {
        entityKey: string
        value: number
        label: string
    }[]
    writes: {
        entityKey: string
        protocolFrameId: string
        controlWifiPath: string
        validator: string
    }[]
    codec: {
        protocol: { name: string; jsonVersion: string; sha256: string }
        convert: { name: string; jsonVersion: string; sha256: string }
    }
}

function implementationIdentity(
    model: WashTowerModel,
    identity: Omit<
        ImplementationIdentity,
        'packetMappedFields' | 'packetMappings' | 'excludedFields' | 'entities' | 'enumOptions' | 'writes'
    >,
): ImplementationIdentity {
    const mapped = model.fields.filter((field) => field.offset + field.length <= model.recordLength)
    const exposed = mapped.filter((field) => publicFieldKeys(model).has(field.key))
    return {
        ...identity,
        packetMappedFields: mapped.map((field) => field.key),
        packetMappings: mapped.map((field) => ({
            key: field.key,
            byteOffset: field.offset,
            byteLength: field.length,
            ...(field.bit === undefined ? {} : { bitOffset: field.bit }),
            ...(field.bits === undefined ? {} : { bitLength: field.bits }),
        })),
        excludedFields: model.fields
            .filter((field) => field.offset + field.length > model.recordLength)
            .map((field) => field.key)
            .concat(DECLARED_NON_PACKET_FIELDS[identity.deviceType]),
        entities: exposed
            .map((field) => ({
                key: publicEntityKey(field.key),
                label: field.label,
            }))
            .concat({ key: 'power_transition', label: 'Power transition state' }),
        enumOptions: exposed.flatMap((field) =>
            Object.entries(field.values ?? {}).map(([value, label]) => ({
                entityKey: publicEntityKey(field.key),
                value: Number(value),
                label,
            })),
        ),
        writes: [
            {
                entityKey: 'wake',
                protocolFrameId: '0x2A',
                controlWifiPath: 'WMWakeup',
                validator: 'state=POWEROFF',
            },
            {
                entityKey: 'power',
                protocolFrameId: '0xE5',
                controlWifiPath: 'vtCtrl/power',
                validator: 'value=ON && state=POWEROFF && no pending power-on within 120s',
            },
            {
                entityKey: 'power_transition',
                protocolFrameId: '0xED',
                controlWifiPath: 'statusQuery',
                validator: 'once as best-effort after a checksum-valid successful power-on E6 while pending',
            },
            {
                entityKey: 'power',
                protocolFrameId: '0x24',
                controlWifiPath: 'WMControl',
                validator: 'value=OFF && state!=POWEROFF && remote-control-allowed',
            },
            {
                entityKey: 'off',
                protocolFrameId: '0x24',
                controlWifiPath: 'WMControl',
                validator: 'state!=POWEROFF && remote-control-allowed',
            },
            {
                entityKey: 'stop',
                protocolFrameId: '0x24',
                controlWifiPath: 'WMControl',
                validator: 'state!=POWEROFF && remote-control-allowed',
            },
            {
                entityKey: 'remote_maintain',
                protocolFrameId: '0x24',
                controlWifiPath: 'remoteMaintain',
                validator: '(value=ON && state in [POWEROFF,INITIAL]) || (value=OFF && state=INITIAL)',
            },
            {
                entityKey: 'start_course',
                protocolFrameId: '0x26',
                controlWifiPath: 'WMStart',
                validator:
                    identity.role === 'washer'
                        ? 'state=INITIAL && remoteStart=true && reserveTimeMinute=0 && ControlValidator(soilWash,temp,spin,rinse,turboWash)'
                        : 'state=INITIAL && remoteStart=true && ControlValidator(dryLevel,ecoHybrid,steam)',
            },
        ],
    }
}

/**
 * Protocol/evidence identity used by release validation. Public entities are
 * deliberately limited to the hand-picked HA surface above.
 */
export const WASHTOWER_IMPLEMENTATION_MANIFEST: ImplementationIdentity[] = [
    implementationIdentity(WASHER_MODEL, {
        model: 'FAKPK21021',
        deviceType: '221',
        role: 'washer',
        codec: {
            protocol: {
                name: 'WASHER_PROTOCOL_EX',
                jsonVersion: '8.3',
                sha256: 'dfb39d74f18664e92dc8839b623a347154a4f9ae3cb354859c1fbef6a45c13b9',
            },
            convert: {
                name: 'WASHER_CONVERT_EX',
                jsonVersion: '2.3',
                sha256: '4311a33597a88fac5c32bc26f12ef65edeab0c4fc1173ca3665b4ad0685beab4',
            },
        },
    }),
    implementationIdentity(DRYER_MODEL, {
        model: 'BDH_D39301_KR',
        deviceType: '222',
        role: 'dryer',
        codec: {
            protocol: {
                name: 'DRYER_PROTOCOL_EX',
                jsonVersion: '4.1',
                sha256: '0428bcd76f1df325d3142fc2541083b3cc094d025c78e11e17f44f5f970dc348',
            },
            convert: {
                name: 'DRYER_CONVERT_EX',
                jsonVersion: '7.8',
                sha256: 'ff3dfc7f7974f18ed6c4a73bea1b03998b8f6c0213d1f08394482bc34844125b',
            },
        },
    }),
]

const HEADER_LENGTH = 15,
    TRAILER_LENGTH = 3
const STATE_FIDS = new Set([0x00eb, 0x00ec])
export function buildWashtowerExtendedFrame(tag: number, fid: number, payload: Buffer, sequence = 0): Buffer {
    if (tag !== 0x33 && tag !== 0x34) throw new RangeError('Not a WashTower device tag')
    if (payload.length > 0xffff) throw new RangeError('WashTower payload too large')
    const f = Buffer.alloc(HEADER_LENGTH + payload.length + TRAILER_LENGTH)
    f.set([0xaa, 0xff, tag, 0x0a, 0], 0)
    f.writeUInt16LE(f.length, 5)
    f.writeUInt16LE(sequence & 0xffff, 7)
    f.set([0, 1], 9)
    f.writeUInt16BE(fid & 0xffff, 11)
    f.writeUInt16BE(payload.length, 13)
    payload.copy(f, HEADER_LENGTH)
    f.writeUInt16BE(crc16(f.subarray(0, f.length - TRAILER_LENGTH)), f.length - TRAILER_LENGTH)
    f[f.length - 1] = 0xbb
    return f
}

/** Product control AABB envelope used by the existing washer/dryer drivers. */
export function buildWashtowerControlFrame(frameId: number, payload: Buffer): Buffer {
    if (frameId < 0 || frameId > 0xff) throw new RangeError('AABB Control frame ID Out of range')
    const inner = Buffer.concat([Buffer.from([0xf0, frameId]), payload])
    if (inner.length + 4 > 0xff) throw new RangeError('AABB Control payload too large')
    const frame = Buffer.concat([Buffer.from([0xaa, inner.length + 4]), inner, Buffer.from([0, 0xbb])])
    frame[frame.length - 2] = (frame.subarray(0, -2).reduce((sum, byte) => sum + byte, 0) & 0xff) ^ 0x55
    return frame
}

export function isWashtowerPowerOnSuccess(frame: Buffer, model: WashTowerModel): boolean {
    const acceptedLengths = new Set([13, 13 + model.liveRecordLength, 13 + model.recordLength])
    if (
        !acceptedLengths.has(frame.length) ||
        frame[0] !== 0xaa ||
        frame[1] !== frame.length ||
        frame[2] !== model.tag ||
        frame[3] !== 0xe6 ||
        frame[frame.length - 1] !== 0xbb
    )
        return false
    const checksum = (frame.subarray(0, -2).reduce((sum, byte) => sum + byte, 0) & 0xff) ^ 0x55
    return (
        frame[frame.length - 2] === checksum &&
        frame.subarray(4, 10).equals(Buffer.from([0x00, 0x02, 0x01, 0xff, 0x01, 0x02])) &&
        frame[10] === 0
    )
}

export const WASH_TOWER_SIMPLE_CONTROLS = {
    wake: { frameId: 0x2a, payload: Buffer.from([0x01, 0x00]) },
    powerOn: { frameId: 0xe5, payload: Buffer.from([0x00, 0x02, 0x01, 0xff, 0x01, 0x02, 0x01]) },
    /** Captured status query; after a verified power-on success it is only a best-effort refresh. */
    statusQuery: { frameId: 0xed, payload: Buffer.from('112101000000180411120000', 'hex') },
    off: { frameId: 0x24, payload: Buffer.from([0x01, 0x01, 0x00]) },
    stop: { frameId: 0x24, payload: Buffer.from([0x04, 0x01, 0x00]) },
    remoteMaintainOn: { frameId: 0x24, payload: Buffer.from([0x10, 0x01, 0x01]) },
    remoteMaintainOff: { frameId: 0x24, payload: Buffer.from([0x10, 0x01, 0x00]) },
} as const

const WASHER_SETTING_KEYS = ['course', 'soilWash', 'spin', 'temp', 'rinse', 'freshCare', 'steam', 'turboWash'] as const
const DRYER_SETTING_KEYS = ['course', 'ecoHybrid', 'wrinkleCare', 'steam', 'dryLevel'] as const
const POWER_ON_PENDING_MS = 120_000

type CourseOptionRule = Record<string, readonly [defaultValue: number, selectable?: readonly number[]]>

// Derived from each model JSON Course.function default/selectable declarations.
const WASHER_COURSE_RULES: Record<number, CourseOptionRule> = {
    27: {
        soilWash: [3, [0, 3]],
        rinse: [3, [0, 1, 2, 3, 4, 5]],
        spin: [4, [0, 1, 2, 4]],
        temp: [8, [8, 2, 3]],
        turboWash: [0, [0, 1]],
        steam: [0],
        freshCare: [0, [0, 1]],
    },
    46: {
        soilWash: [3, [0, 3, 5, 6]],
        rinse: [2, [0, 1, 2, 3, 4, 5]],
        spin: [6, [0, 1, 2, 4, 6, 8]],
        temp: [3, [8, 2, 3, 5]],
        turboWash: [1, [0, 1]],
        steam: [0],
        freshCare: [0, [0, 1]],
    },
    74: {
        soilWash: [3, [0, 3]],
        rinse: [1, [0, 1, 2, 3, 4, 5]],
        spin: [4, [0, 1, 2, 4, 6, 8]],
        temp: [3, [8, 2, 3]],
        turboWash: [1, [0, 1]],
        steam: [0],
        freshCare: [0, [0, 1]],
    },
    76: {
        soilWash: [3, [0, 3]],
        rinse: [3, [0, 1, 2, 3, 4, 5]],
        spin: [4, [0, 1, 2, 4, 6, 8]],
        temp: [6],
        turboWash: [0, [0, 1]],
        steam: [0],
        freshCare: [0, [0, 1]],
    },
    85: {
        soilWash: [3],
        rinse: [2],
        spin: [4],
        temp: [5],
        turboWash: [0],
        steam: [0],
        freshCare: [0, [0, 1]],
    },
    114: {
        soilWash: [3],
        rinse: [2, [1, 2, 3, 4, 5]],
        spin: [6, [1, 2, 4, 6, 8]],
        temp: [3, [8, 2, 3, 5]],
        turboWash: [1, [0, 1]],
        steam: [0],
        freshCare: [0, [0, 1]],
    },
}

const DRYER_COURSE_RULES: Record<number, CourseOptionRule> = {
    1: { ecoHybrid: [3], dryLevel: [0], steam: [1], wrinkleCare: [0, [0, 1]], moreLessTime: [0] },
    4: { ecoHybrid: [2], dryLevel: [0], steam: [0], wrinkleCare: [0, [0, 1]], moreLessTime: [0] },
    7: {
        ecoHybrid: [2, [1, 2, 3]],
        dryLevel: [3, [1, 2, 3, 4, 5]],
        steam: [0, [0, 1]],
        wrinkleCare: [0, [0, 1]],
        moreLessTime: [0],
    },
    9: { ecoHybrid: [3], dryLevel: [0], steam: [0], wrinkleCare: [0, [0, 1]], moreLessTime: [0] },
    15: { ecoHybrid: [2], dryLevel: [0], steam: [0, [0, 1]], wrinkleCare: [0, [0, 1]], moreLessTime: [0] },
    16: { ecoHybrid: [3], dryLevel: [0], steam: [1, [0, 1]], wrinkleCare: [0, [0, 1]], moreLessTime: [0] },
    18: { ecoHybrid: [3], dryLevel: [0], steam: [0], wrinkleCare: [0], moreLessTime: [0] },
    19: { ecoHybrid: [3], dryLevel: [0], steam: [1], wrinkleCare: [0], moreLessTime: [0] },
    21: { ecoHybrid: [2], dryLevel: [0], steam: [0], wrinkleCare: [0, [0, 1]], moreLessTime: [30] },
    44: { ecoHybrid: [2], dryLevel: [0], steam: [0], wrinkleCare: [0, [0, 1]], moreLessTime: [0] },
}

function courseRules(model: WashTowerModel) {
    return model.tag === 0x33 ? WASHER_COURSE_RULES : DRYER_COURSE_RULES
}

function defaultCourse(model: WashTowerModel) {
    // Official Config.defaultCourse is NORMAL for both installed models.
    return model.tag === 0x33 ? 46 : 7
}

function fieldByKey(model: WashTowerModel, key: string) {
    return model.fields.find((field) => field.key === key)
}

function optionByte(
    model: WashTowerModel,
    draft: ReadonlyMap<string, number>,
    offset: number,
    writableKeys: readonly string[],
) {
    let value = 0
    for (const field of model.fields) {
        if (field.offset !== offset || field.bit === undefined || !writableKeys.includes(field.key)) continue
        const raw = draft.get(field.key) ?? 0
        const width = field.bits || 1
        value |= (raw & ((1 << width) - 1)) << field.bit
    }
    return value
}

/** Official WMDownload body (frameId 0x25), without guessed reverse mappings. */
export function buildWashtowerDownloadPayload(model: WashTowerModel, draft: ReadonlyMap<string, number>): Buffer {
    const payload = Buffer.alloc(23)
    payload[0] = 3 // courseDownloadType=COURSEDATA
    payload[1] = 21 // ControlWifi courseDownloadDataLength
    if (model.tag === 0x33) {
        const course = draft.get('course') ?? 0
        payload[2] = course
        payload[3] = draft.get('soilWash') ?? 0
        payload[4] = draft.get('spin') ?? 0
        payload[5] = draft.get('temp') ?? 0
        payload[6] = draft.get('rinse') ?? 0
        payload[7] = 0
        payload[8] = 0
        payload[9] = optionByte(model, draft, 34, WASHER_SETTING_KEYS)
        payload[10] = optionByte(model, draft, 35, WASHER_SETTING_KEYS)
        payload[11] = optionByte(model, draft, 36, WASHER_SETTING_KEYS)
        payload[12] = course
        payload[13] = draft.get('downloadCourse') ?? 0
        payload[17] = draft.get('dryLevel') ?? 0
    } else {
        payload[3] = draft.get('ecoHybrid') ?? 0
        payload[4] = draft.get('moreLessTime') ?? 0
        payload.writeUInt16BE(draft.get('reserveTimeMinute') ?? 0, 7)
        payload[9] = optionByte(model, draft, 24, DRYER_SETTING_KEYS)
        payload[10] = optionByte(model, draft, 25, DRYER_SETTING_KEYS)
        payload[11] = optionByte(model, draft, 26, DRYER_SETTING_KEYS)
        payload[12] = draft.get('course') ?? 0
        payload[13] = draft.get('downloadCourse') ?? 0
        payload[17] = draft.get('dryLevel') ?? 0
    }
    return payload
}

/** Official model-specific WMStart body (frameId 0x26). */
export function buildWashtowerStartPayload(model: WashTowerModel, draft: ReadonlyMap<string, number>): Buffer {
    if (model.tag === 0x33) {
        const payload = Buffer.alloc(21)
        const course = draft.get('course') ?? 0
        payload[0] = course
        payload[1] = draft.get('soilWash') ?? 0
        payload[2] = draft.get('spin') ?? 0
        payload[3] = draft.get('temp') ?? 0
        payload[4] = draft.get('rinse') ?? 0
        // The state record has one two-byte reserveTimeMinute, while WMStart
        // requires separate hour/minute bytes. No official reverse mapping is
        // declared, so both reserved-time bytes remain zero.
        payload[7] = optionByte(model, draft, 34, WASHER_SETTING_KEYS)
        payload[8] = optionByte(model, draft, 35, WASHER_SETTING_KEYS)
        payload[9] = optionByte(model, draft, 36, WASHER_SETTING_KEYS)
        payload[10] = course
        payload[11] = draft.get('downloadCourse') ?? 0
        payload[15] = draft.get('dryLevel') ?? 0
        return payload
    }

    const payload = Buffer.alloc(14)
    payload[0] = draft.get('course') ?? 0
    payload[1] = draft.get('dryLevel') ?? 0
    payload[2] = draft.get('ecoHybrid') ?? 0
    payload[3] = draft.get('moreLessTime') ?? 0
    payload.writeUInt16BE(draft.get('reserveTimeMinute') ?? 0, 6)
    payload[9] = optionByte(model, draft, 24, DRYER_SETTING_KEYS)
    payload[10] = optionByte(model, draft, 25, DRYER_SETTING_KEYS)
    payload[11] = optionByte(model, draft, 26, DRYER_SETTING_KEYS)
    payload[12] = draft.get('downloadCourse') ?? 0
    return payload
}

export function selectCurrentWashtowerRecord(frame: Buffer, model: WashTowerModel): Buffer | undefined {
    if (frame.length < HEADER_LENGTH + model.liveRecordLength + TRAILER_LENGTH) return
    if (frame[0] !== 0xaa || frame[1] !== 0xff || frame[2] !== model.tag || frame[frame.length - 1] !== 0xbb) return
    if (frame.readUInt16LE(5) !== frame.length || !STATE_FIDS.has(frame.readUInt16BE(11))) return
    const n = frame.readUInt16BE(13)
    if (n !== frame.length - HEADER_LENGTH - TRAILER_LENGTH) return
    if (crc16(frame.subarray(0, frame.length - TRAILER_LENGTH)) !== frame.readUInt16BE(frame.length - TRAILER_LENGTH))
        return
    const fid = frame.readUInt16BE(11)
    if (fid === 0x00eb) {
        // Current firmware omits unsupported tail fields (67/50 bytes). Newer/full
        // firmware may send the complete official record (72/51 bytes).
        if (n !== model.liveRecordLength && n !== model.recordLength) return
        return frame.subarray(HEADER_LENGTH, HEADER_LENGTH + n)
    }
    // 0xEC is the official previous+current layout. As with 0xEB, current
    // firmware can omit unsupported tail fields from both records.
    const recordLength =
        n === model.liveRecordLength * 2
            ? model.liveRecordLength
            : n === model.recordLength * 2
              ? model.recordLength
              : undefined
    if (recordLength === undefined) return
    return frame.subarray(HEADER_LENGTH + recordLength, HEADER_LENGTH + recordLength * 2)
}
export default class WashTowerDevice extends HADevice {
    private readonly cache: Record<string, string | number> = {}
    private readonly observed = new Map<string, number>()
    private readonly draft = new Map<string, number>()
    private readonly dirtyDraftKeys = new Set<string>()
    private currentState: number | undefined
    private remoteStartAllowed = false
    private remoteAllowed = false
    private pendingPowerOnAt: number | undefined
    private powerOnRefreshSent = false
    private powerOnTimeout: ReturnType<typeof setTimeout> | undefined
    private draftReconciled = false
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        readonly meta: Metadata,
        readonly model: WashTowerModel,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (f) => this.processData(f))
        const components: DeviceDiscovery['components'] = {}
        const publicFields = publicFieldKeys(model)
        for (const field of model.fields) {
            if (!publicFields.has(field.key) || field.offset + field.length > model.recordLength) continue
            const key = publicEntityKey(field.key)
            components[key] = fieldComponent(field)
        }
        const settingKeys = model.tag === 0x33 ? WASHER_SETTING_KEYS : DRYER_SETTING_KEYS
        for (const settingKey of settingKeys) {
            const field = fieldByKey(model, settingKey)
            if (!field?.values) continue
            const key = componentKey(settingKey)
            const values =
                settingKey === 'course'
                    ? Object.entries(field.values)
                          .filter(([raw]) => Number(raw) in courseRules(model))
                          .map(([, label]) => label)
                    : Object.values(field.values)
            components['setting_' + key] = {
                platform: 'select',
                unique_id: '$deviceid-setting-' + key,
                state_topic: '$this/setting_' + key,
                command_topic: '$this/setting_' + key + '/set',
                name: field.label + ' Setting',
                options: [...new Set(values)],
            } as DeviceDiscovery['components'][string]
        }
        components.wake = {
            platform: 'button',
            unique_id: '$deviceid-wake',
            command_topic: '$this/wake/set',
            name: 'Exit power-save',
        } as DeviceDiscovery['components'][string]
        components.power = {
            platform: 'switch',
            unique_id: '$deviceid-power',
            state_topic: '$this/power',
            command_topic: '$this/power/set',
            name: 'Power',
            payload_on: 'ON',
            payload_off: 'OFF',
        } as DeviceDiscovery['components'][string]
        components.power_transition = {
            platform: 'sensor',
            unique_id: '$deviceid-power-transition',
            state_topic: '$this/power_transition',
            name: 'Power transition state',
            entity_category: 'diagnostic',
        } as DeviceDiscovery['components'][string]
        components.off = {
            platform: 'button',
            unique_id: '$deviceid-off',
            command_topic: '$this/off/set',
            name: 'Power off',
        } as DeviceDiscovery['components'][string]
        components.stop = {
            platform: 'button',
            unique_id: '$deviceid-stop',
            command_topic: '$this/stop/set',
            name: 'Pause',
        } as DeviceDiscovery['components'][string]
        components.start_course = {
            platform: 'button',
            unique_id: '$deviceid-start-course',
            command_topic: '$this/start_course/set',
            name: 'Start course',
        } as DeviceDiscovery['components'][string]
        components.remote_maintain = {
            platform: 'switch',
            unique_id: '$deviceid-remote_maintain',
            state_topic: '$this/remote_maintain',
            command_topic: '$this/remote_maintain/set',
            name: 'Keep remote start',
            payload_on: 'On',
            payload_off: 'Off',
            icon: 'mdi:remote',
        } as DeviceDiscovery['components'][string]
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: model.deviceName }),
                components,
            }),
        )
    }
    processData(frame: Buffer) {
        this.handlePowerOnResponse(frame)
        const record = selectCurrentWashtowerRecord(frame, this.model)
        if (!record) return
        this.remoteStartAllowed = false
        this.remoteAllowed = false
        const trackedFields = trackedFieldKeys(this.model)
        const publicFields = publicFieldKeys(this.model)
        for (const field of this.model.fields) {
            if (!trackedFields.has(field.key)) continue
            if (field.offset + field.length > record.length) continue
            let raw = record.readUIntBE(field.offset, field.length)
            if (field.bit !== undefined) {
                const width = field.bits || 1
                raw = (raw >> field.bit) & ((1 << width) - 1)
            }
            const value = field.values ? (field.values[String(raw)] ?? 'unknown') : raw
            if (publicFields.has(field.key) || field.key === 'remoteMaintain')
                this.publish(field.key === 'remoteMaintain' ? 'remote_maintain' : publicEntityKey(field.key), value)
            this.observed.set(field.key, raw)
            if (!this.dirtyDraftKeys.has(field.key)) this.draft.set(field.key, raw)
            if (field.key === 'state') this.currentState = raw
            if (field.key === 'remoteStart' && raw === 1) this.remoteStartAllowed = true
            if ((field.key === 'remoteStart' || field.key === 'remoteMaintain') && raw === 1) this.remoteAllowed = true
        }
        this.reconcileDraftFromFirstTelemetry()
        this.publish('power', this.currentState === 0 ? 'OFF' : 'ON')
        if (this.currentState !== 0 && this.pendingPowerOnAt !== undefined) {
            this.clearPendingPowerOn()
            this.publish('power_transition', 'Complete')
        } else {
            this.expirePendingPowerOn()
        }
        if (this.cache.power_transition === undefined) this.publish('power_transition', 'Standby')
    }
    private publish(key: string, value: string | number) {
        if (this.cache[key] === value) return
        this.cache[key] = value
        this.HA.publishProperty(this.id, key, value)
    }
    private send(frameId: number, payload: Buffer) {
        this.thinq.send_packet(buildWashtowerControlFrame(frameId, payload))
    }

    private clearPendingPowerOn() {
        if (this.powerOnTimeout !== undefined) clearTimeout(this.powerOnTimeout)
        this.powerOnTimeout = undefined
        this.pendingPowerOnAt = undefined
        this.powerOnRefreshSent = false
    }

    private expirePendingPowerOn(now = Date.now()) {
        if (this.pendingPowerOnAt === undefined || now - this.pendingPowerOnAt < POWER_ON_PENDING_MS) return false
        this.clearPendingPowerOn()
        this.publish('power_transition', 'Timeout')
        return true
    }

    private schedulePowerOnTimeout() {
        if (this.pendingPowerOnAt === undefined) return
        if (this.powerOnTimeout !== undefined) clearTimeout(this.powerOnTimeout)
        const remaining = Math.max(0, this.pendingPowerOnAt + POWER_ON_PENDING_MS - Date.now())
        this.powerOnTimeout = setTimeout(() => {
            this.powerOnTimeout = undefined
            if (!this.expirePendingPowerOn()) this.schedulePowerOnTimeout()
        }, remaining)
    }

    private handlePowerOnResponse(frame: Buffer) {
        if (this.pendingPowerOnAt === undefined || this.expirePendingPowerOn()) return
        if (this.powerOnRefreshSent || !isWashtowerPowerOnSuccess(frame, this.model)) return
        this.powerOnRefreshSent = true
        this.publish('power_transition', 'Command accepted')
        const command = WASH_TOWER_SIMPLE_CONTROLS.statusQuery
        try {
            this.send(command.frameId, command.payload)
        } catch (error) {
            log('status', this.model.deviceName, 'State refresh request failed', error)
        }
    }

    override drop() {
        this.clearPendingPowerOn()
        super.drop()
    }

    private validDraft() {
        const rule = courseRules(this.model)[this.draft.get('course') ?? -1]
        if (!rule) return false
        for (const [key, [defaultValue, selectable]] of Object.entries(rule)) {
            const value = this.draft.get(key)
            if (value === undefined || (selectable ? !selectable.includes(value) : value !== defaultValue)) return false
        }
        if (this.model.tag === 0x33) {
            const noWash = (this.draft.get('soilWash') ?? 0) === 0
            const noSpin = (this.draft.get('spin') ?? 0) === 0
            const noRinse = (this.draft.get('rinse') ?? 0) === 0
            if (
                (noWash && (this.draft.get('temp') ?? 0) !== 0) ||
                ((noWash || noSpin || noRinse) && (this.draft.get('turboWash') ?? 0) !== 0)
            )
                return false
        } else if (
            (this.draft.get('steam') ?? 0) === 1 &&
            ((this.draft.get('dryLevel') ?? 0) === 1 ||
                ((this.draft.get('dryLevel') ?? 0) === 3 && (this.draft.get('ecoHybrid') ?? 0) === 2))
        ) {
            return false
        }
        return true
    }

    private publishDraftSettings() {
        const settingKeys = this.model.tag === 0x33 ? WASHER_SETTING_KEYS : DRYER_SETTING_KEYS
        for (const key of settingKeys) {
            const raw = this.draft.get(key)
            const label = raw === undefined ? undefined : fieldByKey(this.model, key)?.values?.[String(raw)]
            if (label !== undefined) this.publish('setting_' + componentKey(key), label)
        }
    }

    private reconcileDraftFromFirstTelemetry() {
        if (this.draftReconciled) return
        this.draftReconciled = true
        if (this.dirtyDraftKeys.has('course')) return
        const observedCourse = this.observed.get('course')
        const course =
            observedCourse !== undefined && courseRules(this.model)[observedCourse]
                ? observedCourse
                : defaultCourse(this.model)
        this.applyCourseDefaults(course, true)
    }

    private applyCourseDefaults(course: number, preserveDirty = false) {
        const rule = courseRules(this.model)[course]
        if (!rule) return false
        const updates: Array<readonly [string, number]> = [
            ['course', course],
            ['baseDownloadCourseData', 0],
            ['downloadCourse', 0],
            ...Object.entries(rule).map(([key, [defaultValue]]) => [key, defaultValue] as const),
        ]
        for (const [key, value] of updates) {
            if (preserveDirty && this.dirtyDraftKeys.has(key)) continue
            this.draft.set(key, value)
            this.dirtyDraftKeys.add(key)
        }
        this.publishDraftSettings()
        return true
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop.startsWith('setting_')) {
            const key = prop.slice('setting_'.length)
            const settingKeys = this.model.tag === 0x33 ? WASHER_SETTING_KEYS : DRYER_SETTING_KEYS
            const field = this.model.fields.find(
                (candidate) => componentKey(candidate.key) === key && settingKeys.includes(candidate.key as never),
            )
            const raw = Object.entries(field?.values ?? {}).find(([, label]) => label === mqttValue)?.[0]
            if (raw === undefined) return log('status', this.model.deviceName, 'Setting value not allowed ' + mqttValue)
            const rawValue = Number(raw)
            if (field!.key === 'course') {
                if (!this.applyCourseDefaults(rawValue))
                    return log('status', this.model.deviceName, 'not an official control course')
            } else {
                this.draft.set(field!.key, rawValue)
                this.dirtyDraftKeys.add(field!.key)
            }
            this.publish(prop, mqttValue)
            return
        }
        if (prop === 'send_course')
            return log(
                'status',
                this.model.deviceName,
                'Built-in course can only be applied via the start-course command',
            )
        if (this.currentState === undefined) return log('status', this.model.deviceName, 'Status unknown')
        if (prop === 'wake') {
            if (this.currentState !== 0) return log('status', this.model.deviceName, 'Wake only from off state')
            const command = WASH_TOWER_SIMPLE_CONTROLS.wake
            return this.send(command.frameId, command.payload)
        }
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                if (this.currentState !== 0) return log('status', this.model.deviceName, 'Already on')
                this.expirePendingPowerOn()
                if (this.pendingPowerOnAt !== undefined)
                    return log('status', this.model.deviceName, 'Awaiting power-on response')
                const command = WASH_TOWER_SIMPLE_CONTROLS.powerOn
                this.send(command.frameId, command.payload)
                this.pendingPowerOnAt = Date.now()
                this.powerOnRefreshSent = false
                this.schedulePowerOnTimeout()
                this.publish('power_transition', 'Turning on')
                return
            }
            if (mqttValue === 'OFF') {
                if (this.currentState === undefined || this.currentState === 0) {
                    return log('status', this.model.deviceName, 'Power in current state OFF Unavailable')
                }
                if (!this.remoteAllowed) return log('status', this.model.deviceName, 'Remote control not allowed')
                const command = WASH_TOWER_SIMPLE_CONTROLS.off
                return this.send(command.frameId, command.payload)
            }
            return log('status', this.model.deviceName, 'Unsupported power-control value ' + mqttValue)
        }
        if (prop === 'remote_maintain') {
            const enable = mqttValue === 'ON' || mqttValue === 'On'
            const disable = mqttValue === 'OFF' || mqttValue === 'Off'
            if (enable && this.currentState !== 0 && this.currentState !== 1)
                return log('status', this.model.deviceName, 'Remote control lock only while off or standby')
            if (disable && this.currentState !== 1)
                return log('status', this.model.deviceName, 'Remote control unlock only in standby')
            const command = enable
                ? WASH_TOWER_SIMPLE_CONTROLS.remoteMaintainOn
                : disable
                  ? WASH_TOWER_SIMPLE_CONTROLS.remoteMaintainOff
                  : undefined
            if (!command)
                return log('status', this.model.deviceName, 'Unsupported remote-control-lock value ' + mqttValue)
            return this.send(command.frameId, command.payload)
        }
        if (prop === 'start_course') {
            if (this.currentState !== 1) return log('status', this.model.deviceName, 'Course start only in standby')
            if (!this.remoteStartAllowed) return log('status', this.model.deviceName, 'Remote control not allowed')
            if (this.model.tag === 0x33 && (this.observed.get('reserveTimeMinute') ?? 0) !== 0)
                return log('status', this.model.deviceName, 'Cannot start immediately while a reservation is set')
            if (!this.validDraft())
                return log('status', this.model.deviceName, 'Option combination fails official control validation')
            return this.send(0x26, buildWashtowerStartPayload(this.model, this.draft))
        }
        if (prop === 'off' || prop === 'stop') {
            if (this.currentState === undefined || this.currentState === 0)
                return log('status', this.model.deviceName, 'Command rejected in current state')
            if (!this.remoteAllowed) return log('status', this.model.deviceName, 'Remote control not allowed')
            const command = WASH_TOWER_SIMPLE_CONTROLS[prop]
            return this.send(command.frameId, command.payload)
        }
        log('status', this.model.deviceName, 'Unsupported write request ' + prop)
    }
}

/*
 * The washer and dryer share every bit of the decode above and differ only in their model
 * tables, so both live here rather than in separate files. deviceType 221 is the lower washer,
 * 222 the upper dryer.
 */
export class FAKPK21021 extends WashTowerDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, WASHER_MODEL)
    }
}

export class BDH_D39301_KR extends WashTowerDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, DRYER_MODEL)
    }
}
