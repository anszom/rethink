import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

const WASHER_UNIT = 0x33
const DRYER_UNIT = 0x34

const FIXED_HEADER_LENGTH = 13
const STATE_BLOCK_LENGTH = 95

const DOOR_OPEN = 'OPEN'
const DOOR_CLOSE = 'CLOSE'

const WASHER_COURSES = Enum.of({
    NOT_SELECTED: 0x00,
    '3IN2_REF': 0x01,
    ADD_PREWASH: 0x02,
    AIRCLEANING: 0x03,
    ALLERGY_SPASTEAM: 0x04,
    ALLERGYCARE: 0x05,
    ANSIMCOLD: 0x06,
    BABY_STEAMCARE: 0x07,
    BABYCARE: 0x08,
    BEDDING: 0x09,
    BOIL: 0x0a,
    BRIGHT_WHITE: 0x0b,
    BULKY: 0x0c,
    CASUAL: 0x0e,
    COLD_CARE: 0x0f,
    COLD_CLEAN: 0x10,
    COLDWASH: 0x11,
    COLORCARE: 0x12,
    COTTONECO: 0x13,
    CUPBOARD_DRY: 0x14,
    DARKWASH: 0x15,
    DELICATES: 0x16,
    DIRECTWEAR: 0x17,
    DOUBLE_RINSE: 0x18,
    DRAIN_SPIN: 0x19,
    DRYONLY: 0x1a,
    DUVET: 0x1b,
    DUVETCLEANING: 0x1c,
    EASYCARE: 0x1d,
    FAVORITE: 0x1e,
    GENTLECARE: 0x1f,
    HALFLOAD: 0x20,
    HANDWASH: 0x21,
    HANDWASH_WOOL: 0x22,
    HEAVYDUTY: 0x23,
    INTENSIVE60: 0x24,
    IRON_DRY: 0x25,
    JEAN: 0x26,
    KIDS_WEARS: 0x27,
    JUMBOWASH: 0x28,
    LINGERIE: 0x29,
    LOWTEMP_DRY: 0x2a,
    MIX: 0x2b,
    HYGIENE_40: 0x2c,
    SANITARY_60: 0x2d,
    NORMAL: 0x2e,
    OVERNIGHT: 0x2f,
    PERM_PRESS: 0x30,
    POWER_CLEAN: 0x31,
    PRE_WASH: 0x32,
    QUICK_DEO: 0x33,
    QUICK30: 0x34,
    QUIET: 0x35,
    REFRESH: 0x36,
    RINSE_SPIN: 0x37,
    RINSEONLY: 0x38,
    RUGGED: 0x39,
    SAFETY: 0x3a,
    SAFETY_NORMAL: 0x3b,
    SANITARY: 0x3c,
    SANITARY_OXI: 0x3d,
    SAVING_WATER: 0x3e,
    SCHOOLING: 0x3f,
    SHOES: 0x40,
    SILENT: 0x41,
    SILENTWASH: 0x42,
    SKINCARE: 0x43,
    SMALL_LOAD: 0x44,
    SMARTSAVE: 0x45,
    SOAK: 0x46,
    SPA_REF: 0x47,
    SPEED_DRY: 0x48,
    SPEED_TUB_CLEAN: 0x49,
    SPEEDWASH: 0x4a,
    SPEED14: 0x4b,
    SPEEDBOIL: 0x4c,
    SPEEDWASH_DRY: 0x4d,
    SPIN_ONLY: 0x4e,
    SPORTS_WEARS: 0x4f,
    STAINCARE: 0x50,
    STEAM_COTTON: 0x51,
    STRONG_DRY: 0x52,
    TIME_DRY: 0x53,
    TOWELS: 0x54,
    TUB_CLEAN: 0x55,
    TUB_DRY: 0x56,
    TURBOWASH: 0x57,
    WASHDRY: 0x58,
    WASHONLY: 0x59,
    WHITE: 0x5a,
    WINDSPIN120: 0x5b,
    WINDSPIN60: 0x5c,
    WINDSPIN90: 0x5d,
    WOOL: 0x5e,
    SINGLE_SHIRTS: 0x5f,
})

const WASHER_TEMPS = Enum.of({
    NO_TEMP: 0x00,
    TEMP_20: 0x01,
    TEMP_30: 0x02,
    TEMP_40: 0x03,
    TEMP_50: 0x04,
    TEMP_60: 0x05,
    TEMP_95: 0x06,
    TEMP_TAP_COLD: 0x07,
    TEMP_COLD: 0x08,
    TEMP_WARM: 0x09,
    TEMP_HOT: 0x0a,
    TEMP_EXTRA_HOT: 0x0b,
    TEMP_COLD_HOT: 0x0c,
    FL27_TEMP_TAPCOLD: 0x0d,
    'N/A': 0x0e, // not recognized by cloud; reported when temp is not applicable
    FL27_TEMP_ECOWARM: 0x0f,
    FL27_TEMP_WARM: 0x10,
})

const WASHER_SOIL_WASH = Enum.of({
    NO_SOILWASH: 0x00,
    SOILWASH_LIGHT: 0x01,
    SOILWASH_LIGHT_NORMAL: 0x02,
    SOILWASH_NORMAL: 0x03,
    SOILWASH_NORMAL_HEAVY: 0x04,
    SOILWASH_HEAVY: 0x05,
    SOILWASH_PREWASH: 0x06,
    SOILWASH_SOAKING: 0x07,
    SOILWASH_TURBO_WASH: 0x08,
})

const WASHER_RINSE = Enum.of({
    NO_RINSE: 0x00,
    RINSE_1: 0x01,
    RINSE_2: 0x02,
    RINSE_3: 0x03,
    RINSE_4: 0x04,
    RINSE_5: 0x05,
    RINSE_6: 0x06,
    RINSE_7: 0x07,
    RINSE_8: 0x08,
    RINSE_1_SAFE: 0x09,
    RINSE_2_SAFE: 0x0a,
    RINSE_3_SAFE: 0x0b,
    RINSE_4_SAFE: 0x0c,
    RINSE_5_SAFE: 0x0d,
    'N/A': 0x0e, // not recognized by cloud; reported when rinse is not applicable
    RINSE_PLUS: 0x0f,
    RINSE_PLUS2: 0x10,
})

const WASHER_SPIN = Enum.of({
    NO_SPIN: 0x00,
    SPIN_400: 0x01,
    SPIN_600: 0x02,
    SPIN_700: 0x03,
    SPIN_800: 0x04,
    SPIN_900: 0x05,
    SPIN_1000: 0x06,
    SPIN_1100: 0x07,
    SPIN_1200: 0x08,
    SPIN_1400: 0x09,
    SPIN_1600: 0x0a,
    SPIN_MAX: 0x0b,
    SPIN_DRAIN_ONLY: 0x0c,
    SPIN_LOW: 0x0d,
    'N/A': 0x0e, // not recognized by cloud; reported when spin is not applicable
    SPIN_HIGH: 0x0f,
    SPIN_EXTRA_HIGH: 0x10,
})

const WASHER_SOAK = Enum.of({
    NO_SOAK: 0x00,
    SOAK_30: 0x01,
    SOAK_45: 0x02,
    SOAK_60: 0x03,
    SOAK_120: 0x04,
    SOAK_180: 0x05,
    SOAK_240: 0x06,
})

const WASHER_WATER_LEVEL = Enum.of({
    NO_WATERLEVEL: 0x00,
    WATERLEVEL_2: 0x01,
    WATERLEVEL_3: 0x02,
    WATERLEVEL_4: 0x03,
    WATERLEVEL_5: 0x04,
    WATERLEVEL_6: 0x05,
    WATERLEVEL_7: 0x06,
    WATERLEVEL_8: 0x07,
    WATERLEVEL_9: 0x08,
    WATERLEVEL_10: 0x09,
})

const WASHER_LOAD_ITEM = Enum.of({
    NO_LOADITEM: 0x00,
    LOADITEM_1: 0x01,
    LOADITEM_2: 0x02,
    LOADITEM_3: 0x03,
})

const WASHER_LOAD_LEVEL = Enum.of({
    LOAD_AUTO_DETECT: 0x00,
    LOAD_LEVEL_1: 0x01,
    LOAD_LEVEL_2: 0x02,
    LOAD_LEVEL_3: 0x03,
    LOAD_LEVEL_4: 0x04,
    LOAD_LEVEL_5: 0x05,
    LOAD_LEVEL_6: 0x06,
    LOAD_LEVEL_7: 0x07,
    LOAD_LEVEL_8: 0x08,
})

const WASHER_RINSE_COUNT = Enum.of({
    NO_RINSE: 0x00,
    RINSE_1: 0x01,
    RINSE_2: 0x02,
    RINSE_3: 0x03,
    RINSE_4: 0x04,
    RINSE_5: 0x05,
    RINSE_6: 0x06,
    RINSE_7: 0x07,
    RINSE_8: 0x08,
})

const DEVICE_BUZZER = Enum.of({
    Off: 0x00,
    Low: 0x01,
    Medium: 0x02,
    High: 0x03,
    'Very High': 0x04,
})

const DRYER_TEMP = Enum.of({
    NO_TEMP: 0x00,
    TEMP_ULTRALOW: 0x01,
    TEMP_LOW: 0x02,
    TEMP_MEDIUM: 0x03,
    TEMP_MEDIUMHIGH: 0x04,
    TEMP_HIGH: 0x05,
})

const DRYER_TIME_DRY = Enum.of({
    NO_TIMEDRY: 0x00,
    TIMEDRY_20: 0x01,
    TIMEDRY_30: 0x02,
    TIMEDRY_40: 0x03,
    TIMEDRY_50: 0x04,
    TIMEDRY_60: 0x05,
    TIMEDRY_70: 0x06,
    TIMEDRY_80: 0x07,
})

const WASHER_STATES = Enum.of({
    POWEROFF: 0x00,
    INITIAL: 0x01,
    PAUSE: 0x02,
    DETECTING: 0x03,
    DISPLAY_LOAD: 0x04,
    ADD_DRAIN: 0x05,
    DETERGENT_AMOUNT: 0x06,
    RESERVED: 0x07,
    SOAK: 0x08,
    PREWASH: 0x09,
    RUNNING: 0x0b,
    RINSING: 0x0c,
    RINSEHOLD: 0x0d,
    SPINNING: 0x0e,
    DRYING: 0x0f,
    END: 0x10,
    COOLDOWN: 0x11,
    COOLFAN: 0x12,
    STEAM_SOFTENER: 0x14,
    REFRESHING: 0x15,
    ERROR: 0x16,
    ERROR_AUTO_OFF: 0x17,
    SHOES_MODULE: 0x18,
    DOING_DIAGNOSIS: 0x19,
    DOING_FIRM_UPDATE: 0x1a,
    FROZEN_PREVENT_INITIAL: 0x1b,
    FROZEN_PREVENT_PAUSE: 0x1c,
    FROZEN_PREVENT_RUNNING: 0x1d,
    SERVICE: 0x1e,
    TEST: 0x1f,
    AUTOTEST: 0x20,
    FIRMWARE_UPDATE: 0x21,
    AUDIBLE_DIAGNOSIS: 0x22,
    AUTO_DT_OPEN_PAUSE: 0x23,
    CONFIRM_START_FOR_CONTROL: 0x24,
    CLOTHING_RECOGNITION: 0x25,
    DETERGENT_INPUT: 0x26,
    SOFTENER_INPUT: 0x27,
    POLLUTION_DETECTING: 0x28,
    TUB_CLEANING: 0x29,
    END_REMOTE_MAINTAIN_ON: 0x2a,
    STEAM: 0x2b,
    LAUNDRYCARE: 0x2f,
    EZDISPENSE_CLEANING: 0x30,
    END_WAITING: 0x31,
})

const WASHER_ERRORS = Enum.of({
    NONE: 0x00,
    ERROR_PUMP: 0x01,
    ERROR_IE: 0x02,
    ERROR_OE: 0x03,
    ERROR_UE: 0x04,
    ERROR_FE: 0x05,
    ERROR_AE: 0x06,
    ERROR_PE: 0x07,
    ERROR_TE: 0x08,
    ERROR_LE: 0x09,
    ERROR_CE: 0x0a,
    ERROR_DHE: 0x0b,
    ERROR_PFE: 0x0c,
    ERROR_FF: 0x0d,
    ERROR_DCE: 0x0e,
    ERROR_EE: 0x0f,
    ERROR_LOE: 0x10,
    ERROR_LE1: 0x11,
    ERROR_E3: 0x12,
    ERROR_PS: 0x13,
    ERROR_DE1: 0x14,
})

const DRYER_ERRORS = Enum.of({
    NONE: 0x00,
    ERROR_TE1: 0x01,
    ERROR_TE2: 0x02,
    ERROR_TE3: 0x03,
    ERROR_TE4: 0x04,
    ERROR_TE5: 0x05,
    ERROR_TE6: 0x06,
    ERROR_CE1: 0x07,
    ERROR_CE2: 0x08,
    ERROR_HE1: 0x09,
    ERROR_E1: 0x0a,
    ERROR_E3: 0x0b,
    ERROR_E4: 0x0c,
    ERROR_E5: 0x0d,
    ERROR_DRAINMOTOR: 0x0e,
    ERROR_EMPTYWATER: 0x0f,
    ERROR_DOOR: 0x10,
    ERROR_FILTERCLOGGING: 0x11,
    ERROR_NOFILTER: 0x12,
    ERROR_EEPROM: 0x13,
    ERROR_F1: 0x14,
})

const DRYER_STATES = Enum.of({
    POWEROFF: 0x00,
    INITIAL: 0x01,
    RUNNING: 0x02,
    PAUSE: 0x03,
    END: 0x04,
    ERROR: 0x05,
    AUDIBLE_DIAGNOSIS: 0x06,
    DRYING: 0x07,
    COOLING: 0x08,
    WRINKLECARE: 0x09,
    RESERVED: 0x0a,
    DELAYLOAD: 0x0b,
    SPINREERVE: 0x0c,
    AUTOTEST: 0x0d,
    DETECTING: 0x0e,
    STEAM: 0x0f,
    CLOTHING_RECOGNITION: 0x10,
    CONDENSER_CLEAN: 0x11,
    BEDDINGBRUSHING: 0x12,
    DRY_REFRESHING: 0x13,
    ALLERGYCARE: 0x14,
    CONDENSERCARE: 0x15,
    END_REMOTE_MAINTAIN_ON: 0x16,
    DRYREADY: 0x17,
    LAUNDRYCARE: 0x18,
    DEHUMIDIFICATION: 0x19,
    DEHUMIDIFICATION_END: 0x1a,
    END_WAITING: 0x1b,
    DRUM_CARE: 0x1c,
    AI_LOAD_CHECK: 0x1f,
})

const DRYER_DRY_LEVELS = Enum.of({
    NOT_SELECTED: 0x00,
    DAMP: 0x01,
    LESS: 0x02,
    NORMAL: 0x03,
    MORE: 0x04,
    VERY: 0x05,
})

const DRYER_DUCT_CLOGGING = Enum.of({
    NONE: 0x00,
    LEVEL_1: 0x01,
    LEVEL_2: 0x02,
})

const DRYER_COURSES = Enum.of({
    NOT_SELECTED: 0x00,
    REFRESH: 0x01,
    TOWELS: 0x02,
    JEAN: 0x03,
    BEDDING: 0x04,
    EASYCARE: 0x05,
    MIXFABRIC: 0x06,
    NORMAL: 0x07,
    SPORTWEAR: 0x08,
    QUICKDRY: 0x09,
    DELICATES: 0x0a,
    WOOL: 0x0b,
    RACKDRY: 0x0c,
    COOLAIR: 0x0d,
    WARMAIR: 0x0e,
    BEDDINGBRUSH: 0x0f,
    ALLERGYCARE: 0x10,
    POWER: 0x11,
    CONDENSERCARE: 0x12,
    TUBCLEAN: 0x13,
    PADDINGREFRESH: 0x14,
    TIMEDRY: 0x15,
    WATERREPELLENT: 0x16,
    BABYWEAR: 0x17,
    SMALLLOAD: 0x18,
    COTTONPLUS: 0x19,
    PERMPRESS: 0x1a,
    PET_CARE: 0x1b,
    SHIRT1EA: 0x1c,
    HEAVYDUTY: 0x1d,
    ULTRADELICATES: 0x1e,
    KIDWEAR: 0x1f,
    LOWTEMPDRY: 0x20,
    JUMBODRY: 0x21,
    SPEEDDRY: 0x22,
    AIRDRY: 0x23,
    SPOTCLEANING: 0x24,
    STEAMFRESH: 0x25,
    STEAMSANITARY: 0x26,
    FRESHENUP: 0x27,
    FTFRESH: 0x28,
    MISTFRESH: 0x29,
    SUPERDRY: 0x2a,
    LOWTEMPDRYPLUS: 0x2b,
    AI_COURSE: 0x2c,
    SILENT: 0x2d,
    CLOTHCARE: 0x2e,
    WRINKLEFREE: 0x2f,
    LIGHTBEDDING: 0x30,
    GYMCLOTHES: 0x31,
    RAINYDAY: 0x32,
    EASYIRON: 0x33,
    DUVET_COVER: 0x34,
    BLANKETREFRESH: 0x35,
    OVERNIGHTDRY: 0x36,
    HALFLOADDRY: 0x37,
    FULLLOADDRY: 0x38,
    DEHUMIDIFICATION: 0x39,
    TURBODRY: 0x3a,
})

const INIT_LCD_THEMES = Enum.of({
    // The actual enum values are INIT_LCD_{IDX}.
    Default: 0x00,
    'Winter 1': 0x01,
    'Winter 2': 0x02,
    'Winter 3': 0x03,
    'Spring 1': 0x04,
    'Spring 2': 0x05,
    'Summer 1': 0x06,
    'Summer 2': 0x07,
    'Fall 1': 0x08,
    Halloween: 0x09,
    'New Years': 0x0a,
    Christmas: 0x0b,
    None: 0x0c,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG WashTower' }),
                components: {
                    washer_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-state',
                        state_topic: '$this/washer/state',
                        name: 'Washer state',
                        icon: 'mdi:washing-machine',
                    },
                    washer_soil_wash: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-soil-wash',
                        state_topic: '$this/washer/soil_wash',
                        name: 'Washer soil wash',
                        icon: 'mdi:spray',
                    },
                    washer_rinse: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-rinse',
                        state_topic: '$this/washer/rinse',
                        name: 'Washer rinse',
                        icon: 'mdi:water',
                    },
                    washer_spin: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-spin',
                        state_topic: '$this/washer/spin',
                        name: 'Washer spin',
                        icon: 'mdi:rotate-right',
                    },
                    washer_soak: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-soak',
                        state_topic: '$this/washer/soak',
                        name: 'Washer soak',
                        icon: 'mdi:water',
                    },
                    washer_water_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-water-level',
                        state_topic: '$this/washer/water_level',
                        name: 'Washer water level',
                        icon: 'mdi:water-check',
                    },
                    washer_load_item: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-load-item',
                        state_topic: '$this/washer/load_item',
                        name: 'Washer load item',
                        icon: 'mdi:tshirt-crew',
                    },
                    washer_load_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-load-level',
                        state_topic: '$this/washer/load_level',
                        name: 'Washer load level',
                        icon: 'mdi:weight',
                    },
                    washer_rinse_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-rinse-count',
                        state_topic: '$this/washer/rinse_count',
                        name: 'Washer rinse count',
                        icon: 'mdi:counter',
                    },
                    washer_laundry_texture: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-laundry-texture',
                        state_topic: '$this/washer/laundry_texture',
                        name: 'Washer laundry texture',
                        icon: 'mdi:texture',
                    },
                    washer_reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-reserve-time',
                        state_topic: '$this/washer/reserve_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Washer reserve time',
                    },
                    washer_remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-remaining-time',
                        state_topic: '$this/washer/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Washer remaining time',
                    },
                    washer_initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-initial-time',
                        state_topic: '$this/washer/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Washer initial time',
                    },
                    washer_temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-temp',
                        state_topic: '$this/washer/temp',
                        name: 'Washer temperature',
                        icon: 'mdi:thermometer',
                    },
                    washer_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-course',
                        state_topic: '$this/washer/course',
                        name: 'Washer course',
                        icon: 'mdi:washing-machine',
                    },
                    washer_energy: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-energy',
                        state_topic: '$this/washer/energy',
                        name: 'Washer energy',
                        device_class: 'energy',
                        state_class: 'total_increasing',
                        unit_of_measurement: 'Wh',
                        icon: 'mdi:lightning-bolt',
                    },
                    dryer_reserve_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-reserve-time',
                        state_topic: '$this/dryer/reserve_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Dryer reserve time',
                    },
                    dryer_remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-remaining-time',
                        state_topic: '$this/dryer/remaining_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Dryer remaining time',
                    },
                    dryer_initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-initial-time',
                        state_topic: '$this/dryer/initial_time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        name: 'Dryer initial time',
                    },
                    dryer_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-course',
                        state_topic: '$this/dryer/course',
                        name: 'Dryer course',
                        icon: 'mdi:tumble-dryer',
                    },
                    dryer_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-state',
                        state_topic: '$this/dryer/state',
                        name: 'Dryer state',
                        icon: 'mdi:tumble-dryer',
                    },
                    dryer_dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-dry-level',
                        state_topic: '$this/dryer/dry_level',
                        name: 'Dryer dry level',
                        icon: 'mdi:water-percent',
                    },
                    dryer_temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-temp',
                        state_topic: '$this/dryer/temp',
                        name: 'Dryer temperature',
                        icon: 'mdi:thermometer',
                    },
                    dryer_time_dry: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-time-dry',
                        state_topic: '$this/dryer/time_dry',
                        name: 'Dryer time dry',
                        icon: 'mdi:timer',
                    },
                    washer_buzzer: {
                        platform: 'select',
                        unique_id: '$deviceid-washer-buzzer',
                        state_topic: '$this/washer/buzzer',
                        command_topic: '$this/washer/buzzer/set',
                        options: DEVICE_BUZZER.options,
                        optimistic: true,
                        name: 'Washer buzzer',
                        icon: 'mdi:volume-high',
                        availability: [
                            { topic: '$this/washer/power', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                    },
                    washer_error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-washer-error',
                        state_topic: '$this/washer/error',
                        name: 'Washer error',
                        icon: 'mdi:alert-circle',
                    },
                    dryer_buzzer: {
                        platform: 'select',
                        unique_id: '$deviceid-dryer-buzzer',
                        state_topic: '$this/dryer/buzzer',
                        command_topic: '$this/dryer/buzzer/set',
                        options: DEVICE_BUZZER.options,
                        optimistic: true,
                        name: 'Dryer buzzer',
                        icon: 'mdi:volume-high',
                        availability: [
                            { topic: '$this/dryer/power', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                    },
                    dryer_error: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-error',
                        state_topic: '$this/dryer/error',
                        name: 'Dryer error',
                        icon: 'mdi:alert-circle',
                    },
                    washer_door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-washer-door',
                        state_topic: '$this/washer/door',
                        device_class: 'door',
                        payload_on: DOOR_OPEN,
                        payload_off: DOOR_CLOSE,
                        name: 'Washer door',
                    },
                    washer_door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-washer-door-lock',
                        state_topic: '$this/washer/door_lock',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Washer door lock',
                        icon: 'mdi:lock',
                    },
                    washer_add_garment: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-washer-add-garment',
                        state_topic: '$this/washer/add_garment',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Washer add garment',
                        icon: 'mdi:tshirt-crew',
                    },
                    washer_child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-washer-child-lock',
                        state_topic: '$this/washer/child_lock',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Washer child lock',
                        icon: 'mdi:lock-outline',
                    },
                    washer_remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-washer-remote-start',
                        state_topic: '$this/washer/remote_start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Washer remote start',
                        icon: 'mdi:remote',
                    },
                    washer_remote_maintain: {
                        platform: 'switch',
                        unique_id: '$deviceid-washer-remote-maintain',
                        state_topic: '$this/washer/remote_maintain',
                        command_topic: '$this/washer/remote_maintain/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Washer keep remote start',
                        icon: 'mdi:remote',
                        availability: [
                            { topic: '$this/washer/power', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                    },
                    dryer_door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dryer-door',
                        state_topic: '$this/dryer/door',
                        device_class: 'door',
                        payload_on: DOOR_OPEN,
                        payload_off: DOOR_CLOSE,
                        name: 'Dryer door',
                    },
                    dryer_child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dryer-child-lock',
                        state_topic: '$this/dryer/child_lock',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Dryer child lock',
                        icon: 'mdi:lock-outline',
                    },
                    dryer_remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-dryer-remote-start',
                        state_topic: '$this/dryer/remote_start',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Dryer remote start',
                        icon: 'mdi:remote',
                    },
                    dryer_remote_maintain: {
                        platform: 'switch',
                        unique_id: '$deviceid-dryer-remote-maintain',
                        state_topic: '$this/dryer/remote_maintain',
                        command_topic: '$this/dryer/remote_maintain/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        name: 'Dryer keep remote start',
                        icon: 'mdi:remote',
                        availability: [
                            { topic: '$this/dryer/power', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                    },
                    dryer_duct_clogging: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dryer-duct-clogging',
                        state_topic: '$this/dryer/duct_clogging',
                        name: 'Dryer duct clogging',
                        icon: 'mdi:pipe-wrench',
                    },
                    washer_power: {
                        platform: 'switch',
                        unique_id: '$deviceid-washer-power',
                        state_topic: '$this/washer/power',
                        command_topic: '$this/washer/power/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                        name: 'Washer power',
                        icon: 'mdi:washing-machine',
                    },
                    dryer_power: {
                        platform: 'switch',
                        unique_id: '$deviceid-dryer-power',
                        state_topic: '$this/dryer/power',
                        command_topic: '$this/dryer/power/set',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        optimistic: true,
                        name: 'Dryer power',
                        icon: 'mdi:tumble-dryer',
                    },
                    init_lcd: {
                        platform: 'select',
                        unique_id: '$deviceid-init-lcd',
                        state_topic: '$this/shared/init_lcd',
                        command_topic: '$this/shared/init_lcd/set',
                        options: INIT_LCD_THEMES.options,
                        optimistic: true,
                        name: 'Init LCD',
                        icon: 'mdi:image',
                        availability: [
                            { topic: '$this/washer/power', payload_available: 'ON', payload_not_available: 'OFF' },
                        ],
                    },
                },
            }),
        )
    }

    start() {
        //
        // Door state is delta-only (0x42/0x4e events), so default to CLOSE on each connect.
        // The first real door event will override this if the door is actually open.
        // This helps simplify automations that rely on checking if a door is closed
        // for an extended period of time after a cycle completes.
        //
        this.publishProperty('washer/door', DOOR_CLOSE)
        this.publishProperty('dryer/door', DOOR_CLOSE)
        this.send(Buffer.from('F0ED1121010000001800', 'hex'))
    }

    setProperty(prop: string, value: string) {
        if (prop === 'washer/power') {
            const on = value === 'ON' ? 0x01 : 0x00
            this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, WASHER_UNIT, 0x01, 0x02, on]))
        } else if (prop === 'dryer/power') {
            const on = value === 'ON' ? 0x01 : 0x00
            this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, DRYER_UNIT, 0x01, 0x02, on]))
        } else if (prop === 'washer/buzzer') {
            const idx = DEVICE_BUZZER.unmap(value)
            if (idx !== undefined) {
                this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, WASHER_UNIT, 0x01, 0x13, idx]))
            }
        } else if (prop === 'dryer/buzzer') {
            const idx = DEVICE_BUZZER.unmap(value)
            if (idx !== undefined) {
                this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, DRYER_UNIT, 0x01, 0x13, idx]))
            }
        } else if (prop === 'washer/remote_maintain') {
            const on = value === 'ON' ? 0x01 : 0x00
            this.send(Buffer.from([0xf0, 0x24, 0x10, 0x01, on, WASHER_UNIT]))
        } else if (prop === 'dryer/remote_maintain') {
            const on = value === 'ON' ? 0x01 : 0x00
            this.send(Buffer.from([0xf0, 0x24, 0x10, 0x01, on, DRYER_UNIT]))
        } else if (prop === 'shared/init_lcd') {
            const idx = INIT_LCD_THEMES.unmap(value)
            if (idx !== undefined) {
                this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, WASHER_UNIT, 0x01, 0x51, idx]))
            }
        }
    }

    processAABB(buf: Buffer) {
        // Known header structure (common to all packet types):
        //   [0..2]  = 36 0a 00  (fixed prefix)
        //   [3]     = message type discriminator
        //   [4]     = 00        (unknown)
        //   [5]     = unknown
        //   [6]     = sequence counter
        //   [7..12] = unknown

        //
        // Strip the common 13-byte header and what appears to be an extra trailing byte all on messages that changes
        // if the contents of the rest of the payload has any changes (seemingly deterministically based on the data collected so far).
        //
        // It could possibly be an extra checksum but the exact algorithm is yet to be identitifed,
        // or it could be a non-obvious extra state/sensor.
        //
        const body = buf.subarray(FIXED_HEADER_LENGTH, buf.length - 1)

        switch (buf[3]) {
            case 0x42:
                return this.processWasherUpdate(body)
            case 0x4e:
                return this.processDryerUpdate(body)
            case 0x71:
                return this.processStateResync(body)
            case 0xd0:
                return this.processStatusUpdate(body)
        }
    }

    // 0x71: state resync (triggered by start()); body = state_block(95)
    // Door state is NOT present here, only reported via 0x42/0x4e delta events.
    private processStateResync(buf: Buffer) {
        if (buf.length !== STATE_BLOCK_LENGTH) return
        this.processStateBlock(buf)
    }

    // 0x42: washer door delta event; body = 48 bytes (62 total - 13 header - 1 trailing)
    private processWasherUpdate(buf: Buffer) {
        if (buf.length !== 48) return
        this.publishProperty('washer/door', buf[5] ? DOOR_CLOSE : DOOR_OPEN) // inverse of dryer
    }

    // 0x4e: dryer door delta event; body = 60 bytes (74 total - 13 header - 1 trailing)
    private processDryerUpdate(buf: Buffer) {
        if (buf.length !== 60) return
        this.publishProperty('dryer/door', buf[16] ? DOOR_OPEN : DOOR_CLOSE)
    }

    // 0xd0: status update; body = old_state_block(95) + new_state_block(95)
    private processStatusUpdate(buf: Buffer) {
        if (buf.length !== STATE_BLOCK_LENGTH * 2) return
        this.processStateBlock(buf.subarray(STATE_BLOCK_LENGTH))
    }

    //
    // Shared state block decoder (95 bytes). Used by both 0xd0 (status update) and 0x71 (state resync).
    // Below is the current, work in progress, understanding of the protocol.
    //
    // Washer section (block bytes 0–52)
    // [0]=? maybe:overallProtocolVersion [1]=constant(0x32) [2]=? maybe:washerProtocolVersion [3]=soilWash
    // [4]=temp [5]=rinse [6]=spin [7]=course [8]=dryLevel [9]=soak [10]=washTime
    // [11]=waterLevel [12]=loadItemWasher [13:14]=reserveTimeMinute [15:16]=remainTimeMinute
    // [17:18]=initialTimeMinute [19:20]=courseSpendPower(uint16) [21]=error
    // [22]=baseDownloadCourseData [23]=state [24]=preState [25]=downloadCourse
    // [26]=loadLevel [27:28]=courseSpendWater(uint16) [29]=rinseCount [30]=TCLCount
    // [31]=buzzer [32]=ezCSDetergentSetVal [33]=ezCSSoftenerSetVal [34]=ezDetergentAmount
    // [35]=ezSoftenerAmount
    // [36]=bitmask(autoSoak[7]/preWash[6]/turboWash[5]/timeSave[4]/intensive[3]/coldWash[2]/multiStain[1]/waterPlus[0])
    // [37]=bitmask(medicRinse[7]/rinseHold[6]/rinseSpin[5]/steam[4]/sterilize[3]/fabricSoftener[2]/steamSoftener[1]/ecoHybrid[0])
    // [38]=bitmask(creaseCare[7]/freshCare[6]/wrinkleCare[5]/saveEnergy[4]/warmWater[3]/smartCare_onOff[2]/favorite[1]/smartGridEnable[0])
    // [39]=bitmask(addGarment[7]/drumLight[6]/childLock[5]/remoteStart[4]/activeStandby[3]/voiceState[2]/wifiSDS[1]/?[0])
    // [40]=bitmask(standby[7]/speechRecognitionMode[6]/washLoadDisplay[5]/autoDetection[4:3]/rinseDefault[2]/coolDown[1]/doorLock[0])
    // [41]=bitmask(delay[7]/extraRinse[6]/audibleSDS[5]/smallUE[4]/ezDispenseDrawerState[3]/ezDispenseNotation[2]/ezDetergentState[1]/ezSoftenerState[0])
    // [42]=bitmask(dryReady_state[7]/?[6]/applyRemoteMaintain[5]/applyBuzzer[4]/autoCourseArrange[3]/remoteMaintain[2]/dnnReady[1]/AIDDLed[0])
    // [43]=laundryTexture [44]=cloudCourse [45]=masterCard [46]=?
    // [47]=endMelody [48]=initLCD
    // [49]=bitmask(currentTimeDisplay[7]/softenerNozzleCleaning[6]/detergentNozzleCleaning[5]/noti_OverSudsing[4]/laundryCare[3]/applyLaundryCollection[2]/addScent[1]/aquaReserve[0])
    // [50]=ezDispenseType
    // [51]=bitmask(noti3MinEnd[7]/?[6]/?[5]/ezDetergentSelect[4]/isPowerCableOff[3]/currentDateDisplay[2]/currentDisplay_12_24[1]/endReserveTime[0])
    // [52]=?
    //
    // Dryer section (block bytes 53–94)
    // [53]=? maybe:dryerProtocolVersion [54]=dryLevel [55]=ecoHybrid(enum:0=none/1=ECO/2=NORMAL) [56]=temp [57]=timeDry [58]=course
    // [59]=?(silent) [60:61]=reserveTimeMinute(uint16) [62:63]=remainTimeMinute(uint16)
    // [64:65]=initialTimeMinute(uint16) [66]=state [67]=preState [68]=error [69]=?(silent)
    // [70:71]=courseSpendPower(uint16) [72]=buzzer(enum:0=OFF/1=BUZZER_1/4=BUZZER_4) [73]=baseDownloadCourseData
    // [74]=loadItem(enum:0=none/1=LOADITEM_1/2=LOADITEM_2/4=LOADITEM_4) [75]=ductClogging(enum:0=none/1=LEVEL_1/2=LEVEL_2)
    // [76]=downloadCourse(course-ID enum) [77-81]=bitmasks (see below)
    // [77]=bitmask(handIron[7]/dampDryBeep[6]/drumLight[5]/favorite[4]/wrinkleCare[3]/dnnReady[2]/reduceStatic[1]/?[0])
    // [78]=bitmask(energySaver[7]/energySaverDefault[6]/turboSteam[5]/smartGridEnable[4]/ductSensingOnOff[3]/steam[2]/AIDDLed[1]/?[0])
    // [79]=bitmask(smartPairing[7]/remoteStart[6]/selfCleaning[5]/childLock[4]/reservation[3]/detectLoad[2]/standby[1]/doorLock[0])
    // [80]=bitmask(wifiConnected[7]/wifiSetting[6]/voiceState[5]/addItem[4]/?[3]/smartCare_onOff[2]/remoteMaintain[1]/autoCourseArrange[0])
    // [81]=bitmask(currentDateDisplay[7]/currentDisplay_12_24[6]/currentTimeDisplay[5]/laundryCare[4]/BLEOnOff[3]/applyLaundryCollection[2]/applyRemoteMaintain[1]/applyBuzzer[0])
    // [82]=setDownloadedCourse(course-ID enum, same shape as [76]) [83]=masterCard [84]=cloudCourse [85]=endMelody [86]=initLCD
    // [87]=drylevelSubDamp [88]=drylevelSubLess [89]=drylevelSubIron [90]=drylevelSubCup
    // [91]=drylevelSubVery [92:93]=moreLessTime(uint16)
    // [94]=bitmask(ushLaundryCareSettingOnOff[5]/drumlightOpt[4]/drumlightAutoOn[3]/noti3MinEnd[2]/isPowerCableOff[1]/endReserveTime[0])
    //
    private processStateBlock(block: Buffer) {
        if (block.length != STATE_BLOCK_LENGTH) return

        this.publishProperty('washer/soil_wash', WASHER_SOIL_WASH.map(block[3]))
        this.publishProperty('washer/temp', WASHER_TEMPS.map(block[4]))
        this.publishProperty('washer/rinse', WASHER_RINSE.map(block[5]))
        this.publishProperty('washer/spin', WASHER_SPIN.map(block[6]))
        this.publishProperty('washer/course', WASHER_COURSES.map(block[7]))
        this.publishProperty('washer/soak', WASHER_SOAK.map(block[9]))
        this.publishProperty('washer/water_level', WASHER_WATER_LEVEL.map(block[11]))
        this.publishProperty('washer/load_item', WASHER_LOAD_ITEM.map(block[12]))
        this.publishProperty('washer/reserve_time', block.readUInt16BE(13))
        this.publishProperty('washer/remaining_time', block.readUInt16BE(15))
        this.publishProperty('washer/initial_time', block.readUInt16BE(17))
        this.publishProperty('washer/energy', block.readUInt16BE(19))
        this.publishProperty('washer/load_level', WASHER_LOAD_LEVEL.map(block[26]))
        this.publishProperty('washer/rinse_count', WASHER_RINSE_COUNT.map(block[29]))
        this.publishProperty('washer/laundry_texture', block[43]) // Reported as integer value

        //
        // Both washer and dryer have an init_lcd, and the command appears to support per-device config
        // but in real world testing it doesnt appear possible for them to have different values.
        // Use the washer's as the source of truth.
        //
        this.publishProperty('shared/init_lcd', INIT_LCD_THEMES.map(block[48]))

        const washerState = block[23]
        this.publishProperty('washer/power', washerState !== 0 ? 'ON' : 'OFF')
        this.publishProperty('washer/state', WASHER_STATES.map(washerState))
        this.publishProperty('washer/error', WASHER_ERRORS.map(block[21]))
        this.publishProperty('washer/buzzer', DEVICE_BUZZER.map(block[31]))
        this.publishProperty('washer/add_garment', block[39] & 0x80 ? 'ON' : 'OFF')
        this.publishProperty('washer/child_lock', block[39] & 0x20 ? 'ON' : 'OFF')
        this.publishProperty('washer/remote_start', block[39] & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('washer/door_lock', block[40] & 0x01 ? 'ON' : 'OFF')
        // TODO: Determine how detergent/softner state work when ezDispense is configured to use both as detergent
        // this.publishProperty('washer/detergent_state', block[41] & 0x02 ? 'FULL' : 'EMPTY')
        // this.publishProperty('washer/softener_state', block[41] & 0x01 ? 'FULL' : 'EMPTY')
        this.publishProperty('washer/remote_maintain', block[42] & 0x04 ? 'ON' : 'OFF')

        this.publishProperty('dryer/dry_level', DRYER_DRY_LEVELS.map(block[54]))
        this.publishProperty('dryer/temp', DRYER_TEMP.map(block[56]))
        this.publishProperty('dryer/time_dry', DRYER_TIME_DRY.map(block[57]))
        this.publishProperty('dryer/course', DRYER_COURSES.map(block[58]))
        this.publishProperty('dryer/reserve_time', block.readUInt16BE(60))
        this.publishProperty('dryer/remaining_time', block.readUInt16BE(62))
        this.publishProperty('dryer/initial_time', block.readUInt16BE(64))

        const dryerState = block[66]
        this.publishProperty('dryer/power', dryerState !== 0 ? 'ON' : 'OFF')
        this.publishProperty('dryer/state', DRYER_STATES.map(dryerState))
        this.publishProperty('dryer/error', DRYER_ERRORS.map(block[68]))
        this.publishProperty('dryer/buzzer', DEVICE_BUZZER.map(block[72]))
        this.publishProperty('dryer/duct_clogging', DRYER_DUCT_CLOGGING.map(block[75]))
        this.publishProperty('dryer/remote_start', block[79] & 0x40 ? 'ON' : 'OFF')
        this.publishProperty('dryer/child_lock', block[79] & 0x10 ? 'ON' : 'OFF')
        this.publishProperty('dryer/remote_maintain', block[80] & 0x02 ? 'ON' : 'OFF')
    }
}
