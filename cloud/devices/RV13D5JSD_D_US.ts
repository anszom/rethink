import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import log from '@/util/logging'

// LG gas dryer (DLGX4501B) — matched on modelId "RV13D5JSD_D_US". This handler was originally written for the
// 0xEC/0xEB status records below (copied from RV13U6AM8W_D_US_WIFI.ts), but captures of this specific
// appliance's real traffic (three days, four cycles) showed it never sends those: only 0x31 (serial,
// once per reconnect), 0x72 (heartbeat) and 0xE2 (end-of-cycle summary, repeated ~10x). The 0xEC/0xEB
// path is kept as-is in case another unit of this model does send them.
//   0x72 (5 bytes: 30 72 00 <XX> 00) — buf[3] flips between 0xC9 (running/resumed) and 0xC8
//        (paused/stopped); a single transient 0x00 was observed immediately before a 0xC8 at cycle
//        end. `power` and `status` (Running/Off) are driven from this.
//   0xE2 (31 bytes, end-of-cycle only) — buf[2..] follows the same record layout as the 0xEC/0xEB
//        record processRecord() reads, with [hour][minute] time pairs where that record has a single
//        minute byte. Confirmed against four cycles (three with panel photos):
//          rec[2]     phase at the end (0x32/Drying every time)
//          rec[3..4]  cycle time, h:m — 1:03, 0:10, 0:55 and 1:05 (the photographed ones matched the
//                     display at start; it's the start estimate, not the actual run time)
//          rec[5..6]  same value as rec[3..4] in every capture; not published
//          rec[7]     cycle — 0x03 on a load with Normal dry level; 0x07 = Bedding and 0x01 = Heavy
//                     Duty (panel photos, as in the sibling map), 0x05 = Delicates and 0x04 = Perm.
//                     Press (as in the map); 0x02 = Towels and 0x15 = Steam Fresh (confirmed by the user),
//                     0x16 = Steam Sanitary, 0x11 = Air Dry and
//                     0x12 = Manual (Time Dry on the Manual Dry dial position) and 0x10 = Speed Dry
//                     (panel photos);
//                     unmapped codes are published as their raw hex value
//          rec[9]     dry level — 0x01/Damp, 0x02/Less (the step between Damp and Normal),
//                     0x03/Normal, 0x04/More (the step between Normal and Very), 0x05/Very and
//                     0x00/none (steam cycle, no dry-level lamp lit)
//          rec[10]    temp — 0x01/Ultra Low (Manual + Time Dry, panel photo), 0x05/High, 0x04/Med High (the unlabeled lamp between High and Medium) and
//                     0x03/Medium, each matching the panel photo
//          rec[11]    Time Dry setting in 10-minute steps above 10: 0x01 on a 20-minute Time Dry and
//                     0x03 on a 40-minute one (the panel's scale is 20/30/40/50/60), 0x00 on every
//                     sensor cycle
//          rec[16]    options: bit 0x10 = Wrinkle Care — set only on a Small Load cycle photographed
//                     with the Wrinkle Care lamp lit (and the drum restarted after the cycle for the
//                     wrinkle-care tumble); bit 0x02 = Reduce Static — set only on a Sportswear cycle
//                     photographed with the Reduce Static lamp lit. 0x00 on all other cycles.
//          rec[17]    bit 0x02 = Energy Saver — set (0xab) only on the one cycle with the Energy Saver
//                     lamp lit; 0xa9/0x29 on three cycles photographed with it off, and on Towels.
//                     bit 0x04 = the TurboSteam option — set on both Heavy Duty cycles run with
//                     TurboSteam on, clear on the five regular cycles run without it. It's also
//                     clear on Steam Fresh and Steam Sanitary, the dedicated steam cycles (the lamp
//                     shows the built-in steam, and the cycle code already identifies it). The other bits aren't
//                     identified.
//        These are published as the "last cycle" settings, since this dryer only reports them once
//        the cycle is over.
// Live remaining time needs the appliance to be sending 0xEC/0xEB/similar status records with a
// remaining-time field, which these captures never showed; the LG app likely triggers that by making
// the cloud request a status stream while it's open. No such periodic re-request exists anywhere in
// this codebase for the AABB device family (grepped for setInterval/setTimeout in cloud/devices/ —
// the only matches are the unrelated TLV/ThinQ1 and RAC_056905_WW polling code). Several sibling AABB
// washer/dryer models (F3L7CYK5W_US_WIFI, RV13B6ES_D_US_WIFI) and D30 send a one-time
// `F0ED1121010000001800` status-push request from `start()` on every (re)connect; this file has no
// `start()` override at all, so it doesn't even request that one-time push. Not added here since it's
// a live command to real hardware and wasn't captured/verified for this specific model.

const HEARTBEAT_STATE_OFFSET = 3
const HEARTBEAT_RUNNING = 0xc9

const SUMMARY_FRAME_TYPE = 0xe2
const SUMMARY_FRAME_LEN = 31
const SUMMARY_RECORD_OFFSET = 2
// offsets relative to SUMMARY_RECORD_OFFSET, matching processRecord()'s record layout
const SUMMARY_TIME_HOUR = 3
const SUMMARY_TIME_MIN = 4
const SUMMARY_CYCLE = 7
const SUMMARY_DRY_LEVEL = 9
const SUMMARY_TEMP = 10
const SUMMARY_TIME_DRY_STEP = 11
const SUMMARY_OPTIONS = 16
const SUMMARY_OPTION_WRINKLE_CARE = 0x10
const SUMMARY_OPTION_REDUCE_STATIC = 0x02
const SUMMARY_FLAGS = 17
const SUMMARY_FLAG_ENERGY_SAVER = 0x02
const SUMMARY_FLAG_TURBO_STEAM = 0x04

const STATUS = Enum.of({
    Off: 0x00,
    Starting: 0x01,
    Paused: 0x03,
    Drying: 0x32,
    Cooldown: 0x33,
    Finishing: 0x04,
})

const CYCLES = Enum.of({
    'Heavy Duty': 0x01,
    Normal: 0x03,
    'Perm. Press': 0x04,
    Delicates: 0x05,
    Bedding: 0x07,
    'Speed Dry': 0x10,
    'Air Dry': 0x11,
    Manual: 0x12,
    // confirmed on RV13D5JSD_D_US (not present on the model this map came from)
    Towels: 0x02,
    Antibacterial: 0x08,
    'Small Load': 0x09,
    Sportswear: 0x0b,
    'Steam Fresh': 0x15,
    'Steam Sanitary': 0x16,
})

const TEMPS = Enum.of({
    Off: 0x00,
    'Ultra Low': 0x01,
    Low: 0x02,
    Medium: 0x03,
    'Med High': 0x04,
    High: 0x05,
})

const DRY_LEVELS = Enum.of({
    None: 0x00,
    Damp: 0x01,
    Less: 0x02,
    Normal: 0x03,
    More: 0x04,
    Very: 0x05,
})

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Dryer' }),
                components: {
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): the 0x72 heartbeat publishes Running/Off,
                        // which aren't in the 0xEC/0xEB STATUS map.
                    },
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    cycle: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        name: 'Last cycle',
                        icon: 'mdi:tumble-dryer',
                        // free-text: unmapped cycle codes are published as their raw hex value
                    },
                    cycle_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle_time',
                        state_topic: '$this/cycle_time',
                        name: 'Last cycle time',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Last cycle temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMPS.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Last cycle dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
                    },
                    time_dry: {
                        platform: 'sensor',
                        unique_id: '$deviceid-time_dry',
                        state_topic: '$this/time_dry',
                        name: 'Last cycle Time Dry setting',
                        icon: 'mdi:timer-cog-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    reduce_static: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-reduce_static',
                        state_topic: '$this/reduce_static',
                        name: 'Last cycle Reduce Static',
                        icon: 'mdi:flash-off',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle_care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Last cycle Wrinkle Care',
                        icon: 'mdi:tshirt-crew-outline',
                    },
                    turbo_steam: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-turbo_steam',
                        state_topic: '$this/turbo_steam',
                        name: 'Last cycle TurboSteam',
                        icon: 'mdi:kettle-steam',
                    },
                    energy_saver: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-energy_saver',
                        state_topic: '$this/energy_saver',
                        name: 'Last cycle energy saver',
                        icon: 'mdi:leaf',
                    },
                    // remaining_time and drum_running are only decoded from 0xEC/0xEB frames, which
                    // this model hasn't been seen sending; they're left out of discovery so they don't
                    // sit at Unknown in HA.
                },
            }),
        )
    }

    private cycleName(code: number) {
        return CYCLES.map(code) ?? `0x${code.toString(16).padStart(2, '0')}`
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        const mins = rec[4]

        this.publishProperty('status', STATUS.map(phase))
        this.publishProperty('remaining_time', mins)
        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_running', rec[17] === 0xa9 ? 'ON' : 'OFF')
        this.publishProperty('cycle', this.cycleName(rec[7]))
        this.publishProperty('temp', TEMPS.map(rec[10]))
        this.publishProperty('dry_level', DRY_LEVELS.map(rec[9]))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x30) {
            log('RV13D5JSD_D_US', 'unrecognized frame', buf.toString('hex'))
            return
        }

        if (buf[1] === 0xec && buf.length === 60) {
            // 0xEC: two back-to-back 29-byte records (current + previous); use current
            this.processRecord(buf.subarray(2, 31))
        } else if (buf[1] === 0xeb && buf.length === 31) {
            // 0xEB: single record sent after reconnect
            this.processRecord(buf.subarray(2, 31))
        } else if (buf[1] === 0x72 && buf.length > HEARTBEAT_STATE_OFFSET) {
            this.processHeartbeat(buf)
        } else if (buf[1] === SUMMARY_FRAME_TYPE && buf.length === SUMMARY_FRAME_LEN) {
            this.processSummary(buf.subarray(SUMMARY_RECORD_OFFSET))
        } else {
            // 0x31 (serial), any length-mismatched EC/EB/E2/0x72 and anything else not yet decoded
            // land here.
            log('RV13D5JSD_D_US', 'unrecognized frame', buf.toString('hex'))
        }
    }

    private processHeartbeat(buf: Buffer) {
        const running = buf[HEARTBEAT_STATE_OFFSET] === HEARTBEAT_RUNNING
        this.publishProperty('power', running ? 'ON' : 'OFF')
        this.publishProperty('status', running ? 'Running' : 'Off')
    }

    // 0xE2 end-of-cycle summary: the settings of the cycle that just finished. Phase is deliberately
    // not published — it still reads Drying, but the 0x72 heartbeat has already reported Off.
    private processSummary(rec: Buffer) {
        this.publishProperty('cycle', this.cycleName(rec[SUMMARY_CYCLE]))
        this.publishProperty('cycle_time', rec[SUMMARY_TIME_HOUR] * 60 + rec[SUMMARY_TIME_MIN])
        const timeDryStep = rec[SUMMARY_TIME_DRY_STEP]
        this.publishProperty('time_dry', timeDryStep ? 10 + timeDryStep * 10 : 0)
        this.publishProperty('temp', TEMPS.map(rec[SUMMARY_TEMP]))
        this.publishProperty('dry_level', DRY_LEVELS.map(rec[SUMMARY_DRY_LEVEL]))
        this.publishProperty('energy_saver', (rec[SUMMARY_FLAGS] & SUMMARY_FLAG_ENERGY_SAVER) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('turbo_steam', (rec[SUMMARY_FLAGS] & SUMMARY_FLAG_TURBO_STEAM) !== 0 ? 'ON' : 'OFF')
        this.publishProperty('wrinkle_care', (rec[SUMMARY_OPTIONS] & SUMMARY_OPTION_WRINKLE_CARE) !== 0 ? 'ON' : 'OFF')
        this.publishProperty(
            'reduce_static',
            (rec[SUMMARY_OPTIONS] & SUMMARY_OPTION_REDUCE_STATIC) !== 0 ? 'ON' : 'OFF',
        )
    }
}
