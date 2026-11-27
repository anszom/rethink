import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REFT1DIC4P_U'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REFT1DIC4P_U'
const META: Metadata = { modelId: MODEL_ID, modelName: '2REFT1DIC4P_U', swVersion: '1.0' }

// Real packet captures from a 2REFT1DIC4P_U fridge (LG GF-V700BSLC / GC-X24FFKRL.ASBRGAP,
// "F-Next6 Disp Craft Instaview" InstaView Craft Ice French Door fridge). Each capture was
// cross-referenced against the official LG cloud's own decoded state (bridge mode +
// lgcloud-monitor.ts) to confirm the field meaning before it was used here.
//
// STATUS_LENGTH = 68, same 10EB/10EC framing and byte layout as 2REF11EIDA__4 (see the
// wiki's Appliance:2REF11EIDA__4 page): byte 1 = fridge setpoint, byte 2 = freezer
// setpoint, byte 3 = express freeze, byte 7 = any-door-open, byte 8 = temperature unit.

// Fridge setpoint changed from 3C (raw 5) to 2C (raw 6). Cloud reported fridgeTemp: 6.
const STATUS_CHANGE_FRIDGE_TEMP = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0206050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '52BB',
)

// Freezer setpoint changed from -19C (raw 5) to -23C (raw 9). Cloud reported freezerTemp: 9.
const STATUS_CHANGE_FREEZER_TEMP = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205090102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '5FBB',
)

// Express Freeze turned on (raw 1 -> 2). Cloud reported expressMode: EXPRESS_ON.
const STATUS_CHANGE_EXPRESS_FREEZE_ON = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050202FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '52BB',
)

// Right fridge door opened then closed (raw 0 -> 1 -> 0). Cloud reported
// atLeastOneDoorOpen: OPEN then CLOSE.
const STATUS_CHANGE_DOOR_OPEN = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0401010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '52BB',
)
const STATUS_CHANGE_DOOR_CLOSE = buf(
    'AA8E10EC' +
        '0205050102FF0401010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02000101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '52BB',
)

// Craft ice mode changed via the official LG app: OFF -> 3_ICE -> 6_ICE (raw 0 -> 1 -> 2).
const STATUS_CHANGE_CRAFT_ICE_3 = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF01060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '44BB',
)
const STATUS_CHANGE_CRAFT_ICE_6 = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF01060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '44BB',
)

// Craft ice maker's own status: ICE_MAKING -> OFF (raw 1 -> 0), then, once craft ice mode
// was flipped back on (byte 25, not shown here), OFF -> ICE_MAKING (raw 0 -> 1) again.
const STATUS_CHANGE_CRAFT_ICE_MAKER_OFF = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF00060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF00060101FF000001FF00FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '58BB',
)
const STATUS_CHANGE_CRAFT_ICE_MAKER_MAKING = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02060101FF000001FF00FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '44BB',
)

// Night view: OFF -> CUSTOM -> OFF (raw 0 -> 3 -> 0). Cloud reported nightAntiGlareMode accordingly.
const STATUS_CHANGE_NIGHT_VIEW_CUSTOM = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02060101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02070101FF030001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '43BB',
)
const STATUS_CHANGE_NIGHT_VIEW_OFF = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF02090101FF030001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF020A0101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '49BB',
)

// Quiet mode: OFF -> CUSTOM (raw 0 -> 3). Cloud reported nightQuietMode: CUSTOM.
const STATUS_CHANGE_QUIET_MODE_CUSTOM = buf(
    'AA8E10EC' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF020A0101FF000001FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '0205050102FF0400010001FFFFFFFFFFFF00FFFFFFFFFFFFFF020B0101FF000301FF01FFFFFFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0078FF0000' +
        '4BBB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config not published until a status frame establishes the unit', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('start() sends the F0ED status-query packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0ED1211010000010400EBBB')
    })

    test('10EC: fridge setpoint 3C -> 2C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP)

        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')
        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.fridge_setpoint.unit_of_measurement, '°C')
        assert.equal(components.fridge_setpoint.min, 1)
        assert.equal(components.fridge_setpoint.max, 7)
        assert.equal(components.freezer_setpoint.unit_of_measurement, '°C')
        assert.equal(components.freezer_setpoint.min, -23)
        assert.equal(components.freezer_setpoint.max, -15)

        assert.equal(dev.properties.fridge_setpoint, 2) // 8 - 6
        assert.equal(dev.properties.door, 'OFF')
        assert.equal(dev.properties.express_freeze, 'OFF')
    })

    test('10EC: freezer setpoint -19C -> -23C', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FREEZER_TEMP)

        const dev = ha.devices[DEVICE_ID]
        assert.equal(dev.properties.freezer_setpoint, -23) // -14 - 9
    })

    test('10EC: express freeze off -> on', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_EXPRESS_FREEZE_ON)

        const dev = ha.devices[DEVICE_ID]
        assert.equal(dev.properties.express_freeze, 'ON')
    })

    test('10EC: door open then close', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'ON')

        thinq.emit('data', STATUS_CHANGE_DOOR_CLOSE)
        assert.equal(ha.devices[DEVICE_ID].properties.door, 'OFF')
    })

    test('10EC: craft ice mode OFF -> 3_ICE -> 6_ICE', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_CRAFT_ICE_3)
        assert.equal(ha.devices[DEVICE_ID].properties.craft_ice_mode, '3 balls')

        thinq.emit('data', STATUS_CHANGE_CRAFT_ICE_6)
        assert.equal(ha.devices[DEVICE_ID].properties.craft_ice_mode, '6 balls')
    })

    test('10EC: craft ice maker status ICE_MAKING -> OFF -> ICE_MAKING', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_CRAFT_ICE_MAKER_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.craft_ice_maker_status, 'Off')

        thinq.emit('data', STATUS_CHANGE_CRAFT_ICE_MAKER_MAKING)
        assert.equal(ha.devices[DEVICE_ID].properties.craft_ice_maker_status, 'Making ice')
    })

    test('10EC: night view OFF -> CUSTOM -> OFF', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_NIGHT_VIEW_CUSTOM)
        assert.equal(ha.devices[DEVICE_ID].properties.night_view, 'Custom')

        thinq.emit('data', STATUS_CHANGE_NIGHT_VIEW_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.night_view, 'Off')
    })

    test('10EC: quiet mode OFF -> CUSTOM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_QUIET_MODE_CUSTOM)
        assert.equal(ha.devices[DEVICE_ID].properties.quiet_mode, 'Custom')
    })

    test('frames not matching the AA..BB envelope are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('001122'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    test('frames with unrecognised inner shape are ignored', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf('AA08109901020304BB'))
        assert.equal(ha.devices[DEVICE_ID], undefined)
    })

    // Write-side: a plain 0xFF-filled status block with the standard AABBDevice checksum
    // was injected against a real unit and confirmed to change the fridge setpoint - the
    // official LG app's own F017 command uses a batch of extra filler bytes and an
    // inconsistent length/checksum that doesn't match its own framing, so the fridge
    // evidently doesn't validate checksums on incoming commands, and the plain version is
    // all that's needed.
    test('HA write fridge_setpoint=2C matches the packet confirmed against a real unit', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP) // establishes the Celsius unit
        thinq.resetRecorder()

        dev.setProperty('fridge_setpoint', '2')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(
            hex(thinq.outbox[0]),
            'AA4AF017FF06FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBBB',
        )
    })

    test('HA write freezer_setpoint=-20C leaves fridge_setpoint untouched', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP)
        thinq.resetRecorder()

        dev.setProperty('freezer_setpoint', '-20')
        const pkt = thinq.outbox[0]
        // Frame layout: AA <len> F0 17 [68-byte status] <cksum> BB. Status index 0 lands at packet offset 4.
        assert.equal(pkt[4 + 2], 6) // freezerSetpoint = -14 - 6
        assert.equal(pkt[4 + 1], 0xff) // fridgeSetpoint untouched
    })

    test('HA write express_freeze=ON', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP)
        thinq.resetRecorder()

        dev.setProperty('express_freeze', 'ON')
        const pkt = thinq.outbox[0]
        assert.equal(pkt[4 + 3], 2)
    })

    test('HA write craft_ice_mode=3 balls', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP)
        thinq.resetRecorder()

        dev.setProperty('craft_ice_mode', '3 balls')
        assert.equal(
            hex(thinq.outbox[0]),
            'AA4AF017FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF01FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFECBB',
        )
    })

    // Confirmed against a real unit: writing night_view/quiet_mode via F017 is silently
    // ignored (no 10EC change, no cloud update, value reverts) - so they're read-only here.
    test('HA write to night_view or quiet_mode emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP)
        thinq.resetRecorder()

        dev.setProperty('night_view', 'Custom')
        dev.setProperty('quiet_mode', 'Custom')
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write to unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_CHANGE_FRIDGE_TEMP)
        thinq.resetRecorder()

        dev.setProperty('nonsense', 'whatever')
        assert.equal(thinq.outbox.length, 0)
    })
})
