import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WTL_FXU_BDV_NA_01'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { encodePacket } from '@/util/packet-codec'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WTL_FXU_BDV_NA_01'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WKEX200HBA', swVersion: '1.0' }

// Real packet captures from an LG WashTower (washer+dryer combo).
// All full raw packets — processData strips aa/bb framing before calling processAABB.

// buf[3]=0xd0: full status, washer running Delicates, dryer off
const STATUS_WASHER_RUNNING =
    'aad0360a00d0008542000100ec00be013200030e0e0e1600000000000000002d002d00000016010000070000020f0202022d2d00000000000c380000000000070401002a000000000000000000003c00000001000200000200000000201800810700000000070000000000000000013200030e0e0e1600000000000000002d002d000000160b0100070000020f0202022d2d00000010000c380000000000070401002a000000000000000000003c0000000100020000020000000020180081070000000007000000000000000023a9bb'

// buf[3]=0x71: state resync, washer running Delicates (remote_start+door_lock ON), dryer off
const STATE_RESYNC =
    'aa71360a00710085f3000100eb005f013200030e0e0e1600000000000000002a002d000200160b2600070000020f0202022d2d00000010010c380000000000060401002a000000000000000000000000000001000200000000000000000000810700000000060000000000000000d05dbb'

// buf[3]=0x42: washer door events (62-byte inner; door state at inner[18], body[5] after header strip)
const WASHER_DOOR_OPEN =
    'aa42360a0042007d83000201030007100c010b1000330105002557544c5f4658555f4244565f4e41' +
    '5f30310000000102d71c0b8b010700000000000000000018babb'
const WASHER_DOOR_CLOSE =
    'aa42360a0042007d84000201030007100c010b1001330105002557544c5f4658555f4244565f4e41' +
    '5f30310000000102d51c0b8b0107000000000000000000c4cebb'

// buf[3]=0x4e: dryer door events (74-byte inner; door state at inner[29], body[16] after header strip)
const DRYER_DOOR_OPEN =
    'aa4e360a004e007d850002010300130a0a01040a000021ff000000000000000105340105002557544c' +
    '5f4658555f4244565f4e415f30310000000102d81c0b8b0107000000000000000000b590bb'
const DRYER_DOOR_CLOSE =
    'aa4e360a004e007d860002010300130a0a01040a00002200000000000000000005340105002557544c' +
    '5f4658555f4244565f4e415f30310000000102d71c0b8b0107000000000000000000b490bb'

// Expected raw bytes sent to the device (uppercase for hex() comparison)
const SEND_WASHER_POWER_ON = 'AA0DF0E50002013301020193BB'
const SEND_WASHER_POWER_OFF = 'AA0DF0E50002013301020090BB'
const SEND_DRYER_POWER_ON = 'AA0DF0E50002013401020192BB'
const SEND_DRYER_POWER_OFF = 'AA0DF0E50002013401020093BB'
const SEND_INIT_LCD_DEFAULT = 'AA0DF0E50002013301510041BB' // 'Default' = idx 0
const SEND_INIT_LCD_SPRING2 = 'AA0DF0E5000201330151054CBB' // 'Spring 2' = idx 5
const SEND_WASHER_BUZZER_OFF = 'AA0DF0E50002013301130083BB'
const SEND_WASHER_BUZZER_LOW = 'AA0DF0E50002013301130182BB'
const SEND_WASHER_BUZZER_VHIGH = 'AA0DF0E5000201330113048FBB'
const SEND_DRYER_BUZZER_OFF = 'AA0DF0E50002013401130082BB'
const SEND_DRYER_BUZZER_LOW = 'AA0DF0E5000201340113018DBB'
const SEND_DRYER_BUZZER_VHIGH = 'AA0DF0E5000201340113048EBB'
const SEND_START = 'AA0EF0ED1121010000001800B5BB'
const SEND_WASHER_REMOTE_MAINTAIN_ON = 'AA0AF0241001013358BB'
const SEND_WASHER_REMOTE_MAINTAIN_OFF = 'AA0AF0241001003359BB'
const SEND_DRYER_REMOTE_MAINTAIN_ON = 'AA0AF024100101345BBB'
const SEND_DRYER_REMOTE_MAINTAIN_OFF = 'AA0AF0241001003458BB'

// Build a synthetic 0x71 state-resync packet with specific block byte overrides.
// Block starts at inner[13]; inner is 109 bytes (header=13, block=95, trailing=1).
function buildResync(blockOverrides: Record<number, number>): Buffer {
    const inner = Buffer.alloc(109)
    inner[3] = 0x71
    for (const [idx, val] of Object.entries(blockOverrides)) {
        inner[13 + Number(idx)] = val
    }
    return encodePacket({ protocol: 'aabb', body: inner.toString('hex') }).buffer
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config exposes expected HA components', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, unknown>
        for (const c of [
            'washer_state',
            'washer_power',
            'washer_door',
            'washer_course',
            'washer_temp',
            'washer_spin',
            'washer_remaining_time',
            'washer_remote_maintain',
            'dryer_state',
            'dryer_power',
            'dryer_door',
            'dryer_course',
            'dryer_remote_maintain',
            'init_lcd',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // init_lcd select lists all themes
        const init_lcd = components.init_lcd as Record<string, unknown>
        assert.equal(init_lcd.platform, 'select')
        assert.ok((init_lcd.options as string[]).includes('Default'))
        assert.ok((init_lcd.options as string[]).includes('Christmas'))
    })

    test('0xd0 status packet decodes washer state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(STATUS_WASHER_RUNNING))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['washer/power'], 'ON')
        assert.equal(props['washer/state'], 'RUNNING')
        assert.equal(props['washer/course'], 'DELICATES')
        assert.equal(props['washer/temp'], 'N/A')
        assert.equal(props['washer/remaining_time'], 45)
        assert.equal(props['washer/initial_time'], 45)
        assert.equal(props['shared/init_lcd'], 'Summer 2')
    })

    test('0xd0 status packet decodes dryer state (dryer off in this capture)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(STATUS_WASHER_RUNNING))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['dryer/power'], 'OFF')
        assert.equal(props['dryer/state'], 'POWEROFF')
        assert.equal(props['dryer/remaining_time'], 60)
    })

    test('0x42 washer door open publishes washer/door=OPEN', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(WASHER_DOOR_OPEN))
        assert.equal(ha.devices[DEVICE_ID].properties['washer/door'], 'OPEN')
    })

    test('0x42 washer door close publishes washer/door=CLOSE', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(WASHER_DOOR_CLOSE))
        assert.equal(ha.devices[DEVICE_ID].properties['washer/door'], 'CLOSE')
    })

    test('0x4e dryer door open publishes dryer/door=OPEN', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(DRYER_DOOR_OPEN))
        assert.equal(ha.devices[DEVICE_ID].properties['dryer/door'], 'OPEN')
    })

    test('0x4e dryer door close publishes dryer/door=CLOSE', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(DRYER_DOOR_CLOSE))
        assert.equal(ha.devices[DEVICE_ID].properties['dryer/door'], 'CLOSE')
    })

    test('wrong-length 0xd0 packet is ignored', () => {
        const { ha, thinq } = makeDevice()
        // 0xd0 type but only 10 bytes inner — processStatusUpdate rejects body != 190 (STATE_BLOCK_LENGTH*2)
        thinq.emit('data', buf('aaff360a00d000854200010090bb'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('setProperty washer/power ON sends correct packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('washer/power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_POWER_ON)
    })

    test('setProperty washer/power OFF sends correct packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('washer/power', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_POWER_OFF)
    })

    test('setProperty dryer/power ON sends correct packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('dryer/power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_POWER_ON)
    })

    test('setProperty dryer/power OFF sends correct packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('dryer/power', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_POWER_OFF)
    })

    test('setProperty shared/init_lcd sends correct packet with theme index', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('shared/init_lcd', 'Default')
        assert.equal(hex(thinq.outbox[0]), SEND_INIT_LCD_DEFAULT)

        thinq.resetRecorder()
        dev.setProperty('shared/init_lcd', 'Spring 2')
        assert.equal(hex(thinq.outbox[0]), SEND_INIT_LCD_SPRING2)
    })

    test('setProperty shared/init_lcd with unknown theme sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('shared/init_lcd', 'NotATheme')
        assert.equal(thinq.outbox.length, 0)
    })

    test('start() sends get-full-state packet and defaults doors to CLOSE', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), SEND_START)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['washer/door'], 'CLOSE')
        assert.equal(props['dryer/door'], 'CLOSE')
    })

    // ── 0x71 state resync ─────────────────────────────────────────────────────

    test('0x71 state resync decodes washer state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(STATE_RESYNC))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['washer/power'], 'ON')
        assert.equal(props['washer/state'], 'RUNNING')
        assert.equal(props['washer/remaining_time'], 42)
        assert.equal(props['washer/initial_time'], 45)
        assert.equal(props['washer/buzzer'], 'Medium')
        assert.equal(props['washer/remote_start'], 'ON')
        assert.equal(props['washer/door_lock'], 'ON')
        assert.equal(props['washer/add_garment'], 'OFF')
        assert.equal(props['washer/child_lock'], 'OFF')
        assert.equal(props['shared/init_lcd'], 'Summer 1')
    })

    test('0x71 state resync decodes dryer state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(STATE_RESYNC))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['dryer/power'], 'OFF')
        assert.equal(props['dryer/state'], 'POWEROFF')
        assert.equal(props['dryer/remaining_time'], 0)
        assert.equal(props['dryer/buzzer'], 'Off')
        assert.equal(props['dryer/duct_clogging'], 'NONE')
        assert.equal(props['dryer/remote_start'], 'OFF')
        assert.equal(props['dryer/child_lock'], 'OFF')
    })

    test('wrong-length 0x71 packet is ignored', () => {
        const { ha, thinq } = makeDevice()
        // 0x71 type but only 10 bytes inner — processStateResync rejects body != 95 (STATE_BLOCK_LENGTH)
        thinq.emit('data', buf('aa0e360a00710000000000008abb'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    // ── Synthetic bitmask field tests ─────────────────────────────────────────

    test('0x71 washer bitmask sensors decode correctly', () => {
        const { ha, thinq } = makeDevice()
        // block[39]=0xa0: add_garment(bit7) + child_lock(bit5); block[40]=0x01: door_lock
        thinq.emit('data', buildResync({ 39: 0xa0, 40: 0x01 }))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['washer/add_garment'], 'ON')
        assert.equal(props['washer/child_lock'], 'ON')
        assert.equal(props['washer/remote_start'], 'OFF')
    })

    test('0x71 dryer bitmask sensors decode correctly', () => {
        const { ha, thinq } = makeDevice()
        // block[79]=0x50: remote_start(bit6) + child_lock(bit4); block[75]=0x01: LEVEL_1
        thinq.emit('data', buildResync({ 79: 0x50, 75: 0x01 }))
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props['dryer/remote_start'], 'ON')
        assert.equal(props['dryer/child_lock'], 'ON')
        assert.equal(props['dryer/duct_clogging'], 'LEVEL_1')
    })

    // ── Buzzer commands ───────────────────────────────────────────────────────

    test('setProperty washer/buzzer sends correct packet', () => {
        const { thinq, dev } = makeDevice()

        thinq.resetRecorder()
        dev.setProperty('washer/buzzer', 'Off')
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_BUZZER_OFF)

        thinq.resetRecorder()
        dev.setProperty('washer/buzzer', 'Low')
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_BUZZER_LOW)

        thinq.resetRecorder()
        dev.setProperty('washer/buzzer', 'Very High')
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_BUZZER_VHIGH)
    })

    test('setProperty washer/buzzer with unknown value sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('washer/buzzer', 'Deafening')
        assert.equal(thinq.outbox.length, 0)
    })

    test('setProperty dryer/buzzer sends correct packet', () => {
        const { thinq, dev } = makeDevice()

        thinq.resetRecorder()
        dev.setProperty('dryer/buzzer', 'Off')
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_BUZZER_OFF)

        thinq.resetRecorder()
        dev.setProperty('dryer/buzzer', 'Low')
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_BUZZER_LOW)

        thinq.resetRecorder()
        dev.setProperty('dryer/buzzer', 'Very High')
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_BUZZER_VHIGH)
    })

    test('setProperty dryer/buzzer with unknown value sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('dryer/buzzer', 'VEYR_VERY_LOUD')
        assert.equal(thinq.outbox.length, 0)
    })

    // ── remote_maintain ───────────────────────────────────────────────────────

    test('0x71 washer remote_maintain decodes from block[42] bit2', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buildResync({ 42: 0x04 }))
        assert.equal(ha.devices[DEVICE_ID].properties['washer/remote_maintain'], 'ON')

        const { ha: ha2, thinq: thinq2 } = makeDevice()
        thinq2.emit('data', buildResync({ 42: 0x00 }))
        assert.equal(ha2.devices[DEVICE_ID].properties['washer/remote_maintain'], 'OFF')
    })

    test('0x71 dryer remote_maintain decodes from block[80] bit1', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buildResync({ 80: 0x02 }))
        assert.equal(ha.devices[DEVICE_ID].properties['dryer/remote_maintain'], 'ON')

        const { ha: ha2, thinq: thinq2 } = makeDevice()
        thinq2.emit('data', buildResync({ 80: 0x00 }))
        assert.equal(ha2.devices[DEVICE_ID].properties['dryer/remote_maintain'], 'OFF')
    })

    test('setProperty washer/remote_maintain sends correct packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('washer/remote_maintain', 'ON')
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_REMOTE_MAINTAIN_ON)

        thinq.resetRecorder()
        dev.setProperty('washer/remote_maintain', 'OFF')
        assert.equal(hex(thinq.outbox[0]), SEND_WASHER_REMOTE_MAINTAIN_OFF)
    })

    test('setProperty dryer/remote_maintain sends correct packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('dryer/remote_maintain', 'ON')
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_REMOTE_MAINTAIN_ON)

        thinq.resetRecorder()
        dev.setProperty('dryer/remote_maintain', 'OFF')
        assert.equal(hex(thinq.outbox[0]), SEND_DRYER_REMOTE_MAINTAIN_OFF)
    })
})
