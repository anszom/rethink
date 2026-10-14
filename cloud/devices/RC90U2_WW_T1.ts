import { Device as Thinq1Device } from '../thinq1/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import log from '@/util/logging'
import AABBDevice, { type AABBTransport } from './aabb_device'
import RC90U2_WW, {
    CLASS_BYTE,
    RECORD_LEN_MARKER,
    STATUS_LENGTH,
    STATUS_REQUEST,
    POWER_ON,
    POWER_OFF,
    START_PAUSE,
} from './RC90U2_WW'

// RC90U2_WW with the Qualcomm "QC_Modem" Wi-Fi module (fw QC_Modem_1.2.80), which only speaks ThinQ1: same
// model id as the AABB variant, the way RAC_056905_WW_T1 relates to RAC_056905_WW.
//
// After `Mon Start` the module pushes the appliance status about once a second as a bare 24-byte payload:
// the AABB variant's 25-byte record without its last byte, so the offsets are the same modelJSON
// Monitoring offsets. Checked against a real unit across the dial, dry level, Eco Hybrid, Delay End,
// start and pause. The payload is rebuilt into the AABB status frame and handed to the AABB handler, so both
// variants share one decoder.
//
// Commands go the other way: the F0 frames the AABB handler sends are translated to the module's
// ThinQ1 controls. Those come from the model's modelJSON (TITAN2.0_D_WIFI_CZ, ControlWifi), where
// OperationStart carries the F0 26 payload without its two header bytes.
const PAYLOAD_LEN = 24
const PAYLOAD_OFFSET = 2 // after the 00 19 block header
const FRAME_TYPE_STATUS = 0xeb

// payload offsets, named as in the modelJSON Monitoring section
const STATE = 0
const COURSE = 5
const DRY_LEVEL = 7
const ECO_HYBRID = 8
const OPTION1 = 14
const OPTION2 = 15
const SMART_COURSE = 20
const STATE_OFF = 0x00
const STATE_RUNNING = 0x02
const STATE_PAUSE = 0x03
const OPTION1_ANTI_CREASE = 0x02 // Wrinkle Care
const OPTION2_REMOTE_START = 0x01

const START_COURSE = 0x26 // F0 26
const START_DATA_LEN = 14

const control = (CmdOpt: string, Value: string, data?: Buffer) => ({
    Cmd: 'Control',
    CmdOpt,
    Value,
    Format: 'B64',
    Data: data ? data.toString('base64') : '',
})

// OperationStart: [Course, DryLevel, EcoHybrid, MoreLessTime, 0, 0, Reserve_Time_H, 0, 0, Option1,
// Option2, 0, SmartCourse, 0]. Resuming a paused cycle repeats what it is running, without InitialBit.
export function resumeData(status: Buffer) {
    const data = Buffer.alloc(START_DATA_LEN)
    data[0] = status[COURSE]
    data[1] = status[DRY_LEVEL]
    data[2] = status[ECO_HYBRID]
    data[9] = status[OPTION1] & OPTION1_ANTI_CREASE
    data[10] = status[OPTION2] & OPTION2_REMOTE_START
    data[12] = status[SMART_COURSE]
    return data
}

// The ThinQ1 control for an F0 command frame of the AABB handler, or undefined when there is none.
export function translate(inner: Buffer, status: Buffer | undefined): object | undefined {
    const hex = inner.toString('hex').toUpperCase()
    if (hex === POWER_OFF) return control('Power', 'Off')
    // The modelJSON has no power on. WakeUp powers the appliance on from standby, as long as the module
    // is reachable; the panel then lights its Remote Start icon.
    if (hex === POWER_ON) return control('Operation', 'WakeUp')
    // On the AABB variant this is the panel's Start/Pause toggle. ThinQ1 has separate Stop and Start.
    if (hex === START_PAUSE) {
        if (status?.[STATE] === STATE_RUNNING) return control('Operation', 'Stop')
        if (status?.[STATE] === STATE_PAUSE) return control('Operation', 'Start', resumeData(status))
        return undefined
    }
    if (inner[0] === 0xf0 && inner[1] === START_COURSE && inner.length === 2 + START_DATA_LEN)
        return control('Operation', 'Start', inner.subarray(2))
    return undefined
}

// A Start while the appliance is off is refused (ReturnCode 0100), yet the module keeps it and applies it at
// the next power-on from the panel, which would start a cycle nobody is expecting. So an off appliance is
// woken first, and the start follows once it reports Ready. WakeUp has taken 1 to 8 s to power it on,
// and now and then it only lights the Remote Start icon instead: then the start is dropped.
const WAKE_TIMEOUT_MS = 20000
// Seen working 5 s after Ready; give the main board a moment before the start.
const START_AFTER_WAKE_MS = 2000

function transport(thinq: Thinq1Device): AABBTransport {
    let status: Buffer | undefined
    let pendingStart: { cmd: object; timer: NodeJS.Timeout } | undefined

    const startWhenAwake = (cmd: object) => {
        if (pendingStart) clearTimeout(pendingStart.timer)
        const timer = setTimeout(() => {
            pendingStart = undefined
            log('status', thinq.id, 'RC90U2_WW_T1: the appliance did not power on, start dropped')
        }, WAKE_TIMEOUT_MS)
        timer.unref?.()
        pendingStart = { cmd, timer }
        thinq.send(control('Operation', 'WakeUp'))
    }

    return {
        id: thinq.id,
        on(event, listener) {
            thinq.on(event, (payload) => {
                // the module also passes the DevInfo text through `data`
                if (payload.length !== PAYLOAD_LEN) return
                status = payload
                if (pendingStart && payload[STATE] !== STATE_OFF) {
                    const { cmd, timer } = pendingStart
                    clearTimeout(timer)
                    pendingStart = undefined
                    setTimeout(() => thinq.send(cmd), START_AFTER_WAKE_MS).unref?.()
                }
                const rec = Buffer.alloc(STATUS_LENGTH)
                rec[1] = RECORD_LEN_MARKER
                payload.copy(rec, PAYLOAD_OFFSET)
                listener(AABBDevice.frame(Buffer.concat([Buffer.from([CLASS_BYTE, FRAME_TYPE_STATUS]), rec])))
            })
        },
        send_packet(packet) {
            const inner = packet.subarray(2, packet.length - 2)
            const hex = inner.toString('hex').toUpperCase()
            // `Mon Start` replaces the status request
            if (hex === STATUS_REQUEST) return
            const cmd = translate(inner, status)
            if (pendingStart && hex === POWER_OFF) {
                clearTimeout(pendingStart.timer)
                pendingStart = undefined
            }
            if (cmd && inner[1] === START_COURSE && (!status || status[STATE] === STATE_OFF)) startWhenAwake(cmd)
            else if (cmd) thinq.send(cmd)
            else log('status', thinq.id, `RC90U2_WW_T1: no ThinQ1 equivalent for ${inner.toString('hex')}, dropped`)
        },
        // status pushes over ThinQ1 are not acked by the cloud
        send_ack() {},
    }
}

export default class Device extends RC90U2_WW {
    constructor(
        HA: Connection,
        readonly thinq1: Thinq1Device,
        meta: Metadata,
    ) {
        super(HA, transport(thinq1), meta)
    }

    start() {
        super.start()
        this.thinq1.send({ Cmd: 'Mon', CmdOpt: 'Start' })
    }
}
