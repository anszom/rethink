import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/MI2U7B'
import AABBDevice from '@/cloud/devices/aabb_device'
import { parseSideKickFrame } from '@/cloud/devices/MI2U7B_status'
import Bridge from '@/cloud/ha_bridge'
import crc16 from '@/util/crc16'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'MI2U7B', modelName: 'Test SideKick', deviceType: '201' }

// Synthetic, privacy-safe fixtures cover status, duration and energy fields.
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
        const sends: unknown[] = []
        thinq.on('sendData', (...args) => sends.push(args))
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
        assert.deepEqual(Object.keys(dev.config!.components).sort(), [
            'buzzer',
            'course',
            'cycle_finished',
            'drawer',
            'energy',
            'pause',
            'power',
            'problem',
            'problem_reason',
            'remaining_time',
            'resume',
            'rinse',
            'start',
            'status',
            'total_time',
        ])
        assert.equal(dev.config!.components.course.platform, 'select')
        assert.equal(thinq.sent.length, 5)
        assert.ok(thinq.sent.every((message) => message.cmd === 'ack'))
        assert.deepEqual(thinq.outbox, [])
        assert.ok(sends.every((entry) => (entry as unknown[])[0] === 'ack'))
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
function inner(packet: Buffer) {
    return [...packet.subarray(2, -2)]
}

describe('MI2U7B automatic ACKs', () => {
    test('valid long frames are processed before sequence-carrying ACKs, including retries', () => {
        const { thinq, properties: p, dev } = makeDevice()
        const packet = status(12, 85)
        packet.writeUInt16BE(0x1234, 7)
        checksum(packet)
        const sendAck = mock.method(thinq, 'send_ack', (ack: Buffer) => {
            assert.equal(p.status, 'Rinsing')
            assert.deepEqual(ack, AABBDevice.frame(Buffer.from([0xf0, 0, 0x0a, 4, 0x12, 0x34])))
        })
        thinq.emit('data', packet)
        thinq.emit('data', packet)
        assert.equal(sendAck.mock.callCount(), 2)
        dev.drop()
    })
    test('invalid frames are not ACKed; heartbeats and appliance ACKs never cause ACK loops', () => {
        const { thinq, dev } = makeDevice()
        const packet = status()
        const corrupt = Buffer.from(packet)
        corrupt[20] ^= 1
        for (let n = 0; n < packet.length; n++) thinq.emit('data', packet.subarray(0, n))
        thinq.emit('data', corrupt)
        thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0xc3])))
        thinq.emit('data', AABBDevice.frame(Buffer.from([0x20, 0, 0x24, 0])))
        assert.equal(thinq.sent.length, 0)
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })
})

describe('MI2U7B explicit assumed washer-style controls', () => {
    test('reports power, raw rinse and buzzer without startup writes', () => {
        const { dev, thinq, properties: p } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', frame(0xeb, commandStatus()))
        assert.equal(p.power, 'ON')
        assert.equal(p.rinse, 2)
        assert.equal(p.buzzer, 'Very High')
        const buzzer = dev.config!.components.buzzer
        assert.ok('entity_category' in buzzer)
        assert.equal(buzzer.entity_category, 'config')
        thinq.emit('data', frame(0xeb, commandStatus(0)))
        assert.equal(p.power, 'OFF')
        dev.drop()
    })
    test('rinse bundle preserves unknown unrelated fields and never echoes requested state', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('rinse', '6')
        const expected = Buffer.from([0xf0, 0xe5, 0, 2, 1, 0xff, 4, 0x1f, 0, 0x21, 19, 0x1e, 0, 0x20, 6])
        assert.deepEqual(thinq.outbox[0], AABBDevice.frame(expected))
        assert.equal(p.rinse, 2)
        thinq.emit('data', reply([0x1f, 0x21, 0x1e, 0x20], commandStatus(1, 46, 6)))
        assert.equal(p.rinse, 2)
        thinq.emit('data', frame(0xeb, commandStatus(1, 46, 6)))
        assert.equal(p.rinse, 6)
        dev.drop()
    })
    test('serializes, coalesces unsent rinse and validates matching reply property sets', () => {
        const { dev, thinq } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('buzzer', 'Low')
        assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0x33, 1, 0x13, 1])
        dev.setProperty('rinse', '3')
        dev.setProperty('rinse', '4')
        thinq.emit('data', reply([0x20]))
        assert.equal(thinq.outbox.length, 1)
        thinq.emit('data', reply([0x13], commandStatus(), [0], 0x33))
        assert.equal(thinq.outbox.length, 2)
        assert.deepEqual(inner(thinq.outbox[1]).slice(-2), [0x20, 4])
        dev.drop()
    })
    test('course selection, Start with course, pause/resume and power use explicit ordered writes', () => {
        for (const [prop, value, pairs] of [
            ['power', 'ON', [2, 1]],
            ['power', 'OFF', [2, 0]],
            ['course', 'Intimates', [10, 100]],
            ['start', 'PRESS', [10, 46, 3, 1]],
            ['pause', 'PRESS', [3, 2]],
            ['resume', 'PRESS', [3, 3]],
        ] as const) {
            const { dev, thinq } = makeDevice()
            thinq.emit('data', frame(0xeb, commandStatus()))
            dev.setProperty(prop, value)
            assert.deepEqual(inner(thinq.outbox[0]), [0xf0, 0xe5, 0, 2, 1, 0xff, pairs.length / 2, ...pairs])
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
            ['buzzer', 'Loud'],
            ['course', 'Downloaded'],
            ['power', 'on'],
            ['warm_water', 'ON'],
            ['clock_display', 'ON'],
            ['remote_maintain', 'ON'],
        ])
            dev.setProperty(prop, value)
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', frame(0xeb, commandStatus(1, 255)))
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox.length, 0)
        dev.drop()
    })
    test('refused writes report failure and late replies across course boundaries cannot restore context', () => {
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('rinse', '4')
        dev.setProperty('rinse', '5')
        thinq.emit('data', frame(0xeb, commandStatus(1, 85)))
        thinq.emit('data', reply([0x1f, 0x21, 0x1e, 0x20]))
        assert.equal(thinq.outbox.length, 1)
        assert.equal(p.course, 'Tub Clean')
        dev.setProperty('buzzer', 'Low')
        thinq.emit('data', reply([0x13], commandStatus(1, 85), [0x13], 0x33))
        assert.equal(p.problem, 'ON')
        assert.equal(p.buzzer, 'Very High')
        dev.drop()
    })
    test('accepted bundle baseline survives stale reports for 30 seconds only', (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: 1000 })
        const { dev, thinq } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('rinse', '3')
        const accepted = commandStatus(1, 46, 3)
        accepted[2] = 9
        thinq.emit('data', reply([0x1f, 0x21, 0x1e, 0x20], accepted))
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('rinse', '4')
        assert.equal(inner(thinq.outbox[1])[8], 9)
        thinq.emit('data', reply([0x1f, 0x21, 0x1e, 0x20], accepted))
        t.mock.timers.tick(30_001)
        dev.setProperty('rinse', '5')
        assert.equal(inner(thinq.outbox[2])[8], 0)
        dev.drop()
    })
    test('tracks bridge writes and waits for fresh status after course acceptance', () => {
        const { dev, thinq } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        thinq.send_packet(AABBDevice.frame(Buffer.from([0xf0, 0xe5, 0, 2, 1, 0xff, 1, 10, 85])))
        dev.setProperty('rinse', '4')
        thinq.emit('data', reply([10], commandStatus(1, 85)))
        assert.equal(thinq.outbox.length, 1)
        thinq.emit('data', frame(0xeb, commandStatus(1, 85)))
        dev.setProperty('rinse', '4')
        assert.equal(thinq.outbox.length, 2)
        dev.drop()
    })
    test('strict timeout blocks further writes, malformed replies do not settle', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { dev, thinq, properties: p } = makeDevice()
        thinq.emit('data', frame(0xeb, commandStatus()))
        dev.setProperty('buzzer', 'Off')
        dev.setProperty('rinse', '3')
        const corrupt = reply([0x13], commandStatus(), [0], 0x33)
        corrupt[corrupt.length - 2] ^= 1
        thinq.emit('data', corrupt)
        t.mock.timers.tick(AABBDevice.WRITE_TIMEOUT_MS)
        thinq.emit('data', reply([0x13], commandStatus(), [0], 0x33))
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.match(String(p.problem_reason), /reconnect required/)
        dev.drop()
    })
})
