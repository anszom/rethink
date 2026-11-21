import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RH90V9_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'

// RH90V9_WW (RC10V9AV2W) sends the same records; captures from a bridged unit.
describe('RH90V9_WW', () => {
    const meta: Metadata = { modelId: 'RH90V9_WW', modelName: 'RH90V9_WW', swVersion: '2.10.123' }
    // Reply to the cloud's F0ED request: on, no course yet.
    const EB_READY = buf('AA2130EB0019010000000000000000000000000000080000000000000073002EBB')
    // Knob: Delicate -> Sports Wear, no dry level, Eco, 0:50.
    const SPORTS_WEAR = buf(
        'AA3C30EC001901003000000A0000010200000000000800000000000000730000190100320000080000010200000000000820000000000000730093BB',
    )
    // Knob: Rack Dry -> the Downloaded Course position, Shoes/Fabric Doll on its base course Rack Dry, 3:00.
    const DOWNLOADED_SHOES = buf(
        'AA3C30EC001901030000000C00000102000000000008000000000000007300001901030000000C0000010200000000000800000000730000730096BB',
    )
    // Knob: Cotton -> Cotton+, Cupboard, Eco, 2:45.
    const COTTON_PLUS = buf(
        'AA3C30EC001901022D00000700030302000000000008000000000000007300001901022D00001900030102000000000008000000000000007300EDBB',
    )
    // Drum Care button: Rack Dry -> Tub Clean, no dry level, Time, 3:00.
    const TUB_CLEAN = buf(
        'AA3C30EC001901030000000C000001020000000008080000000000000073000019010300000013000003030000000008080000000000000073003FBB',
    )
    // Delay End: reserve 3 h and the Reservation bit.
    const DELAY_END_ON = buf(
        'AA3C30EC0019010300000013000003030000000000080000000000000073000019010300000013000003030300030001080000000000000073003EBB',
    )
    // Start: Ready -> Running, drying phase, initial time filled in (3:00).
    const START = buf(
        'AA3C30EC001901030000001300000303000000000008000000000000007300001902030003001300000303000000000008500000010000007300ECBB',
    )
    // Running -> Paused, then power off.
    const PAUSE = buf(
        'AA3C30EC0019020300030013000003030000000000085000000100000073000019030300030013000003030000000008080000000200000073009DBB',
    )
    const POWER_OFF = buf(
        'AA3C30EC0019030300030013000003030000000008080000000200000073000019000000000000000000000000000000080000000300000073000CBB',
    )

    test('decodes the knob, Delay End, a start, a pause and power off', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, meta)
        new DUT(ha.asConnection(), thinq, meta)
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', EB_READY)
        assert.deepEqual([props().power, props().status, props().course], ['ON', 'Standby', 'None'])

        thinq.emit('data', SPORTS_WEAR)
        assert.deepEqual(
            [props().course, props().dry_level, props().eco_hybrid, props().remaining_time],
            ['Sports Wear', 'Not selected', 'Eco', 50],
        )
        thinq.emit('data', DOWNLOADED_SHOES)
        assert.deepEqual([props().course, props().remaining_time], ['Shoes/Fabric Doll', 180])
        thinq.emit('data', COTTON_PLUS)
        assert.deepEqual(
            [props().course, props().dry_level, props().eco_hybrid, props().remaining_time],
            ['Cotton+', 'Cupboard', 'Eco', 165],
        )

        thinq.emit('data', TUB_CLEAN)
        assert.deepEqual(
            [props().course, props().dry_level, props().eco_hybrid, props().remaining_time],
            ['Tub Clean', 'Not selected', 'Turbo', 180],
        )

        thinq.emit('data', DELAY_END_ON)
        assert.deepEqual([props().delay, props().reserve_time], ['ON', 180])
        assert.equal(props().anti_crease, 'OFF')

        thinq.emit('data', START)
        assert.deepEqual(
            [props().status, props().phase, props().remaining_time, props().initial_time, props().delay],
            ['Drying', 'Drying', 180, 180, 'OFF'],
        )
        thinq.emit('data', PAUSE)
        assert.deepEqual([props().status, props().phase], ['Paused', 'Drying'])
        assert.equal(props().error, 'OFF')

        thinq.emit('data', POWER_OFF)
        assert.deepEqual([props().power, props().status, props().course], ['OFF', 'Off', 'None'])
    })
})
