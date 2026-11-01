import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import * as TLV from '@/util/tlv'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'RAC_056905_WW', modelName: 'TEST', swVersion: '1.0' }

// Live captures from a WZ18AWN SNU1 (S3NW18TZXBA) indoor unit (firmware 0x917be), running in heat.
// Its capabilities have no EEPROM checksum (0x2da), and advertise swing as 0x2cd=0x30.
const CAPS_RESPONSE_HEX =
    '000004000000A702010167B001B05057B0A001FEB0C0B100B2103DB280B2C4B300B4C4B5A08000B500B540B35030D402B85020B890' +
    '3EB8D020B9103EBAD020BB103EBC6002014281B5C0B61032B648B5C1B61032B648B5C2B61032B648B5C6B61032B648B5C4B61032B6' +
    '48B6F00917BEBD4151C5'
const QUERY_RESPONSE_HEX =
    '000004000000A7020401417E447DC17E887F50327F9032820081408180824082C083008340838083C086A0000086E000008720000087' +
    'C08850008E80C8C0D5600000D5A002D0C85000C89000B257'

// Writes sent from HA and accepted by the unit (its remote sends the same values)
const WRITE_SWING_ON_HEX = '0101040000006502010103C8506471D7' // 0x321=100
const WRITE_SWING_H_OFF_HEX = '0101040000006502010102C880AC4A' // 0x322=0

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => dev.setProperty(prop, value))

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))
    // filter probe timeout, then initMakeSetConfig queries the values again
    tickMockTimers(t, 6000)
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))

    thinq.resetRecorder()
    return { ha, thinq, dev, components: ha.devices[DEVICE_ID]?.config?.components as Record<string, any> }
}

/** The TLVs of each packet sent to the unit. */
const sentTLVs = (thinq: MockThinq2Device) => thinq.outbox.map((b) => TLV.parse(b.subarray(11, b.length - 2)))

describe('RAC_056905_WW S3NW18TZXBA (fw 0x917be)', () => {
    test('initialises from a caps response without an EEPROM checksum', (t) => {
        const { thinq, components, dev } = buildReadyDevice(t)
        assert.ok(components?.climate)

        // the caps query (0x1f5=1) is no longer retried
        tickMockTimers(t, 60 * 1000)
        assert.ok(!sentTLVs(thinq).some((tlvs) => tlvs.some(({ t, v }) => t === 0x1f5 && v === 1)))
        dev.drop()
    })

    test('exposes on/off-only swing', (t) => {
        const { ha, thinq, components, dev } = buildReadyDevice(t)
        const write = (prop: string, value: string) => {
            thinq.resetRecorder()
            ha.setProperty(DEVICE_ID, 'climate', prop, value)
            return thinq.outbox.map((b) => hex(b))
        }

        assert.deepEqual(components.climate.swing_modes, ['on', 'off'])
        assert.deepEqual(components.climate.swing_horizontal_modes, ['on', 'off'])
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'off')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'off')

        assert.deepEqual(write('swing_mode_command', 'on'), [WRITE_SWING_ON_HEX])
        assert.deepEqual(write('swing_horizontal_mode_command', 'off'), [WRITE_SWING_H_OFF_HEX])
        // vane positions aren't sent: the unit rejects them
        assert.deepEqual(write('swing_mode_command', '3'), [])
        assert.deepEqual(write('swing_horizontal_mode_command', '1-3'), [])
        dev.drop()
    })
})
