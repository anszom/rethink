import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG WM4000HBA front-load washer — matched on modelId "F3P2CYUBE__" (deviceType 201,
// protocolVer 4.8, RTK_RTL8711am / clip_hna_v1.9.202). AABB frames (buf = the AABB body, AA+len and
// checksum+BB already stripped, buf[0]==0x20 on every frame) are discriminated by buf[1]:
//   0x31        connect/serial frame — not decoded.
//   0xDE        status frame, 47-byte body — the only frame decoded here.
//   0xBD / 0xCD full status dump (~443 B) / idle keepalive — only 21 bytes move across a whole
//               cycle, so they are very mappable, but not decoded yet.
//   0xE2        burst of ~10 frames, 2 s apart, starting the instant a cycle completes — not decoded.
//   0x72, 0xD8  short heartbeat/ping frames — not decoded.
//
// NOTE this model does NOT emit the 0xEC/0xEB dial/status frames that F3L2CYU__ (WM3900HBA) keys on,
// which is why it cannot simply alias that handler despite the near-identical model ID. Nor does it
// report idle interactions at all: two full door open/close cycles and a dial turn, with the machine
// powered on and holding an established MQTTS session, produced zero frames. There is consequently no
// `door` entity here — unlike F3L2CYU__, unload has to be detected with an external sensor.
//
// Offsets below were derived by capturing one full Normal cycle and correlating byte changes against a
// wall-clock timeline of observed machine behaviour. They are NOT cross-checked against the LG cloud's
// own decoded state (bridge mode was not used), so this is weaker evidence than the F3L2CYU__ notes.
// Fields that could not be pinned down are deliberately left unpublished rather than guessed.

const STATUS_FRAME_TYPE = 0xde
const STATUS_FRAME_LEN = 47

// Minutes remaining, and the total for the current cycle. Both carry the machine's running estimate
// while it is sensing the load, then TOTAL freezes and REMAINING counts down. Across one Normal wash
// these read 46,46,46,29,16,9,1,0 and 46,46,46,29,29,29,0 respectively — autosense rewrote both to 29,
// after which only REMAINING moved. The 16-minute reading predicted the actual finish to within 8
// seconds.
//
// These are plain minute counts, not the hour/minute pair F3L2CYU__ uses: a later capture of a longer
// cycle published 140 and then 134 from this single byte, which an hour/minute split could not produce.
const REMAINING_MIN_OFFSET = 18
const TOTAL_MIN_OFFSET = 20

// Phase code. off26 always carries the PREVIOUS value of off25 (old-state/new-state stacking, the same
// idea as F3L2CYU__'s two-record 0xEC frame). Observed sequence across a cycle:
// 0x01 -> 0x24 -> 0x03 -> 0x0B -> 0x0C -> 0x0E -> 0x10 -> 0x01.
const PHASE_OFFSET = 25

// Running flag. 0x40 whenever idle or powered off, 0x10 from the moment Start is pressed through to
// completion, then back to 0x40. Preferred over the run-state byte at offset 28, which only reads 3
// once autosense finishes and so misses the fill/sense phase at the head of the cycle.
const RUNNING_OFFSET = 41
const RUNNING = 0x10

// Increments by one as a cycle completes.
const CYCLE_COUNT_OFFSET = 32

const PHASE_OFF = 0x01
const PHASE_COMPLETE = 0x10

// Only the two unambiguous codes are named. The intermediate values (0x24, 0x03, 0x0B, 0x0C, 0x0E) were
// each seen exactly once mid-cycle, which is not enough to label them; they fall through to 'Running'.
const STATUS: Record<number, string> = {
    [PHASE_OFF]: 'Off',
    [PHASE_COMPLETE]: 'Complete',
}

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                        device_class: 'running',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        // free-text (NOT device_class:enum): unmapped phase codes emit 'Running'.
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining_time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        icon: 'mdi:timer-outline',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    initial_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-initial_time',
                        state_topic: '$this/initial_time',
                        name: 'Cycle length',
                        icon: 'mdi:timer-sand',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                        entity_category: 'diagnostic',
                    },
                    cycle_count: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycle_count',
                        state_topic: '$this/cycle_count',
                        name: 'Cycle count',
                        icon: 'mdi:counter',
                        state_class: 'total_increasing',
                        entity_category: 'diagnostic',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== 0x20 || buf.length < 2) return
        if (buf[1] === STATUS_FRAME_TYPE) return this.processStatus(buf)
    }

    private processStatus(buf: Buffer) {
        if (buf.length !== STATUS_FRAME_LEN) return // reject header/layout drift

        const phase = buf[PHASE_OFFSET]
        const running = buf[RUNNING_OFFSET] === RUNNING

        this.publishProperty('power', running ? 'ON' : 'OFF')
        // 'Running' is the fallback for the mid-cycle codes; a non-running frame whose phase is
        // unrecognised reports 'Off' rather than inventing a state.
        this.publishProperty('status', STATUS[phase] ?? (running ? 'Running' : 'Off'))

        // Zeroed when not running: the machine leaves a stale minute count in these bytes after a cycle,
        // and a countdown that keeps reading 1 while idle would be actively misleading in HA.
        this.publishProperty('remaining_time', running ? buf[REMAINING_MIN_OFFSET] : 0)
        this.publishProperty('initial_time', running ? buf[TOTAL_MIN_OFFSET] : 0)

        this.publishProperty('cycle_count', buf[CYCLE_COUNT_OFFSET])
        // Not located, and deliberately left undeclared rather than published wrong: course/cycle
        // selection, soil/spin/temp, door and door lock, error codes. Dial changes are not reported by
        // this model at all, so the course table probably has to come out of the 0xBD dump.
    }
}
