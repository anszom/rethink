import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/MI2U7B'
import { parseSideKickFrame } from '@/cloud/devices/MI2U7B_status'
import Bridge from '@/cloud/ha_bridge'
import crc16 from '@/util/crc16'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const META: Metadata = { modelId: 'MI2U7B', modelName: 'Test SideKick', deviceType: '201' }

// Synthetic, privacy-safe fixtures cover observed and user-approved provisional fields.
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
    test('confirmed course labels, Standby and observed TubClean Rinsing context', () => {
        const { thinq, properties: p } = makeDevice()
        for (const [code, label] of [
            [46, 'Normal'],
            [85, 'TubClean'],
            [100, 'Intimates'],
            [33, 'Hand Wash'],
            [55, 'Rinse+Spin'],
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
            course: 'TubClean',
            status: 'Rinsing',
            status_confidence: 'Observed',
            remaining_time: 13,
            total_time: 39,
            energy: 0,
        })
        thinq.emit('data', status(12, 85, 513))
        assert.equal(p.remaining_time, 513)
        // The same label on other courses remains provisional.
        thinq.emit('data', status(12, 46, 7))
        assert.equal(p.status, 'Rinsing')
        assert.equal(p.status_confidence, 'Provisional')
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
            payload[17] = high
            payload[18] = low
            payload[19] = 9
            thinq.emit('data', frame(0xeb, payload))
            assert.equal(p.energy, value)
        }
        const energy = dev.config!.components.energy
        assert.ok('unit_of_measurement' in energy && 'device_class' in energy && 'state_class' in energy)
        assert.equal(energy.unit_of_measurement, 'Wh')
        assert.equal(energy.device_class, 'energy')
        assert.equal(energy.state_class, 'total_increasing')
    })

    test('provisional phases retain confidence and unknown numeric fallback; countdown follows ours', () => {
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
            assert.equal(p.status_confidence, 'Provisional')
            assert.equal(p.remaining_time, code === 0 ? 'None' : code === 16 ? 0 : 9)
        }
        thinq.emit('data', status(16, 46, 9))
        assert.equal(p.remaining_time, 9)
        thinq.emit('data', status(255, 254, 9))
        assert.equal(p.status, 'Status 255')
        assert.equal(p.status_confidence, 'Unknown')
        assert.equal(p.course, 'Program 254')
        thinq.emit('data', status(1))
        assert.equal(p.status_confidence, 'Observed')
        assert.equal(p.remaining_time, 'None')
    })

    test('total time uses LE16 at16 while canonical energy uses overlapping BE16 at17', () => {
        const { thinq, properties: p } = makeDevice()
        const payload = Buffer.alloc(49)
        payload[21] = 11
        payload.set([0x34, 0x12, 0x56, 0x78], 16)
        thinq.emit('data', frame(0xeb, payload))
        assert.equal(p.total_time, 0x1234)
        assert.equal(p.energy, 0x1256)
        payload.writeUInt16LE(513, 14)
        thinq.emit('data', frame(0xeb, payload))
        assert.equal(p.remaining_time, 513)
        assert.equal(p.total_time, 0x1234)
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
            'course',
            'cycle_finished',
            'drawer',
            'energy',
            'remaining_time',
            'status',
            'status_confidence',
            'total_time',
        ])
        for (const component of Object.values(dev.config!.components)) {
            assert.ok(['sensor', 'binary_sensor', 'event'].includes(component.platform))
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
