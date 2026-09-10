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
const CHILD_LOCK_ON = buf(
    'AA3C30EC00190000000000000000000000000000000000000001000000770000190100000000000000000000000000080800000000000000770061BB',
)
const CHILD_LOCK_OFF = buf(
    'AA3C30EC00190100000000000000000000000000080800000000000000770000190100000000000000000000000000000800000000000000770069BB',
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
const CONDENSER_CARE_RUNNING = buf(
    'AA3C30EC00190301000100160000030103000300091900000002000000770000190201140114120000030100000000001908000003000000770084BB',
)
const SHIRTS_LOW_AC_ON_RESERVED_3H = buf(
    'AA3C30EC001902010A010A050002020203000300031B000000030000007700001902010A010A0500020202023B023B031B0000000300000077007FBB',
)
const TOWEL_RESERVED_3H = buf(
    'AA3C30EC00190301000100170000020204000400091B0000000200000077000019020128012802000002000300030001990000000300000077003EBB',
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
            CONDENSER_CARE_RUNNING,
            SHIRTS_LOW_AC_ON_RESERVED_3H,
            TOWEL_RESERVED_3H,
        ])
            assertIntact(frame)
    })

    test('exposes the common read-only status sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'anti_crease',
            'anti_crease_select',
            'child_lock',
            'course',
            'course_select',
            'dry_level',
            'dry_level_select',
            'eco_hybrid',
            'eco_hybrid_select',
            'error',
            'error_message',
            'pause',
            'power',
            'power_off',
            'remote_start',
            'reserve_hours',
            'resume',
            'smart_diagnosis',
            'start_course',
            'status',
            'steam',
        ])
        for (const [id, component] of Object.entries(components)) {
            if (
                id === 'pause' ||
                id === 'power_off' ||
                id === 'start_course' ||
                id === 'resume' ||
                id === 'course_select' ||
                id === 'reserve_hours' ||
                id === 'dry_level_select' ||
                id === 'eco_hybrid_select' ||
                id === 'anti_crease_select'
            )
                assert.equal(component.command_topic, `$this/${id}/set`)
            else assert.equal(component.command_topic, undefined)
        }
        assert.equal(components.pause.platform, 'button')
        assert.equal(components.pause.payload_press, '')
        assert.equal(components.power_off.platform, 'button')
        assert.equal(components.power_off.payload_press, '')
        assert.equal(components.course.device_class, 'enum')
        assert.equal(components.dry_level.device_class, 'enum')
        assert.equal(components.eco_hybrid.device_class, 'enum')
        assert.equal(components.power.icon, 'mdi:power')
        assert.equal(components.status.icon, 'mdi:tumble-dryer')
        assert.equal(components.child_lock.device_class, 'lock')
        assert.equal(components.error.device_class, 'problem')
        assert.equal(components.error_message.device_class, 'enum')
        assert.equal(components.error_message.entity_category, 'diagnostic')
        assert.equal(components.smart_diagnosis.device_class, 'problem')
    })

    test('decodes the current real powered-off EB snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
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
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Normal')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'OFF')
        thinq.emit('data', withState(8))
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Smart diagnosis')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_diagnosis, 'ON')
    })

    test('maps the model-declared error byte and safely handles an undefined code', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withError(1))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'tE1')
        thinq.emit('data', withError(0))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'Normal')
        thinq.emit('data', withError(3))
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.error_message, 'None')
    })

    test('uses the captured process sub-state for Detecting, Drying, then Pause', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD_DETECTING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Detecting')
        thinq.emit('data', STANDARD_DRYING)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Drying')
        thinq.emit('data', STANDARD_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Pause')
    })

    test('reports Reserved while a real 19h or 3h reservation is pending', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD_ENERGY_DELICATE_RESERVED_19H)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Reserved')
        thinq.emit('data', STANDARD_SPEED_LOW_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Reserved')
    })

    test('decodes child lock from the isolated real ON and OFF transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        thinq.emit('data', CHILD_LOCK_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
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
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Delicate')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Energy')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', SHIRTS_LOW_AC_ON_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Easy Care')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'Light')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Auto')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', DUVET_RESERVED_4H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Bulky Item')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Speed')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', TOWEL_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Towel')
        assert.equal(ha.devices[DEVICE_ID].properties.dry_level, 'None')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid, 'Auto')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'OFF')
        thinq.emit('data', STEAM_REFRESH_RESERVED_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Steam Refresh')
        assert.equal(ha.devices[DEVICE_ID].properties.steam, 'ON')
        thinq.emit('data', CONDENSER_CARE_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Condenser Care')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Steam')
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
        dev.setProperty('dry_level_select', 'Strong')
        dev.setProperty('eco_hybrid_select', 'Speed')
        dev.setProperty('anti_crease_select', 'On')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox[0].toString('hex'), 'aa14f0260705030000000300000201000000bcbb')
        // Easy Care allows Light/Standard only: Strong leaves the template byte.
        const easy = makeDevice()
        easy.dev.setProperty('course_select', 'Easy Care')
        easy.dev.setProperty('dry_level_select', 'Strong')
        easy.dev.setProperty('eco_hybrid_select', 'Speed')
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

    test('selecting a course resets options to the model defaults', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('course_select', 'Bulky Item')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Bulky Item')
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease_select, 'On')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid_select, 'Speed')
        dev.setProperty('course_select', 'Sports Wear')
        assert.equal(ha.devices[DEVICE_ID].properties.anti_crease_select, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.eco_hybrid_select, 'Energy')
    })

    test('invalid select values fall back to the remembered defaults', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Rack Dry')
        dev.setProperty('reserve_hours', '20')
        dev.setProperty('dry_level_select', 'Damp')
        dev.setProperty('start_course', '')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Standard')
        assert.equal(thinq.outbox[0].toString('hex'), 'aa14f0260703020000000000000001000000b4bb')
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
