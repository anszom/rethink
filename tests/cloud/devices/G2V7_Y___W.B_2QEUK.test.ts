import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/G2V7_Y___W.B_2QEUK'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, captureLog } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'G2V7_Y___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'G2V7_Y___W.B_2QEUK', swVersion: '2.11.306' }

// Real frames from an LG F2NX50S9TKC, September and October 2026: the panel passes (one setting at a
// time, from Ready) and real washes. A single 0xeb record answers the status request; every later change comes
// as a pushed 0xec pair, the record being replaced followed by its replacement.

// Cotton at its defaults: 40 C, 1200 rpm, 203 min estimated. The door is open (and the drum lit).
const READY_COTTON = buf(
    'AAFF200A005500C7F9000100EB00430003030E082E0000000000000000CB00CB0000002E010090000004020504000000000000004000001000000000000004000000000000000000000000000000180000009383BB',
)
// The dial moved on to Easy Care: 40 C, 1200 rpm, 148 min.
const PAIR_EASY_CARE = buf(
    'AAFF200A009800C818000100EC00860003030E082E0000000000000000CB00CB0000002E010090000004020504000000000000004000001000000000000004000000000000000000000000000000180000000003030E081D00000000000000009400940000001D01009000000302050400000000000000400000100000000000000400000000000000000000000000000018000000B3FCBB',
)
// Activewear -> Download Cycle, which defaults to Rinse + Spin: no temperature, 1200 rpm, 16 min.
const PAIR_DOWNLOAD_CYCLE = buf(
    'AAFF200A009800C84B000100EC00860003030E044F00000000000000003900390000004F010090090002020504000000000000004000001000000000000004000000000000000000000000000000180000000003000E08FF0000000000000000100010000000FF0100900900010105040000000000000040000010000000000000040000000000000000000000000000001800000078E8BB',
)
// Cotton with the panel parked on Co.
const READY_COLD = buf(
    'AAFF200A005500C8D3000100EB00430003080E082E00000000000000005D005D0000002E010090000004020504000000000000000000001000000000000004000000000000000000000000000000180000005B9EBB',
)
// Mixed Fabric at Ready, the door shut: [37] 0x00 -> 0x01 and nothing else in the record moved.
const PAIR_DOOR_CLOSED = buf(
    'AAFF200A009800CE17000100EC00860003030E062B00000000000000005600560000002B010090000003020504000000000000000000001000000000000004000000000000000000000000000000180000000003030E062B00000000000000005600560000002B01009000000302050400000000000000010000100000000000000400000000000000000000000000000018000000B10DBB',
)
// Cotton 60 C with the spin set to 0, paused a minute into the wash.
const PAUSED_NO_SPIN = buf(
    'AAFF200A00550005E4000100EB00430003050E0C2E00000000000000004200420000002E020B90010004020404000000000000004101001000000000000004000000000000000000000000000000180000008068BB',
)

// One Cotton 30 C wash: the load weighed (203 -> 57 min) and the wash under way...
const PAIR_WASHING = buf(
    'AAFF200A0098000D67000100EC00860003020E082E00000000000000007100710000002E030190000000020504000000000000009101001000000000000004000000000000000000000000000000180000000003020E082E00000000000000003900390000002E0B039003000002050400000000000000910100100000000000000400000000000000000000000000000018000000AAE0BB',
)
// ...into the rinse, 20 minutes on, which clears the temperature...
const PAIR_RINSING = buf(
    'AAFF200A0098000ECE000100EC00860003020E082E0000000000000000260039001E002E0B0390030000020504000000000000009101001000000000000004000000000000000000000000000000180000000003000E082E0000000000000000250039001E002E0C0B9003000002050400000000000000110100100000000000000400000000000000000000000000000018000000C9D3BB',
)
// ...and, on another wash, from rinse into the final spin.
const PAIR_SPINNING = buf(
    'AAFF200A009800AE67000100EC00860003000E082E00000000000000000C003A00C8002E0C0B900400010106040000000000000011010010000000000000040000000000000000000000000000001800000000000000082E00000000000000000B003A00C8002E0E0C9004000100060400000000000000110100100000000000000400000000000000000000000000000018000000B40CBB',
)
// The end of that Cotton 30 C wash, spin cleared and the door released, the wash count already stepped;
// then the machine switching itself off.
const END = buf(
    'AAFF200A00550011BD000100EB004300000000002E0000000000000000000039004C002E100E90000001000604000000000000004101001000000000000004000000000000000000000000000000180000008F81BB',
)
const PAIR_OFF_AFTER_END = buf(
    'AAFF200A00980011CF000100EC008600000000002E0000000000000000000039004C002E100E900000010006040000000000000041010010000000000000040000000000000000000000000000001800000000000000002E0000000000000000000039004C002E00109000000400060400000000000000400000100000000000000400000000000000000000000000000018000000DDA3BB',
)
// TurboWash 39 at 40 C, heating: the energy count rolls over from 255 to 256 Wh.
const PAIR_ENERGY_HIGH_BYTE = buf(
    'AAFF200A00980001A3000100EC00860003030E087A00000000000000001B002700FF007A0B0190090000010B04000000002000001101001000000000000004000000000000000000000000000000180000000003030E087A00000000000000001B00270100007A0B0190090000010B04000000002000001101001000000000000004000000000000000000000000000000180000000421BB',
)
// The first record after mains power came back: off, and every field zeroed, the wash count included.
const AFTER_POWER_CUT = buf(
    'AAFF200A00550005C9000100EB0043000000000000000000000000000000000000000000000000000000000004000000000000000000201000000000000004000000000000000000000000000000180000007749BB',
)

// Quick 14 under way after a remote start, 2026-10-17: Child Lock held on (CL), then off again.
const PAIR_CHILD_LOCK_ON = buf(
    'AAFF200A0098008ED9000100EC00860003010E014B00000000000000000E000E0000004B0B0290090000021504000000002000009101001000000000000004000000000000000000000000000000180000000003010E014B00000000000000000E000E0000004B0B029009000002150400000000200000B101001000000000000004000000000000000000000000000000180000002F90BB',
)
const PAIR_CHILD_LOCK_OFF = buf(
    'AAFF200A0098008EEC000100EC00860003010E014B00000000000000000D000E0008004B0B029009000002150400000000200000B101001000000000000004000000000000000000000000000000180000000003010E014B00000000000000000D000E0009004B0B0290090000021504000000002000009101001000000000000004000000000000000000000000000000180000003804BB',
)

// 2026-10-17, from Ready on Quick 14: Remote Start pressed on the panel.
const PAIR_REMOTE_START_ON = buf(
    'AAFF200A0098008E83000100EC00860003010E014B00000000000000000E000E0000004B010090090001021504000000002000004100001000000000000004000000000000000000000000000000180000000003010E014B00000000000000000E000E0000004B01009009000102150400000000200000510000100000000000000400000000000000000000000000000018000000BE45BB',
)
// Then, from Cotton at its defaults, each option button pressed once: Rinse+ (+15 min), Intensive
// (+31 min), Pre Wash (+17 min), TurboWash (which also took the spin down to 1000).
const PAIR_RINSE_PLUS = buf(
    'AAFF200A0098009060000100EC00860003030E082E0000000000000000CB00CB0000002E010090000004021604000000000000004000001000000000000004000000000000000000000000000000180000000003030F082E0000000000000000DA00DA0000002E01009000000502160400000000000000400040100000000000000400000000000000000000000000000018000000C1A2BB',
)
const PAIR_INTENSIVE = buf(
    'AAFF200A0098009068000100EC00860003030E082E0000000000000000CB00CB0000002E01009000000402160400000000000000400000100000000000000400000000000000000000000000000018000000000A030E082E0000000000000000EA00EA0000002E010090000004021604000000000800004000001000000000000004000000000000000000000000000000180000003A49BB',
)
const PAIR_PREWASH = buf(
    'AAFF200A009800906F000100EC00860003030E082E0000000000000000CB00CB0000002E010090000004021604000000000000004000001000000000000004000000000000000000000000000000180000000003030E082E0000000000000000DC00DC0000002E01009000000502160400000000400000400000100000000000000400000000000000000000000000000018000000C0E0BB',
)
const PAIR_TURBOWASH = buf(
    'AAFF200A0098009077000100EC00860003030E082E0000000000000000CB00CB0000002E010090000004021604000000000000004000001000000000000004000000000000000000000000000000180000000003030E062E0000000000000000A600A60000002E010090000004021604000000002000004000001000000000000004000000000000000000000000000000180000000D53BB',
)
// Timer pressed three times (5:00 on the display), and on another run once (3:00) followed by Start:
// the load weighed, Cotton recalculated to 56 min, and the delay counting down.
const PAIR_DELAY_5H = buf(
    'AAFF200A0098009155000100EC00860003030E082E000000000000B400CB00CB0001002E010090000004021604000000000000004100801000000000000004000000000000000000000000000000180000000003030E082E0000000000012C00CB00CB0001002E010090000004021604000000000000004100801000000000000004000000000000000000000000000000180000005D26BB',
)
const PAIR_DELAYED = buf(
    'AAFF200A0098009125000100EC00860003030E082E000000000000B4003800380000002E070390010000021604000000000000009101801000000000000004000000000000000000000000000000180000000003030E082E000000000000B3003800380000002E07039001000002160400000000000000910180100000000000000400000000000000000000000000000018000000FA24BB',
)
// The appliance's answers to commands: Start refused while Remote Start was off, and taken once it was on.
const START_REFUSED = buf('AA08200024FFA0BB')
const START_TAKEN = buf('AA0820002400A3BB')

const WRITE_STATUS_REQUEST = 'AA0EF0ED1121010000001800B5BB'
const WRITE_POWER_ON = 'AA08F02A010098BB'
const WRITE_POWER_OFF = 'AA09F0240101009CBB'
const WRITE_PAUSE = 'AA09F02404010099BB'
const WRITE_START = 'AA09F02405010098BB'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, props: () => ha.devices[DEVICE_ID].properties }
}

describe(MODEL_ID, () => {
    test('asks for the status once on connect, and never again', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            [WRITE_STATUS_REQUEST],
        )
    })

    test('the 0xeb answer decodes the selected course', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', READY_COTTON)
        assert.equal(props().power, 'ON')
        assert.equal(props().status, 'Standby')
        assert.equal(props().course, 'Cotton')
        assert.equal(props().temp, '40 °C')
        assert.equal(props().spin, '1200 rpm')
        assert.equal(props().initial_time, 203)
        assert.equal(props().remaining_time, 203)
        assert.equal(props().door, 'ON')
        assert.equal(props().tub_clean_count, 5)
    })

    test('a pushed 0xec pair is read from its second record', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', READY_COTTON)
        thinq.emit('data', PAIR_EASY_CARE)
        assert.equal(props().course, 'Easy Care')
        assert.equal(props().initial_time, 148)

        thinq.emit('data', PAIR_DOWNLOAD_CYCLE)
        assert.equal(props().course, 'Download Cycle')
        assert.equal(props().temp, 'None') // Rinse + Spin heats nothing
        assert.equal(props().spin, '1200 rpm')
        assert.equal(props().initial_time, 16)
    })

    test('the zero settings sit past the top of their scales', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', READY_COLD)
        assert.equal(props().temp, 'Cold')

        thinq.emit('data', PAUSED_NO_SPIN)
        assert.equal(props().status, 'Paused')
        assert.equal(props().temp, '60 °C')
        assert.equal(props().spin, 'No spin')
    })

    test('the door', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', READY_COLD)
        assert.equal(props().door, 'ON')
        thinq.emit('data', PAIR_DOOR_CLOSED)
        assert.equal(props().door, 'OFF')
        assert.equal(props().course, 'Mixed Fabric')
        assert.equal(props().spin, '1000 rpm')
    })

    test('a wash, phase by phase', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', PAIR_WASHING)
        assert.equal(props().status, 'Washing')
        assert.equal(props().temp, '30 °C')
        assert.equal(props().initial_time, 57)

        thinq.emit('data', PAIR_RINSING)
        assert.equal(props().status, 'Rinsing')
        assert.equal(props().remaining_time, 37)
        assert.equal(props().energy, 30)
        assert.equal(props().temp, 'None') // cleared once the wash phase is over
        assert.equal(props().spin, '1200 rpm')

        thinq.emit('data', PAIR_SPINNING)
        assert.equal(props().status, 'Spinning')
        assert.equal(props().remaining_time, 11)
        assert.equal(props().energy, 200)
    })

    test('the energy count is 16 bits', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', PAIR_ENERGY_HIGH_BYTE)
        assert.equal(props().course, 'TurboWash 39')
        assert.equal(props().energy, 256)
        assert.equal(props().tub_clean_count, 11)
    })

    test('an idle machine publishes no settings, but keeps its energy total', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', END)
        assert.equal(props().status, 'End')
        assert.equal(props().remaining_time, 0)
        assert.equal(props().spin, 'None')

        thinq.emit('data', PAIR_OFF_AFTER_END)
        assert.equal(props().power, 'OFF')
        assert.equal(props().status, 'Off')
        // course and times are still in the record, but the panel no longer shows them
        assert.equal(props().course, 'None')
        assert.equal(props().initial_time, 'None')
        assert.equal(props().remaining_time, 'None')
        assert.equal(props().energy, 76)
        assert.equal(props().tub_clean_count, 6)
    })

    test('the wash count is not taken from a machine that is off', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', READY_COTTON)
        thinq.emit('data', AFTER_POWER_CUT)
        assert.equal(props().power, 'OFF')
        assert.equal(props().tub_clean_count, 5) // the record read 0 after the power cut
    })

    test('child lock', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', PAIR_CHILD_LOCK_ON)
        assert.equal(props().course, 'Quick 14')
        assert.equal(props().child_lock, 'OFF')
        thinq.emit('data', PAIR_CHILD_LOCK_OFF)
        assert.equal(props().child_lock, 'ON')
        assert.equal(props().energy, 9)
    })

    test('remote start', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', PAIR_REMOTE_START_ON)
        assert.equal(props().remote_start, 'ON')
        assert.equal(props().turbowash, 'ON') // Quick 14's default
        thinq.emit('data', PAIR_WASHING) // a wash started at the panel
        assert.equal(props().remote_start, 'ON')
        thinq.emit('data', READY_COTTON)
        assert.equal(props().remote_start, 'OFF')
    })

    test('the option buttons', () => {
        const { thinq, props } = makeDevice()
        const options = () => [props().rinse_plus, props().intensive, props().prewash, props().turbowash]
        thinq.emit('data', READY_COTTON)
        assert.deepEqual(options(), ['OFF', 'OFF', 'OFF', 'OFF'])
        thinq.emit('data', PAIR_RINSE_PLUS)
        assert.deepEqual(options(), ['ON', 'OFF', 'OFF', 'OFF'])
        assert.equal(props().initial_time, 218)
        thinq.emit('data', PAIR_INTENSIVE)
        assert.deepEqual(options(), ['OFF', 'ON', 'OFF', 'OFF'])
        thinq.emit('data', PAIR_PREWASH)
        assert.deepEqual(options(), ['OFF', 'OFF', 'ON', 'OFF'])
        thinq.emit('data', PAIR_TURBOWASH)
        assert.deepEqual(options(), ['OFF', 'OFF', 'OFF', 'ON'])
        assert.equal(props().spin, '1000 rpm')
    })

    test('delay end', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', READY_COTTON)
        assert.equal(props().delay_end, 0)
        thinq.emit('data', PAIR_DELAY_5H)
        assert.equal(props().delay_end, 300)

        thinq.emit('data', PAIR_DELAYED)
        assert.equal(props().status, 'Delayed')
        assert.equal(props().delay_end, 179)
        assert.equal(props().remaining_time, 56)
    })

    test('a refused command is logged', () => {
        const { thinq } = makeDevice()
        const logged = captureLog()
        try {
            thinq.emit('data', START_TAKEN)
            thinq.emit('data', START_REFUSED)
            const refusals = logged.calls
                .map((c) => c.arguments as unknown[])
                .filter((args) => args.includes('command refused'))
            assert.equal(refusals.length, 1)
            assert.ok(refusals[0].includes('200024ff'))
        } finally {
            logged.restore()
        }
    })

    test('every envelope is acked by its sequence number', () => {
        const { thinq } = makeDevice()
        thinq.emit('data', READY_COTTON)
        thinq.emit('data', PAIR_EASY_CARE)
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, [
            AABBDevice.frame(buf('f0000a04c7f9')).toString('hex').toUpperCase(),
            AABBDevice.frame(buf('f0000a04c818')).toString('hex').toUpperCase(),
        ])
    })

    test('commands', () => {
        const { thinq, dev } = makeDevice()
        const sent = () => thinq.outbox.map((b) => b.toString('hex').toUpperCase())
        dev.setProperty('power', 'ON')
        dev.setProperty('power', 'OFF')
        dev.setProperty('pause', '')
        dev.setProperty('start', '')
        assert.deepEqual(sent(), [WRITE_POWER_ON, WRITE_POWER_OFF, WRITE_PAUSE, WRITE_START])
    })
})
