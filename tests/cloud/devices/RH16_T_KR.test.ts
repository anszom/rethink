import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RH16_T_KR'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RH16_T_KR', modelName: 'RH16_T_KR', swVersion: '2.10.122' }

// Real frames captured from the owner's RH16_T_KR. OFF is the current state
// after a live reconnect; INITIAL and the EC transition are historical traffic
// from the same appliance.
const OFF = buf('AA2130EB00190000000000000000000000000000000000000000000000770023BB')
const INITIAL = buf('AA2130EB001901000000000000000000000000000804000000000000007700D6BB')
const DOUBLE_INITIAL = buf(
    'AA3C30EC00190100000000000000000000000000080400000000000000770000190100000000000000000000000000000400000000000000770061BB',
)
// Owner toggled child lock ON then OFF on the appliance while a reserved
// Steam Refresh run waited. rec[15] went 0x01 -> 0x11 -> 0x01, and in both
// frames that byte was the only one in the record to change.
const CHILD_LOCK_ON = buf(
    'AA3C30EC0019030020002001000002010D380D38010A0800050200000077000019030020002001000002010D380D38110A0800050200000077005DBB',
)
const CHILD_LOCK_OFF = buf(
    'AA3C30EC0019030020002001000002010D380D38110A0800050200000077000019030020002001000002010D380D38010A0800050200000077005DBB',
)
const REMOTE_START_ON = buf(
    'AA3C30EC00190100000000000000000000000000000900000000000000770000190100000000000000000000000000001900000000000000770013BB',
)
const REMOTE_START_OFF = buf(
    'AA3C30EC00190100000000000000000000000000001900000000000000770000190100000000000000000000000000001800000000000000770000BB',
)
const STANDARD_DETECTING = buf(
    'AA3C30EC00190100000000000000000000000000001900000000000000770000190201280128070003020000000000009B0000000100000077006DBB',
)
const STANDARD_DRYING = buf(
    'AA3C30EC00190201280128070003020000000000009B000000010000007700001902010F010F070003020200000000001B0000000100000077003FBB',
)
// Real captures from the 04:21 drying cycle (app daily total: 694Wh).
// record+18 (16-bit BE) is the this-cycle Wh counter, x1.
const ENERGY_MID_CYCLE = buf(
    'aa3c30ec00190201080114120000030300000000201b0800ad01000000770000190201070114120000030300000000201b0800b001000000770023bb',
)
const ENERGY_AT_COMPLETION = buf(
    'aa3c30ec00190200010114120000030500000000001b0802b301000000770000190400010114120000030700000000081a0802b602000000770012bb',
)
const STANDARD_PAUSED = buf(
    'AA3C30EC001902010F010F070003020200000000001B000000010000007700001903010F010F070003020200000000081B00000002000000770091BB',
)
const STANDARD_ENERGY_DELICATE_RESERVED_19H = buf(
    'AA3C30EC001903010C010F0700030202000000000819000005020000007700001902001E001E070001010013001300019B000000030000007700D1BB',
)
const STANDARD_SPEED_LOW_RESERVED_3H = buf(
    'AA3C30EC001903013701370700010102123A123A091B000000020000007700001902001E001E07000203000300030001990000000300000077001EBB',
)
const ANTI_CREASE_ON = buf(
    'AA3C30EC001903011401140700040202033B033B0919000000020000007700001902001E001E0700050300030003000399000000030000007700A5BB',
)
const ANTI_CREASE_OFF = buf(
    'AA3C30EC001902001E001E070005030003000300019B000000030000007700001902001E001E070005030003000300019900000003000000770051BB',
)
const DUVET_RESERVED_4H = buf(
    'AA3C30EC00190202370237040000030204000400031B00000003000000770000190202370237040000030204000400031900000003000000770039BB',
)
const STEAM_REFRESH_RESERVED_3H = buf(
    'AA3C30EC001903010A010A0500020202023B023B0B1900000002000000770000190200200020010000020103000300011908000003000000770002BB',
)
const STEAM_REFRESH_RESUMED_11H = buf(
    'AA3C30EC0019030020002001000002010B000B0001190800010200000077000019020020002001000002010B000B00011908000103000000770073BB',
)
const STEAM_REFRESH_RESERVED_14H_PARTWAY = buf(
    'AA3C30EC0019030020002001000002010D380D3801130800010200000077000019030020002001000002010D380D38011B0800010200000077005FBB',
)
const CONDENSER_CARE_RUNNING = buf(
    'AA3C30EC00190301000100160000030103000300091900000002000000770000190201140114120000030100000000001908000003000000770084BB',
)
const SHIRTS_LOW_AC_ON_RESERVED_3H = buf(
    'AA3C30EC001902010A010A050002020203000300031B000000030000007700001902010A010A0500020202023B023B031B0000000300000077007FBB',
)
const TOWEL_RESERVED_3H = buf(
    'AA3C30EC00190301000100170000020204000400091B0000000200000077000019020128012802000002000300030001990000000300000077003EBB',
)
// Owner-confirmed Big Size Item 3h reservation. All ten live download-course
// reservations matched the execution-id/signature pair encoded in F025.
const BIG_SIZE_ITEM_RESERVED_3H = buf(
    'AA3C30EC00190202370237040000030203000300011B000000017100007100001902023702370400000302023B023B011B000000017100007100F9BB',
)
const STATUS_REQUEST = 'aa0ef0ed1121010000001800b5bb'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function assertIntact(packet: Buffer) {
    assert.equal(packet[1], packet.length)
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    assert.equal(packet[packet.length - 2], (sum & 0xff) ^ 0x55)
}

/** Model-declared state probe derived from a real frame; not capture evidence. */
function withState(state: number) {
    const packet = Buffer.from(OFF)
    packet[6] = state
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

/** Model-declared error probe derived from a real frame; not capture evidence. */
function withError(error: number) {
    const packet = Buffer.from(OFF)
    packet[12] = error
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    packet[packet.length - 2] = (sum & 0xff) ^ 0x55
    return packet
}

describe('RH16_T_KR read-only status', () => {
    test('real capture fixtures have intact AA/BB envelopes', () => {
        for (const frame of [
            OFF,
            INITIAL,
            DOUBLE_INITIAL,
            CHILD_LOCK_ON,
            CHILD_LOCK_OFF,
            REMOTE_START_ON,
            REMOTE_START_OFF,
            STANDARD_DETECTING,
            STANDARD_DRYING,
            STANDARD_PAUSED,
            STANDARD_ENERGY_DELICATE_RESERVED_19H,
            STANDARD_SPEED_LOW_RESERVED_3H,
            ANTI_CREASE_ON,
            ANTI_CREASE_OFF,
            DUVET_RESERVED_4H,
            STEAM_REFRESH_RESERVED_3H,
            STEAM_REFRESH_RESUMED_11H,
            STEAM_REFRESH_RESERVED_14H_PARTWAY,
            CONDENSER_CARE_RUNNING,
            SHIRTS_LOW_AC_ON_RESERVED_3H,
            TOWEL_RESERVED_3H,
            BIG_SIZE_ITEM_RESERVED_3H,
        ])
            assertIntact(frame)
    })

    test('decodes the current real powered-off EB snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'OK')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Off')
        // The installed download is reported even while powered off.
        assert.equal(ha.devices[DEVICE_ID].properties.download_course, 'Super Dry')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Not selected')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Not selected')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 0)
    })

    test('publishes this-cycle energy from the record+18 Wh counter', () => {
        // Real 04:21 cycle captures: the counter rises 176 -> 694 and the
        // ThinQ app reported 694Wh for the day, so the value is Wh x1 —
        // the same convention as the F24VDD washer.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ENERGY_MID_CYCLE)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 176)
        thinq.emit('data', ENERGY_AT_COMPLETION)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 694)
    })

    test('decodes the real Initial EB snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
    })

    test('uses the current record in a real EC frame', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF)
        thinq.emit('data', DOUBLE_INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
    })

    test('keeps Error separate from the state enum and derives it from the error code', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withState(5))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Error')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'OK')
        thinq.emit('data', withState(8))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Smart Diagnosis')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
    })

    test('maps the model-declared error byte', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withError(1))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Temperature sensor error (tE1)')
        thinq.emit('data', withError(0))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'OK')
        thinq.emit('data', withError(3))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'None')
    })

    test('reports the captured process sub-state as Phase while a cycle runs', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD_DETECTING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Drying')
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Detecting')
        thinq.emit('data', STANDARD_DRYING)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Drying')
        thinq.emit('data', STANDARD_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Paused')
        thinq.emit('data', INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'None')
    })

    test('a pending reservation sets Delay end, from the same rec[15] byte as anti_crease, bit 0x01', () => {
        // The appliance itself reports Running while it waits; the flag and the countdown carry the
        // reservation, as on RC90U2_WW.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD_ENERGY_DELICATE_RESERVED_19H)
        assert.equal(ha.devices[DEVICE_ID].properties.delay, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 19 * 60)
        thinq.emit('data', STANDARD_SPEED_LOW_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.delay, 'ON')
        thinq.emit('data', OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.delay, 'OFF')
    })

    test('decodes child lock from the isolated real ON and OFF transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        thinq.emit('data', CHILD_LOCK_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
    })

    test('does not mistake the unrelated 0x08 bit for child lock', () => {
        // The first mapping used rec[15] bit 0x08, which is also set in plain
        // idle and paused captures the owner never locked. Those have to read
        // OFF or the lock is reported on for a dryer nobody locked.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', INITIAL)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
        thinq.emit('data', STANDARD_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
    })

    test('keeps child lock and anti-crease on separate bits of the same byte', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease, 'OFF')
    })

    test('decodes anti-crease from the single-toggle ON and OFF pair', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_CREASE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease, 'ON')
        thinq.emit('data', ANTI_CREASE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease, 'OFF')
    })

    test('decodes remote start from the isolated real ON and OFF transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', REMOTE_START_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
        thinq.emit('data', REMOTE_START_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
    })

    test('decodes course, dry level, eco and steam from real reservation frames', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD_ENERGY_DELICATE_RESERVED_19H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Standard')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Damp')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Eco')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 30)
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 30)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 19 * 60)
        thinq.emit('data', SHIRTS_LOW_AC_ON_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Easy Care')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Less')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', DUVET_RESERVED_4H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Bulky Item')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Not selected')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Turbo')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', TOWEL_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Towel')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Not selected')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', STEAM_REFRESH_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Steam Refresh')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
        thinq.emit('data', STEAM_REFRESH_RESUMED_11H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Steam Refresh')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Not selected')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.delay, 'ON')
        thinq.emit('data', CONDENSER_CARE_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Condenser Care')
        assert.equal(ha.devices[DEVICE_ID].properties.phase, 'Steam')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
    })

    test('Start course replays the captured template per course with reserve folded in', () => {
        const cases: Array<[string, string, string]> = [
            ['Steam Refresh', '0', 'aa14f0260100020000000000000003080000b7bb'],
            ['Towel', '0', 'aa14f02602000200000000000000030000008ebb'],
            ['Bulky Item', '0', 'aa14f0260400030000000000000203000000b5bb'],
            ['Easy Care', '0', 'aa14f0260503020000000000000003000000b4bb'],
            ['Standard', '0', 'aa14f0260703020000000000000001000000b4bb'],
            ['Sports Wear', '0', 'aa14f0260800010000000000000003000000b5bb'],
            ['Quick Dry', '0', 'aa14f0260900030000000000000203000000b0bb'],
            ['Wool', '0', 'aa14f0260b00020000000000000003000000b1bb'],
            ['Bedding Brush', '0', 'aa14f0260f00030000000000000003000000bcbb'],
            ['Allergy Care', '0', 'aa14f0261000030000000000000003080000a7bb'],
            ['Condenser Care', '0', 'aa14f0261200030000000000000003080000a1bb'],
            ['Tub Clean', '0', 'aa14f0261300030000000000000003080000a0bb'],
            ['Padding Refresh', '0', 'aa14f0261400030000000000000003000000bbbb'],
            ['Time Dry', '0', 'aa14f0261500021e0000000000000300000059bb'],
            ['Outdoor Refresh', '0', 'aa14f0261600033c0000000000000300000079bb'],
            ['Baby Wear', '0', 'aa14f0261700020000000000000003000000a5bb'],
            ['Standard', '3', 'aa14f0260703020000000300000001000000b1bb'],
        ]
        for (const [course, reserve, expected] of cases) {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', course)
            dev.setProperty('reserve_hours', reserve)
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1, course)
            assert.equal(thinq.outbox[0].toString('hex'), expected, course)
        }
    })

    test('Start course folds dry, eco and anti-crease in only where the model allows', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Standard')
        dev.setProperty('dry_level_select', 'Very')
        dev.setProperty('eco_hybrid_select', 'Turbo')
        dev.setProperty('anti_crease_select', 'On')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox[0].toString('hex'), 'aa14f0260705030000000300000201000000bcbb')
        // Easy Care allows Less/Normal only: Very leaves the template byte.
        const easy = makeDevice()
        easy.dev.setProperty('course_select', 'Easy Care')
        easy.dev.setProperty('dry_level_select', 'Very')
        easy.dev.setProperty('eco_hybrid_select', 'Turbo')
        easy.dev.setProperty('start_course', '')
        assert.equal(easy.thinq.outbox[0].toString('hex'), 'aa14f0260503020000000000000003000000b4bb')
        // Condenser Care declares no anti-crease: On leaves the template byte.
        const cond = makeDevice()
        cond.dev.setProperty('course_select', 'Condenser Care')
        cond.dev.setProperty('anti_crease_select', 'On')
        cond.dev.setProperty('start_course', '')
        assert.equal(cond.thinq.outbox[0].toString('hex'), 'aa14f0261200030000000000000003080000a1bb')
    })

    test('Resume replays the remembered full start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa14f0260703020000000000000001000000b4bb')
    })

    test('reserve_hours=1 or 2 is refused: LG declares 0 or 3..19, not 1 or 2', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('reserve_hours', '1')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 0)
        dev.setProperty('reserve_hours', '2')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 0)
        // 0 and the declared 3..19 bounds remain accepted.
        dev.setProperty('reserve_hours', '3')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 3)
        dev.setProperty('reserve_hours', '19')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 19)
        dev.setProperty('reserve_hours', '20')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_hours, 19)
    })

    test('selecting a course resets options to the model defaults', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('course_select', 'Bulky Item')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Bulky Item')
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease_select, 'On')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid_select, 'Turbo')
        dev.setProperty('course_select', 'Sports Wear')
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease_select, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid_select, 'Eco')
    })

    test('invalid select values fall back to the remembered defaults', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Rack Dry')
        dev.setProperty('reserve_hours', '20')
        dev.setProperty('dry_level_select', 'Delicate')
        dev.setProperty('start_course', '')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Standard')
        assert.equal(thinq.outbox[0].toString('hex'), 'aa14f0260703020000000000000001000000b4bb')
    })

    test('counts the reserve minute byte, not just whole hours', () => {
        // A 14h reservation read 13h56m left: rec[11]=13, rec[12]=56. Reading
        // the hour alone reported 780 minutes for a 836-minute countdown.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STEAM_REFRESH_RESERVED_14H_PARTWAY)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 13 * 60 + 56)
        assert.equal(ha.devices[DEVICE_ID].properties.delay, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Steam Refresh')
    })

    test('every Status value it can publish is a declared option', () => {
        // device_class enum forces any value outside options to unknown, so a
        // fallback like `Code 12` would blank the entity instead of informing.
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as unknown as Record<string, { options: string[] }>
        const frames = [
            INITIAL,
            OFF,
            STANDARD_ENERGY_DELICATE_RESERVED_19H,
            STANDARD_DETECTING,
            STANDARD_DRYING,
            STANDARD_PAUSED,
            STEAM_REFRESH_RESERVED_14H_PARTWAY,
            CONDENSER_CARE_RUNNING,
            CHILD_LOCK_ON,
        ]
        for (const frame of frames) {
            thinq.emit('data', frame)
            const { status } = ha.devices[DEVICE_ID].properties
            assert.ok(components.status.options.includes(status as string), `status ${status}`)
        }
    })

    test('offers only startable courses and captured downloads in the selects', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as unknown as Record<string, { options: string[] }>
        assert.ok(!components.course_select.options.includes('Off'))
        // Every offered native course and Downloaded Course has a start path.
        assert.equal(components.course_select.options.length, 17)
        assert.ok(components.course_select.options.includes('Downloaded Course'))
        assert.deepEqual(components.smart_course_select.options, [
            'Super Dry',
            'Minimize Wrinkles',
            'Full Size Load',
            'Deodorization',
            'Small Load',
            'Gym Clothes',
            'Rainy Season',
            'Economic Dry',
            'Easy Iron',
            'Big Size Item',
        ])
    })

    test('Power off reproduces the exact ThinQ app command captured by MCP', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('power_off', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa09f0240101009cbb')
    })

    test('Pause reproduces the exact ThinQ app command captured by MCP', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa09f02404010099bb')
    })

    test('Smart course select installs the download straight away', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', OFF)
        dev.setProperty('smart_course_select', 'Super Dry')
        assert.equal(
            thinq.outbox[thinq.outbox.length - 1]?.toString('hex'),
            'aa1df0250315000264000000000000001177000000000000000000b7bb',
        )
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, 'Super Dry')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Downloaded Course')
    })

    test('installing a download course replays the exact captured app bytes', () => {
        // Both install frames were captured live from the ThinQ app's own
        // toDevice traffic while the owner downloaded each course.
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Super Dry')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df0250315000264000000000000001177000000000000000000b7bb')
    })

    test('installing the second download course replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Minimize Wrinkles')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df025031500025a0000000002000007720000000300000000009bbb')
    })

    test('installing Full Size Load replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Full Size Load')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df02503150003640000000000000007740000000500000000008ebb')
    })

    test('installing Deodorization replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Deodorization')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df0250315000314000000000000000f6b000000000000000000d0bb')
    })

    test('installing Small Load replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Small Load')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df025031500031e000000000000000e6c000000000000000000dabb')
    })

    test('installing Gym Clothes replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Gym Clothes')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df025031500013d000000000000000866000000000000000000f5bb')
    })

    test('installing Rainy Season replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Rainy Season')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df0250315000328000000000000000e69000000000000000000c3bb')
    })

    test('installing Economic Dry replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Economic Dry')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df025031500017d000000000000000770000000030000000000b9bb')
    })

    test('installing Easy Iron replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Easy Iron')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df025031500034100000000000000076e000000010000000000fbbb')
    })

    test('installing Big Size Item replays its captured bytes', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Big Size Item')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df02503150003af0000000000000004710000000000000000004ebb')
    })

    test('refuses a download course with no captured install blob', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('a running download is the course, and the installed one is read from rec[24]', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.start()
        thinq.emit('data', BIG_SIZE_ITEM_RESERVED_3H)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.course, 'Big Size Item')
        assert.equal(p.download_course, 'Big Size Item')
        assert.equal(p.smart_course_select, 'Big Size Item')
        assert.equal(p.course_select, 'Downloaded Course')
        // A native course on another frame leaves the installed download as reported.
        thinq.emit('data', STANDARD_DETECTING)
        assert.equal(p.course, 'Standard')
        assert.equal(p.course_select, 'Standard')
        assert.equal(p.download_course, 'Super Dry')
    })

    test('Start course on Downloaded Course runs the download the appliance reports', () => {
        // rec[24] = 119 on the powered-off capture: Super Dry is installed, whoever installed it.
        const { thinq, dev } = makeDevice()
        thinq.emit('data', OFF)
        dev.setProperty('course_select', 'Downloaded Course')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa14f026110002640000000000000300770090bb')
    })

    test('starts Super Dry through Downloaded Course with the captured F026 frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Super Dry')
        dev.setProperty('course_select', 'Downloaded Course')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 2)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1df0250315000264000000000000001177000000000000000000b7bb')
        assert.equal(thinq.outbox[1].toString('hex'), 'aa14f026110002640000000000000300770090bb')
    })

    test('starts Minimize Wrinkles through Downloaded Course with the captured F026 frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Minimize Wrinkles')
        dev.setProperty('course_select', 'Downloaded Course')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 2)
        assert.equal(thinq.outbox[1].toString('hex'), 'aa14f0260703025a00000000000203007200e4bb')
    })

    test('builds a checksummed start frame for every captured download definition', () => {
        const expected: Record<string, string> = {
            'Super Dry': 'aa14f026110002640000000000000300770090bb',
            'Minimize Wrinkles': 'aa14f0260703025a00000000000203007200e4bb',
            'Full Size Load': 'aa14f0260705036400000000000003007400ebbb',
            Deodorization: 'aa14f0260f00031400000000000003006b003dbb',
            'Small Load': 'aa14f0260e00031e00000000000003006c0027bb',
            'Gym Clothes': 'aa14f0260800013d00000000000003006600d6bb',
            'Rainy Season': 'aa14f0260e000328000000000000030069002cbb',
            'Economic Dry': 'aa14f0260703017d000000000000030070009abb',
            'Easy Iron': 'aa14f0260701034100000000000003006e00c4bb',
            'Big Size Item': 'aa14f026040003af00000000000003007100abbb',
        }
        for (const [course, frame] of Object.entries(expected)) {
            const { thinq, dev } = makeDevice()
            dev.setProperty('smart_course_select', course)
            dev.setProperty('course_select', 'Downloaded Course')
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox[1].toString('hex'), frame, course)
            assertIntact(thinq.outbox[1])
        }
    })

    test('does not guess a downloaded start or resume without captured state', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Downloaded Course')
        dev.setProperty('start_course', '')
        dev.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('asks only for the family-wide read-only status snapshot on connect', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), STATUS_REQUEST)
    })

    test('ignores other device types and malformed RH16 status shapes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA2120EB00190000000000000000000000000000000000000000000000770033BB'))
        thinq.emit('data', buf('AA0730EB00A8BB'))
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.status, undefined)
    })
})
