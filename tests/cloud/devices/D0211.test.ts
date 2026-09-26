import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/D0211'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'D0211'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1' }

// Real wire frames from bridge captures of a DB365TXS / DBC435TSL dishwasher.
//
// These are complete AABB packets: the driver strips the AA+length prefix and the checksum+BB
// suffix before processAABB, so inside the body index 0 is the inner type, the CURRENT record
// starts at body[28] on an 0xec frame (record1 is the prior minute) and at body[2] on an 0xeb
// one. Offsets below are relative to the current record, so in a packet they land at
// 30 + offset for 0xec.
const OPTION_BYTE = 14
const CURRENT_RECORD_0XEC = 30

// State 0x01 with a program selected on the panel: course 0x02 (Intensive) and the steam bit
// set while the load is prepared. 0xeb = single (current) record. It is the same state the
// appliance reports while merely idle (see IDLE_ECO), so no cycle entity here is ON.
const SENSING_STEAM = buf('AA2032EB0018010000040B0200040B0000728002040100000000000000004CBB')

// Idle with the panel awake, 2026-09-25 12:15:52, straight off the live bridge after the
// switch: the cycle had ended at 11:01 and the door was open, while the cloud's own on/off
// sensor read `off`. State 0x01, process 0x00, course 0x05 (Eco = 3:53 selected on the panel).
const IDLE_ECO = buf(
    'AA3A32EC001801000003350500033500007200020401000000000000000008180100000335050003350000720002040100000000000000004DBB',
)

// RUNNING, steam on: record1 is the rinsing minute, record2 the drying one (current).
const RUNNING_DRY_STEAM = buf(
    'AA3A32EC0018020300040B0200011F0000708002040100000000000000000018020400040B0200011F000070800204010000000000000000D8BB',
)

// Cycle end: record1 is the last running minute (steam bit still set), record2 is the state
// 0x05 completing record, where the options byte has already cleared while the course byte
// still reads 0x02. Reading record1 instead of record2 would publish steam ON here.
const COMPLETING_OPTIONS_CLEARED = buf(
    'AA3A32EC0018020400040B020000010000728002040100000000000000000018050500040B020000010000720002040100000000000000008DBB',
)

// END: state 0x04, course and options both 0x00.
const END = buf(
    'AA3A32EC0018050500040B020000010000720002040100000000000000000018040000040B0000000100007200020401000000000000000001BB',
)

// Intensive with no options: same programme, same course byte, options byte 0x00. Also the base
// for the bit-level tests below, so that a single flipped bit is the only thing lit.
const RUNNING_INTENSIVE_NO_OPTIONS = buf(
    'AA3A32EC001801000003050200030500007200020401000000000000000000180202000305020003050000700002040100000000000000001EBB',
)

// Auto + Dual Zone, 2026-09-25: against the plain Auto baseline the only constant-byte
// difference is rec[14] 0x00 -> 0x10, and the initial time is unchanged at 2:42, so the option
// costs no time. record2 is the current minute (rec[13]=0x70, door closed).
const RUNNING_DUAL_ZONE = buf(
    'AA3A32EC0018010000022A0100022A0000721002040100000000000000000818020200022A0100022A00007010020401000000000000000054BB',
)

// Auto + Energy Saver, 2026-09-18, with the salt indicator lit: record2 rec[13]=0x78 is the
// usual 0x70 plus bit 3 (salt), with the door bit clear (record1 reads 0x7a, door still open).
const RUNNING_SALT = buf(
    'AA3A32EC001801000002390100023900007A020204010000000000000000081802020002390100023900007802020401000000000000000064BB',
)

// The delay-start countdown, 2026-09-26 13:41:51: record2 is state 0x02 with process 0x01, which
// is not a wash — the appliance held exactly this state for 59m36s (61 records). rec[14]=0x11 is
// delay start (bit 0) together with dual zone (bit 4), and the remaining time still reads the full
// 3:53: the reservation is not counted down in this frame. record1 is the panel one minute
// earlier, idle at state 0x01, carrying the same 0x11 — the selection the countdown runs on.
const COUNTDOWN_DELAY_START = buf(
    'AA3A32EC0018010000033505000335000072110204010000000000000000001802010003350500033501007011020401000000000000000066BB',
)

// Idle with the panel awake and High Temp selected, 2026-09-26 13:35:48: state 0x01, process
// 0x00, rec[14]=0x18 (high temp bit 3 plus dual zone bit 4). Against the same programme with no
// options the initial time reads 3:50 instead of 2:42, so the option costs 68 minutes.
const IDLE_HIGH_TEMP = buf(
    'AA3A32EC0018010000033201000332000072080204010000000000000000001801000003320100033200007218020401000000000000000049BB',
)

// Idle with the panel awake and Control Lock engaged, 2026-09-26 13:38:31: rec[13]=0x73 is the
// 0x70 base plus bit 0. The next record in the capture reads 0x72, the lock released again, so
// the bit was measured in both directions.
const IDLE_CHILD_LOCK = buf(
    'AA3A32EC0018010000033201000332000072180204010000000000000000001801000003320100033200007318020401000000000000000078BB',
)

// Idle with the panel awake, Half Load (upper basket) and Extra Dry selected, 2026-09-26
// 13:39:46: rec[14]=0x44 is half load (bit 6) plus extra dry (bit 2).
const IDLE_HALF_LOAD_EXTRA_DRY = buf(
    'AA3A32EC0018010000031201000312000072540204010000000000000000001801000003120100031200007244020401000000000000000041BB',
)

// Drying on Eco with the rinse aid empty, 2026-09-26 17:42:24: rec[13]=0x76 is the 0x70 base plus
// the door bit and bit 2, which the panel's rinse-aid lamp confirmed by eye at the same minute.
const RUNNING_RINSE_REFILL = buf(
    'AA3A32EC001802040003350500003800007210020401000000000000000000180204000335050000380000761002040100000000000000006BBB',
)

// The cycle-counter frame, once per cycle at the rinse->dry transition (here 0x11).
const TRANSITION = buf('AA0732D81199BB')

// Device identity handshake (flag 0x31) — not a status frame, must be ignored.
const HANDSHAKE = buf(
    'AA373231020153414134313236333932350000D1DB00008000000000000253414134313236313032300000FFA7FFFC000000000000A5BB',
)

// Set one bit in the current record of a real frame. Used only by the defensive tests below: the
// bit positions the decode publishes are the ones measured here, so this helper never stands in
// for a captured frame as evidence — it only checks that a bit nobody publishes stays silent.
function withBit(frame: Buffer, offset: number, bit: number): Buffer {
    const copy = Buffer.from(frame)
    copy[CURRENT_RECORD_0XEC + offset] |= bit
    return copy
}

const OPTION_PROPS = ['delay_start', 'energy_saver', 'dual_zone', 'steam'] as const

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function propsOf(ha: MockHAConnection) {
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('config declares exactly the entities the decode feeds, and nothing else', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        // Pinned on purpose. A component declared here but never published appears in Home
        // Assistant as a permanently unknown entity, so this list must equal what processAABB
        // can fill: extend it only together with the decode that feeds the new entity.
        assert.deepEqual(Object.keys(components).sort(), [
            'child_lock',
            'current_course',
            'delay_start',
            'door_open',
            'dual_zone',
            'energy_saver',
            'initial_time',
            'process_state',
            'remaining_time',
            'rinse_refill',
            'run_state',
            'running',
            'salt_refill',
            'steam',
            'tub_clean_counter',
        ])
        assert.equal(
            (components.steam as Record<string, unknown>).default_entity_id,
            'binary_sensor.lg_dishwasher_steam',
        )
        // A duration sensor needs a unit and a number: an "H:MM:SS" string makes it unavailable.
        for (const c of ['initial_time', 'remaining_time']) {
            const comp = components[c] as Record<string, unknown>
            assert.equal(comp.device_class, 'duration', `${c} device class`)
            assert.equal(comp.unit_of_measurement, 'min', `${c} unit`)
        }
    })

    test('every declared component is reachable from the frames the decode reads', () => {
        // The other direction of the entity set: a component left declared after its publish call
        // was removed is just as much a phantom, and the pinned list above cannot see it. Every
        // publish is unconditional for the frame that carries it, so one status frame plus the
        // counter frame fill all fifteen and the two sets must match exactly.
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        thinq.emit('data', RUNNING_INTENSIVE_NO_OPTIONS)
        thinq.emit('data', TRANSITION)

        assert.deepEqual(Object.keys(propsOf(ha)).sort(), Object.keys(components).sort())
    })

    test('Intensive with no options publishes the course and every option OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING_INTENSIVE_NO_OPTIONS)
        const props = propsOf(ha)

        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.current_course, 'Intensive')
        assert.equal(props.initial_time, 185)
        assert.equal(props.remaining_time, 185)
        for (const prop of OPTION_PROPS) assert.equal(props[prop], 'OFF', `${prop} OFF`)
        assert.equal(props.door_open, 'OFF')
    })

    test('the steam option bit (rec[14] bit 7) publishes steam ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING_DRY_STEAM)
        const props = propsOf(ha)

        assert.equal(props.steam, 'ON')
        assert.equal(props.energy_saver, 'OFF', 'bit 1 must not be inferred from bit 7')
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Drying')
        assert.equal(props.running, 'ON', 'a real drying phase is a running cycle')
        assert.equal(props.initial_time, 251)
        assert.equal(props.remaining_time, 91)
        assert.equal(props.current_course, 'Intensive')
    })

    test('the delay-start countdown is not a running cycle, but its options are published', () => {
        // The countdown runs at state 0x02 with process 0x01. Gating `running` on the state alone
        // raised the live activity an hour before the wash on 2026-09-26; the options are a
        // separate question, and here the byte carries a real selection.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COUNTDOWN_DELAY_START)
        const props = propsOf(ha)

        assert.equal(props.running, 'OFF', 'the countdown is not a wash')
        assert.equal(props.run_state, 'Running', 'run_state still reports the machine state')
        assert.equal(props.process_state, 'Delay', 'the reservation is a phase, not an unknown')
        assert.equal(props.delay_start, 'ON')
        assert.equal(props.dual_zone, 'ON', 'the option byte holds the selection, not the cycle')
        assert.equal(props.current_course, 'Eco')
        assert.equal(props.remaining_time, 233, 'the reservation is not counted down here')
    })

    test('state 0x02 with an unknown process value stays running', () => {
        // Defensive, and it pins the direction the gate fails in: process 0x01 is excluded by
        // value, so a phase this decode has not met keeps `running` ON rather than switching it
        // OFF mid-cycle, which would clear the live activity while the machine is still washing.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withBit(RUNNING_INTENSIVE_NO_OPTIONS, 3, 0x04))
        const props = propsOf(ha)

        assert.equal(props.process_state, 'None', 'rec[3] = 0x06, a phase this decode does not know')
        assert.equal(props.running, 'ON', 'an unknown phase must not read as "not running"')
    })

    test('the high temp bit (rec[14] bit 3) has no entity yet, and the bit is live on the frame', () => {
        // Measured on the idle panel on 2026-09-26 and deliberately not published: the option
        // entities report only while a cycle runs, so the mapping still owes a running-cycle
        // frame. Pinning the gap here makes publishing it later a deliberate change rather than an
        // accident, and the frame is real, so the bit really is in rec[14] where it says it is.
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        thinq.emit('data', IDLE_HIGH_TEMP)
        const props = propsOf(ha)

        assert.ok(!('high_temp' in props), 'no publish')
        assert.ok(!('high_temp' in components), 'and no declaration: a declared entity with no publish is a phantom')
        assert.equal(props.initial_time, 230, 'the frame is the 3:50 one, high temp selected')
        assert.equal(props.running, 'OFF', 'the panel is awake, the machine is not washing')
    })

    test('the held option bits (extra dry, half load) publish nothing', () => {
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        thinq.emit('data', IDLE_HALF_LOAD_EXTRA_DRY)
        const props = propsOf(ha)

        assert.equal(props.initial_time, 198, 'the frame is the half-load + extra-dry one')
        for (const held of ['extra_dry', 'half_load']) {
            assert.ok(!(held in props), `${held} has no publish yet`)
            assert.ok(!(held in components), `${held} has no declaration either`)
        }
    })

    test('the child lock bit (rec[13] bit 0) publishes child lock, without touching the options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', IDLE_CHILD_LOCK)
        const props = propsOf(ha)

        assert.equal(props.child_lock, 'ON')
        assert.equal(
            props.door_open,
            'ON',
            'rec[13]=0x73 carries the door bit too: the machine was idle with its door open',
        )
        assert.equal(props.dual_zone, 'OFF', 'the option entities report only while a cycle runs')
    })

    test('the rinse-aid bit (rec[13] bit 2) publishes rinse refill, separately from salt', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING_RINSE_REFILL)
        const props = propsOf(ha)

        assert.equal(props.rinse_refill, 'ON')
        assert.equal(props.salt_refill, 'OFF', 'the two reservoirs have their own bits')
        assert.equal(props.door_open, 'ON', 'captured with the auto-door open')
        assert.equal(props.process_state, 'Drying')
    })

    test('the dual zone bit (rec[14] bit 4) publishes dual zone ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING_DUAL_ZONE)
        const props = propsOf(ha)

        assert.equal(props.dual_zone, 'ON')
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Washing')
        assert.equal(props.current_course, 'Auto')
        assert.equal(props.initial_time, 162, 'dual zone costs no time against the Auto baseline')
        assert.equal(props.remaining_time, 162)
        // The rest of the same byte must not be inferred from it.
        for (const prop of OPTION_PROPS) {
            if (prop !== 'dual_zone') assert.equal(props[prop], 'OFF', `${prop} OFF`)
        }
    })

    test('the unassigned option bit (0x20) drives no entity', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withBit(RUNNING_INTENSIVE_NO_OPTIONS, OPTION_BYTE, 0x20))
        const props = propsOf(ha)

        for (const prop of OPTION_PROPS) assert.equal(props[prop], 'OFF', `${prop} OFF`)
    })

    test('an option bit left set on an inactive frame publishes OFF', () => {
        // Defensive: the options byte is read from the same record as the state byte, and every
        // captured inactive frame carries 0x00 there, so no stale bit has ever been seen. The
        // gate is what keeps a desynchronised bit from publishing ON once the cycle is over.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', withBit(COMPLETING_OPTIONS_CLEARED, OPTION_BYTE, 0x80))
        const props = propsOf(ha)

        assert.equal(props.run_state, 'Completing')
        for (const prop of OPTION_PROPS) assert.equal(props[prop], 'OFF', `${prop} OFF`)
    })

    test('the salt bit (rec[13] bit 3) publishes salt refill', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RUNNING_SALT)
        const props = propsOf(ha)

        assert.equal(props.salt_refill, 'ON')
        assert.equal(props.door_open, 'OFF', 'record2 has the door bit clear, record1 does not')
        assert.equal(props.energy_saver, 'ON', 'rec[14]=0x02 in the same frame')
    })

    test('idle with the panel awake (state 0x01) is not running', () => {
        // The case the captures could not show: after END this appliance falls silent, so a
        // resting-but-awake panel was never observed until it ran against the real bridge.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', IDLE_ECO)
        const props = propsOf(ha)

        assert.equal(props.run_state, 'Initial')
        assert.equal(props.process_state, 'None')
        assert.equal(props.running, 'OFF', 'a resting panel is not a cycle')
        assert.equal(props.current_course, 'None', 'nothing is selected for a cycle')
        assert.equal(props.initial_time, 233)
        assert.equal(props.remaining_time, 233)
        assert.equal(props.door_open, 'ON')
        for (const prop of OPTION_PROPS) assert.equal(props[prop], 'OFF', `${prop} OFF`)
    })

    test('state 0x01 with options selected is still not a cycle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SENSING_STEAM)
        const props = propsOf(ha)

        assert.equal(props.run_state, 'Initial')
        assert.equal(props.process_state, 'None')
        assert.equal(props.running, 'OFF')
        assert.equal(props.current_course, 'None')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.door_open, 'ON')
        assert.equal(props.initial_time, 251)
        assert.equal(props.remaining_time, 251)
    })

    test('on an 0xec frame the CURRENT record wins: the stale steam bit in record1 is not published', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COMPLETING_OPTIONS_CLEARED)
        const props = propsOf(ha)

        // record1 still carries state 0x02 / process 0x04 / steam 0x80.
        assert.equal(props.run_state, 'Completing')
        assert.equal(props.process_state, 'Completing')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.running, 'OFF')
        // The options byte clears one record before the course byte: no course is
        // published once the cycle is no longer active.
        assert.equal(props.current_course, 'None')
        assert.equal(props.remaining_time, 1)
    })

    test('END clears the course and the options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', END)
        const props = propsOf(ha)

        assert.equal(props.run_state, 'End')
        assert.equal(props.process_state, 'None')
        assert.equal(props.current_course, 'None')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.energy_saver, 'OFF')
        assert.equal(props.running, 'OFF')
    })

    test('the 0xd8 frame publishes the cycle counter', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TRANSITION)

        assert.equal(propsOf(ha).tub_clean_counter, 17)
        // A persistent flag, not cycle state: nothing else moves.
        assert.deepEqual(Object.keys(propsOf(ha)), ['tub_clean_counter'])
    })

    test('a non-status frame publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HANDSHAKE)
        assert.deepEqual(propsOf(ha), {})
    })

    test('a truncated 0xeb frame publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        // The head of the SENSING_STEAM record, cut short of its 26 bytes: the length guard has
        // to drop it rather than read past the end of the buffer.
        thinq.emit('data', buf('AA1432EB0018010000040B0200040B00007200BB'))
        assert.deepEqual(propsOf(ha), {})
    })

    test('an 0xec frame carrying only record1 publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        // 0xec with record1 alone: 28 body bytes, so the CURRENT record (base 28) does not exist.
        // Without the length guard this would read past the end and publish undefined state,
        // phase and time strings.
        thinq.emit('data', buf('AA2032EC0018020300040B0200011F00007080020401000000000000000000BB'))
        assert.deepEqual(propsOf(ha), {})
    })

    test('an undecoded course is published as None, not as its code', () => {
        const { ha, thinq } = makeDevice()
        // rec[7] = 0x0e, a course this decode does not know. The raw code would be a value
        // outside the declared options, which Home Assistant refuses and logs.
        thinq.emit('data', withBit(RUNNING_INTENSIVE_NO_OPTIONS, 7, 0x0c))
        const props = propsOf(ha)

        assert.equal(props.current_course, 'None')
        // The rest of the same record is untouched.
        assert.equal(props.run_state, 'Running')
        assert.equal(props.process_state, 'Washing')
    })

    test('an undecoded run state is published as None, not as its code', () => {
        const { ha, thinq } = makeDevice()
        // rec[2] = 0x03, a state this decode does not know — and not a cycle, so nothing the
        // cycle owns is published either.
        thinq.emit('data', withBit(RUNNING_INTENSIVE_NO_OPTIONS, 2, 0x01))
        const props = propsOf(ha)

        assert.equal(props.run_state, 'None')
        assert.equal(props.running, 'OFF')
        assert.equal(props.current_course, 'None')
    })

    test('an undecoded process state is published as None, not as its code', () => {
        const { ha, thinq } = makeDevice()
        // rec[3] = 0x0a, a phase this decode does not know, on a frame that IS a running cycle: the
        // state and the course must still be published, the phase not.
        thinq.emit('data', withBit(RUNNING_INTENSIVE_NO_OPTIONS, 3, 0x08))
        const props = propsOf(ha)

        assert.equal(props.process_state, 'None')
        assert.equal(props.run_state, 'Running')
        assert.equal(props.current_course, 'Intensive')
    })

    test('a frame longer than the layout publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        // 0xeb with two bytes too many: read as the single-record layout, it would still decode.
        thinq.emit('data', buf('AA2232EB0018010000040B0200040B000072800204010000000000000000DEAD00BB'))
        assert.deepEqual(propsOf(ha), {})

        // 0xec with a third record: read as the two-record layout, record2 would be published as
        // the current reading while record3 is. The sibling D30 handler met a longer 0xec once.
        const record1 = RUNNING_DRY_STEAM.subarray(2, 28)
        const record2 = RUNNING_DRY_STEAM.subarray(28, 54)
        const body = Buffer.concat([buf('32EC'), record1, record2, record2])
        thinq.emit('data', Buffer.concat([buf('AA54'), body, buf('0000BB')]))
        assert.deepEqual(propsOf(ha), {})
    })

    test('every enum sensor declares the options its values come from', () => {
        // The three state-like sensors are closed sets, so they are `enum` with an `options`
        // list; a new one must not appear without it.
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        const enums = Object.entries(components).filter(([, c]) => c.device_class === 'enum')

        assert.deepEqual(enums.map(([name]) => name).sort(), ['current_course', 'process_state', 'run_state'])
        for (const [name, comp] of enums) {
            const options = comp.options as string[] | undefined
            assert.ok(Array.isArray(options) && options.length > 0, `${name} declares no options`)
        }
    })

    test('no enum entity is ever published a value outside its options', () => {
        // The room the options list leaves is 'None' alone: Home Assistant accepts that value
        // unconditionally and shows it as unknown.
        const { ha, thinq } = makeDevice()
        const frames = [
            RUNNING_INTENSIVE_NO_OPTIONS,
            RUNNING_DRY_STEAM,
            RUNNING_DUAL_ZONE,
            RUNNING_SALT,
            COMPLETING_OPTIONS_CLEARED,
            END,
            IDLE_ECO,
            SENSING_STEAM,
            // The two frames whose mapped byte is unknown are the ones a raw-code fallback
            // would leak through, so they belong in this list.
            withBit(RUNNING_INTENSIVE_NO_OPTIONS, 7, 0x0c),
            withBit(RUNNING_INTENSIVE_NO_OPTIONS, 2, 0x01),
        ]
        for (const frame of frames) {
            thinq.emit('data', frame)
            const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
            for (const [name, comp] of Object.entries(components)) {
                if (comp.device_class !== 'enum') continue
                const value = String(propsOf(ha)[name])
                const options = comp.options as string[]
                assert.ok(value === 'None' || options.includes(value), `${name} published ${value}`)
            }
        }
    })
})
