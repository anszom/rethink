import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/MI2U7B'
import AABBDevice from '@/cloud/devices/aabb_device'
import { WriteQueueMultiplexer } from '@/cloud/devices/aabb_write_queue'
import { parseSideKickFrame } from '@/cloud/devices/MI2U7B_status'
import Bridge from '@/cloud/ha_bridge'
import crc16 from '@/util/crc16'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'MI2U7B', modelName: 'Test SideKick', deviceType: '201' }

// Captured MI2U7B wire reports, limited to protocol/status bytes with no device identifiers.
// EC records are previous/current; the EB report is an independent captured control.
const CAPTURED_SPINNING = Buffer.from(
    'aaff200a0074000ae2000100ec00620000000013ff000000000000000008000800000000010081000000000004000000000000001001003000000000010000000000000013ff0000000000000000080008000000000e01810000000000040000000000000010010030000000000100000059b3bb',
    'hex',
)
const CAPTURED_PAUSED = Buffer.from(
    'aaff200a0074000b06000100ec00620000000013ff0000000000000000060008000000000e0281000000000004000000000000001001003000000000010000000000000013ff000000000000000006000800000000020e810000000000040000000000000010010030000000000100000005a2bb',
    'hex',
)
const CAPTURED_STANDBY = Buffer.from(
    'aaff200a004300095f000100eb003100000001132e00000000000000002700270000002e0100ee0000000000040000000000000802002030000000000b000000cc60bb',
    'hex',
)

// User-operated MI2U7B captures (2026-11-11): protocol/status only, no appliance IDs.
// EC records are previous/current. The first setting ON also clears unknown bits37/02 and39/20.
const REMOTE_CAPTURES = {
    SETTING_ON: Buffer.from(
        'aaff200a007400ae1f000100ec006200000001132e00000000000000002700270000002e0100ee0000000000040000000000000802002030000000000b00000000000001132e00000000000000002700270000002e0100ee0000000000040000000000000800000034000000000b0000002246bb',
        'hex',
    ),
    SETTING_OFF: Buffer.from(
        'aaff200a007400ae24000100ec006200000001132e00000000000000002700270000002e0100ee0000000000040000000000000800000034000000000b00000000000001132e00000000000000002700270000002e0100ee0000000000040000000000000800000030000000000b00000083f1bb',
        'hex',
    ),
    ARMED: Buffer.from(
        'aaff200a007400ae43000100ec006200000001132e00000000000000002700270000002e010bee0000000000040000000000000800000030000000000b00000000000001132e00000000000000002700270000002e010bee0000000000040000000000000810000030000000000b0000004a55bb',
        'hex',
    ),
    LOCKED: Buffer.from(
        'aaff200a007400ae45000100ec006200000001132e00000000000000002700270000002e010bee0000000000040000000000000810000030000000000b00000000000001132e00000000000000002700270000002e010bee0000000000040000000000000810010030000000000b00000043a9bb',
        'hex',
    ),
    DISARMED: Buffer.from(
        'aaff200a007400ae4d000100ec006200000001132e00000000000000002700270000002e010bee0000000000040000000000000810010030000000000b00000000000001132e00000000000000002700270000002e010bee0000000000040000000000000800010030000000000b0000001869bb',
        'hex',
    ),
    UNLOCKED: Buffer.from(
        'aaff200a007400ae4e000100ec006200000001132e00000000000000002700270000002e010bee0000000000040000000000000800010030000000000b00000000000001132e00000000000000002700270000002e010bee0000000000040000000000000800000030000000000b000000068dbb',
        'hex',
    ),
    COMPLETED: Buffer.from(
        'aaff200a007400aeca000100ec00620000000013ff0000000000000000010008000400000e01810000000000040000000000000010010034000000000b0000000000000013ff0000000000000000010008000500002a0e810000000000040000000000000010010034000000000b000000a4a1bb',
        'hex',
    ),
    RETAINED: Buffer.from(
        'aaff200a007400aecd000100ec00620000000013ff0000000000000000010008000500002a0e810000000000040000000000000010010034000000000b0000000000000013ff0000000000000000080008000500002a2a810000000000040000000000000010010034000000000b0000002859bb',
        'hex',
    ),
} as const

// Synthetic mutations cover boundaries and fields not varied in the captured reports.
function checksum(packet: Buffer): Buffer {
    packet.writeUInt16BE(crc16(packet.subarray(0, packet.length - 3)), packet.length - 3)
    return packet
}

function frame(opcode: number, payload: Buffer): Buffer {
    const packet = Buffer.alloc(payload.length + 18)
    packet.set([0xaa, 0xff, 0x20, 0x0a])
    packet.writeUInt16BE(packet.length, 4)
    packet[12] = opcode
    packet.writeUInt16BE(payload.length, 13)
    payload.copy(packet, 15)
    packet[packet.length - 1] = 0xbb
    return checksum(packet)
}

function status(state = 1, course = 46, minutes = 39, secondQuantity = 39): Buffer {
    const payload = Buffer.alloc(49)
    payload[5] = course
    payload[21] = state
    payload.writeUInt16LE(minutes, 14)
    payload.writeUInt16LE(secondQuantity, 16)
    return frame(0xeb, payload)
}

function drawer(value: number, counter = 0, length = 15): Buffer {
    const payload = Buffer.alloc(length)
    payload.set([0x0f, 0x0b, 0x01, 0x08, 0x0f])
    if (length > 14) payload[14] = value
    if (length > 5) payload[5] = counter
    return frame(0x03, payload)
}

function completion(): Buffer {
    const payload = Buffer.alloc(99)
    payload.set([0x0c, 0x0b, 0x01, 0x08, 0x0c])
    return frame(3, payload)
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('test-sidekick', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, properties: ha.devices[thinq.id].properties }
}

describe('MI2U7B passive exact-model support', () => {
    test('confirmed course labels, Standby and observed Tub Clean Rinsing context', () => {
        const { thinq, properties: p } = makeDevice()
        for (const [code, label] of [
            [46, 'Normal'],
            [85, 'Tub Clean'],
            [100, 'Intimates'],
            [33, 'Hand Wash'],
            [55, 'Rinse + Spin'],
            [255, 'Downloaded'],
            [254, 'Program 254'],
        ] as const) {
            thinq.emit('data', status(1, code))
            assert.equal(p.course, label)
            assert.equal(p.status, 'Standby')
            assert.equal(p.remaining_time, 'None')
        }
        thinq.emit('data', status(12, 85, 13))
        assert.deepEqual(p, {
            power: 'ON',
            rinse: 0,
            buzzer: 'Off',
            warm_water: 'OFF',
            keep_remote_start: 'OFF',
            remote_start: 'OFF',
            door_lock: 'OFF',
            melody: 'Normal',
            course: 'Tub Clean',
            status: 'Rinsing',
            remaining_time: 13,
            total_time: 39,
            energy: 0,
        })
        thinq.emit('data', status(12, 85, 513))
        assert.equal(p.remaining_time, 513)
        // State labels apply across courses.
        thinq.emit('data', status(12, 46, 7))
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.remaining_time, 7)
    })

    test('energy reads big-endian bytes17/18, including carry and reset while off', () => {
        const { thinq, dev, properties: p } = makeDevice()
        for (const [high, low, value] of [
            [0, 255, 255],
            [1, 0, 256],
            [1, 2, 258],
            [0, 0, 0],
        ]) {
            const payload = Buffer.alloc(49)
            payload[16] = 39
            payload[17] = high
            payload[18] = low
            payload[19] = 9
            thinq.emit('data', frame(0xeb, payload))
            assert.equal(p.energy, value)
            assert.equal(p.total_time, 39)
        }
        const energy = dev.config!.components.energy
        assert.ok('unit_of_measurement' in energy && 'device_class' in energy && 'state_class' in energy)
        assert.equal(energy.unit_of_measurement, 'Wh')
        assert.equal(energy.device_class, 'energy')
        assert.equal(energy.state_class, 'total_increasing')
    })

    test('phase labels retain unknown numeric fallback; countdown follows ours', () => {
        const { thinq, properties: p } = makeDevice()
        for (const [code, label] of [
            [0, 'Off'],
            [2, 'Pause'],
            [3, 'Detecting'],
            [11, 'Washing'],
            [14, 'Spinning'],
            [16, 'Finished'],
            [41, 'Tub cleaning'],
        ] as const) {
            thinq.emit('data', status(code, 85, 9))
            assert.equal(p.status, label)
            assert.equal(p.remaining_time, code === 0 ? 'None' : code === 16 ? 0 : 9)
        }
        thinq.emit('data', status(16, 46, 9))
        assert.equal(p.remaining_time, 9)
        thinq.emit('data', status(255, 254, 9))
        assert.equal(p.status, 'Status 255')
        assert.equal(p.course, 'Program 254')
        thinq.emit('data', status(1))
        assert.equal(p.remaining_time, 'None')
    })

    test('total time uses byte16 independently of big-endian energy at17', () => {
        const { thinq, properties: p } = makeDevice()
        const payload = Buffer.alloc(49)
        payload[21] = 11
        payload.set([0x34, 0x12, 0x56, 0x78], 16)
        thinq.emit('data', frame(0xeb, payload))
        assert.equal(p.total_time, 0x34)
        assert.equal(p.energy, 0x1256)
        payload.writeUInt16LE(513, 14)
        thinq.emit('data', frame(0xeb, payload))
        assert.equal(p.remaining_time, 513)
        assert.equal(p.total_time, 0x34)
        assert.equal(p.energy, 0x1256)
    })

    test('completion requires exact signature and active latch, stays nonretained and out of replay cache', () => {
        const { ha, thinq, dev, properties: p } = makeDevice()
        const bridge = new Bridge(ha.asConnection())
        bridge.haDevices.set(thinq.id, dev)
        const spy = mock.method(ha, 'publishProperty')
        const events = () => spy.mock.calls.filter((call) => call.arguments[1] === 'cycle_finished')
        thinq.emit('data', completion())
        dev.start()
        ha.emit('discovery')
        assert.equal(events().length, 0)
        thinq.emit('data', status(12, 85))
        for (const length of [10, 17, 55, 73, 98, 100]) thinq.emit('data', frame(3, Buffer.alloc(length)))
        const wrongPrefix = Buffer.from(completion())
        wrongPrefix[19] ^= 1
        thinq.emit('data', checksum(wrongPrefix))
        const wrongOpcode = Buffer.from(completion())
        wrongOpcode[12] = 0xeb
        thinq.emit('data', checksum(wrongOpcode))
        assert.equal(events().length, 0)
        thinq.emit('data', completion())
        assert.equal(events().length, 1)
        assert.deepEqual(events()[0].arguments, [
            thinq.id,
            'cycle_finished',
            JSON.stringify({ event_type: 'finished' }),
            { retain: false },
        ])
        assert.equal(dev.publishCache.has('cycle_finished'), false)
        thinq.emit('data', completion())
        thinq.emit('data', status(14))
        thinq.emit('data', completion())
        ha.emit('discovery')
        assert.equal(events().length, 1)
        for (const resetState of [0, 1]) {
            thinq.emit('data', status(resetState))
            thinq.emit('data', completion())
            thinq.emit('data', status(11))
            thinq.emit('data', completion())
        }
        assert.equal(events().length, 3)
        assert.equal(p.cycle_finished, JSON.stringify({ event_type: 'finished' }))
        const restarted = makeDevice()
        restarted.thinq.emit('data', completion())
        assert.equal(restarted.properties.cycle_finished, undefined)
        spy.mock.restore()
    })

    test('drawer events reverse independently and do not infer inner-lid state', () => {
        const { thinq, properties: p } = makeDevice()
        thinq.emit('data', status())
        for (const [value, counter, expected] of [
            [1, 127, 'ON'],
            [1, 128, 'ON'],
            [0, 129, 'OFF'],
            [2, 130, 'None'],
        ] as const) {
            thinq.emit('data', drawer(value, counter))
            assert.equal(p.drawer, expected)
            assert.equal(p.status, 'Standby')
        }
        thinq.emit('data', drawer(1))
        thinq.emit('data', status(12, 85))
        for (let offset = 0; offset < 5; offset++) {
            const wrongEvent = Buffer.from(drawer(0))
            wrongEvent[15 + offset] ^= 1
            thinq.emit('data', checksum(wrongEvent))
            assert.equal(p.drawer, 'ON')
        }
        for (const length of [10, 14, 16, 73, 99]) thinq.emit('data', drawer(0, 0, length))
        assert.equal(p.drawer, 'ON')
    })

    test('rejects malformed envelopes, lengths, CRC, wrong status layouts and all truncations', () => {
        const valid = status(12, 85)
        const invalid: Buffer[] = []
        for (let n = 0; n < valid.length; n++) invalid.push(valid.subarray(0, n))
        for (const [offset, value] of [
            [0, 0],
            [1, 0],
            [2, 0x30],
            [3, 0x0b],
            [5, 66],
            [14, 48],
            [12, 0xec],
            [15, 1],
            [valid.length - 1, 0],
        ]) {
            const bad = Buffer.from(valid)
            bad[offset] = value
            invalid.push(checksum(bad))
        }
        const corrupt = Buffer.from(valid)
        corrupt[20] ^= 1
        invalid.push(corrupt, Buffer.concat([valid, Buffer.from([0])]))
        for (const length of [48, 50, 98]) invalid.push(frame(0xeb, Buffer.alloc(length)))
        for (const opcode of [0x85, 0x86, 0xec]) invalid.push(frame(opcode, Buffer.alloc(49)))
        const { thinq, properties: p } = makeDevice()
        thinq.emit('data', valid)
        thinq.emit('data', drawer(1))
        const before = { ...p }
        for (const bad of invalid) {
            assert.equal(parseSideKickFrame(bad), undefined)
            thinq.emit('data', bad)
        }
        for (let n = 0; n < drawer(0).length; n++) assert.equal(parseSideKickFrame(drawer(0).subarray(0, n)), undefined)
        const complete = completion()
        for (let n = 0; n < complete.length; n++) assert.equal(parseSideKickFrame(complete.subarray(0, n)), undefined)
        const badCompletion = Buffer.from(complete)
        badCompletion[20] ^= 1
        assert.equal(parseSideKickFrame(badCompletion), undefined)
        const badDrawer = drawer(0)
        badDrawer[20] ^= 1
        assert.equal(parseSideKickFrame(badDrawer), undefined)
        assert.deepEqual(p, before)
    })

    test('startup preserves prior reports; bridge only sends ACKs without explicit commands', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('test-sidekick', META)
        ha.publishProperty(thinq.id, 'status', 'previous state')
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        const dev = bridge.haDevices.get(thinq.id)!
        assert.ok(dev instanceof DUT)
        assert.equal(ha.devices[thinq.id].properties.status, 'previous state')
        assert.equal(dev.publishCache.has('status'), false)
        dev.start()
        ha.emit('discovery')
        for (const prop of ['start', 'drawer', 'anything']) ha.emit('setProperty', thinq.id, prop, 'ON')
        for (const packet of [
            status(),
            drawer(1),
            status(12, 85),
            completion(),
            frame(0x85, Buffer.alloc(52)),
            Buffer.alloc(0),
        ])
            thinq.emit('data', packet)
        assert.equal(dev.config!.components.course.platform, 'select')
        assert.equal(thinq.sent.length, 5)
        assert.ok(thinq.sent.every((message) => message.cmd === 'ack'))
        assert.deepEqual(thinq.outbox, [])
        const unknown = new MockThinq2Device('unmatched', { ...META, modelId: 'MI2U7B_other' })
        bridge.newDevice(unknown)
        assert.equal(bridge.haDevices.has(unknown.id), false)
    })
})

function commandStatus(state = 1, course = 46, rinse = 2) {
    const payload = Buffer.alloc(49)
    payload.set([0, 0, 0, rinse, 19, course])
    payload[21] = state
    payload[29] = 4
    return payload
}
function reply(ids: number[], rec = commandStatus(), results = ids.map(() => 0), target = 0xff) {
    return AABBDevice.frame(
        Buffer.from([0x20, 0xe6, 0, 2, 1, target, ids.length, ...ids.flatMap((id, i) => [id, results[i]]), ...rec]),
    )
}
function transition(previous: Buffer, current: Buffer) {
    return frame(0xec, Buffer.concat([previous, current]))
}
function inner(packet: Buffer) {
    return [...packet.subarray(2, -2)]
}

describe('MI2U7B automatic ACKs', () => {
    test('shared multiplexer ACKs valid envelopes by sequence, including retries', () => {
        const { thinq, dev } = makeDevice()
        const packet = status(12, 85)
        packet.writeUInt16BE(0x1234, 7)
        checksum(packet)
        thinq.emit('data', packet)
        thinq.emit('data', packet)
        const expected = AABBDevice.frame(Buffer.from([0xf0, 0, 0x0a, 4, 0x12, 0x34]))
            .toString('hex')
            .toUpperCase()
        assert.deepEqual(
            thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data),
            [expected, expected],
        )
        dev.drop()
    })
    test('shared ACK handling avoids heartbeat and appliance ACK loops', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0xc3])))
        thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0, 0x24, 0])))
        assert.equal(thinq.sent.length, 0)
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })
})

describe('MI2U7B captured remote setting and panel arming', () => {
    test('accepted setting writes wait for captured readback; arming and lock remain independent', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', CAPTURED_STANDBY)
        for (const [value, packet] of [
            ['ON', REMOTE_CAPTURES.SETTING_ON],
            ['OFF', REMOTE_CAPTURES.SETTING_OFF],
        ] as const) {
            const before = p.keep_remote_start
            dev.setProperty('keep_remote_start', value)
            assert.deepEqual(
                thinq.outbox[thinq.outbox.length - 1],
                AABBDevice.frame(Buffer.from([0xf0, 0x24, 0x10, 1, value === 'ON' ? 1 : 0])),
            )
            thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0, 0x24, 0])))
            assert.equal(p.problem, 'OFF')
            assert.equal(p.keep_remote_start, before)
            assert.equal(parseSideKickFrame(packet)?.kind, 'status')
            thinq.emit('data', packet)
            assert.equal(p.keep_remote_start, value)
            assert.equal(p.remote_start, 'OFF')
            assert.equal(p.door_lock, 'OFF')
        }
        dev.drop()
    })
    test('panel arming/disarming and following lock reports do not change the setting', () => {
        const { dev, thinq, properties: p } = makeDevice()
        for (const [packet, remote, lock] of [
            [REMOTE_CAPTURES.ARMED, 'ON', 'OFF'],
            [REMOTE_CAPTURES.LOCKED, 'ON', 'ON'],
            [REMOTE_CAPTURES.DISARMED, 'OFF', 'ON'],
            [REMOTE_CAPTURES.UNLOCKED, 'OFF', 'OFF'],
        ] as const) {
            assert.equal(parseSideKickFrame(packet)?.kind, 'status')
            thinq.emit('data', packet)
            assert.equal(p.remote_start, remote)
            assert.equal(p.door_lock, lock)
            assert.equal(p.keep_remote_start, 'OFF')
        }
        assert.deepEqual(thinq.outbox, [])
        dev.drop()
    })
    test('Spin Only completion retains remote arming, lock and setting without starting another cycle', () => {
        const { dev, thinq, properties: p } = makeDevice()
        for (const [packet, remaining] of [
            [REMOTE_CAPTURES.COMPLETED, 1],
            [REMOTE_CAPTURES.RETAINED, 8],
        ] as const) {
            assert.equal(parseSideKickFrame(packet)?.kind, 'status')
            thinq.emit('data', packet)
            assert.equal(p.status, 'Remote maintain')
            assert.equal(p.course, 'Spin Only')
            assert.equal(p.remote_start, 'ON')
            assert.equal(p.door_lock, 'ON')
            assert.equal(p.keep_remote_start, 'ON')
            assert.equal(p.remaining_time, remaining)
        }
        // The eight-minute field does not indicate a restart: state remains42.
        assert.deepEqual(thinq.outbox, [])
        dev.drop()
    })
})

describe('MI2U7B captured current-record reports', () => {
    test('captured EC98 selects the last record; captured EB49 still decodes', () => {
        const { dev, thinq, properties: p } = makeDevice()
        for (const [packet, course, phase, remaining, total] of [
            [CAPTURED_STANDBY, 'Normal', 'Standby', 'None', 39],
            [CAPTURED_SPINNING, 'Spin Only', 'Spinning', 8, 8],
            [CAPTURED_PAUSED, 'Spin Only', 'Pause', 6, 8],
        ] as const) {
            const decoded = parseSideKickFrame(packet)
            assert.equal(decoded?.kind, 'status')
            if (decoded?.kind !== 'status') assert.fail('Expected a captured status record')
            assert.deepEqual(decoded.record, packet.subarray(packet.length - 52, -3))
            thinq.emit('data', packet)
            assert.equal(p.course, course)
            assert.equal(p.status, phase)
            assert.equal(p.remaining_time, remaining)
            assert.equal(p.total_time, total)
            assert.equal(p.energy, 0)
        }
        dev.drop()
    })
    test('EC98 rejects CRC, length, record markers, wrong opcode and every truncation without changing state', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', CAPTURED_PAUSED)
        const before = { ...p }
        const invalid: Buffer[] = Array.from({ length: CAPTURED_SPINNING.length }, (_, n) =>
            CAPTURED_SPINNING.subarray(0, n),
        )
        const corrupt = Buffer.from(CAPTURED_SPINNING)
        corrupt[70] ^= 1
        invalid.push(corrupt, Buffer.concat([CAPTURED_SPINNING, Buffer.from([0])]))
        for (const [offset, value] of [
            [5, CAPTURED_SPINNING.length - 1],
            [14, 97],
            [12, 0xeb],
            [15, 1],
            [64, 1],
            [CAPTURED_SPINNING.length - 1, 0],
        ]) {
            const bad = Buffer.from(CAPTURED_SPINNING)
            bad[offset] = value
            invalid.push(checksum(bad))
        }
        for (const length of [49, 97, 99]) invalid.push(frame(0xec, Buffer.alloc(length)))
        for (const bad of invalid) {
            assert.equal(parseSideKickFrame(bad), undefined)
            thinq.emit('data', bad)
        }
        assert.deepEqual(p, before)
        dev.drop()
    })
    test('standalone commands use current reported power without a course-generation barrier', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', transition(commandStatus(0, 85), commandStatus(1, 46)))
        dev.setProperty('rinse', '3')
        assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x20, 3])
        dev.setProperty('rinse', '4')
        thinq.emit('data', transition(commandStatus(1, 46), commandStatus(1, 85)))
        thinq.emit('data', reply([0x20], commandStatus(1, 46, 3)))
        assert.equal(p.course, 'Tub Clean')
        assert.equal(thinq.outbox.length, 2)
        assert.deepEqual(inner(thinq.outbox[1]).slice(-2), [0x20, 4])
        dev.setProperty('rinse', '5')
        thinq.emit('data', transition(commandStatus(1, 85), commandStatus(0, 85)))
        thinq.emit('data', reply([0x20]))
        assert.equal(thinq.outbox.length, 2)
        assert.equal(p.power, 'OFF')
        dev.drop()
    })
})

describe('MI2U7B confirmed explicit controls', () => {
    test('reports settings without startup writes', () => {
        const { dev, thinq, properties: p } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', frame(0xeb, commandStatus()))
        assert.equal(p.power, 'ON')
        assert.equal(p.rinse, 2)
        assert.equal(p.buzzer, 'Very Loud')
        const buzzer = dev.config!.components.buzzer
        assert.ok('entity_category' in buzzer)
        assert.equal(buzzer.entity_category, 'config')
        thinq.emit('data', frame(0xeb, commandStatus(0)))
        assert.equal(p.power, 'OFF')
        dev.drop()
    })
    test('rinse writes only property20; accepted replies never override fresh reports or course defaults', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('rinse', '6')
        assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x20, 6])
        assert.equal(p.rinse, 2)
        const accepted = commandStatus(1, 46, 6)
        accepted[36] = 8
        thinq.emit('data', reply([0x20], accepted))
        assert.equal(p.problem, 'OFF')
        assert.equal(p.rinse, 2)
        assert.equal(p.warm_water, 'OFF')
        thinq.emit('data', frame(0xeb, accepted))
        assert.equal(p.rinse, 6)
        assert.equal(p.warm_water, 'ON')
        // A fresh report is authoritative, even if it differs from the accepted write.
        thinq.emit('data', frame(0xeb, commandStatus(1, 46, 1)))
        assert.equal(p.rinse, 1)
        assert.equal(p.warm_water, 'OFF')
        dev.setProperty('course', 'Hand Wash')
        thinq.emit('data', reply([0x0a], accepted))
        assert.equal(p.course, 'Normal')
        const defaults = commandStatus(1, 33, 2)
        thinq.emit('data', frame(0xeb, defaults))
        assert.equal(p.course, 'Hand Wash')
        assert.equal(p.rinse, 2)
        assert.equal(p.warm_water, 'OFF')
        dev.setProperty('rinse', '3')
        assert.deepEqual(inner(thinq.outbox[2]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x20, 3])
        dev.drop()
    })
    test('all buzzer levels use targetFF property13 and read byte29', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        for (const [code, label] of ['Off', 'Low', 'Medium', 'Loud', 'Very Loud'].entries()) {
            dev.setProperty('buzzer', label)
            assert.deepEqual(inner(thinq.outbox[code]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x13, code])
            const rec = commandStatus()
            rec[29] = code
            const before = p.buzzer
            thinq.emit('data', reply([0x13], rec))
            assert.equal(p.buzzer, before)
            thinq.emit('data', frame(0xeb, rec))
            assert.equal(p.buzzer, label)
        }
        dev.drop()
    })
    test('Warm Water uses property46 but reads only byte36 mask08', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        for (const [i, value] of ['ON', 'OFF'].entries()) {
            const bit = value === 'ON' ? 1 : 0
            dev.setProperty('warm_water', value)
            assert.deepEqual(inner(thinq.outbox[i]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x46, bit])
            const rec = commandStatus()
            rec[36] = 0x40 | (bit ? 8 : 0)
            rec[46] = bit ? 0 : 8
            const before = p.warm_water
            thinq.emit('data', reply([0x46], rec))
            assert.equal(p.warm_water, before)
            thinq.emit('data', frame(0xeb, rec))
            assert.equal(p.warm_water, value)
        }
        dev.drop()
    })
    test('melody property50 reads byte45 for each captured choice', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        for (const [i, [label, code]] of [
            ['Normal', 0],
            ['Vivaldi Winter', 1],
            ['Verdi La Traviata Drinking Song', 6],
            ['Bubble', 7],
            ['Beethoven Symphony No. 5', 8],
            ['Arirang', 9],
            ["Pachelbel's Canon", 10],
            ['Beethoven Symphony No. 9', 11],
        ].entries()) {
            dev.setProperty('melody', String(label))
            assert.deepEqual(inner(thinq.outbox[i]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x50, code])
            const rec = commandStatus()
            rec[45] = Number(code)
            thinq.emit('data', reply([0x50], rec))
            thinq.emit('data', frame(0xeb, rec))
            assert.equal(p.melody, label)
        }
        dev.drop()
    })
    test('Keep Remote Start uses short F024 commands/replies and byte40 mask04, not readiness', () => {
        const { dev, thinq, properties: p } = makeDevice()
        const rec = commandStatus()
        rec[40] = 0x30
        thinq.emit('data', frame(0xeb, rec))
        dev.setProperty('keep_remote_start', 'ON')
        dev.setProperty('keep_remote_start', 'OFF')
        assert.deepEqual(thinq.outbox[0], AABBDevice.frame(Buffer.from([0xf0, 0x24, 0x10, 1, 1])))
        assert.equal(p.keep_remote_start, 'OFF')
        thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0, 0x24, 0])))
        assert.equal(p.problem, 'OFF')
        assert.equal(p.keep_remote_start, 'OFF')
        assert.deepEqual(thinq.outbox[1], AABBDevice.frame(Buffer.from([0xf0, 0x24, 0x10, 1, 0])))
        rec[40] = 0x34
        thinq.emit('data', frame(0xeb, rec))
        assert.equal(p.keep_remote_start, 'ON')
        thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0, 0x24, 1])))
        assert.equal(p.problem, 'ON')
        assert.equal(p.keep_remote_start, 'ON')
        rec[40] = 0x30
        thinq.emit('data', frame(0xeb, rec))
        assert.equal(p.keep_remote_start, 'OFF')
        assert.equal(p.remote_start, 'OFF')
        dev.drop()
    })
    test('serializes FIFO writes and validates matching reply property sets and target', () => {
        const { dev, thinq } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('buzzer', 'Low')
        dev.setProperty('rinse', '3')
        dev.setProperty('rinse', '4')
        thinq.emit('data', reply([0x20]))
        thinq.emit('data', reply([0x13], commandStatus(), [0], 0x33))
        thinq.emit('data', reply([0x13, 0x13]))
        assert.equal(thinq.outbox.length, 1)
        thinq.emit('data', reply([0x13]))
        assert.equal(thinq.outbox.length, 2)
        assert.deepEqual(inner(thinq.outbox[1]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x20, 3])
        thinq.emit('data', reply([0x20]))
        assert.deepEqual(inner(thinq.outbox[2]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 0x20, 4])
        dev.drop()
    })
    test('built-in course, action-only Start, pause/resume and power use explicit ordered writes', () => {
        for (const [prop, value, pairs] of [
            ['power', 'ON', [2, 1]],
            ['power', 'OFF', [2, 0]],
            ['course', 'Normal', [10, 46]],
            ['course', 'Intimates', [10, 100]],
            ['course', 'Hand Wash', [10, 33]],
            ['course', 'Rinse + Spin', [10, 55]],
            ['course', 'Tub Clean', [10, 85]],
            ['start', 'PRESS', [3, 1]],
            ['pause', 'PRESS', [3, 2]],
            ['resume', 'PRESS', [3, 3]],
        ] as const) {
            const { dev, thinq } = makeDevice()
            thinq.emit('data', frame(0xeb, commandStatus()))
            dev.setProperty(prop, value)
            assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0xff, pairs.length / 2, ...pairs])
            dev.drop()
        }
        const { dev, thinq } = makeDevice()
        thinq.emit('data', CAPTURED_PAUSED)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0xff, 1, 3, 1])
        dev.drop()
    })
    test('both captured seven-property downloaded bundles accept only the specific46=01 exception', () => {
        for (const [label, download, course, rinse, total] of [
            ['Spin Only', 0x81, 0x37, 0, 8],
            ['Active Wear', 0xee, 0x63, 2, 43],
        ] as const) {
            const { dev, thinq, properties: p } = makeDevice()
            thinq.emit('data', frame(0xeb, commandStatus()))
            dev.setProperty('course', label)
            const pairs = [0x0b, download, 0x0a, 0xff, 0x0c, course, 0x20, rinse, 0x21, 0x13, 0x1f, 0, 0x46, 0]
            assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0xff, 7, ...pairs])
            const current = commandStatus(1, 255, rinse)
            current[23] = download
            current[16] = total
            thinq.emit('data', reply([0x0b, 0x0a, 0x0c, 0x20, 0x21, 0x1f, 0x46], current, [0, 0, 0, 0, 0, 0, 1]))
            assert.equal(p.problem, 'OFF')
            assert.equal(p.course, 'Normal')
            thinq.emit('data', transition(commandStatus(), current))
            assert.equal(p.course, label)
            assert.equal(p.rinse, rinse)
            assert.equal(p.total_time, total)
            dev.setProperty('rinse', '3')
            assert.equal(thinq.outbox.length, 2)
            dev.drop()
        }
    })
    test('result01 is refused outside the exact downloaded Warm Water exception', () => {
        for (const [prop, value, id] of [
            ['warm_water', 'OFF', 0x46],
            ['rinse', '3', 0x20],
        ] as const) {
            const { dev, thinq, properties: p } = makeDevice()
            thinq.emit('data', frame(0xeb, commandStatus()))
            dev.setProperty(prop, value)
            thinq.emit('data', reply([id], commandStatus(), [1]))
            assert.equal(p.problem, 'ON')
            dev.drop()
        }
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('course', 'Spin Only')
        thinq.emit('data', reply([0x0b, 0x0a, 0x0c, 0x20, 0x21, 0x1f, 0x46], commandStatus(), [1, 0, 0, 0, 0, 0, 1]))
        assert.equal(p.problem, 'ON')
        dev.drop()
    })
    test('result15 accepts power/actions only and never publishes embedded reply state', () => {
        for (const [prop, value, id] of [
            ['power', 'ON', 2],
            ['power', 'OFF', 2],
            ['start', 'PRESS', 3],
            ['pause', 'PRESS', 3],
            ['resume', 'PRESS', 3],
        ] as const) {
            const { dev, thinq, properties: p } = makeDevice()
            thinq.emit('data', frame(0xeb, commandStatus()))
            dev.setProperty(prop, value)
            const before = { ...p }
            thinq.emit('data', reply([id], commandStatus(14, 255, 0), [0x15]))
            assert.equal(p.problem, 'OFF')
            assert.deepEqual(p, before)
            dev.drop()
        }
        for (const [prop, value, id] of [
            ['rinse', '3', 0x20],
            ['buzzer', 'Low', 0x13],
            ['warm_water', 'ON', 0x46],
            ['melody', 'Bubble', 0x50],
            ['course', 'Tub Clean', 0x0a],
        ] as const) {
            const { dev, thinq, properties: p } = makeDevice()
            thinq.emit('data', frame(0xeb, commandStatus()))
            dev.setProperty(prop, value)
            thinq.emit('data', reply([id], commandStatus(14, 255, 0), [0x15]))
            assert.equal(p.problem, 'ON')
            assert.equal(p.course, 'Normal')
            assert.equal(p.status, 'Standby')
            assert.equal(p.rinse, 2)
            dev.drop()
        }
    })
    test('result17 refusal leaves state and the future command baseline unchanged, with no retry', () => {
        for (const [prop, value, id] of [
            ['rinse', '2', 0x20],
            ['warm_water', 'ON', 0x46],
            ['start', 'PRESS', 3],
        ] as const) {
            const { dev, thinq, properties: p } = makeDevice()
            const baseline = commandStatus(1, 46, 1)
            baseline[16] = 39
            thinq.emit('data', frame(0xeb, baseline))
            dev.setProperty(prop, value)
            const refused = commandStatus(0, 85, 2)
            refused[16] = 51
            refused[36] = 8
            thinq.emit('data', reply([id], refused, [0x17]))
            assert.equal(p.problem, 'ON')
            assert.equal(p.power, 'ON')
            assert.equal(p.course, 'Normal')
            assert.equal(p.status, 'Standby')
            assert.equal(p.rinse, 1)
            assert.equal(p.warm_water, 'OFF')
            assert.equal(p.total_time, 39)
            assert.equal(thinq.outbox.length, 1)
            dev.setProperty('rinse', '3')
            assert.equal(thinq.outbox.length, 2)
            assert.deepEqual(inner(thinq.outbox[1]).slice(-2), [0x20, 3])
            dev.drop()
        }
    })
    test('rejects invalid values and unsupported features, gates settings while off or unknown', () => {
        const { dev, thinq } = makeDevice()
        dev.setProperty('start', 'PRESS')
        dev.setProperty('rinse', '1')
        thinq.emit('data', frame(0xeb, commandStatus(0)))
        dev.setProperty('course', 'Normal')
        thinq.emit('data', frame(0xeb, commandStatus()))
        for (const [prop, value] of [
            ['rinse', '-1'],
            ['rinse', '7'],
            ['rinse', '1.5'],
            ['rinse', ''],
            ['rinse', 'NaN'],
            ['buzzer', 'Very High'],
            ['course', 'Downloaded'],
            ['power', 'on'],
            ['warm_water', 'on'],
            ['melody', 'Unknown'],
            ['keep_remote_start', 'on'],
            ['clock_display', 'ON'],
            ['remote_maintain', 'ON'],
        ])
            dev.setProperty(prop, value)
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })
    test('bridge and driver share FIFO; bridge replies do not update driver diagnostics or state', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.start()
        thinq.sendAsBridge(AABBDevice.frame(Buffer.from([0xf0, 0xe5, 0, 2, 1, 0xff, 1, 10, 85])))
        dev.setProperty('rinse', '4')
        assert.equal(thinq.outbox.length, 1)
        thinq.emit('data', reply([10], commandStatus(1, 85), [0x17]))
        assert.equal(thinq.outbox.length, 2)
        assert.equal(p.problem, 'OFF')
        assert.equal(p.course, 'Normal')
        thinq.emit('data', reply([0x20], commandStatus(), [0x17]))
        assert.equal(p.problem, 'ON')
        thinq.emit('data', frame(0xeb, commandStatus(1, 85)))
        assert.equal(p.course, 'Tub Clean')
        dev.drop()
    })
    test('shared timeout reports failure then resumes FIFO without retry or reconnect', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('buzzer', 'Off')
        dev.setProperty('rinse', '3')
        thinq.emit('data', reply([0x13], commandStatus().subarray(0, 48)))
        const wrongMarker = commandStatus()
        wrongMarker[0] = 1
        thinq.emit('data', reply([0x13], wrongMarker))
        assert.equal(thinq.outbox.length, 1)
        t.mock.timers.tick(WriteQueueMultiplexer.WRITE_TIMEOUT_MS)
        assert.equal(thinq.outbox.length, 2)
        assert.deepEqual(inner(thinq.outbox[1]).slice(-2), [0x20, 3])
        assert.match(String(p.problem_reason), /timed out/)
        thinq.emit('data', reply([0x20]))
        assert.equal(p.problem, 'OFF')
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 3)
        dev.drop()
    })
})
