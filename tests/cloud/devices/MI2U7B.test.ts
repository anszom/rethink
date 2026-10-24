import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/MI2U7B'
import { parseSideKickFrame } from '@/cloud/devices/MI2U7B_status'
import Bridge from '@/cloud/ha_bridge'
import crc16 from '@/util/crc16'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'MI2U7B', modelName: 'Test SideKick', deviceType: '201' }

// Synthetic, privacy-safe fixtures populate only independently observed offsets.
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
    if (length > 14) payload[14] = value
    payload[5] = counter
    return frame(0x03, payload)
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device('test-sidekick', META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, properties: ha.devices[thinq.id].properties }
}

describe('MI2U7B passive exact-model support', () => {
    test('confirmed course labels, Standby and observed TubClean Rinsing context', () => {
        const { thinq, properties: p } = makeDevice()
        for (const [code, label] of [
            [46, 'Normal'],
            [85, 'TubClean'],
            [100, 'Intimates'],
            [33, 'Hand Wash'],
            [55, 'Rinse+Spin'],
            [255, 'Downloaded'],
            [254, 'Unknown'],
        ] as const) {
            thinq.emit('data', status(1, code))
            assert.equal(p.course, label)
            assert.equal(p.status, 'Standby')
            assert.equal(p.remaining_time, 'None')
        }
        thinq.emit('data', status(12, 85, 13))
        assert.deepEqual(p, { course: 'TubClean', status: 'Rinsing', remaining_time: 13 })
        thinq.emit('data', status(12, 85, 513))
        assert.equal(p.remaining_time, 513)
        // A physical Rinsing observation on TubClean does not establish other courses.
        thinq.emit('data', status(12, 46, 7))
        assert.equal(p.status, 'Unknown')
        assert.equal(p.remaining_time, 7)
    })

    test('does not import provisional phases or normalize a guessed finish', () => {
        const { thinq, properties: p } = makeDevice()
        for (const code of [0, 2, 3, 11, 14, 16, 41, 255]) {
            thinq.emit('data', status(code, 85, 1))
            assert.equal(p.status, 'Unknown')
            assert.equal(p.remaining_time, 1)
        }
        const candidate = Buffer.alloc(99)
        candidate.set([12, 11, 1, 8, 12])
        const before = { ...p }
        for (const length of [10, 17, 55, 73]) thinq.emit('data', frame(3, Buffer.alloc(length)))
        thinq.emit('data', frame(3, candidate))
        assert.deepEqual(p, before)
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
        const badDrawer = drawer(0)
        badDrawer[20] ^= 1
        assert.equal(parseSideKickFrame(badDrawer), undefined)
        assert.deepEqual(p, before)
    })

    test('startup preserves prior reports and exact-model bridge never writes, queries or ACKs', () => {
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
        assert.equal(dev.publishCache.size, 0)
        dev.start()
        ha.emit('discovery')
        for (const prop of ['power', 'start', 'drawer', 'anything']) ha.emit('setProperty', thinq.id, prop, 'ON')
        for (const packet of [status(), drawer(1), frame(0x85, Buffer.alloc(52)), Buffer.alloc(0)])
            thinq.emit('data', packet)
        assert.deepEqual(Object.keys(dev.config!.components).sort(), ['course', 'drawer', 'remaining_time', 'status'])
        for (const component of Object.values(dev.config!.components)) {
            assert.ok(['sensor', 'binary_sensor'].includes(component.platform))
            assert.ok(!Object.keys(component).some((key) => key.includes('command_topic')))
        }
        assert.deepEqual(thinq.sent, [])
        assert.deepEqual(thinq.outbox, [])
        assert.deepEqual(sends, [])
        const unknown = new MockThinq2Device('unmatched', { ...META, modelId: 'MI2U7B_other' })
        bridge.newDevice(unknown)
        assert.equal(bridge.haDevices.has(unknown.id), false)
    })
})
