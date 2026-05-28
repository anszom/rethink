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

// Inverse cycle lookup for start payload
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
    // ── All wire IDs confirmed from packet captures ────────────────────────────
    0x65: {
        name: 'BABYWEAR',
        label: 'Baby Wear',
        baseId: 0x02,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 130,
    },
    0x66: {
        name: 'GYMCLOTHES',
        label: 'Gym Clothes',
        baseId: 0x08,
        defaultDryLevel: 0,
        defaultEcoHybrid: 1,
        defaultTime: 60,
    },
    0x67: {
        name: 'BLANKET',
        label: 'Blanket',
        baseId: 0x04,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 165,
    },
    0x68: {
        name: 'BLANKETREFRESH',
        label: 'Blanket Refresh',
        baseId: null,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 30,
    },
    0x69: {
        name: 'RAINYSEASON',
        label: 'Rainy Day',
        baseId: 0x0e,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 30,
    },
    0x6a: {
        name: 'SINGLEGARMENTS',
        label: 'Single Garments',
        baseId: 0x0e,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 40,
    },
    0x6b: {
        name: 'DEODORIZATION',
        label: 'Deodorization',
        baseId: null,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 39,
    },
    0x6c: {
        name: 'SMALLLOAD',
        label: 'Small Load',
        baseId: 0x0e,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 50,
    },
    0x6d: {
        name: 'LINGERIE',
        label: 'Lingerie',
        baseId: 0x0a,
        defaultDryLevel: 0,
        defaultEcoHybrid: 1,
        defaultTime: 50,
    },
    0x6e: {
        name: 'EASYIRON',
        label: 'Easy Ironing',
        baseId: 0x19,
        defaultDryLevel: 1,
        defaultEcoHybrid: 1,
        defaultTime: 110,
    },
    0x6f: {
        name: 'SUPERDRY',
        label: 'Super Dry',
        baseId: 0x19,
        defaultDryLevel: 4,
        defaultEcoHybrid: 3,
        defaultTime: 160,
    },
    0x70: {
        name: 'ECONOMICDRY',
        label: 'Economic Dry',
        baseId: 0x19,
        defaultDryLevel: 3,
        defaultEcoHybrid: 1,
        defaultTime: 150,
    },
    0x71: {
        name: 'BIGSIZEITEM',
        label: 'Big Size Item',
        baseId: 0x04,
        defaultDryLevel: 0,
        defaultEcoHybrid: 3,
        defaultTime: 165,
    },
    0x72: {
        name: 'MINIMIZEWRINKLES',
        label: 'Minimize Wrinkles',
        baseId: 0x19,
        defaultDryLevel: 3,
        defaultEcoHybrid: 3,
        defaultTime: 130,
    },
    0x73: {
        name: 'SHOESFABRICDOLL',
        label: 'Shoes / Fabric Doll',
        baseId: 0x0c,
        defaultDryLevel: 0,
        defaultEcoHybrid: 1,
        defaultTime: 180,
    },
    0x74: {
        name: 'FULLSIZELOAD',
        label: 'Full Size Load',
        baseId: 0x19,
        defaultDryLevel: 4,
        defaultEcoHybrid: 3,
        defaultTime: 160,
    },
}

// ─── Per-cycle schema ──────────────────────────────────────────────────────────
type CycleSchema = {
    dryLevels: number[]
    ecoHybrids: number[]
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
    private lastDownloadedCycleId: number = 0 // tracks last known SmartCourse ID for wake sequence
    private cycleStartTime: Date | null = null // set when state transitions to Running

    // Last known Bd values — used as fallback for start payload missing fields
    private lastBdCycle: number = 0
    private lastBdDryLevel: number = 0
    private lastBdEcoHybrid: number = 0
    private lastBdAntiCrease: boolean = false
    private lastBdReservation: number = 0

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:tumble-dryer',
                    },
                    remote_start: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote-start',
                        state_topic: '$this/remote_start',
                        name: 'Remote Start',
                        icon: 'mdi:remote',
                    },

                    // ── Read-only status sensors ──────────────────────────────
                    cycle: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        name: 'Cycle',
                        icon: 'mdi:pin-outline',
                        device_class: 'enum',
                        options: ['None', ...Object.values(CYCLES)],
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry-level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: Object.values(DRY_LEVELS),
                    },
                    eco_hybrid: {
                        platform: 'sensor',
                        unique_id: '$deviceid-eco-hybrid',
                        state_topic: '$this/eco_hybrid',
                        name: 'Eco hybrid',
                        icon: 'mdi:leaf',
                        device_class: 'enum',
                        options: Object.values(ECO_HYBRID),
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
                        platform: 'sensor',
                        unique_id: '$deviceid-reservation',
                        state_topic: '$this/reservation',
                        name: 'Delayed end',
                        icon: 'mdi:clock-end',
                        device_class: 'enum',
                        options: Object.values(RESERVATION),
                    },

                    // ── Actions ──────────────────────────────────────────────
                    // start accepts an optional JSON payload:
                    //   {"cycle":"Mixed Fabric","dry_level":"Cupboard Dry","eco_hybrid":"Time",
                    //    "reservation":"Off","anti_crease":false}
                    // Any missing field falls back to the last known Bd value.
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

                    // ── Diagnostic ───────────────────────────────────────────
                    // Sends F0 ED handshake — wakes dryer if polling has stalled
                    // and logs the 30 EB compact state response.
                    ping: {
                        platform: 'button',
                        unique_id: '$deviceid-ping',
                        command_topic: '$this/ping/set',
                        payload_press: '',
                        name: 'Poll (Debug)',
                        icon: 'mdi:connection',
                        entity_category: 'diagnostic',
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
                        options: ['-', ...new Set(Object.values(PROCESS_STATES))],
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
                    cycle_start_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle-start-time',
                        state_topic: '$this/cycle_start_time',
                        name: 'Cycle start time',
                        device_class: 'timestamp',
                        icon: 'mdi:clock-start',
                    },
                    cycle_end_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle-end-time',
                        state_topic: '$this/cycle_end_time',
                        name: 'Cycle end time',
                        device_class: 'timestamp',
                        icon: 'mdi:clock-end',
                    },
                    cycle_duration: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle-duration',
                        state_topic: '$this/cycle_duration',
                        name: 'Cycle duration',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        icon: 'mdi:timer-outline',
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
        //   [10] reservation hours (0=off, 3-19=delayed end)
        //   [11-13] unknown
        //   [14] flags: bit 0x02=anti-crease
        //   [15] flags: bit 0x01=remote-start
        //   [16-22] unknown/counter
        //   [23] downloaded/smart cycle ID (0=none, see DOWNLOADED_CYCLES) ✓ confirmed inner[54]
        //   [24] unknown

        if (buf.length !== 56 || buf[0] !== 0x30 || buf[1] !== 0xec) return

        const Bd = buf.subarray(31)

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
        const reservation = Bd[10]
        const flags14 = Bd[14]
        const flags15 = Bd[15]
        const downloadedCycleId = Bd[23] // SmartCourse/downloaded cycle ID — confirmed inner[54]=Bd[23]
        if (downloadedCycleId) this.lastDownloadedCycleId = downloadedCycleId

        const remainingTime = remainHr * 60 + remainMin
        const initialTime = initialHr * 60 + initialMin

        const isOff = state === 0
        const isRunning = state === 2
        const isEnd = state === 4
        const hasError = errorCode !== 0
        const remoteStart = !!(flags15 & FLAG15_REMOTE_START)
        const antiCrease = !!(flags14 & FLAG14_ANTI_CREASE)

        // Track cycle start time — set on first Running packet, cleared on Off/End
        if (isRunning && !this.cycleStartTime) {
            this.cycleStartTime = new Date()
            this.publishProperty('cycle_start_time', this.cycleStartTime.toISOString())
        } else if (isOff || isEnd) {
            this.cycleStartTime = null
        }

        // Retain last known Bd values while a cycle is active (used as start fallback)
        if (cycle > 1) {
            this.lastBdCycle = cycle
            this.lastBdDryLevel = dryLevel
            this.lastBdEcoHybrid = ecoHybrid
            this.lastBdAntiCrease = antiCrease
            this.lastBdReservation = reservation
        }

        this.publishProperty('power', isOff ? 'OFF' : 'ON')
        this.publishProperty('run_state', STATES[state] ?? `unknown (${state})`)
        this.publishProperty(
            'process_state',
            isOff ? '-' : (PROCESS_STATES[processState] ?? `unknown (${processState})`),
        )
        this.publishProperty('remaining_time', remainingTime)
        this.publishProperty('initial_time', initialTime)
        this.publishProperty('remote_start', remoteStart ? 'ON' : 'OFF')
        this.publishProperty('run_completed', isEnd ? 'ON' : 'OFF')

        // Cycle timing — only meaningful while running
        if (this.cycleStartTime) {
            const now = new Date()
            const durationMin = Math.floor((now.getTime() - this.cycleStartTime.getTime()) / 60000)
            const endTime = new Date(now.getTime() + remainingTime * 60000)
            this.publishProperty('cycle_duration', durationMin)
            this.publishProperty('cycle_end_time', endTime.toISOString())
        } else {
            this.publishProperty('cycle_duration', 0)
            this.publishProperty('cycle_end_time', '-')
        }

        this.publishProperty('error', hasError ? 'ON' : 'OFF')
        this.publishProperty('error_message', ERRORS[errorCode] ?? `unknown (0x${errorCode.toString(16)})`)

        this.publishProperty('cycle', cycle <= 1 ? 'None' : (CYCLES[cycle] ?? `unknown (0x${cycle.toString(16)})`))
        this.publishProperty(
            'downloaded_cycle_id',
            downloadedCycleId
                ? `0x${downloadedCycleId.toString(16)} (${DOWNLOADED_CYCLES[downloadedCycleId]?.label ?? 'unknown'})`
                : '-',
        )
        this.publishProperty('dry_level', DRY_LEVELS[dryLevel] ?? `unknown (${dryLevel})`)
        this.publishProperty('eco_hybrid', ECO_HYBRID[ecoHybrid] ?? `unknown (${ecoHybrid})`)
        this.publishProperty('anti_crease', antiCrease ? 'ON' : 'OFF')
        this.publishProperty('reservation', RESERVATION[reservation] ?? 'Off')
    }

    // ── F0 25 SmartCourse select — used as idle safety timer reset ────────────
    // Sending F0 25 resets the dryer's idle safety lockout, allowing F0 2A
    // (power on) to work after the machine has been idle for 3-5+ minutes.
    // The dryer treats F0 25 as user interaction, resetting the timer.
    // Layout confirmed from captures:
    //   [2]  = eco hybrid default
    //   [3]  = 0x15 (constant)
    //   [5]  = eco hybrid
    //   [6]  = default time (minutes)
    //   [14] = base course ID (or 0x00)
    //   [15] = SmartCourse ID
    //   [19] = dry level default
    private buildF025(smartCourseId: number): Buffer | null {
        const course = DOWNLOADED_CYCLES[smartCourseId]
        if (!course) return null
        const inner = Buffer.alloc(25, 0)
        inner[0] = 0xf0
        inner[1] = 0x25
        inner[2] = course.defaultEcoHybrid
        inner[3] = 0x15
        inner[5] = course.defaultEcoHybrid
        inner[6] = course.defaultTime
        inner[14] = course.baseId ?? 0x00
        inner[15] = smartCourseId
        inner[19] = course.defaultDryLevel
        return inner
    }

    // ── Command builder ───────────────────────────────────────────────────────

    private buildStartCommand(
        cycleId: number,
        dryLevel: number,
        ecoHybrid: number,
        antiCrease: boolean,
        reservation: number,
    ): Buffer {
        const schema = CYCLE_SCHEMA[cycleId]
        let effectiveDryLevel = dryLevel
        let effectiveEcoHybrid = ecoHybrid
        if (schema) {
            if (schema.dryLevels.length === 0) {
                effectiveDryLevel = 0
            } else if (!schema.dryLevels.includes(effectiveDryLevel)) {
                console.warn(
                    `[RH90V9] dry_level ${DRY_LEVELS[effectiveDryLevel] ?? effectiveDryLevel} invalid for ${CYCLES[cycleId]}, correcting to default`,
                )
                effectiveDryLevel = schema.defaultDryLevel
            }
            if (!schema.ecoHybrids.includes(effectiveEcoHybrid)) {
                console.warn(
                    `[RH90V9] eco_hybrid ${ECO_HYBRID[effectiveEcoHybrid] ?? effectiveEcoHybrid} invalid for ${CYCLES[cycleId]}, correcting to default`,
                )
                effectiveEcoHybrid = schema.defaultEcoHybrid
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
        inner[2] = cycleId
        inner[3] = effectiveDryLevel
        inner[4] = effectiveEcoHybrid
        inner[8] = reservation
        inner[11] = antiCrease ? 0x02 : 0x00
        inner[12] = 0x03
        return inner
    }

    // ── HA command handler ────────────────────────────────────────────────────

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power') {
            if (mqttValue === 'ON') {
                // F0 25 resets the idle safety timer before F0 2A power on.
                // Dryer treats SmartCourse select as user interaction, unlocking
                // the firmware safety gate that blocks remote power on after ~3-5min idle.
                const wake = this.lastDownloadedCycleId ? this.buildF025(this.lastDownloadedCycleId) : null
                if (wake) {
                    console.log(
                        `[RH90V9] Sending wake (F0 25 with 0x${this.lastDownloadedCycleId.toString(16)}) before power on`,
                    )
                    this.send(wake)
                    setTimeout(() => this.send(Buffer.from('F02A0100', 'hex')), 500)
                } else {
                    // No downloaded cycle known — send power on directly (may fail if idle)
                    console.warn('[RH90V9] No downloaded cycle known for wake sequence — sending F0 2A directly')
                    this.send(Buffer.from('F02A0100', 'hex'))
                }
            } else if (mqttValue === 'OFF') {
                this.send(Buffer.from('F024010100', 'hex'))
            }
            return
        }

        // Poll (Debug) — sends F0 ED handshake, wakes dryer if polling has stalled
        // Dryer replies with 30 EB compact state snapshot (logged by rethink)
        if (prop === 'ping') {
            console.log('[RH90V9] Sending poll (F0 ED handshake)')
            this.send(Buffer.from('F0ED1121010000001804131400005a', 'hex'))
            return
        }

        if (prop === 'anti_crease') {
            this.lastBdAntiCrease = mqttValue === 'ON'
            this.publishProperty('anti_crease', mqttValue)
            return
        }

        if (prop === 'pause') {
            this.send(Buffer.from('F024040100', 'hex'))
            return
        }

        if (prop === 'start') {
            // Start payload is optional JSON; any missing field falls back to last known Bd value.
            let cycleId = this.lastBdCycle
            let dryLevel = this.lastBdDryLevel
            let ecoHybrid = this.lastBdEcoHybrid
            let antiCrease = this.lastBdAntiCrease
            let reservation = this.lastBdReservation

            if (mqttValue.trim()) {
                try {
                    const payload = JSON.parse(mqttValue) as Record<string, unknown>
                    if (payload.cycle !== undefined) {
                        const id = CYCLE_IDS[payload.cycle as string]
                        if (id !== undefined) cycleId = id
                        else console.warn(`[RH90V9] Unknown cycle '${payload.cycle}' in start payload`)
                    }
                    if (payload.dry_level !== undefined) {
                        const id = DRY_LEVEL_IDS[payload.dry_level as string]
                        if (id !== undefined) dryLevel = id
                        else console.warn(`[RH90V9] Unknown dry_level '${payload.dry_level}' in start payload`)
                    }
                    if (payload.eco_hybrid !== undefined) {
                        const id = ECO_HYBRID_IDS[payload.eco_hybrid as string]
                        if (id !== undefined) ecoHybrid = id
                        else console.warn(`[RH90V9] Unknown eco_hybrid '${payload.eco_hybrid}' in start payload`)
                    }
                    if (payload.anti_crease !== undefined) {
                        antiCrease = Boolean(payload.anti_crease)
                    }
                    if (payload.reservation !== undefined) {
                        const id = RESERVATION_IDS[payload.reservation as string]
                        if (id !== undefined) reservation = id
                        else console.warn(`[RH90V9] Unknown reservation '${payload.reservation}' in start payload`)
                    }
                } catch {
                    console.warn('[RH90V9] start payload is not valid JSON — using last known Bd values')
                }
            }

            if (cycleId < 2) {
                console.warn('[RH90V9] Start ignored: no cycle known')
                return
            }

            this.send(this.buildStartCommand(cycleId, dryLevel, ecoHybrid, antiCrease, reservation))
            return
        }
    }
}
