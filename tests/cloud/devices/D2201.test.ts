import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/D2201'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'D2201'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1' }

// Real wire frames from an XD3A15MB dishwasher, captured in bridge mode while each setting was
// changed in the LG app. Every status frame is the 0xec change that followed the command above it
// (the appliance acknowledges the command with 32 00 26 00, which carries no state). The records
// start in Ready (state 0x01) with Turbo selected, so only the settings differ between them.

// Rinse aid level 0 -> 4 (byte 13 of the record).
const TX_RINSE_4 = 'AA09F02604000098BB'
const RX_RINSE_4 = buf(
    'AA3A32EC00180100000123040001230000020400000100000000000000010018010000012304000123000002040400010000000000000001B5BB',
)

// Softening level 0 -> 1 (byte 14). The salt refill bit (flags1 0x08) comes up with it.
const TX_SOFTENING_1 = 'AA09F0260001009FBB'
const RX_SOFTENING_1 = buf(
    'AA3A32EC0018010000012304000123000002040000010000000000000001001801000001230400012300000A040001010000000000000001B0BB',
)

// Chime sound off -> on (flags1 0x10), then back off.
const TX_CHIME_ON = 'AA09F0260200049ABB'
const RX_CHIME_ON = buf(
    'AA3A32EC00180100000123040001230000020402000100000000000000010018010000012304000123000012040200010000000000000001A5BB',
)
const TX_CHIME_OFF = 'AA09F0260200009EBB'
const RX_CHIME_OFF = buf(
    'AA3A32EC00180100000123040001230000120402000100000000000000010018010000012304000123000002040200010000000000000001A5BB',
)

// Machine clean reminder off -> on (flags1 0x20).
const TX_REMINDER_ON = 'AA09F02602000199BB'
const RX_REMINDER_ON = buf(
    'AA3A32EC0018010000012304000123000002040200010000000000000001001801000001230400012300002204020001000000000000000155BB',
)

// Clean indicator light off -> on (flags1 0x40).
const TX_LIGHT_ON = 'AA09F0260200108EBB'
const RX_LIGHT_ON = buf(
    'AA3A32EC0018010000012304000123000002040200010000000000000001001801000001230400012300004204020001000000000000000175BB',
)

// Smart courses loaded from the app: the command, then the 0xec change that followed it. Byte 5 of the
// record becomes the base course and byte 20 the smart course number.
const SMART_COURSE_LOADS: [string, string, Buffer][] = [
    [
        'Pots & Pans',
        'AA0EF02503060201000000058BBB',
        buf(
            'AA3A32EC00180100000130030101300000120402000100000000040000040018010000022A0201022A00001204020001000000000100000164BB',
        ),
    ],
    [
        'Casseroles',
        'AA0EF02503060202000000018EBB',
        buf(
            'AA3A32EC0018010000020A0500020A0000120002000100000000000000040018010000021702010217000012000200010000000002000002EDBB',
        ),
    ],
    [
        'Glassware',
        'AA0EF025030603030000000188BB',
        buf(
            'AA3A32EC00180100000217020102170000120002000100000000020000020018010000011E0301011E0000120002000100000000030000038ABB',
        ),
    ],
    [
        'Night Care',
        'AA0EF0250306030400000005B7BB',
        buf(
            'AA3A32EC0018010000011E0301011E00001200020001000000000300000300180100000130030101300000120402000100000000040000044DBB',
        ),
    ],
]

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, properties: () => ha.devices[DEVICE_ID].properties }
}

describe(MODEL_ID, () => {
    test('the settings are read back from the status record', () => {
        const { thinq, properties } = makeDevice()

        thinq.emit('data', RX_RINSE_4)
        assert.equal(properties().rinse_level, 4)
        assert.equal(properties().softening_level, 0)

        thinq.emit('data', RX_SOFTENING_1)
        assert.equal(properties().softening_level, 1)
        assert.equal(properties().salt_refill, 'ON')

        thinq.emit('data', RX_CHIME_ON)
        assert.equal(properties().chime_sound, 'ON')
        thinq.emit('data', RX_CHIME_OFF)
        assert.equal(properties().chime_sound, 'OFF')

        thinq.emit('data', RX_REMINDER_ON)
        assert.equal(properties().machine_clean_reminder, 'ON')
        assert.equal(properties().clean_indicator_light, 'OFF')

        thinq.emit('data', RX_LIGHT_ON)
        assert.equal(properties().clean_indicator_light, 'ON')
        assert.equal(properties().machine_clean_reminder, 'OFF')
    })

    // Each write has to reproduce what LG's cloud sent, checksum included. The starting records hold
    // the same settings the appliance had when the app sent the command, so a snapshot that dropped
    // one of them would not match.
    const writes: [string, Buffer, string, string, string][] = [
        // rinse level 2, nothing else set
        ['rinse level 4', RX_CHIME_OFF, 'rinse_level', '4', TX_RINSE_4],
        ['chime on', RX_CHIME_OFF, 'chime_sound', 'ON', TX_CHIME_ON],
        ['machine clean reminder on', RX_CHIME_OFF, 'machine_clean_reminder', 'ON', TX_REMINDER_ON],
        ['clean indicator light on', RX_CHIME_OFF, 'clean_indicator_light', 'ON', TX_LIGHT_ON],
        // rinse level 2, chime on
        ['chime off', RX_CHIME_ON, 'chime_sound', 'OFF', TX_CHIME_OFF],
    ]
    for (const [name, status, prop, value, expected] of writes) {
        test(`writing ${name} reproduces the command the LG app sent`, () => {
            const { thinq, dev } = makeDevice()
            thinq.emit('data', status)
            thinq.resetRecorder()
            dev.setProperty(prop, value)
            assert.equal(hex(thinq.outbox[0]), expected)
        })
    }

    test('writing softening level 1 reproduces the command the LG app sent', () => {
        const { thinq, dev } = makeDevice()
        // the app sent it with the rinse level at 0, so bring the level there first
        thinq.emit('data', RX_RINSE_4)
        dev.setProperty('rinse_level', '0')
        thinq.resetRecorder()
        dev.setProperty('softening_level', '1')
        assert.equal(hex(thinq.outbox[0]), TX_SOFTENING_1)
    })

    for (const [name, command, status] of SMART_COURSE_LOADS) {
        test(`loading ${name} reproduces the command the LG app sent, and reads back`, () => {
            const { thinq, dev, properties } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('downloaded_cycle', name)
            assert.equal(hex(thinq.outbox[0]), command)

            thinq.emit('data', status)
            assert.equal(properties().downloaded_cycle, name)
        })
    }

    // Byte 20 is 0 here, because the panel is on an ordinary course, but byte 23 still holds the preset
    // the app showed as the current download cycle.
    test('the stored downloaded cycle is reported while another course is selected', () => {
        const { thinq, properties } = makeDevice()
        thinq.emit('data', RX_CHIME_OFF)
        assert.equal(properties().downloaded_cycle, 'Pots & Pans')
    })

    test('a write carries the settings the appliance already has', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', RX_CHIME_ON)
        thinq.resetRecorder()

        // rinse level 2 and the chime on: changing the softening level must not clear the chime
        dev.setProperty('softening_level', '1')
        assert.equal(thinq.outbox[0].subarray(2, 7).toString('hex'), 'f026020104')
    })

    test('a settings write is refused until a status record has been read', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('chime_sound', 'ON')
        assert.equal(thinq.outbox.length, 0)
    })

    test('out-of-range levels are not sent', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', RX_CHIME_OFF)
        thinq.resetRecorder()
        dev.setProperty('rinse_level', '5')
        dev.setProperty('softening_level', '-1')
        assert.equal(thinq.outbox.length, 0)
    })
})
