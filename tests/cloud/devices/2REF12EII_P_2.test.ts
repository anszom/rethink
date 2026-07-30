import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF12EII_P_2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF12EII_P_2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

// Real packet captures from my_fridge_study*.jsonl (LG ThinQ fridge 2REF12EII_P_2).
// Frame structure (AABBDevice):
//   AA <len> 10 EC <9B prev status> <9B cur status> <cksum> BB    - status push
//   AA <len> 10 A8 <door type> <state> <cksum> BB                  - door state push
//
// Status block (9 bytes): [type][fridge_raw][freezer_raw][expressFreeze][pureNFresh][...4B]
//   Fridge:    C = 7 - raw     (verified: raw 2->5C, raw 5->2C, raw 4->3C)
//   Freezer:   C = -(raw + 15) (verified: raw 3->-18C, raw 4->-19C)
//   ExpressFreeze: 0x01=OFF, 0x02=ON
//   PureNFresh:    0x01=Off, 0x02=Automatic, 0x03=Power

function captures() {
    return {
        // --- 0x10EC status frames (full AA..BB packets from live data) ---

        // BASELINE: fridge=3C(raw4), freezer=-17C(raw2), expressOff, pureAuto(2), doorClosed
        BASELINE_10EC: buf('aa1810ec020403010202040001020403010202040001b0bb'),

        // DELTA DOOR OPEN: cur[7]=0x01 (door OPEN), all else same as baseline
        DELTA_DOOR_OPEN_10EC: buf('aa1810ec020403010202040001020403010202040101b0bb'),

        // DELTA PURE POWER: cur[4]=0x03 (Pure N Fresh = Power)
        DELTA_PURE_POWER_10EC: buf('aa1810ec020403010102040001020403010302040001b1bb'),

        // DELTA PURE AUTO: cur[4]=0x02 (Pure N Fresh = Automatic)
        DELTA_PURE_AUTO_10EC: buf('aa1810ec020403010302040001020403010202040001b0bb'),

        // DELTA PURE OFF: cur[4]=0x01 (Pure N Fresh = Off)
        DELTA_PURE_OFF_10EC: buf('aa1810ec020403010202040001020403010102040001b6bb'),

        // DELTA EXPRESS FREEZE ON: cur[3]=0x02 (express freeze ON)
        DELTA_EXPRESS_ON_10EC: buf('aa1810ec020403010202040001020403020202040001b0bb'),

        // DELTA FRIDGE 5C (set): cur[1]=0x02 -> 7-2=5°C
        DELTA_FRIDGE_5C_10EC: buf('aa1810ec020403010202040001020203010202040001b7bb'),

        // DELTA FREEZER -18C: cur[2]=0x03 -> -(3+15)=-18°C
        DELTA_FREEZER_18C_10EC: buf('aa1810ec020403010202040001020403010202040001b7bb'),

        // DELTA PURE REPLACE: cur[4]=0x04 (Pure N Fresh filter needs replacing)
        DELTA_PURE_REPLACE_10EC: buf('aa1610ec0204030102020400010204030104020400016fbb'),

        // DELTA WATER FILTER 7: cur[6]=0x07 (water filter = 7 months)
        DELTA_WATER_FILTER_7_10EC: buf('aa1610ec0204030102020400010204030102020700016ebb'),

        // --- 0x10A8 door frames ---

        // DOOR OPEN (door type 1, state=0x01=open)
        DOOR_OPEN_10A8: buf('aa0810a8010139bb'),

        // DOOR CLOSED (door type 1, state=0x00=closed)
        DOOR_CLOSED_10A8: buf('aa0810a801003ebb'),

        // --- Outgoing command frames (full AA..BB from toDevice captures) ---

        FRIDGE_SET_5C_F017: buf(
            'aa2ff017ff02ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff94bb',
        ),

        FREEZER_SET_M18C_F017: buf(
            'aa2ff017ffff03ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff97bb',
        ),

        PURE_OFF_F017: buf(
            'aa2ff017ffffffff01ffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffebbb',
        ),

        PURE_POWER_F017: buf(
            'aa2ff017ffffffff03ffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff95bb',
        ),

        PURE_AUTO_F017: buf(
            'aa2ff017ffffffff02ffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffeabb',
        ),

        EXPRESS_ON_F017: buf(
            'aa2ff017ffffff02ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffeabb',
        ),
    }
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config is published immediately in the constructor (always Celsius)', () => {
        const { ha } = makeDevice()
        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev, 'device entry created at construction')
        assert.ok(dev.config, 'config published without a status packet')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)
        assert.ok(components.express_freeze, 'express_freeze component present')
        assert.ok(components.pure_option, 'pure_option component present')
        assert.equal(
            components.pure_n_fresh_replace.entity_category,
            'diagnostic',
            'pure_n_fresh_replace is diagnostic category',
        )
        assert.equal(components.water_filter.entity_category, 'diagnostic', 'water_filter is diagnostic category')
        assert.equal(components.water_filter.unit_of_measurement, 'months', 'water_filter unit is months')
        assert.ok(components.door, 'door component present')

        const pureOptions = components.pure_option.options as string[]
        assert.deepEqual(pureOptions, ['Automatic', 'Power', 'Off'])
    })

    test('0x10EC baseline decodes all seven properties including door from status block', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.BASELINE_10EC)

        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 3) // 7 - raw(4) = 3°C
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -18) // -(raw(3)+15) = -18°C
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF') // cur[7]=0 → door closed
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.pure_option, 'Automatic')
        // New: replace indicator shows OK (byte[4]=2, not 4)
        assert.equal(ha.devices[DEVICE_ID].properties.pure_n_fresh_replace, 'OK')
        // New: water filter raw value from byte[6]
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter, '4')
    })

    test('0x10EC with pure N Fresh = replace (byte 4 = 0x04) sets replace sensor', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_PURE_REPLACE_10EC)

        // pure_option: value 0x04 not in mapping, defaults to 'Automatic'
        assert.equal(ha.devices[DEVICE_ID].properties.pure_option, 'Automatic')
        // replace sensor: byte[4]=4 → 'replace'
        assert.equal(ha.devices[DEVICE_ID].properties.pure_n_fresh_replace, 'replace')
    })

    test('0x10EC water filter sensor reports raw month value from byte 6', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_WATER_FILTER_7_10EC)

        assert.equal(ha.devices[DEVICE_ID].properties.water_filter, '7')
    })

    test('door state is also reported via 0x10A8 frames (secondary source)', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()

        // 0x10A8 works as a secondary/confirming door source alongside 0x10EC
        thinq.emit('data', caps.DOOR_OPEN_10A8)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')

        thinq.emit('data', caps.DOOR_CLOSED_10A8)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('0x10EC delta with pure N Fresh = Power', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_PURE_POWER_10EC)
        assert.equal(ha.devices[DEVICE_ID].properties.pure_option, 'Power')
    })

    test('0x10EC delta with pure N Fresh = Automatic', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_PURE_AUTO_10EC)
        assert.equal(ha.devices[DEVICE_ID].properties.pure_option, 'Automatic')
    })

    test('0x10EC delta with pure N Fresh = Off', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_PURE_OFF_10EC)
        assert.equal(ha.devices[DEVICE_ID].properties.pure_option, 'Off')
    })

    test('0x10EC delta with express freeze ON', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_EXPRESS_ON_10EC)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
    })

    test('0x10EC delta with fridge=5°C decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_FRIDGE_5C_10EC)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 5) // 7 - raw(2) = 5°C
    })

    test('0x10EC delta with freezer=-18°C decodes correctly', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.DELTA_FREEZER_18C_10EC)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -18) // -(raw(3)+15) = -18°C
    })

    test('0x10A8 door frame sets door state', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()

        thinq.emit('data', caps.DOOR_OPEN_10A8)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')

        thinq.emit('data', caps.DOOR_CLOSED_10A8)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('suppresses duplicate publishes when status block is unchanged', () => {
        const { ha, thinq } = makeDevice()
        const caps = captures()
        thinq.emit('data', caps.BASELINE_10EC)

        let publishCalls = 0
        const realPublish = ha.publishProperty.bind(ha)
        ha.publishProperty = (id, prop, value) => {
            publishCalls++
            return realPublish(id, prop, value)
        }
        thinq.emit('data', caps.BASELINE_10EC)
        assert.equal(publishCalls, 0, 'no republishes when nothing changed')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(Object.keys(ha.devices[DEVICE_ID].properties).length, 0)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(Object.keys(ha.devices[DEVICE_ID].properties).length, 0)
    })

    test('start() sends the F0ED status-query packet so all entities initialize at boot', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        const pkt = thinq.outbox[0]
        // send() wraps in AA..BB envelope → inner bytes F0, ED land at frame offsets 2, 3
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0xed)
    })

    test('0x10EB initial status (9-byte variant) populates all seven entities at startup', () => {
        const { ha, thinq } = makeDevice()
        // Simulate a 0x10EB response: [cmd 2B][status 9B] matching baseline values
        // Derived from live capture baseline: prev=020403010202040001  cur=020403010202040001
        const initial10EB = buf('aa0b10eb020403010202040001d5bb')
        thinq.emit('data', initial10EB)

        // All seven entities should be populated immediately
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_setpoint, 3) // 7 - raw(4) = 3°C
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_setpoint, -18) // -(raw(3)+15) = -18°C
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF') // cur[7]=0 → door closed
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.pure_option, 'Automatic')
        assert.equal(ha.devices[DEVICE_ID].properties.pure_n_fresh_replace, 'OK')
        assert.equal(ha.devices[DEVICE_ID].properties.water_filter, '4')
    })

    // --- Outgoing command tests ---

    test('HA write fridge_setpoint=5°C sends correct F017 command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '5')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        // raw = 7 - 5 = 2, written to body[3] -> frame offset 5
        assert.equal(pkt[5], 2)
        // ack flag at body[10] -> frame offset 12
        assert.equal(pkt[12], 0x01)
    })

    test('HA write fridge_setpoint=1°C sends correct command (boundary)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '1')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        // raw = 7 - 1 = 6
        assert.equal(pkt[5], 6)
    })

    test('HA write fridge_setpoint=7°C sends correct command (boundary)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '7')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        // raw = 7 - 7 = 0
        assert.equal(pkt[5], 0)
    })

    test('HA write freezer_setpoint=-20°C sends correct F017 command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        // raw = -(-20 + 15) = 5, written to body[4] -> frame offset 6
        assert.equal(pkt[6], 5)
        // ack flag at body[10] -> frame offset 12
        assert.equal(pkt[12], 0x01)
    })

    test('HA write freezer_setpoint=-23°C sends correct command (boundary)', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-23')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        // raw = -(-23 + 15) = 8
        assert.equal(pkt[6], 8)
    })

    test('HA write express_freeze=ON sends correct command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        // express freeze value at body[5] -> frame offset 7
        assert.equal(pkt[7], 0x02)
    })

    test('HA write express_freeze=OFF sends correct command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'OFF')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        assert.equal(pkt[7], 0x01)
    })

    test('HA write pure_option=Off sends correct command with value at body[6]', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('pure_option', 'Off')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        // Pure N Fresh value at body[6] -> frame offset 8
        assert.equal(pkt[2], 0xf0)
        assert.equal(pkt[3], 0x17)
        assert.equal(pkt[8], 0x01) // Off = raw 1
    })

    test('HA write pure_option=Automatic sends correct command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('pure_option', 'Automatic')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        assert.equal(pkt[8], 0x02) // Automatic = raw 2
    })

    test('HA write pure_option=Power sends correct command', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('pure_option', 'Power')
        assert.equal(thinq.outbox.length, 1)

        const pkt = thinq.outbox[0]
        assert.equal(pkt[8], 0x03) // Power = raw 3
    })

    test('HA write pure_option with unrecognised value sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('pure_option', 'InvalidMode')
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write to an unknown property sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('does-not-exist', '1')
        assert.equal(thinq.outbox.length, 0)
    })
})
