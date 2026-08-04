import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import DUT from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import { encodePacket } from '@/util/packet-codec'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WIN_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WIN_056905_WW', swVersion: '352200' }

// Captured from an LG LW1022FVSM. This model reports TLV capabilities in a 0xA7
// device-to-cloud packet even though older WIN_056905_WW captures used 0x87.
const CAPS_RESPONSE_HEX =
    '000004000000A702016A51' +
    'B009B0600107B09054B0C1B103B300B340B4E05016B55060B6A003E5B6F0352200B85020B8903C' +
    'B8D020B9103CBC600201BD30080000BD47B5C0B61020B642B5C1B600B642B5C2B600B642B5C8B600B6427811'
const QUERY_REQUEST_HEX = '01010400000065020201027D425A6E'
const VALUES_RESPONSE_HEX =
    '000004000000A702041643' +
    '7E427DC17E827F502D7F90238180C8C08340868086C08700884089408A008A50628A808C808CC0' +
    'ACD032D550F9D590FACAD086CB1086CB8CCBC0CC00CC90851B00C0C03967'
const WRITE_FAN_MEDIUM_HEX = '01010400000065020101077E847E427F9023133F'
const WRITE_FAN_HIGH_HEX = toDeviceHex([
    { t: 0x1fa, v: 6 },
    { t: 0x1f9, v: 2 },
    { t: 0x1fe, v: 35 },
])
const WRITE_MODE_DRY_HEX = '01010400000065020101097E417DC17E827F9023521E'
const WRITE_MODE_FAN_ONLY_FROM_OFF_HEX = toDeviceHex([
    { t: 0x1f9, v: 2 },
    { t: 0x1f7, v: 1 },
    { t: 0x1fa, v: 2 },
    { t: 0x1fe, v: 35 },
])
const WRITE_POWER_OFF_HEX = '01010400000065020101027DC00576'
const WRITE_ENERGY_SAVER_ON_HEX = '01010400000065020101097E487DC17E827F90230B17'
const WRITE_ENERGY_SAVER_OFF_HEX = '01010400000065020101097E407DC17E827F902315CD'
const WRITE_SLEEP_TIMER_1H_HEX = '010104000000650201010386903CBAD2'
const WRITE_STOP_TIMER_1H_HEX = '010104000000650201010386D03CB71E'
const WRITE_START_TIMER_1H_HEX = '010104000000650201010387103C967A'
const WRITE_TEMPERATURE_21C_HEX = toDeviceHex([
    { t: 0x1fe, v: 42 },
    { t: 0x1f9, v: 2 },
    { t: 0x1fa, v: 2 },
])
const VALUES_RESPONSE_ENERGY_SAVER_HEX =
    '000004000000A702041643' +
    '7E487DC17E827F502D7F90238180C8C08340868086C08700884089408A008A50628A808C808CC0' +
    'ACD032D550F9D590FACAD086CB1086CB8CCBC0CC00CC90851B00C0C03967'
const VALUES_RESPONSE_SLEEP_TIMER_SUBHOUR_HEX = '000004000000A702040D02868F09F5'
const VALUES_RESPONSE_STOP_TIMER_SUBHOUR_HEX = '000004000000A70204410286CF609F'
const VALUES_RESPONSE_START_TIMER_SUBHOUR_HEX = '000004000000A70204C602870F06F7'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

function toDeviceHex(tlv: { t: number; v: number }[]) {
    return encodePacket({
        protocol: 'tlv',
        direction: 'toDevice',
        a: 1,
        s: 1,
        byte5: 0x02,
        byte6: 0x01,
        byte7: 0x01,
        tlv,
    }).hex.toUpperCase()
}

function buildReadyDevice(t: import('node:test').TestContext) {
    return buildDeviceFromFixtures(t, CAPS_RESPONSE_HEX, VALUES_RESPONSE_HEX)
}

function buildDeviceFromFixtures(t: import('node:test').TestContext, capsHex: string, valuesHex: string) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()
    thinq.resetRecorder()

    thinq.emit('data', buf(capsHex))
    assert.equal(thinq.outbox.length, 1)
    assert.equal(hex(thinq.outbox[0]), QUERY_REQUEST_HEX)

    thinq.emit('data', buf(valuesHex))
    tickMockTimers(t, 6000)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe('RAC unified implementation with LG LW1022FVSM / WIN_056905_WW fixtures', () => {
    test('discovery config waits for capability packet', () => {
        const { ha, dev } = makeDevice()

        try {
            assert.equal(ha.devices[DEVICE_ID]?.config, undefined, 'HA discovery should not publish before caps')
        } finally {
            dev.drop()
        }
    })

    test('0xA7 caps response triggers values query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        try {
            thinq.emit('data', buf(CAPS_RESPONSE_HEX))

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), QUERY_REQUEST_HEX)
        } finally {
            dev.drop()
        }
    })

    test('ha_bridge routes WIN_056905_WW through the unified RAC implementation', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())

        try {
            bridge.newDevice(thinq)

            assert.ok(bridge.haDevices.get(DEVICE_ID) instanceof DUT)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('0xA7 values response publishes expected climate properties', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        try {
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'fan_only')
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'low')
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 22.5)
            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 17.5)
        } finally {
            dev.drop()
        }
    })

    test('LW1022FVSM capability packet advertises supported HA controls', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        try {
            const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
            assert.deepEqual(components.climate.modes, ['off', 'cool', 'dry', 'fan_only'])
            assert.deepEqual(components.climate.fan_modes, ['low', 'medium', 'high'])
            assert.equal(components.climate.min_temp, 16)
            assert.equal(components.climate.max_temp, 30)
            assert.equal(Object.hasOwn(components.climate, 'swing_modes'), false)
            assert.equal(Object.hasOwn(components.climate, 'swing_mode_state_topic'), false)
            assert.equal(Object.hasOwn(components.climate, 'swing_mode_command_topic'), false)
            assert.equal(components.energysaver.platform, 'switch')
            assert.equal(components.energysaver.name, 'Energy Saver')
            assert.equal(components.energysaver.state_topic, '$this/energysaver')
            assert.equal(components.energysaver.command_topic, '$this/energysaver/set')
            assert.ok(components.sleeptimer, 'sleep timer number component')
            assert.equal(components.sleeptimer.platform, 'number')
            assert.equal(components.sleeptimer.name, 'Sleep timer')
            assert.equal(components.sleeptimer.max, 12)
            assert.equal(components.sleeptimer.step, 1)
            assert.ok(components.starttimer, 'turn-on timer number component')
            assert.equal(components.starttimer.platform, 'number')
            assert.equal(components.starttimer.name, 'Turn-on timer')
            assert.equal(components.starttimer.max, 24)
            assert.equal(components.starttimer.step, 1)
            assert.ok(components.stoptimer, 'turn-off timer number component')
            assert.equal(components.stoptimer.platform, 'number')
            assert.equal(components.stoptimer.name, 'Turn-off timer')
            assert.equal(components.stoptimer.max, 24)
            assert.equal(components.stoptimer.step, 1)
        } finally {
            dev.drop()
        }
    })

    test('discovery config has no invalid top-level name field after capabilities', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        try {
            const device = ha.devices[DEVICE_ID]
            assert.ok(device, 'HA configuration published')
            assert.equal(Object.hasOwn(device.config!, 'name'), false, 'discovery config should omit top-level name')
            assert.equal(device.config!.device.name, 'LG Air Conditioner')
            assert.equal(device.config!.components.climate.name, null)
        } finally {
            dev.drop()
        }
    })

    test('initial values publish timer state in hours', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        try {
            assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 0)
            assert.equal(ha.getProperty(DEVICE_ID, 'starttimer', 'state'), 0)
            assert.equal(ha.getProperty(DEVICE_ID, 'stoptimer', 'state'), 0)
        } finally {
            dev.drop()
        }
    })

    test('LW1022FVSM timer readback follows manual whole-hour display steps', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            thinq.emit('data', buf(VALUES_RESPONSE_SLEEP_TIMER_SUBHOUR_HEX))
            thinq.emit('data', buf(VALUES_RESPONSE_STOP_TIMER_SUBHOUR_HEX))
            thinq.emit('data', buf(VALUES_RESPONSE_START_TIMER_SUBHOUR_HEX))

            assert.equal(ha.getProperty(DEVICE_ID, 'sleeptimer', 'state'), 1)
            assert.equal(ha.getProperty(DEVICE_ID, 'starttimer', 'state'), 1)
            assert.equal(ha.getProperty(DEVICE_ID, 'stoptimer', 'state'), 1)
        } finally {
            dev.drop()
        }
    })

    test('HA write climate-fan_mode=medium emits raw fan value 4', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'medium')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_FAN_MEDIUM_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA write climate-fan_mode=high emits raw fan value 6', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            ha.setProperty(DEVICE_ID, 'climate', 'fan_mode_command', 'high')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_FAN_HIGH_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA write climate-mode=dry emits raw mode value 1', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'dry')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_MODE_DRY_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA write climate-mode=fan_only from off includes power-on TLV', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            dev.raw_clip_state[0x1f7] = 0
            dev.raw_clip_state[0x1f9] = 0
            thinq.resetRecorder()

            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'fan_only')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_MODE_FAN_ONLY_FROM_OFF_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA write climate-mode=off emits a power-off packet', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'off')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_POWER_OFF_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA write climate-temperature=21 emits raw target temperature 42', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            ha.setProperty(DEVICE_ID, 'climate', 'temperature_command', '21')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_TEMPERATURE_21C_HEX)
        } finally {
            dev.drop()
        }
    })

    test('raw mode 8 publishes climate cool plus energy saver ON', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        try {
            thinq.emit('data', buf(VALUES_RESPONSE_ENERGY_SAVER_HEX))

            assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'cool')
            assert.equal(ha.devices[DEVICE_ID].properties.energysaver, 'ON')
        } finally {
            dev.drop()
        }
    })

    test('HA write energysaver=ON emits raw mode value 8', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        try {
            dev.setProperty('energysaver', 'ON')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_ENERGY_SAVER_ON_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA write energysaver=OFF from energy saver emits raw cool mode', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        try {
            thinq.emit('data', buf(VALUES_RESPONSE_ENERGY_SAVER_HEX))
            thinq.resetRecorder()

            dev.setProperty('energysaver', 'OFF')

            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_ENERGY_SAVER_OFF_HEX)
        } finally {
            dev.drop()
        }
    })

    test('HA timer writes emit protocol minutes', (t) => {
        const { thinq, dev } = buildReadyDevice(t)

        try {
            dev.setProperty('sleeptimer-', '1')
            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_SLEEP_TIMER_1H_HEX)

            thinq.resetRecorder()
            dev.setProperty('stoptimer-', '1')
            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_STOP_TIMER_1H_HEX)

            thinq.resetRecorder()
            dev.setProperty('starttimer-', '1')
            assert.equal(thinq.outbox.length, 1)
            assert.equal(hex(thinq.outbox[0]), WRITE_START_TIMER_1H_HEX)
        } finally {
            dev.drop()
        }
    })
})
