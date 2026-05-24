import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// ─── Lookup tables ─────────────────────────────────────────────────────────────
// All indices sourced from official modelJson MonitoringValue unless noted.

// Bd[0] — run state
const STATES: Record<number, string> = {
    0: 'Off',
    1: 'Initial',
    2: 'Running',
    3: 'Paused',
    4: 'End',
    5: 'Error',
    8: 'Smart Diagnosis',
    100: 'Reserved',
}

// Bd[5] — cycle/programme ID
// Indices from packet captures; names from modelJson Cycle.cycleValue
const CYCLES: Record<number, string> = {
    0x02: 'Towels',
    0x04: 'Duvet', // BULKYITEM
    0x05: 'Easy Care', // EASYCARE
    0x06: 'Mixed Fabric', // MIXFABRIC ✓ confirmed via API snapshot
    0x07: 'Cotton', // COTTONNORMAL
    0x08: 'Sports Wear', // SPORTWEAR
    0x09: 'Speed 30', // QUICKDRY
    0x0a: 'Delicates', // DELICATES
    0x0b: 'Wool', // WOOL
    0x0c: 'Rack Dry', // RACKDRY
    0x0e: 'Warm Air', // WARMAIR
    0x10: 'Allergy Care', // ALLERGYCARE
    0x12: 'Condenser Care', // CONDENSER_CARE
    0x13: 'Drum Care', // TUB_CLEAN
    0x19: 'Eco (Cotton+)', // COTTONPLUS
}

// Inverse cycle lookup for commands
const CYCLE_IDS: Record<string, number> = Object.fromEntries(Object.entries(CYCLES).map(([k, v]) => [v, Number(k)]))

// Bd[7] — dry level (modelJson dryLevel.valueMapping indices)
const DRY_LEVELS: Record<number, string> = {
    0: 'None',
    1: 'Iron Dry', // DRYLEVEL_IRON ✓
    3: 'Cupboard Dry', // DRYLEVEL_CUPBOARD ✓ confirmed via API snapshot
    4: 'Extra Dry', // DRYLEVEL_EXTRA ✓
}
const DRY_LEVEL_IDS: Record<string, number> = Object.fromEntries(
    Object.entries(DRY_LEVELS).map(([k, v]) => [v, Number(k)]),
)

// Bd[8] — eco hybrid (modelJson ecoHybrid.valueMapping indices)
const ECO_HYBRID: Record<number, string> = {
    0: 'None',
    1: 'Energy', // ECOHYBRID_ECO ✓
    2: 'Normal', // ECOHYBRID_NORMAL
    3: 'Time', // ECOHYBRID_TURBO ✓ confirmed via API snapshot
}
const ECO_HYBRID_IDS: Record<string, number> = Object.fromEntries(
    Object.entries(ECO_HYBRID).map(([k, v]) => [v, Number(k)]),
)

// Bd[9] — process state (modelJson processState.valueMapping indices)
const PROCESS_STATES: Record<number, string> = {
    0: 'Detecting',
    1: 'Steam',
    2: 'Dry', // DRY_LV1 ✓ confirmed via API snapshot
    3: 'Dry', // DRY_LV2
    4: 'Dry', // DRY_LV3
    5: 'Cooling',
    6: 'Anti-crease',
    7: 'End',
}

// Bd[6] — error code (modelJson error.valueMapping indices)
const ERRORS: Record<number, string> = {
    0: '-',
    1: 'TE1 (temperature)',
    2: 'TE2 (temperature)',
    4: 'TE4 (temperature)',
    7: 'CE1 (communication)',
    13: 'OE (drain motor)',
    14: 'Empty water tank',
    15: 'dE (door open)', // ✓ confirmed 0x0f=15
    17: 'No filter',
    19: 'F1',
    20: 'LE2 (motor)',
    21: 'AE',
    30: 'LE1 (motor)',
    37: 'DE4 (door)',
    42: 'DE2 (door lock)',
}

// Reservation hours for delayed end
// modelJson: reserveTimeHour min=3, max=19 (0=off, 1 and 2 are invalid)
const RESERVATION: Record<number, string> = {
    0: 'Off',
    3: '3h',
    4: '4h',
    5: '5h',
    6: '6h',
    7: '7h',
    8: '8h',
    9: '9h',
    10: '10h',
    11: '11h',
    12: '12h',
    13: '13h',
    14: '14h',
    15: '15h',
    16: '16h',
    17: '17h',
    18: '18h',
    19: '19h',
}
const RESERVATION_IDS: Record<string, number> = Object.fromEntries(
    Object.entries(RESERVATION).map(([k, v]) => [v, Number(k)]),
)

// Flag bits
const FLAG14_ANTI_CREASE = 0x02 // Bd[14] ✓
const FLAG15_REMOTE_START = 0x01 // Bd[15] ✓

// Safety Lock — gates both Power On and Remote Start commands.
// Both are potentially dangerous without someone present at the machine.
// Must be re-acknowledged each session.
const SAFETY_LOCK_ENABLED = 'Enabled'
const SAFETY_LOCK_DISABLED =
    'Disabled (I accept the safety/fire risk, not recommended, use with caution, see docs for details)'

// Bd[20] — downloaded/smart cycle ID
// Each entry carries the schema from modelJson SmartCourse so defaults are correct.
// Wire IDs marked 0x?? are not yet captured — uncomment and add the ID when known.
// To find an ID: start the cycle, check the `downloaded_cycle_id` diagnostic sensor.

type DownloadedCycle = {
    name: string // modelJson courseValue
    label: string // human-friendly display name
    baseId: number | null // base course wire ID (Bd[5])
    defaultDryLevel: number
    defaultEcoHybrid: number
    defaultTime: number // minutes
}

const DOWNLOADED_CYCLES: Record<number, DownloadedCycle> = {
    // ── Confirmed wire IDs ────────────────────────────────────────────────────
    0x66: {
        name: 'GYMCLOTHES',
        label: 'Gym Clothes',
        baseId: 0x08,
        defaultDryLevel: 0,
        defaultEcoHybrid: 1,
        defaultTime: 60,
    },
    0x6b: {
        name: 'DEODORIZATION',
        label: 'Deodorization',
        baseId: null,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 39,
    },

    // ── Wire ID unknown — uncomment and fill in 0x?? when captured ────────────
    // 0x??: { name: 'SHOESFABRICDOLL',  label: 'Shoes / Fabric Doll',  baseId: 0x0c, defaultDryLevel: 0, defaultEcoHybrid: 1, defaultTime: 180 },
    // 0x??: { name: 'BABYWEAR',         label: 'Baby Wear',             baseId: 0x02, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 130 },
    // 0x??: { name: 'BLANKET',          label: 'Blanket',               baseId: 0x04, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 165 },
    // 0x??: { name: 'BLANKETREFRESH',   label: 'Blanket Refresh',       baseId: null, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 30  },
    // 0x??: { name: 'SINGLEGARMENTS',   label: 'Single Garments',       baseId: 0x0e, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 40  },
    // 0x??: { name: 'LINGERIE',         label: 'Lingerie',              baseId: 0x0a, defaultDryLevel: 0, defaultEcoHybrid: 1, defaultTime: 50  },
    // 0x??: { name: 'RAINYSEASON',      label: 'Rainy Season',          baseId: 0x0e, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 30  },
    // 0x??: { name: 'SMALLLOAD',        label: 'Small Load',            baseId: 0x0e, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 50  },
    // 0x??: { name: 'EASYIRON',         label: 'Easy Iron',             baseId: 0x19, defaultDryLevel: 1, defaultEcoHybrid: 1, defaultTime: 110 },
    // 0x??: { name: 'SUPERDRY',         label: 'Super Dry',             baseId: 0x19, defaultDryLevel: 4, defaultEcoHybrid: 3, defaultTime: 160 },
    // 0x??: { name: 'ECONOMICDRY',      label: 'Economic Dry',          baseId: 0x19, defaultDryLevel: 3, defaultEcoHybrid: 1, defaultTime: 150 },
    // 0x??: { name: 'BIGSIZEITEM',      label: 'Big Size Item',         baseId: 0x04, defaultDryLevel: 0, defaultEcoHybrid: 3, defaultTime: 165 },
    // 0x??: { name: 'MINIMIZEWRINKLES', label: 'Minimize Wrinkles',     baseId: 0x19, defaultDryLevel: 3, defaultEcoHybrid: 3, defaultTime: 130 },
    // 0x??: { name: 'FULLSIZELOAD',     label: 'Full Size Load',        baseId: 0x19, defaultDryLevel: 4, defaultEcoHybrid: 3, defaultTime: 160 },
}

// ─── Per-cycle schema ──────────────────────────────────────────────────────────
// Derived from modelJson Course.function — defines which dry levels and eco hybrid
// modes are valid per cycle, plus the defaults to apply when a cycle is selected.

type CycleSchema = {
    dryLevels: number[] // valid dry level indices (empty = only None supported)
    ecoHybrids: number[] // valid eco hybrid indices
    defaultDryLevel: number
    defaultEcoHybrid: number
}

const CYCLE_SCHEMA: Record<number, CycleSchema> = {
    0x02: { dryLevels: [], ecoHybrids: [3], defaultDryLevel: 0, defaultEcoHybrid: 3 }, // Towels
    0x04: { dryLevels: [], ecoHybrids: [3], defaultDryLevel: 0, defaultEcoHybrid: 3 }, // Duvet
    0x05: { dryLevels: [1, 3], ecoHybrids: [1, 3], defaultDryLevel: 3, defaultEcoHybrid: 3 }, // Easy Care
    0x06: { dryLevels: [1, 3, 4], ecoHybrids: [1, 3], defaultDryLevel: 3, defaultEcoHybrid: 3 }, // Mixed Fabric
    0x07: { dryLevels: [1, 3, 4], ecoHybrids: [3], defaultDryLevel: 3, defaultEcoHybrid: 3 }, // Cotton
    0x08: { dryLevels: [], ecoHybrids: [1], defaultDryLevel: 0, defaultEcoHybrid: 1 }, // Sports Wear
    0x09: { dryLevels: [], ecoHybrids: [3], defaultDryLevel: 0, defaultEcoHybrid: 3 }, // Speed 30
    0x0a: { dryLevels: [], ecoHybrids: [1], defaultDryLevel: 0, defaultEcoHybrid: 1 }, // Delicates
    0x0b: { dryLevels: [], ecoHybrids: [1], defaultDryLevel: 0, defaultEcoHybrid: 1 }, // Wool
    0x0c: { dryLevels: [], ecoHybrids: [1], defaultDryLevel: 0, defaultEcoHybrid: 1 }, // Rack Dry
    0x0e: { dryLevels: [], ecoHybrids: [1, 3], defaultDryLevel: 0, defaultEcoHybrid: 1 }, // Warm Air
    0x10: { dryLevels: [], ecoHybrids: [3], defaultDryLevel: 0, defaultEcoHybrid: 3 }, // Allergy Care
    0x12: { dryLevels: [], ecoHybrids: [3], defaultDryLevel: 0, defaultEcoHybrid: 3 }, // Condenser Care
    0x13: { dryLevels: [], ecoHybrids: [3], defaultDryLevel: 0, defaultEcoHybrid: 3 }, // Drum Care
    0x19: { dryLevels: [1, 3, 4], ecoHybrids: [1, 3], defaultDryLevel: 3, defaultEcoHybrid: 1 }, // Eco (Cotton+)
}

// ─── Device class ──────────────────────────────────────────────────────────────

export default class Device extends AABBDevice {
    // Pending command state — populated by selector changes, sent on start
    private selectedCycle: number | null = null
    private selectedDryLevel: number = 0 // NO_DRYLEVEL
    private selectedEcoHybrid: number = 0 // NO_ECOHYBRID
    private selectedAntiCrease: boolean = false
    private selectedReservation: number = 0 // Off

    // Safety lock — gates Power On and Remote Start, resets each session
    private safetyLockDisabled: boolean = false

    // Debounce: suppress state-packet selector updates briefly after user edits
    private selectorLockUntil: Record<string, number> = {}
    private readonly SELECTOR_LOCK_MS = 10000

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    // ── Safety Lock ──────────────────────────────────────────
                    // Gates Power On and Remote Start — both can operate the dryer
                    // without anyone present. Matches the physical Safety Lock button
                    // on the machine. Resets to Enabled each session.
                    safety_lock: {
                        platform: 'select',
                        unique_id: '$deviceid-safety-lock',
                        state_topic: '$this/safety_lock',
                        command_topic: '$this/safety_lock/set',
                        name: '🔒 Safety Lock',
                        icon: 'mdi:lock-alert-outline',
                        options: [SAFETY_LOCK_ENABLED, SAFETY_LOCK_DISABLED],
                        entity_category: 'config',
                    },
                    // Power ON — works at wire level but rejected by LG cloud.
                    // Gated behind Safety Lock.
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:tumble-dryer',
                    },
                    // Remote Start — read-only status indicator
                    // Reflects whether the machine has remote start armed physically
                    // Cannot be armed remotely — must be done on the machine
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote-start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        icon: 'mdi:remote',
                    },

                    // ── Cycle controls ───────────────────────────────────────
                    cycle: {
                        platform: 'select',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        command_topic: '$this/cycle/set',
                        name: 'Cycle',
                        icon: 'mdi:pin-outline',
                        options: Object.values(CYCLES),
                        optimistic: false,
                    },
                    dry_level: {
                        platform: 'select',
                        unique_id: '$deviceid-dry-level',
                        state_topic: '$this/dry_level',
                        command_topic: '$this/dry_level/set',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        options: Object.values(DRY_LEVELS),
                        optimistic: false,
                    },
                    eco_hybrid: {
                        platform: 'select',
                        unique_id: '$deviceid-eco-hybrid',
                        state_topic: '$this/eco_hybrid',
                        command_topic: '$this/eco_hybrid/set',
                        name: 'Eco hybrid',
                        icon: 'mdi:leaf',
                        options: Object.values(ECO_HYBRID),
                        optimistic: false,
                    },
                    anti_crease: {
                        platform: 'switch',
                        unique_id: '$deviceid-anti-crease',
                        state_topic: '$this/anti_crease',
                        command_topic: '$this/anti_crease/set',
                        name: 'Anti-crease',
                        icon: 'mdi:iron-outline',
                        optimistic: false,
                    },
                    reservation: {
                        platform: 'select',
                        unique_id: '$deviceid-reservation',
                        state_topic: '$this/reservation',
                        command_topic: '$this/reservation/set',
                        name: 'Delayed end',
                        icon: 'mdi:clock-end',
                        options: Object.values(RESERVATION),
                        optimistic: false,
                    },

                    // ── Actions ──────────────────────────────────────────────
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },

                    // ── Status sensors ───────────────────────────────────────
                    run_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-run-state',
                        state_topic: '$this/run_state',
                        name: 'Run state',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: [...new Set(Object.values(STATES))],
                    },
                    process_state: {
                        platform: 'sensor',
                        unique_id: '$deviceid-process-state',
                        state_topic: '$this/process_state',
                        name: 'Process state',
                        icon: 'mdi:cog-outline',
                        device_class: 'enum',
                        options: [...new Set(Object.values(PROCESS_STATES))],
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial-time',
                        state_topic: '$this/initial_time',
                        name: 'Initial time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    run_completed: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-run-completed',
                        state_topic: '$this/run_completed',
                        name: 'Run completed',
                        icon: 'mdi:check-circle-outline',
                    },
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error state',
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
                        entity_category: 'diagnostic',
                    },
                    downloaded_cycle_id: {
                        platform: 'sensor',
                        unique_id: '$deviceid-downloaded-cycle-id',
                        state_topic: '$this/downloaded_cycle_id',
                        name: 'Downloaded cycle ID',
                        icon: 'mdi:download-circle-outline',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )

        // Safety lock always starts enabled — resets each session
        this.publishProperty('safety_lock', SAFETY_LOCK_ENABLED)

        // Reservation starts at Off
        this.publishProperty('reservation', 'Off')
    }

    // ── Selector lock helpers ─────────────────────────────────────────────────

    private lockSelector(prop: string) {
        this.selectorLockUntil[prop] = Date.now() + this.SELECTOR_LOCK_MS
    }

    private isSelectorLocked(prop: string): boolean {
        return Date.now() < (this.selectorLockUntil[prop] ?? 0)
    }

    // ── Dynamic options update ────────────────────────────────────────────────

    // When cycle changes, update dry_level and eco_hybrid selector options
    // to only show valid options for that cycle, reset to defaults, republish
    // config, then immediately re-publish state values to prevent "unknown" flash.
    private updateCycleOptions(cycleId: number) {
        const schema = CYCLE_SCHEMA[cycleId]
        if (!schema || !this.config) return

        const dryOptions = schema.dryLevels.length > 0 ? schema.dryLevels.map((id) => DRY_LEVELS[id]) : [DRY_LEVELS[0]] // None only — selector will be hidden via availability

        const ecoOptions = schema.ecoHybrids.map((id) => ECO_HYBRID[id])

        // Mutate config in place and republish
        ;(this.config.components.dry_level as any).options = dryOptions
        ;(this.config.components.eco_hybrid as any).options = ecoOptions

        // Apply defaults for this cycle
        this.selectedDryLevel = schema.defaultDryLevel
        this.selectedEcoHybrid = schema.defaultEcoHybrid

        // Republish full device config with updated options
        this.publishConfig()

        // Re-publish current values immediately to prevent "unknown" flash
        this.publishProperty('dry_level', DRY_LEVELS[this.selectedDryLevel] ?? 'None')
        this.publishProperty('eco_hybrid', ECO_HYBRID[this.selectedEcoHybrid] ?? 'None')
    }

    // ── State packet processing ───────────────────────────────────────────────

    processAABB(buf: Buffer) {
        // Packet: AA + len + inner(56) + chk + BB
        // inner: header(4: 30 EC 00 19) + A block(26) + B block(26)
        // B block: B[0]=0x19 marker, Bd=B[1..25] = current state (authoritative)
        //
        // Confirmed Bd field map (modelJson indices unless noted):
        //   [0]  run state
        //   [1]  remain hours
        //   [2]  remain minutes
        //   [3]  initial hours
        //   [4]  initial minutes
        //   [5]  cycle ID
        //   [6]  error code
        //   [7]  dry level
        //   [8]  eco hybrid
        //   [9]  process state
        //   [10]  reservation hours (0=off, 3-19=delayed end)
        //   [11-13] unknown
        //   [14] flags: bit 0x02=anti-crease
        //   [15] flags: bit 0x01=remote-start
        //   [16-19] unknown/counter
        //   [20] downloaded/smart cycle ID (0=none, see DOWNLOADED_CYCLES)
        //   [21-24] unknown/marker

        if (buf.length !== 56 || buf[0] !== 0x30 || buf[1] !== 0xec) return

        const Bd = buf.subarray(31) // 25 bytes after 0x19 marker

        const state = Bd[0]
        const remainHr = Bd[1]
        const remainMin = Bd[2]
        const initialHr = Bd[3]
        const initialMin = Bd[4]
        const cycle = Bd[5]
        const errorCode = Bd[6]
        const dryLevel = Bd[7]
        const ecoHybrid = Bd[8]
        const processState = Bd[9]
        const reservation = Bd[10] // reservation hours (0=off, 3-19=delayed end)
        const flags14 = Bd[14]
        const flags15 = Bd[15]
        const downloadedCycleId = Bd[20] // SmartCourse/downloaded cycle ID (0=none)

        const remainingTime = remainHr * 60 + remainMin
        const initialTime = initialHr * 60 + initialMin

        const isOff = state === 0
        const isEnd = state === 4
        const hasError = errorCode !== 0
        const remoteStart = !!(flags15 & FLAG15_REMOTE_START)
        const antiCrease = !!(flags14 & FLAG14_ANTI_CREASE)

        // Sync pending command state from machine — respects selector lock
        // so in-progress HA edits aren't clobbered by incoming state packets.
        // When cycle changes from the machine side, also update options.
        if (!this.isSelectorLocked('cycle') && cycle !== 0) {
            if (this.selectedCycle !== cycle) {
                this.selectedCycle = cycle
                this.updateCycleOptions(cycle)
            }
        }

        // Sync dry level and eco hybrid from packet, but apply schema defaults
        // if the packet reports None/0 for a field the cycle actually supports.
        // This handles the case where the machine is in standby with a cycle selected
        // but hasn't set the options yet, or reports 0 before user interaction.
        const schema = this.selectedCycle !== null ? CYCLE_SCHEMA[this.selectedCycle] : null
        if (!this.isSelectorLocked('dry_level')) {
            let effectiveDryLevel: number
            if (!schema || schema.dryLevels.length === 0) {
                effectiveDryLevel = 0 // cycle has no dry level support — always None
            } else if (schema.dryLevels.includes(dryLevel)) {
                effectiveDryLevel = dryLevel // valid for this cycle
            } else {
                effectiveDryLevel = schema.defaultDryLevel // stale/invalid — use default
            }
            this.selectedDryLevel = effectiveDryLevel
        }
        if (!this.isSelectorLocked('eco_hybrid')) {
            let effectiveEcoHybrid: number
            if (!schema || schema.ecoHybrids.length === 0) {
                effectiveEcoHybrid = 0 // no eco hybrid support
            } else if (schema.ecoHybrids.includes(ecoHybrid)) {
                effectiveEcoHybrid = ecoHybrid // valid for this cycle
            } else {
                effectiveEcoHybrid = schema.defaultEcoHybrid // stale/invalid — use default
            }
            this.selectedEcoHybrid = effectiveEcoHybrid
        }
        if (!this.isSelectorLocked('anti_crease')) this.selectedAntiCrease = antiCrease
        if (!this.isSelectorLocked('reservation')) this.selectedReservation = reservation

        // Publish status sensors
        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('run_state', STATES[state] ?? `unknown (${state})`)
        this.publishProperty('process_state', PROCESS_STATES[processState] ?? `unknown (${processState})`)
        this.publishProperty('remaining_time', remainingTime)
        this.publishProperty('initial_time', initialTime)
        this.publishProperty('remote_start', remoteStart ? 'ON' : 'OFF')
        this.publishProperty('run_completed', isEnd ? 'ON' : 'OFF')
        this.publishProperty('error', hasError ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS[errorCode] ?? `unknown (0x${errorCode.toString(16)})`)

        // Publish selectors (only if not locked by a recent user edit)
        if (!this.isSelectorLocked('cycle')) {
            // If a downloaded SmartCourse is active, show its name instead of the base cycle
            const cycleName =
                downloadedCycleId && DOWNLOADED_CYCLES[downloadedCycleId]
                    ? DOWNLOADED_CYCLES[downloadedCycleId].label
                    : (CYCLES[cycle] ?? `unknown (0x${cycle.toString(16)})`)
            this.publishProperty('cycle', cycleName)
        }
        this.publishProperty('downloaded_cycle_id', downloadedCycleId ? `0x${downloadedCycleId.toString(16)}` : '-')
        if (!this.isSelectorLocked('dry_level')) {
            this.publishProperty('dry_level', DRY_LEVELS[this.selectedDryLevel] ?? `unknown (${this.selectedDryLevel})`)
        }
        if (!this.isSelectorLocked('eco_hybrid')) {
            this.publishProperty(
                'eco_hybrid',
                ECO_HYBRID[this.selectedEcoHybrid] ?? `unknown (${this.selectedEcoHybrid})`,
            )
        }
        if (!this.isSelectorLocked('anti_crease')) {
            this.publishProperty('anti_crease', antiCrease ? 'ON' : 'OFF')
        }
        if (!this.isSelectorLocked('reservation')) {
            this.publishProperty('reservation', RESERVATION[reservation] ?? 'Off')
        }
    }

    // ── Command builder ───────────────────────────────────────────────────────

    private buildStartCommand(): Buffer | null {
        if (this.selectedCycle === null) {
            console.warn('[RH90V9] Start ignored: no cycle selected')
            return null
        }

        // Enforce per-cycle schema at send time — safety net for raw JSON commands
        // or any case where selectors get out of sync with the schema.
        // Also handles downloaded cycles which have their own defaults.
        const schema = CYCLE_SCHEMA[this.selectedCycle]
        let dryLevel = this.selectedDryLevel
        let ecoHybrid = this.selectedEcoHybrid
        if (schema) {
            if (schema.dryLevels.length > 0 && !schema.dryLevels.includes(dryLevel)) {
                console.warn(
                    `[RH90V9] dry_level ${DRY_LEVELS[dryLevel]} invalid for ${CYCLES[this.selectedCycle]}, using default`,
                )
                dryLevel = schema.defaultDryLevel
            }
            if (!schema.ecoHybrids.includes(ecoHybrid)) {
                console.warn(
                    `[RH90V9] eco_hybrid ${ECO_HYBRID[ecoHybrid]} invalid for ${CYCLES[this.selectedCycle]}, using default`,
                )
                ecoHybrid = schema.defaultEcoHybrid
            }
        }

        // inner layout (confirmed from captures):
        // [0-1]  = F0 26 opcode
        // [2]    = cycle ID
        // [3]    = dry level
        // [4]    = eco hybrid
        // [8]    = reservation hours (0=off, 3-19=delayed end)
        // [11]   = anti-crease (0x00=off, 0x02=on)
        // [12]   = operation (0x03=start, 0x01=resume/update)
        // [14]   = SmartCourse ID (0x00 for base courses)
        const inner = Buffer.alloc(16, 0)
        inner[0] = 0xf0
        inner[1] = 0x26
        inner[2] = this.selectedCycle
        inner[3] = dryLevel
        inner[4] = ecoHybrid
        inner[8] = this.selectedReservation
        inner[11] = this.selectedAntiCrease ? 0x02 : 0x00
        inner[12] = 0x03 // start new cycle
        return inner
    }

    // ── HA command handler ────────────────────────────────────────────────────

    setProperty(prop: string, mqttValue: string) {
        // Safety lock
        if (prop === 'safety_lock') {
            this.safetyLockDisabled = mqttValue === SAFETY_LOCK_DISABLED
            this.publishProperty('safety_lock', mqttValue)
            return
        }

        // Power ON — gated behind safety lock
        // Wire-level confirmed working (aa08f02a010098bb)
        // Rejected by LG cloud: "Not support dryer_operation_mode: POWER_ON"
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                if (!this.safetyLockDisabled) {
                    console.warn('[RH90V9] Power on blocked — disable Safety Lock first')
                    this.publishProperty('power', 'OFF')
                    return
                }
                this.send(Buffer.from('F02A0100', 'hex'))
            } else if (mqttValue === 'OFF') {
                // Confirmed: aa09f0240101009cbb
                this.send(Buffer.from('F024010100', 'hex'))
            }
            return
        }

        // Cycle — also triggers dynamic options update for dry_level and eco_hybrid
        if (prop === 'cycle') {
            const id = CYCLE_IDS[mqttValue]
            if (id !== undefined) {
                this.selectedCycle = id
                this.lockSelector('cycle')
                this.lockSelector('dry_level')
                this.lockSelector('eco_hybrid')
                this.publishProperty('cycle', mqttValue)
                this.updateCycleOptions(id)
            }
            return
        }

        if (prop === 'dry_level') {
            const id = DRY_LEVEL_IDS[mqttValue]
            if (id !== undefined) {
                this.selectedDryLevel = id
                this.lockSelector('dry_level')
                this.publishProperty('dry_level', mqttValue)
            }
            return
        }

        if (prop === 'eco_hybrid') {
            const id = ECO_HYBRID_IDS[mqttValue]
            if (id !== undefined) {
                this.selectedEcoHybrid = id
                this.lockSelector('eco_hybrid')
                this.publishProperty('eco_hybrid', mqttValue)
            }
            return
        }

        if (prop === 'anti_crease') {
            this.selectedAntiCrease = mqttValue === 'ON'
            this.lockSelector('anti_crease')
            this.publishProperty('anti_crease', mqttValue)
            return
        }

        if (prop === 'reservation') {
            const hours = RESERVATION_IDS[mqttValue]
            if (hours !== undefined) {
                this.selectedReservation = hours
                this.lockSelector('reservation')
                this.publishProperty('reservation', mqttValue)
            }
            return
        }

        // Pause — confirmed: aa09f02404010099bb
        if (prop === 'pause') {
            this.send(Buffer.from('F024040100', 'hex'))
            return
        }

        // Start / Resume
        if (prop === 'start') {
            const cmd = this.buildStartCommand()
            if (cmd) this.send(cmd)
            return
        }
    }
}
