import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WFV474PGV'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, hex } from '@/tests/helpers/mocks'
import { encodePacket } from '@/util/packet-codec'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WFV474PGV'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// REAL frames from 2026-08-22. The first is an idle/off report at 16:58:18Z. The second is the exact
// 17:02:22Z transition where the first 62-byte record is cooktop-off and the current record is on:
// the five slot-state bytes at current-record offsets 36, 41, 46, 51 and 56 all move 00 -> 01.
const COOKTOP_OFF = Buffer.from(
    'AA8240EC00000000000000004E0000000000000E000000000000000000004D0000000000000E0000000000000000000000000000000000000000000000000000000000000000000000004D0000000000000E000000000000000000004D0000000000000E0000000000000000000000000000000000000000000000000000000090BB',
    'hex',
)
const COOKTOP_OFF_TO_ON = Buffer.from(
    'AA8240EC00000000000000004E0000000000000E000000000000000000004D0000000000000E0000000000000000000000000000000000000000000000000000000000000000000000004E00000000000006000000000000000000004D00000000000006000001000300000100030000010003000001000300000100030000009FBB',
    'hex',
)
// REAL 17:16:48Z reverse transition: the previous block has all five slot flags at 01 and the
// current block has all five at 00.
const COOKTOP_ON_TO_OFF = Buffer.from(
    'AA8240EC00000000000000004E0000000000000E000000000000000000004D0000000000000E00000100190E000100190E000100190E000100190E000100190E000000000000000000004E0000000000000E000000000000000000004C0000000000000E00000000000000000000000000000000000000000000000000000000D8BB',
    'hex',
)

// REAL timer frames from 2026-08-22. The timer was set from the LG app to 09:01:13. Record offsets
// 30/31/32 carry seconds/minutes/hours; the rollover fixture proves both byte order and ordinary
// binary encoding by moving from 09:01:01 to 09:00:59.
const TIMER_09_01_13 = Buffer.from(
    'AA8240EC00000000000000004E0000000000000E000000000000000000004C0000000000000E0000000000000000000000000000000000000000000000000000000000000000000000004E00000000000006000000000000000000004C0000000D010906000000000000000000000000000000000000000000000000000000009EBB',
    'hex',
)
const TIMER_ROLLOVER_09_00_59 = Buffer.from(
    'AA8240EC00000000000000004E00000000000006000000000000000000004C000000010109060000000000000000000000000000000000000000000000000000000000000000000000004E00000000000006000000000000000000004C0000003B00090600000000000000000000000000000000000000000000000000000000A6BB',
    'hex',
)
const TIMER_STOPPED = Buffer.from(
    'AA8240EC00000000000000004E00000000000006000000000000000000004C0000001A3A08060000000000000000000000000000000000000000000000000000000000000000000000004E0000000000000E000000000000000000004D0000000000000E0000000000000000000000000000000000000000000000000000000044BB',
    'hex',
)
// REAL acknowledgements to the 0x43 set/start family. The first answered an accepted command; the
// second answered an Upper Bake start aimed at a cavity whose Remote Start was not armed, sent
// deliberately to establish what the oven does on its own. Byte 3 is the result: 0x00 versus 0x40.
const START_ACCEPTED_ACK = Buffer.from('AA084000430060BB', 'hex')
const START_REJECTED_ACK = Buffer.from('AA084000434020BB', 'hex')

// REAL one-shot event emitted when a five-second timer expired naturally. Explicit Stop did not emit
// this opcode. Alarm-clear behavior is still unknown, so it remains a diagnostic rather than a
// stateful binary sensor.
const TIMER_EXPIRED_ALARM = Buffer.from('AA13407203F50A0000000000000000000024BB', 'hex')

// REAL status frames from the app-labelled Upper Oven remote-start experiment. Before starting,
// both cavity readiness bytes are 01. The start frame populates only the first block with 170°F
// (0xAA) and 00:03:00; the next frame rolls it to 00:02:59, proving the time offsets and block order.
const BOTH_OVENS_REMOTE_START_READY = Buffer.from(
    'AA8240EC00000000000000004E00000000000006000000000000000000004D000008000000060000000000000000000000000000000000000000000000000000000000000000000000004E00000000000001000000000000000000004C0000000000000100000000000000000000000000000000000000000000000000000000F6BB',
    'hex',
)
// REAL Lower-only readiness transition. The previous record has both cavity bytes at 0E; the
// current record has Upper offset 15 at 00 and only Lower offset 33 at 01.
const LOWER_ONLY_REMOTE_START_READY = Buffer.from(
    'AA8240EC0000000000000000850000000000000E000000000000000000004E0000000000000E0000000000000000000000000000000000000000000000000000000000000000000000008500000000000000000000000000000000004E00000000000001000000000000000000000000000000000000000000000000000000004EBB',
    'hex',
)
// REAL Lower Convection Roast start after the app requested 350°F with cook time disabled. Only
// the Lower block is active. Its mode is 98, time is zero, and setpoint 01 45 is 325°F after the
// appliance's 25°F convection auto-conversion.
const LOWER_CONVECTION_ROAST_350F_TIME_OFF = Buffer.from(
    'AA8240EC00000000000000008300000000000000000000000000000000004E00000000000001000000000000000000000000000000000000000000000000000000000000000000000000830000000000000200000198000000014500000000000000000200000000000000000000000000000000000000000000000000000000C5BB',
    'hex',
)
// REAL app-labelled Lower Bake start at 285°C for five minutes. Lower mode is 95, and the status
// normalizes the requested setpoint to 0221 (545°F). The rollover confirms the countdown.
const LOWER_BAKE_285C_FIVE_MINUTES = Buffer.from(
    'AA8240EC0000000000000000FE0000000000000000000000000000000000AF00000000000001000000000000000000000000000000000000000000000000000000000000000000000000FE000000000000020000019500050002210000000000000000020000000000000000000000000000000000000000000000000000000093BB',
    'hex',
)
const LOWER_BAKE_285C_FOUR_MINUTES_59 = Buffer.from(
    'AA8240EC0000000000000000FE00000000000002000001950005000221000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000FE00000000000002000001953B040002210000000000000000020000000000000000000000000000000000000000000000000000000047BB',
    'hex',
)
// REAL cancellation of the remotely started Lower Bake. The current record clears Lower state,
// mode, time, and setpoint, then exposes current temperature 00FC (252°F).
const LOWER_BAKE_CANCELLED_AT_252F = Buffer.from(
    'AA8240EC0000000000000000F400000000000002000001952702000221000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000F40000000000000600000000000000000000FC00000000000006000000000000000000000000000000000000000000000000000000007BBB',
    'hex',
)
// REAL app-labelled Lower Convection Bake start at 300°F for ten minutes. Lower mode is 97, and
// the appliance's convection auto-conversion reports a 0113 (275°F) setpoint.
const LOWER_CONVECTION_BAKE_300F_TEN_MINUTES = Buffer.from(
    'AA8240EC0000000000000000EC0000000000000000000000000000000000F200000000000001000000000000000000000000000000000000000000000000000000000000000000000000EC0000000000000200000197000A0001130000000000000000020000000000000000000000000000000000000000000000000000000088BB',
    'hex',
)
const LOWER_CONVECTION_BAKE_300F_NINE_MINUTES_59 = Buffer.from(
    'AA8240EC0000000000000000EC0000000000000200000197000A000113000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000EC00000000000002000001973B09000113000000000000000002000000000000000000000000000000000000000000000000000000008BBB',
    'hex',
)
const LOWER_CONVECTION_BAKE_PREHEAT_COMPLETE = Buffer.from(
    'AA8240EC0000000000000000EB00000000000002000001973009000113000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000E9000000000000020000029705090001130000000000000000020000000000000000000000000000000000000000000000000000000081BB',
    'hex',
)
// REAL manual Upper Broil High start while Lower Convection Roast remained in Preheating. Upper
// state/mode/setpoint are 02/07/0190 (400°F); Lower remains 01/98/0145 (325°F).
const UPPER_BROIL_HIGH_WITH_LOWER_PREHEATING = Buffer.from(
    'AA8240EC00000000000000007F0000000000000000000198000000014500000000000000000000000000000000000000000000000000000000000000000000000000020700000001900000000000000000020000019800000001450000000000000000020000000000000000000000000000000000000000000000000000000066BB',
    'hex',
)
// REAL Lower preheat-complete event and following transition while Upper Broil remained active.
// Lower state changes 01 -> 02; mode 98, converted 325°F setpoint, and zero current temp persist.
const LOWER_PREHEAT_COMPLETE_EVENT = Buffer.from('AA13407203E90A0000000000000000000030BB', 'hex')
const LOWER_PREHEAT_COMPLETE_WITH_UPPER_BROIL = Buffer.from(
    'AA8240EC0207000000019000000000000000000200000198000000014500000000000000000200000000000000000000000000000000000000000000000000000000020700000001900000000000000000020000029800000001450000000000000000020000000000000000000000000000000000000000000000000000000006BB',
    'hex',
)
// REAL app cancel transition for Upper only. The prior record has both cavities active; the current
// record clears Upper state/mode/setpoint, exposes its 206°F temperature, and leaves Lower unchanged.
const UPPER_CANCELLED_WITH_LOWER_ACTIVE = Buffer.from(
    'AA8240EC02070000000190000000000000000002000002980000000145000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000CE0000000000000200000298000000014500000000000000000200000000000000000000000000000000000000000000000000000000DDBB',
    'hex',
)
// REAL Lower cancel transition. The current record clears Lower and exposes its 16-bit current
// temperature as 01 64 (356°F), while Upper remains idle at 00 CC (204°F).
const LOWER_CANCELLED = Buffer.from(
    'AA8240EC0000000000000000CC00000000000002000002980000000145000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000CC000000000000060000000000000000000164000000000000060000000000000000000000000000000000000000000000000000000010BB',
    'hex',
)
const UPPER_OVEN_170F_THREE_MINUTES = Buffer.from(
    'AA8240EC00000000000000004E00000000000001000000000000000000004D0000000000000100000000000000000000000000000000000000000000000000000000018100030000AA000000000000000002000000000000000000004D000000000000020000000000000000000000000000000000000000000000000000000020BB',
    'hex',
)
const UPPER_OVEN_170F_TWO_MINUTES_59 = Buffer.from(
    'AA8240EC018100030000AA000000000000000002000000000000000000004D000000000000020000000000000000000000000000000000000000000000000000000001813B020000AA000000000000000002000000000000000000004D0000000000000200000000000000000000000000000000000000000000000000000000C7BB',
    'hex',
)
// REAL app-labelled Upper Bake start at 125°C with a 01:03:00 cook time. The status normalizes
// the setpoint to 257°F (01 01). The rollover proves that status time remains seconds/minutes/hours.
const UPPER_BAKE_125C_ONE_HOUR_THREE_MINUTES = Buffer.from(
    'AA8240EC00000000000000009F0000000000000100000000000000000000D100000000000000000000000000000000000000000000000000000000000000000000000181000301010100000000000000000200000000000000000000D0000000000000020000000000000000000000000000000000000000000000000000000070BB',
    'hex',
)
const UPPER_BAKE_125C_ONE_HOUR_TWO_MINUTES_59 = Buffer.from(
    'AA8240EC0181000301010100000000000000000200000000000000000000D0000000000000020000000000000000000000000000000000000000000000000000000001813B0201010100000000000000000200000000000000000000D100000000000002000000000000000000000000000000000000000000000000000000001EBB',
    'hex',
)
// REAL Upper Bake preheat-complete event and its following transition. Upper state changes
// Preheating 01 -> Active 02 while mode 81, setpoint 0101 (257°F), and the running timer persist.
const UPPER_BAKE_PREHEAT_COMPLETE_EVENT = Buffer.from('AA13407200010A000000000000000000002FBB', 'hex')
const UPPER_BAKE_PREHEAT_COMPLETE = Buffer.from(
    'AA8240EC01813B3A00010100000000000000000200000000000000000000C4000000000000020000000000000000000000000000000000000000000000000000000002811F3A00010100000000000000000200000000000000000000C30000000000000200000000000000000000000000000000000000000000000000000000EBBB',
    'hex',
)
// REAL cancellation of the remotely started Upper Bake. The current record is Idle, clears mode,
// time, and setpoint, and exposes the post-cancel Upper current temperature as 010A (266°F).
const UPPER_BAKE_CANCELLED_AT_266F = Buffer.from(
    'AA8240EC02813A3500010100000000000000000200000000000000000000B9000000000000020000000000000000000000000000000000000000000000000000000000000000000000010A0000000000000600000000000000000000B6000000000000060000000000000000000000000000000000000000000000000000000083BB',
    'hex',
)
// REAL end-of-cycle transition. Upper current temperature is 124°F (0x7C) at offset 8 while
// the setpoint and cook time clear. The following 40 72 frame is the dedicated completion event.
const UPPER_OVEN_FINISHED_AT_124F = Buffer.from(
    'AA8240EC018102000000AA000000000000000002000000000000000000004C000000000000020000000000000000000000000000000000000000000000000000000003000000000000007C00000000000000000000000000000000004C0000000000000200000000000000000000000000000000000000000000000000000000F6BB',
    'hex',
)
const UPPER_OVEN_FINISHED_EVENT = Buffer.from('AA13407200040A0000000000000000000028BB', 'hex')
// REAL Clear Upper transition after the completion alarm. There was no outgoing command or new
// event; the appliance reported Upper state 03 -> 00 while retaining its 149°F current temperature.
const UPPER_OVEN_CLEARED_AT_149F = Buffer.from(
    'AA8240EC03000000000000009500000000000000000000000000000000004D000000000000020000000000000000000000000000000000000000000000000000000000000000000000009500000000000006000000000000000000004D000000000000060000000000000000000000000000000000000000000000000000000078BB',
    'hex',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

// Synthetic frames exercise the known oven shapes while keeping the unknown 62-byte record
// contents conspicuous.
function frame(inner: Buffer) {
    return encodePacket({ protocol: 'aabb', body: inner.toString('hex') }).buffer
}

// Frames the handler does not decode must not reach Home Assistant at all, so the oracle for
// "ignored" is that no published property moves.
function snapshot(ha: MockHAConnection) {
    return JSON.stringify(ha.devices[DEVICE_ID].properties)
}

// A 62-byte status record carrying only the Upper cavity fields named here, enough to tell the two
// blocks of an EC frame apart and to drive the undecoded state/mode paths.
function record({ temperature = 0, state = 0, mode = 0 } = {}) {
    const out = Buffer.alloc(62)
    out.writeUInt16BE(temperature, 7)
    out[0] = state
    out[1] = mode
    return out
}

// Every real frame above, for assertions that must hold across the whole capture set.
const ALL_CAPTURES = [
    COOKTOP_OFF,
    COOKTOP_OFF_TO_ON,
    COOKTOP_ON_TO_OFF,
    TIMER_09_01_13,
    TIMER_ROLLOVER_09_00_59,
    TIMER_STOPPED,
    TIMER_EXPIRED_ALARM,
    BOTH_OVENS_REMOTE_START_READY,
    LOWER_ONLY_REMOTE_START_READY,
    LOWER_CONVECTION_ROAST_350F_TIME_OFF,
    LOWER_BAKE_285C_FIVE_MINUTES,
    LOWER_BAKE_285C_FOUR_MINUTES_59,
    LOWER_BAKE_CANCELLED_AT_252F,
    LOWER_CONVECTION_BAKE_300F_TEN_MINUTES,
    LOWER_CONVECTION_BAKE_300F_NINE_MINUTES_59,
    LOWER_CONVECTION_BAKE_PREHEAT_COMPLETE,
    UPPER_BROIL_HIGH_WITH_LOWER_PREHEATING,
    LOWER_PREHEAT_COMPLETE_EVENT,
    LOWER_PREHEAT_COMPLETE_WITH_UPPER_BROIL,
    UPPER_CANCELLED_WITH_LOWER_ACTIVE,
    LOWER_CANCELLED,
    UPPER_OVEN_170F_THREE_MINUTES,
    UPPER_OVEN_170F_TWO_MINUTES_59,
    UPPER_BAKE_125C_ONE_HOUR_THREE_MINUTES,
    UPPER_BAKE_125C_ONE_HOUR_TWO_MINUTES_59,
    UPPER_BAKE_PREHEAT_COMPLETE_EVENT,
    UPPER_BAKE_PREHEAT_COMPLETE,
    UPPER_BAKE_CANCELLED_AT_266F,
    UPPER_OVEN_FINISHED_AT_124F,
    UPPER_OVEN_FINISHED_EVENT,
    UPPER_OVEN_CLEARED_AT_149F,
]

describe(MODEL_ID, () => {
    test('is selected by the Home Assistant bridge and queried on connect', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())

        bridge.newDevice(thinq)

        assert.ok(bridge.haDevices.has(DEVICE_ID))
        assert.ok(ha.devices[DEVICE_ID].config)
        assert.equal(thinq.outbox.length, 1)
        assert.equal(
            hex(thinq.outbox[0]),
            'AA28F0ED114101000000181A0207080C14191A1E262B30353A00000000000000000000000000F3BB',
        )
    })

    test('publishes status, confirmed write controls, and diagnostics', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        const properties = ha.devices[DEVICE_ID].properties

        assert.equal(components.cooktop_status.platform, 'binary_sensor')
        assert.equal(components.cooktop_status.payload_on, 'ON')
        assert.equal(components.cooktop_status.payload_off, 'OFF')
        assert.equal(components.cooktop_status.command_topic, undefined)
        assert.equal(components.upper_oven_temperature.command_topic, undefined)
        assert.equal(components.upper_oven_temperature.unit_of_measurement, '°F')
        assert.equal(components.upper_oven_status.command_topic, undefined)
        assert.equal(components.upper_oven_mode.command_topic, undefined)
        assert.equal(components.upper_oven_set_temperature.command_topic, undefined)
        assert.equal(components.upper_oven_set_temperature.unit_of_measurement, '°F')
        assert.equal(components.upper_oven_cook_time.command_topic, undefined)
        assert.equal(components.lower_oven_temperature.command_topic, undefined)
        assert.equal(components.lower_oven_temperature.unit_of_measurement, '°F')
        assert.equal(components.lower_oven_status.command_topic, undefined)
        assert.equal(components.lower_oven_mode.command_topic, undefined)
        assert.equal(components.lower_oven_set_temperature.command_topic, undefined)
        assert.equal(components.lower_oven_set_temperature.unit_of_measurement, '°F')
        assert.equal(components.lower_oven_cook_time.command_topic, undefined)
        assert.equal(components.upper_oven_remote_start.command_topic, undefined)
        assert.equal(components.lower_oven_remote_start.command_topic, undefined)
        assert.equal(components.timer.platform, 'text')
        assert.equal(components.timer.command_topic, '$this/timer/set')
        assert.equal(components.timer_stop.platform, 'button')
        assert.equal(components.timer_stop.command_topic, '$this/timer_stop/set')
        assert.equal(components.clock_sync.platform, 'button')
        assert.equal(components.clock_sync.command_topic, '$this/clock_sync/set')
        assert.equal(components.clock_sync.state_topic, undefined)
        assert.equal(components.beeper_volume.platform, 'select')
        assert.equal(components.beeper_volume.command_topic, '$this/beeper_volume/set')
        assert.deepEqual(components.beeper_volume.options, ['High', 'Low', 'Mute'])
        // Write-only: the oven never reports it, so HA must track the selection optimistically.
        assert.equal(components.beeper_volume.optimistic, true)
        assert.equal(components.beeper_volume.state_topic, undefined)
        assert.equal(components.preheat_alarm_light.platform, 'switch')
        assert.equal(components.preheat_alarm_light.command_topic, '$this/preheat_alarm_light/set')
        assert.equal(components.preheat_alarm_light.optimistic, true)
        assert.equal(components.preheat_alarm_light.state_topic, undefined)
        assert.equal(components.temperature_unit.platform, 'select')
        assert.equal(components.temperature_unit.command_topic, '$this/temperature_unit/set')
        assert.deepEqual(components.temperature_unit.options, ['°F', '°C'])
        assert.equal(components.temperature_unit.optimistic, true)
        assert.equal(components.temperature_unit.state_topic, undefined)
        assert.equal(components.auto_conversion.platform, 'switch')
        assert.equal(components.auto_conversion.command_topic, '$this/auto_conversion/set')
        assert.equal(components.auto_conversion.optimistic, true)
        assert.equal(components.auto_conversion.state_topic, undefined)
        assert.equal(components.upper_temperature_adjustment.platform, 'number')
        assert.equal(components.upper_temperature_adjustment.min, -35)
        assert.equal(components.upper_temperature_adjustment.max, 35)
        assert.equal(components.upper_temperature_adjustment.unit_of_measurement, '°F')
        assert.equal(components.upper_temperature_adjustment.optimistic, true)
        assert.equal(components.upper_temperature_adjustment.state_topic, undefined)
        assert.equal(components.lower_temperature_adjustment.platform, 'number')
        assert.equal(components.lower_temperature_adjustment.state_topic, undefined)
        assert.equal(components.upper_remote_temperature.platform, 'number')
        assert.equal(components.upper_remote_temperature.min, 170)
        assert.equal(components.upper_remote_temperature.max, 550)
        assert.equal(components.upper_remote_cook_time.platform, 'number')
        assert.equal(components.upper_start.platform, 'button')
        assert.equal(components.upper_start.name, 'Start Upper Bake')
        assert.equal(components.upper_cancel.platform, 'button')
        assert.equal(components.lower_remote_temperature.platform, 'number')
        assert.equal(components.lower_remote_temperature.min, 170)
        assert.equal(components.lower_remote_temperature.max, 550)
        assert.equal(components.lower_remote_cook_time.platform, 'number')
        assert.equal(components.lower_remote_mode.platform, 'select')
        assert.deepEqual(components.lower_remote_mode.options, ['Bake', 'Convection Bake', 'Convection Roast'])
        assert.equal(components.lower_start.platform, 'button')
        assert.equal(components.lower_start.name, 'Start Lower')
        assert.equal(components.lower_cancel.platform, 'button')
        assert.equal(properties.upper_remote_temperature, 350)
        assert.equal(properties.upper_remote_cook_time, 10)
        assert.equal(properties.lower_remote_temperature, 350)
        assert.equal(properties.lower_remote_cook_time, 10)
        assert.equal(properties.lower_remote_mode, 'Bake')
        // Construction forces readiness OFF so a stale retained ON from a previous run cannot
        // enable the Start buttons before the first status reply.
        assert.equal(properties.upper_oven_remote_start, 'OFF')
        assert.equal(properties.lower_oven_remote_start, 'OFF')
        assert.equal(components.upper_oven_status.device_class, 'enum')
        assert.deepEqual(components.upper_oven_status.options, ['Idle', 'Preheating', 'Active', 'Complete'])
        assert.equal(components.upper_oven_mode.device_class, 'enum')
        assert.deepEqual(components.upper_oven_mode.options, [
            'None',
            'Bake',
            'Broil',
            'Convection Bake',
            'Convection Roast',
        ])
        // Undecoded bytes and frames are logged rather than published, so the discovery payload
        // must carry no diagnostic dump entity.
        assert.equal(components.raw_status, undefined)
        assert.equal(components.undecoded_frame, undefined)
    })

    test('start sends the exact status query observed from LG cloud', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.start()

        assert.equal(thinq.outbox.length, 1)
        assert.equal(
            hex(thinq.outbox[0]),
            'AA28F0ED114101000000181A0207080C14191A1E262B30353A00000000000000000000000000F3BB',
        )
    })

    // Publishing a value outside the declared options is an error in HA, and only the 'None'
    // payload — what an undecoded byte publishes — is exempt. Replay every captured frame and check
    // both enum sensors against the discovery config.
    test('no captured frame publishes an oven state or mode outside the declared options', () => {
        const { ha, thinq } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, { options?: string[] }>
        const properties = ha.devices[DEVICE_ID].properties

        for (const capture of ALL_CAPTURES) {
            thinq.emit('data', capture)
            for (const entity of ['upper_oven_status', 'lower_oven_status', 'upper_oven_mode', 'lower_oven_mode']) {
                const allowed = [...components[entity].options!, 'None']
                assert.ok(
                    allowed.includes(properties[entity] as string),
                    `${entity} published ${properties[entity]} for ${hex(capture)}`,
                )
            }
        }
    })

    // Every captured status arrived as EC, so the EB shape is the one place a synthetic record is
    // unavoidable. Only the framing is synthetic; the field offsets come from the real captures.
    test('40 EB decodes its single status block', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', frame(Buffer.concat([Buffer.from([0x40, 0xeb]), record({ temperature: 350 })])))

        assert.equal(ha.devices[DEVICE_ID].properties.upper_oven_temperature, 350)
    })

    test('40 EC decodes the second (current) block, not the first', () => {
        const { ha, thinq } = makeDevice()
        const inner = Buffer.concat([
            Buffer.from([0x40, 0xec]),
            record({ temperature: 100 }),
            record({ temperature: 350 }),
        ])

        thinq.emit('data', frame(inner))

        assert.equal(ha.devices[DEVICE_ID].properties.upper_oven_temperature, 350)
    })

    // HA rejects values outside a declared option list, so an undecoded state/mode byte publishes
    // undefined — which goes out as the 'None' payload and shows in HA as unknown — rather than
    // leaking a raw byte value.
    test('undecoded state and mode bytes publish unknown', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', frame(Buffer.concat([Buffer.from([0x40, 0xeb]), record({ state: 0x7f, mode: 0x7e })])))

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.upper_oven_status, 'None')
        assert.equal(properties.upper_oven_mode, 'None')
    })

    test('real cooktop transitions publish OFF, ON, then OFF from the five slot flags', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', COOKTOP_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop_status, 'OFF')

        thinq.emit('data', COOKTOP_OFF_TO_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop_status, 'ON')

        thinq.emit('data', COOKTOP_ON_TO_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop_status, 'OFF')
    })

    test('real timer frames decode set, rollover, and stop states', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', TIMER_09_01_13)
        assert.equal(ha.devices[DEVICE_ID].properties.timer, '09:01:13')

        thinq.emit('data', TIMER_ROLLOVER_09_00_59)
        assert.equal(ha.devices[DEVICE_ID].properties.timer, '09:00:59')

        thinq.emit('data', TIMER_STOPPED)
        assert.equal(ha.devices[DEVICE_ID].properties.timer, '00:00:00')
    })

    test('real timer-expiry alarm event publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        const before = snapshot(ha)

        thinq.emit('data', TIMER_EXPIRED_ALARM)

        assert.equal(snapshot(ha), before)
    })

    test('real set/start, cancel, and rejection acknowledgements publish nothing', () => {
        const { ha, thinq } = makeDevice()
        const before = snapshot(ha)

        thinq.emit('data', START_ACCEPTED_ACK)
        thinq.emit('data', Buffer.from('AA084000440063BB', 'hex'))
        thinq.emit('data', START_REJECTED_ACK)

        assert.equal(snapshot(ha), before)
    })

    test('timer set and stop send the exact captured commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('timer', '09:01:13')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF04323068080800D0109FEBB')

        thinq.resetRecorder()
        dev.setProperty('timer_stop', 'PRESS')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF0432306808080000000C1BB')
    })

    // Both frames were captured from the LG app's Clock Settings -> "Sync with smartphone" on
    // 2026-08-29, at 23:12 and 23:15 local time. They differ only in byte 2 of the payload and in
    // how the hour is expressed, which is what leaves that byte's meaning open.
    test('clock sync reproduces the captured 24-hour preference command', () => {
        const { thinq, dev } = makeDevice()

        dev.sendClock(23, 15)

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E170F008080808080808080FF8093BB')
    })

    // The 12-hour capture is not a shape the handler emits, but it is the other half of the
    // evidence for byte 2, so it is pinned here to keep the payload layout honest.
    test('the captured 12-hour clock frame differs only in the hour and byte 2', () => {
        const twelveHour = Buffer.from('AA15F043210E0B0C018080808080808080FF80EDBB', 'hex')
        const twentyFourHour = Buffer.from('AA15F043210E170F008080808080808080FF8093BB', 'hex')

        // Payload sits after AA <len> F0 43 21 0E and before <checksum> BB.
        const payload = (frame: Buffer) => [...frame.subarray(6, frame.length - 2)]
        assert.deepEqual(payload(twelveHour), [0x0b, 0x0c, 0x01, ...Array(8).fill(0x80), 0xff, 0x80])
        assert.deepEqual(payload(twentyFourHour), [0x17, 0x0f, 0x00, ...Array(8).fill(0x80), 0xff, 0x80])
    })

    test('clock sync sends the host time and leaves every other preference unchanged', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('clock_sync', 'PRESS')

        assert.equal(thinq.outbox.length, 1)
        const frame = thinq.outbox[0]
        const payload = frame.subarray(6, frame.length - 2)
        assert.equal(hex(frame.subarray(0, 6)), 'AA15F043210E')
        assert.ok(payload[0] < 24)
        assert.ok(payload[1] < 60)
        assert.equal(payload[2], 0x00)
        // Every field the user did not touch must go out as the no-change sentinel.
        assert.deepEqual([...payload.subarray(3)], [...Array(8).fill(0x80), 0xff, 0x80])
    })

    // One Save per value, captured 2026-08-29 at 05:23:17Z, 05:24:43Z and 05:25:01Z. Each frame
    // changed only payload index 8, which is what identifies that slot as Beeper Volume.
    test('beeper volume reproduces all three captured commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('beeper_volume', 'Mute')
        dev.setProperty('beeper_volume', 'High')
        dev.setProperty('beeper_volume', 'Low')

        assert.equal(thinq.outbox.length, 3)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E8080808080808080008080FF80F5BB')
        assert.equal(hex(thinq.outbox[1]), 'AA15F043210E8080808080808080028080FF80F7BB')
        assert.equal(hex(thinq.outbox[2]), 'AA15F043210E8080808080808080018080FF80F4BB')
    })

    test('a preference write leaves every field it does not set at its no-change sentinel', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('beeper_volume', 'Mute')

        const frame = thinq.outbox[0]
        const payload = frame.subarray(6, frame.length - 2)
        // Everything but index 8 (beeper) and index 11 (its own FF sentinel) stays 0x80.
        payload.forEach((value, index) => {
            if (index === 8) return assert.equal(value, 0x00)
            if (index === 11) return assert.equal(value, 0xff)
            assert.equal(value, 0x80, `payload index ${index}`)
        })
    })

    // Captured 2026-08-29 at 05:27:54Z and 05:28:27Z; each changed only payload index 7.
    test('preheating alarm light reproduces both captured commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('preheat_alarm_light', 'OFF')
        dev.setProperty('preheat_alarm_light', 'ON')

        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E8080808080808000808080FF80F5BB')
        assert.equal(hex(thinq.outbox[1]), 'AA15F043210E8080808080808001808080FF80F4BB')
    })

    // Captured 2026-08-29 at 05:29:33Z (°C) and 05:34:50Z (°F); each changed only payload index 9.
    test('temperature unit reproduces both captured commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('temperature_unit', '°C')
        dev.setProperty('temperature_unit', '°F')

        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E8080808080808080800180FF80F4BB')
        assert.equal(hex(thinq.outbox[1]), 'AA15F043210E8080808080808080800080FF80F5BB')
    })

    // The EC frames captured either side of the °C switch kept reporting Fahrenheit ambient
    // temperatures, so the display unit must not reach status decoding.
    test('the display temperature unit does not change how status temperatures decode', () => {
        const { ha, thinq, dev } = makeDevice()

        dev.setProperty('temperature_unit', '°C')
        thinq.emit('data', LOWER_CANCELLED)

        assert.equal(ha.devices[DEVICE_ID].properties.lower_oven_temperature, 356)
    })

    // Captured 2026-08-29 at 05:44:31Z and 05:45:02Z; each changed only payload index 3.
    test('auto conversion reproduces both captured commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('auto_conversion', 'OFF')
        dev.setProperty('auto_conversion', 'ON')

        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E8080800080808080808080FF80F5BB')
        assert.equal(hex(thinq.outbox[1]), 'AA15F043210E8080800180808080808080FF80F4BB')
    })

    // REAL frame, 2026-08-29 05:48:41Z: one Save carrying Upper -2°F and Lower Off. Index 4 named
    // °F, index 5 held the signed -2 and index 6 the zero that the app labels Off.
    test('temperature adjustment reproduces the captured Upper -2°F, Lower Off command', () => {
        const { thinq, dev } = makeDevice()

        dev.sendTemperatureAdjustment({ upper: -2, lower: 0 })

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E8080808000FE0080808080FF80CBBB')
    })

    // REAL frame, 2026-08-29 05:51:06Z: Upper +2°F and Lower -1°F in one Save. The pair with the
    // capture above covers a positive, a negative and a zero, pinning the two's-complement encoding.
    test('temperature adjustment reproduces the captured Upper +2°F, Lower -1°F command', () => {
        const { thinq, dev } = makeDevice()

        dev.sendTemperatureAdjustment({ upper: 2, lower: -1 })

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA15F043210E808080800002FF80808080FF80F4BB')
    })

    // REAL frame, 2026-08-29 05:53:22Z: Upper Off and Lower -1°C. The handler always names °F at
    // index 4, so it does not emit this shape; it is pinned here because it is the evidence that
    // index 4 is the unit for the trims and shares index 9's encoding.
    test('the captured Celsius trim frame names °C at the temperature adjustment unit index', () => {
        const frame = Buffer.from('AA15F043210E808080800100FF80808080FF80F5BB', 'hex')

        const payload = frame.subarray(6, frame.length - 2)
        assert.equal(payload[4], 0x01)
        assert.equal(payload[5], 0x00)
        assert.equal(payload[6], 0xff)
    })

    test('temperature adjustment writes one cavity and leaves the other unchanged', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('upper_temperature_adjustment', '-2')
        dev.setProperty('lower_temperature_adjustment', '15')

        const payload = (frame: Buffer) => [...frame.subarray(6, frame.length - 2)]
        // Upper write: index 5 carries the trim, index 6 stays at the no-change sentinel.
        assert.deepEqual(payload(thinq.outbox[0]).slice(4, 7), [0x00, 0xfe, 0x80])
        // Lower write: the reverse.
        assert.deepEqual(payload(thinq.outbox[1]).slice(4, 7), [0x00, 0x80, 0x0f])
    })

    test('out-of-range and non-numeric temperature adjustments send nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('upper_temperature_adjustment', '-36')
        dev.setProperty('upper_temperature_adjustment', '36')
        dev.setProperty('upper_temperature_adjustment', 'hot')
        dev.setProperty('lower_temperature_adjustment', '')

        assert.equal(thinq.outbox.length, 0)
    })

    test('an unknown auto conversion payload sends nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('auto_conversion', 'AUTO')

        assert.equal(thinq.outbox.length, 0)
    })

    test('an unknown temperature unit option sends nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('temperature_unit', 'kelvin')

        assert.equal(thinq.outbox.length, 0)
    })

    test('an unknown preheating alarm light payload sends nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('preheat_alarm_light', 'MAYBE')

        assert.equal(thinq.outbox.length, 0)
    })

    test('an unknown beeper volume option sends nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('beeper_volume', 'Deafening')

        assert.equal(thinq.outbox.length, 0)
    })

    test('a non-press clock sync payload sends nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('clock_sync', 'not-a-press')

        assert.equal(thinq.outbox.length, 0)
    })

    test('invalid timer values and non-press button payloads send nothing', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('timer', '9:01:13')
        dev.setProperty('timer', '09:61:13')
        dev.setProperty('timer_stop', 'not-a-press')

        assert.equal(thinq.outbox.length, 0)
    })

    test('Upper and Lower cancel send the exact captured selector commands', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('upper_cancel', 'PRESS')
        dev.setProperty('lower_cancel', 'PRESS')

        assert.equal(hex(thinq.outbox[0]), 'AA07F04400B0BB')
        assert.equal(hex(thinq.outbox[1]), 'AA07F04401B3BB')
    })

    test('remote start reproduces both captured start commands', () => {
        const { thinq, dev } = makeDevice()

        // Stage the parameters the captured commands actually carried, so the frames stay pinned to
        // the captures rather than to whatever the constructor defaults happen to be.
        dev.setProperty('upper_remote_temperature', '170')
        dev.setProperty('upper_remote_cook_time', '3')
        dev.setProperty('lower_remote_temperature', '350')
        dev.setProperty('lower_remote_cook_time', '0')
        dev.setProperty('lower_remote_mode', 'Convection Roast')

        dev.setProperty('upper_start', 'PRESS')
        dev.setProperty('lower_start', 'PRESS')

        assert.equal(thinq.outbox.length, 2)
        assert.equal(hex(thinq.outbox[0]), 'AA13F043200B010000000000AA000300009CBB')
        assert.equal(hex(thinq.outbox[1]), 'AA13F043200B1800000000015E00000000C7BB')
    })

    // The oven arms Remote Start on its own front panel and answers an unarmed start with
    // START_REJECTED_ACK, so the handler adds no lockout of its own on top of that.
    test('remote start is sent without a readiness check of our own', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('upper_start', 'PRESS')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA13F043200B0100000000015E000A0000D0BB')
    })

    test('remote-start inputs publish and encode temperature and cook time', () => {
        const { ha, thinq, dev } = makeDevice()

        dev.setProperty('upper_remote_temperature', '400')
        dev.setProperty('upper_remote_cook_time', '90')

        assert.equal(ha.devices[DEVICE_ID].properties.upper_remote_temperature, 400)
        assert.equal(ha.devices[DEVICE_ID].properties.upper_remote_cook_time, 90)
        // Staging a value must not put anything on the wire; only the Start button does that.
        assert.equal(thinq.outbox.length, 0)

        dev.setProperty('upper_start', 'PRESS')

        const command = thinq.outbox[0]
        assert.deepEqual(
            [...command.subarray(2, command.length - 2)],
            [0xf0, 0x43, 0x20, 0x0b, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x90, 0x01, 0x1e, 0x00, 0x00],
        )
    })

    test('Lower mode selection validates, publishes, and encodes every captured operation', () => {
        const { ha, thinq, dev } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        dev.setProperty('lower_remote_mode', 'Convection Roast')
        dev.setProperty('lower_remote_mode', 'Steam Bake')
        assert.equal(properties.lower_remote_mode, 'Convection Roast')
        assert.equal(thinq.outbox.length, 0)

        dev.setProperty('lower_remote_temperature', '300')
        dev.setProperty('lower_remote_cook_time', '10')
        dev.setProperty('lower_remote_mode', 'Bake')
        assert.equal(properties.lower_remote_mode, 'Bake')
        thinq.emit('data', LOWER_ONLY_REMOTE_START_READY)
        dev.setProperty('lower_start', 'PRESS')
        assert.equal(hex(thinq.outbox[0]), 'AA13F043200B1500000000012C000A000032BB')

        dev.setProperty('lower_remote_mode', 'Convection Bake')
        assert.equal(properties.lower_remote_mode, 'Convection Bake')
        thinq.emit('data', LOWER_ONLY_REMOTE_START_READY)
        dev.setProperty('lower_start', 'PRESS')
        assert.equal(hex(thinq.outbox[1]), 'AA13F043200B1700000000012C000A00003CBB')

        dev.setProperty('lower_remote_mode', 'Convection Roast')
        assert.equal(properties.lower_remote_mode, 'Convection Roast')
        thinq.emit('data', LOWER_ONLY_REMOTE_START_READY)
        dev.setProperty('lower_start', 'PRESS')
        assert.equal(hex(thinq.outbox[2]), 'AA13F043200B1800000000012C000A00003FBB')
    })

    test('real upper-oven remote start pins cavity order, temperature, cook time, and readiness', () => {
        const { ha, thinq } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        thinq.emit('data', BOTH_OVENS_REMOTE_START_READY)
        assert.equal(properties.upper_oven_remote_start, 'ON')
        assert.equal(properties.lower_oven_remote_start, 'ON')

        thinq.emit('data', UPPER_OVEN_170F_THREE_MINUTES)
        assert.equal(properties.upper_oven_status, 'Preheating')
        assert.equal(properties.upper_oven_mode, 'Bake')
        assert.equal(properties.lower_oven_status, 'Idle')
        assert.equal(properties.upper_oven_temperature, 'None')
        assert.equal(properties.upper_oven_set_temperature, 170)
        assert.equal(properties.upper_oven_cook_time, 180)
        assert.equal(properties.lower_oven_temperature, 77)
        assert.equal(properties.lower_oven_set_temperature, 'None')
        assert.equal(properties.lower_oven_cook_time, 0)
        assert.equal(properties.upper_oven_remote_start, 'OFF')
        assert.equal(properties.lower_oven_remote_start, 'OFF')

        thinq.emit('data', UPPER_OVEN_170F_TWO_MINUTES_59)
        assert.equal(properties.upper_oven_cook_time, 179)

        thinq.emit('data', UPPER_OVEN_FINISHED_AT_124F)
        assert.equal(properties.upper_oven_status, 'Complete')
        assert.equal(properties.upper_oven_temperature, 124)
        assert.equal(properties.upper_oven_set_temperature, 'None')
        assert.equal(properties.upper_oven_cook_time, 0)
        assert.equal(properties.upper_oven_remote_start, 'OFF')

        const beforeEvent = snapshot(ha)
        thinq.emit('data', UPPER_OVEN_FINISHED_EVENT)
        assert.equal(snapshot(ha), beforeEvent)

        thinq.emit('data', UPPER_OVEN_CLEARED_AT_149F)
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.upper_oven_temperature, 149)
        assert.equal(properties.upper_oven_set_temperature, 'None')
        assert.equal(properties.upper_oven_cook_time, 0)
        assert.equal(properties.upper_oven_remote_start, 'OFF')
        assert.equal(properties.lower_oven_remote_start, 'OFF')
    })

    test('real 125°C Upper Bake frame confirms mode, normalized setpoint, and 01:03:00 countdown', () => {
        const { ha, thinq } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        thinq.emit('data', UPPER_BAKE_125C_ONE_HOUR_THREE_MINUTES)
        assert.equal(properties.upper_oven_status, 'Preheating')
        assert.equal(properties.upper_oven_mode, 'Bake')
        assert.equal(properties.upper_oven_set_temperature, 257)
        assert.equal(properties.upper_oven_cook_time, 3780)

        thinq.emit('data', UPPER_BAKE_125C_ONE_HOUR_TWO_MINUTES_59)
        assert.equal(properties.upper_oven_cook_time, 3779)

        const beforeEvent = snapshot(ha)
        thinq.emit('data', UPPER_BAKE_PREHEAT_COMPLETE_EVENT)
        assert.equal(snapshot(ha), beforeEvent)

        thinq.emit('data', UPPER_BAKE_PREHEAT_COMPLETE)
        assert.equal(properties.upper_oven_status, 'Active')
        assert.equal(properties.upper_oven_mode, 'Bake')
        assert.equal(properties.upper_oven_set_temperature, 257)
        assert.equal(properties.upper_oven_cook_time, 3511)

        thinq.emit('data', UPPER_BAKE_CANCELLED_AT_266F)
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.upper_oven_mode, 'None')
        assert.equal(properties.upper_oven_temperature, 266)
        assert.equal(properties.upper_oven_set_temperature, 'None')
        assert.equal(properties.upper_oven_cook_time, 0)
    })

    test('real Lower-only remote-start frame publishes only Lower as ready', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', LOWER_ONLY_REMOTE_START_READY)

        assert.equal(ha.devices[DEVICE_ID].properties.upper_oven_remote_start, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.lower_oven_remote_start, 'ON')
    })

    test('real 285°C Lower Bake frame confirms mode, normalized setpoint, and countdown', () => {
        const { ha, thinq } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        thinq.emit('data', LOWER_BAKE_285C_FIVE_MINUTES)
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.lower_oven_status, 'Preheating')
        assert.equal(properties.lower_oven_mode, 'Bake')
        assert.equal(properties.lower_oven_set_temperature, 545)
        assert.equal(properties.lower_oven_cook_time, 300)

        thinq.emit('data', LOWER_BAKE_285C_FOUR_MINUTES_59)
        assert.equal(properties.lower_oven_cook_time, 299)

        thinq.emit('data', LOWER_BAKE_CANCELLED_AT_252F)
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.lower_oven_status, 'Idle')
        assert.equal(properties.lower_oven_mode, 'None')
        assert.equal(properties.lower_oven_temperature, 252)
        assert.equal(properties.lower_oven_set_temperature, 'None')
        assert.equal(properties.lower_oven_cook_time, 0)
    })

    test('real 300°F Lower Convection Bake confirms mode, auto-converted setpoint, and countdown', () => {
        const { ha, thinq } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        thinq.emit('data', LOWER_CONVECTION_BAKE_300F_TEN_MINUTES)
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.lower_oven_status, 'Preheating')
        assert.equal(properties.lower_oven_mode, 'Convection Bake')
        assert.equal(properties.lower_oven_set_temperature, 275)
        assert.equal(properties.lower_oven_cook_time, 600)

        thinq.emit('data', LOWER_CONVECTION_BAKE_300F_NINE_MINUTES_59)
        assert.equal(properties.lower_oven_cook_time, 599)

        const beforeEvent = snapshot(ha)
        thinq.emit('data', LOWER_PREHEAT_COMPLETE_EVENT)
        assert.equal(snapshot(ha), beforeEvent)

        thinq.emit('data', LOWER_CONVECTION_BAKE_PREHEAT_COMPLETE)
        assert.equal(properties.lower_oven_status, 'Active')
        assert.equal(properties.lower_oven_mode, 'Convection Bake')
        assert.equal(properties.lower_oven_set_temperature, 275)
        assert.equal(properties.lower_oven_cook_time, 545)
    })

    test('real Lower Convection Roast frame decodes 16-bit auto-converted setpoint and time off', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', LOWER_CONVECTION_ROAST_350F_TIME_OFF)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.upper_oven_set_temperature, 'None')
        assert.equal(properties.upper_oven_cook_time, 0)
        assert.equal(properties.lower_oven_set_temperature, 325)
        assert.equal(properties.lower_oven_status, 'Preheating')
        assert.equal(properties.lower_oven_mode, 'Convection Roast')
        assert.equal(properties.lower_oven_cook_time, 0)
        assert.equal(properties.upper_oven_remote_start, 'OFF')
        assert.equal(properties.lower_oven_remote_start, 'OFF')
    })

    test('real manual Upper Broil High frame decodes both simultaneously active cavities', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', UPPER_BROIL_HIGH_WITH_LOWER_PREHEATING)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.upper_oven_status, 'Active')
        assert.equal(properties.upper_oven_mode, 'Broil')
        assert.equal(properties.upper_oven_set_temperature, 400)
        assert.equal(properties.upper_oven_cook_time, 0)
        assert.equal(properties.lower_oven_status, 'Preheating')
        assert.equal(properties.lower_oven_mode, 'Convection Roast')
        assert.equal(properties.lower_oven_set_temperature, 325)
        assert.equal(properties.lower_oven_cook_time, 0)
    })

    test('real Lower preheat-complete event and transition publish Lower Active', () => {
        const { ha, thinq } = makeDevice()

        const beforeEvent = snapshot(ha)
        thinq.emit('data', LOWER_PREHEAT_COMPLETE_EVENT)
        assert.equal(snapshot(ha), beforeEvent)

        thinq.emit('data', LOWER_PREHEAT_COMPLETE_WITH_UPPER_BROIL)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.upper_oven_status, 'Active')
        assert.equal(properties.upper_oven_mode, 'Broil')
        assert.equal(properties.upper_oven_set_temperature, 400)
        assert.equal(properties.lower_oven_status, 'Active')
        assert.equal(properties.lower_oven_mode, 'Convection Roast')
        assert.equal(properties.lower_oven_set_temperature, 325)
        assert.equal(properties.lower_oven_temperature, 'None')
    })

    test('real Upper cancel transition clears only Upper and preserves active Lower', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', UPPER_CANCELLED_WITH_LOWER_ACTIVE)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.upper_oven_mode, 'None')
        assert.equal(properties.upper_oven_set_temperature, 'None')
        assert.equal(properties.upper_oven_temperature, 206)
        assert.equal(properties.lower_oven_status, 'Active')
        assert.equal(properties.lower_oven_mode, 'Convection Roast')
        assert.equal(properties.lower_oven_set_temperature, 325)
        assert.equal(properties.lower_oven_temperature, 'None')
    })

    test('real Lower cancel transition clears Lower and decodes 16-bit current temperatures', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', LOWER_CANCELLED)

        const properties = ha.devices[DEVICE_ID].properties
        assert.equal(properties.upper_oven_status, 'Idle')
        assert.equal(properties.upper_oven_temperature, 204)
        assert.equal(properties.lower_oven_status, 'Idle')
        assert.equal(properties.lower_oven_mode, 'None')
        assert.equal(properties.lower_oven_set_temperature, 'None')
        assert.equal(properties.lower_oven_temperature, 356)
        assert.equal(properties.upper_oven_remote_start, 'OFF')
        assert.equal(properties.lower_oven_remote_start, 'OFF')
    })

    test('other oven opcodes are ignored', () => {
        const { ha, thinq } = makeDevice()
        const before = snapshot(ha)

        thinq.emit('data', frame(Buffer.from([0x40, 0x31, 0x01, 0x02])))

        assert.equal(snapshot(ha), before)
    })

    test('foreign class bytes and malformed status records are ignored, not decoded as status', () => {
        const { ha, thinq } = makeDevice()
        const before = snapshot(ha)

        thinq.emit('data', frame(Buffer.from([0x32, 0xeb, 0x01])))
        thinq.emit('data', frame(Buffer.from([0x40, 0xeb, 0x01])))
        thinq.emit('data', frame(Buffer.from([0x40, 0xec, 0x01])))
        // A 4-byte frame with an unknown command family is not a known acknowledgement.
        thinq.emit('data', frame(Buffer.from([0x40, 0x00, 0x45, 0x00])))

        assert.equal(snapshot(ha), before)
    })

    test('non-numeric and unknown-option payloads leave the staged value alone', () => {
        const { ha, thinq, dev } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        dev.setProperty('upper_remote_temperature', '425')
        dev.setProperty('lower_remote_mode', 'Convection Bake')
        dev.setProperty('upper_remote_temperature', '')
        dev.setProperty('upper_remote_temperature', 'hot')
        dev.setProperty('lower_remote_mode', 'Steam Bake')

        assert.equal(properties.upper_remote_temperature, 425)
        assert.equal(properties.lower_remote_mode, 'Convection Bake')

        // The staged values, not the discarded payloads, are what a start actually sends.
        dev.setProperty('upper_start', 'PRESS')
        dev.setProperty('lower_start', 'PRESS')
        assert.equal(hex(thinq.outbox[0]), 'AA13F043200B010000000001A9000A000085BB')
        assert.equal(hex(thinq.outbox[1]), 'AA13F043200B1700000000015E000A0000CEBB')
    })

    test('reconnect resets staged remote parameters and readiness to defaults', () => {
        const { ha, thinq, dev } = makeDevice()
        const properties = ha.devices[DEVICE_ID].properties

        dev.setProperty('upper_remote_temperature', '425')
        dev.setProperty('lower_remote_mode', 'Convection Bake')
        thinq.emit('data', BOTH_OVENS_REMOTE_START_READY)
        assert.equal(properties.upper_oven_remote_start, 'ON')

        // The bridge constructs a fresh Device each time the appliance transport reopens.
        new DUT(ha.asConnection(), new MockThinq2Device(DEVICE_ID, META), META)

        assert.equal(properties.upper_remote_temperature, 350)
        assert.equal(properties.lower_remote_mode, 'Bake')
        assert.equal(properties.upper_oven_remote_start, 'OFF')
        assert.equal(properties.lower_oven_remote_start, 'OFF')
    })

    test('unflagged panel-started mode codes decode via the remote-start flag mask', () => {
        const { ha, thinq } = makeDevice()
        const current = Buffer.alloc(62)
        current[1] = 0x01 // panel Bake: remote-start flag 0x80 clear
        current[19] = 0x17 // panel Convection Bake in the Lower block

        thinq.emit('data', frame(Buffer.concat([Buffer.from([0x40, 0xeb]), current])))

        assert.equal(ha.devices[DEVICE_ID].properties.upper_oven_mode, 'Bake')
        assert.equal(ha.devices[DEVICE_ID].properties.lower_oven_mode, 'Convection Bake')
    })
})
