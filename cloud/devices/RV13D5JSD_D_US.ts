import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'
import log from '@/util/logging'

// LG dryer — matched on modelId "RV13D5JSD_D_US". This handler was originally written for the
// 0xEC/0xEB status records below (copied from RV13U6AM8W_D_US_WIFI.ts), but a ~2-day capture of this
// specific appliance's real traffic showed it never sends those: only 17 frames total, all 0x31
// (serial, once per reconnect), 0x72 (heartbeat) and 0xE2 (end-of-cycle summary, repeated ~10x). The
// 0xEC/0xEB path is kept as-is in case another unit of this model does send them.
//   0x72 (5 bytes: 30 72 00 <XX> 00) — buf[3] flips between 0xC9 (running/resumed) and 0xC8
//        (paused/stopped); a single transient 0x00 was observed immediately before a 0xC8 at cycle
//        end. `power` is driven from this.
//   0xE2 (31 bytes, end-of-cycle only) — buf[4] confirmed as the phase byte (0x32/Drying, matching
//        the STATUS map above). The physical panel for this capture read Medium temp / Normal dry
//        level, and buf[6], buf[8] and buf[9] are all candidates for those two fields — but all three
//        happen to read 0x03 in the only capture available (Medium and Normal both map to 0x03), so
//        there's no way to tell which byte is which from this data. TODO: decode temp/dry_level from
//        0xE2 once a capture with differing temp and dry-level values disambiguates the offsets.
// Live remaining time needs the appliance to be sending 0xEC/0xEB/similar status records with a
// remaining-time field, which this capture never showed; the LG app likely triggers that by making
// the cloud request a status stream while it's open. No such periodic re-request exists anywhere in
// this codebase for the AABB device family (grepped for setInterval/setTimeout in cloud/devices/ —
// the only matches are the unrelated TLV/ThinQ1 and RAC_056905_WW polling code). Several sibling AABB
// washer/dryer models (F3L7CYK5W_US_WIFI, RV13B6ES_D_US_WIFI) and D30 send a one-time
// `F0ED1121010000001800` status-push request from `start()` on every (re)connect; this file has no
// `start()` override at all, so it doesn't even request that one-time push. Not added here since it's
// a live command to real hardware and wasn't captured/verified for this specific model — flagged for
// the user to decide on.

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
                        device_class: 'enum',
                        options: STATUS.options,
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'running',
                    },
                    drum_running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum_running',
                        state_topic: '$this/drum_running',
                        name: 'Drum running',
                        icon: 'mdi:rotate-3d-variant',
                    },
                    cycle: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle',
                        state_topic: '$this/cycle',
                        name: 'Cycle',
                        icon: 'mdi:tumble-dryer',
                        device_class: 'enum',
                        options: CYCLES.options,
                    },
                    temp: {
                        platform: 'sensor',
                        unique_id: '$deviceid-temp',
                        state_topic: '$this/temp',
                        name: 'Temperature',
                        icon: 'mdi:thermometer',
                        device_class: 'enum',
                        options: TEMPS.options,
                    },
                    dry_level: {
                        platform: 'sensor',
                        unique_id: '$deviceid-dry_level',
                        state_topic: '$this/dry_level',
                        name: 'Dry level',
                        icon: 'mdi:water-percent',
                        device_class: 'enum',
                        options: DRY_LEVELS.options,
                    },
                },
            }),
        )
    }

    private processRecord(rec: Buffer) {
        const phase = rec[2]
        const mins = rec[4]

        this.publishProperty('status', STATUS.map(phase))
        this.publishProperty('remaining_time', mins)
        this.publishProperty('power', phase !== 0 ? 'ON' : 'OFF')
        this.publishProperty('drum_running', rec[17] === 0xa9 ? 'ON' : 'OFF')
        this.publishProperty('cycle', CYCLES.map(rec[7]))
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
        } else if (buf[1] === 0x72 && buf.length >= 4) {
            this.processHeartbeat(buf)
        } else {
            // 0x31 (serial), 0xE2 (end-of-cycle summary), any length-mismatched EC/EB/0x72 and
            // anything else not yet decoded land here — see the header comment for 0xE2's status.
            log('RV13D5JSD_D_US', 'unrecognized frame', buf.toString('hex'))
        }
    }

    private processHeartbeat(buf: Buffer) {
        this.publishProperty('power', buf[3] === 0xc9 ? 'ON' : 'OFF')
    }
}
