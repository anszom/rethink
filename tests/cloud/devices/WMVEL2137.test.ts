import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WMVEL2137'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WMVEL2137'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WMVEL2137', swVersion: '20230920' }

// Real frames captured from an LG MVEL2033F over-the-range microwave (modelId WMVEL2137, thinq2
// deviceType 302) while it was driven by hand at the panel with rethink bridged to the LG cloud.
// The comment on each fixture names the cloud field that confirmed the decode, taken from the
// ovenState the cloud reported within ~300ms of that frame.
//
// Frames: AA 62 41 EC <46B previous record> <46B current record> <cksum> BB
//         AA 34 41 EB <46B current record> <cksum> BB

// mwoVentSpeedLevel=4, mwoLampLevel=2. The vent had just been switched on with the panel's
// ON/OFF key, which advances four steps from off and so lands on Turbo.
const SAMPLE_VENT_TURBO_LAMP_HIGH = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000005320008080808001000000003000015500000000000000FF030D000000000000000000000000000000C300000000532400808080800100000080BB',
)
// mwoVentSpeedLevel=0, lamp still 2 - the vent switched back off.
const SAMPLE_VENT_OFF_LAMP_HIGH = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000005324008080808001000000003000015500000000000000FF030D000000000000000000000000000000C300000000532000808080800100000080BB',
)
// mwoVentSpeedLevel=1, lamp 2. This is the fixture that settles the nibble order: if the halves
// were read the other way round this frame would report a lamp level of 1 and a vent speed of 2.
const SAMPLE_VENT_LOW_LAMP_HIGH = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000005324008080808001000000003000015500000000000000FF030D000000000000000000000000000000C300000000532100808080800100000083BB',
)
// mwoLampLevel=1, vent 0.
const SAMPLE_LAMP_LOW = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000005300008080808001000000003000015500000000000000FF030D000000000000000000000000000000C3000000005310008080808001000000F4BB',
)
// LWOState=COOKING_IN_PROGRESS, LWOManualCookName=MICROWAVE, LWOMGTPowerLevel=10,
// LWORemainTimeMinute=5, LWOTargetTimeMinute=5 - the start of a five-minute full-power run.
const SAMPLE_COOKING_FULL_POWER_5MIN = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C3000000005300008080808001000000023000004401000000000A00FF030D000500000500000000000000000000C7000100005300018080808001000000C9BB',
)
// The same run one second later: LWORemainTimeMinute=4, LWORemainTimeSecond=59.
const SAMPLE_COOKING_4M59S = buf(
    'AA6241EC023000004401000000000A00FF030D000500000500000000000000000000C7000100005300018080808001000000023000004401000000000A00FF030D00043B000500000000000000000000C7000100005300018080808001000000B4BB',
)
// LWOState=PAUSED with LWORemainTimeSecond=30 left of the five minutes - the door was opened.
const SAMPLE_PAUSED = buf(
    'AA6241EC023000004401000000000A00FF030D00043B000500000000000000000000C7000100005300018080808001000000043000004401000000000A00FF030D00041E000500000000000000000000C700010000530001808080800100000055BB',
)
// LWOMGTPowerLevel=5, LWORemainTimeSecond=30 - the 30-second run at the panel's "50" power.
const SAMPLE_COOKING_HALF_POWER_30S = buf(
    'AA6241EC073000004001000000000000FF030D000000000000000000000000000000C3000100005300008080808001000000023000004401000000000500FF030D00001E00001E000000000000000000C7000100005300018080808001000000E9BB',
)
// LWOState=DONE at the end of a run.
const SAMPLE_DONE = buf(
    'AA6241EC023000004401000000000A00FF030D00001E00001E000000000000000000C7000100005300018080808001000000053000015500000000000000FF030D000000000000000000000000000000C300000000530000808080800100000086BB',
)
// LWOState=PREFERENCE, LWOManualCookName=SENSOR_COOK, LWOSubCookName=254 - the panel sitting in
// its Sensor Cook selection screen.
const SAMPLE_SENSOR_COOK_SETTINGS = buf(
    'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C300000000530000808080800100000007300000401800FE00000000FF030D000000000000000000000000000000E3000000005300008080808001000000EDBB',
)
// LWOManualCookName=AUTO_COOK, LWOState=COOKING_IN_PROGRESS, LWORemainTimeMinute=1,
// LWORemainTimeSecond=10 - a Kids Menu > Mac and cheese run. Every other preset reports the same
// 0x1f mode with a different rec[6..7], which is why 0x1f names the menu and not the dish.
const SAMPLE_AUTO_COOK_RUNNING = buf(
    'AA6241EC07300000401F000000000000FF030D000000000000000000000000000000C300000000530000808080800100000002300000441F0D1200000A00FF030D00010A00010A000000000000000000C7000000005300018080808001000000A1BB',
)
// Two Sensor Cook dishes running, LWOSubCookName=255 and 264 - Cook > Rice and Reheat > Soup or
// sauce. The dish id spans both rec[6] and rec[7]: 255 is 0x00FF and 264 is 0x0108.
const SAMPLE_SENSOR_COOK_RICE = buf(
    'AA6241EC07300000401800FF00000000FF030D000000000000000000000000000000E300000000530000808080800100000002300000441800FF00000000FF030D000000000000000000000000000000E3000000005300018080808001000000B4BB',
)
const SAMPLE_SENSOR_REHEAT_SOUP = buf(
    'AA6241EC073000004018010800000000FF030D000000000000000000000000000000E3000000005300008080808001000000023000004418010800000000FF030D000000000000000000000000000000E3000000005300018080808001000000A0BB',
)
// A Soften > Butter run, LWOSubCookName=3354 at power 2 for 50 seconds. Every portion size on this
// menu reports the same id and differs only in the time the appliance picks.
const SAMPLE_SOFTEN_BUTTER = buf(
    'AA6241EC07300000401F000000000000FF030D000000000000000000000000000000C300000000530000808080800100000002300000441F0D1A00000200FF030D000032000032000000000000000000C700000000530001808080800100000017BB',
)
// LWOManualCookName=INVERTER_DEFROST, LWOState=COOKING_IN_PROGRESS, LWOMGTPowerLevel=7 - a
// two-pound poultry defrost, for which the appliance chose ten minutes at power 7.
const SAMPLE_DEFROST_RUNNING = buf(
    'AA6241EC07300000401500D300000000FF030D000000000000000000000000000000C300000000530000808080800100000002300000441500D400000700FF030D000A00000A00000000000000000000C700000000530001808080800100000031BB',
)
// The 41 EB single-record reply to the start() status query, captured right after the appliance
// first connected: idle, vent off, lamp at level 2.
const SAMPLE_INITIAL_STATUS = buf(
    'AA3441EB003000015500000000000000FF030D000000000000000000000000000000C300000000532000808080800100000083BB',
)

// A 90-minute kitchen timer. The minutes byte reads 90, not one hour and thirty: there is no hour
// byte in front of it and no borrow at 60. Cloud: LWOTimerMinute:90 with LWOTimerSet "ENABLE".
const TIMER_90_MINUTES = buf(
    'aa6241ec003000014000000000000000ff030d000000000000000000000000000000c3000000005300008080808001000000003000015500000000000000ff030d000000000000005a00000000000000c300000000530000808080800100000083bb',
)

// A 90-minute Microwave cook just started: the remaining time reads 90 minutes in its own minutes
// byte while rec[18..19] carries the length it was given as 1 hour 30, matching the cloud's
// LWOTargetTimeHour:1 and LWOTargetTimeMinute:30 with LWORemainTimeMinute:90 in the same frame.
const COOKING_90_MINUTES = buf(
    'aa6241ec073000004001000000000000ff030d000000000000000000000000000000c3000100005300008080808001000000023000004401000000000a00ff030d005a00011e00000000000000000000c7000100005300018080808001000000abbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('config published on device creation', () => {
        const { ha } = makeDevice()
        const dev = ha.devices[DEVICE_ID]
        assert.ok(dev?.config, 'config published')

        const components = dev.config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'status',
            'cook_mode',
            'cook_item',
            'power_level',
            'remaining_time',
            'cook_time',
            'timer',
            'fan_power',
            'light_power',
        ])
        assert.equal(components.status.device_class, 'enum')
        assert.deepEqual(components.status.options, ['Idle', 'Cooking', 'Paused', 'Done', 'Settings'])
        assert.equal(components.remaining_time.device_class, 'duration')
        assert.equal(components.remaining_time.unit_of_measurement, 's')
        assert.equal(components.timer.device_class, 'duration')
        // 'None' is the payload an undefined value publishes under, which HA reads as unknown, so it
        // must not double as the label for "no dish chosen".
        assert.ok(!(components.cook_item.options as string[]).includes('None'))
        assert.equal(components.fan_power.platform, 'fan')
        assert.equal(components.fan_power.speed_range_min, 1)
        assert.equal(components.fan_power.speed_range_max, 4)
        assert.equal(components.light_power.platform, 'light')
        assert.equal(components.light_power.brightness_scale, 2)
    })

    test('start() sends the status query the LG cloud uses', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(hex(thinq.outbox[0]), 'AA1CF0ED114101000000180E111718191A1A1B0000000000000091BB')
    })

    test('vent speed and lamp level come from opposite nibbles of one byte', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', SAMPLE_VENT_TURBO_LAMP_HIGH)
        assert.equal(props().fan_speed, 4)
        assert.equal(props().fan_power, 'ON')
        assert.equal(props().light_level, 2)
        assert.equal(props().light_power, 'ON')

        thinq.emit('data', SAMPLE_VENT_LOW_LAMP_HIGH)
        assert.equal(props().fan_speed, 1)
        assert.equal(props().light_level, 2)

        thinq.emit('data', SAMPLE_VENT_OFF_LAMP_HIGH)
        assert.equal(props().fan_speed, 0)
        assert.equal(props().fan_power, 'OFF')
        assert.equal(props().light_level, 2)

        thinq.emit('data', SAMPLE_LAMP_LOW)
        assert.equal(props().fan_speed, 0)
        assert.equal(props().light_level, 1)
    })

    // The four frames below are the exact bytes that were sent to a real MVEL2033F during
    // protocol verification; the appliance acknowledged each with AA084100430063BB and then
    // reported the state named in the comment.
    test('setting the vent speed sends an absolute level and leaves the lamp alone', () => {
        const { thinq, dev } = makeDevice()

        // fan -> 1, lamp untouched. The appliance reported vent=1, lamp unchanged at 0.
        dev.setProperty('fan_speed', '1')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401018080808046BB')

        // fan -> 2 while it was running at 4. The appliance went to 2, which is what proves the
        // level byte is absolute rather than a count of presses to advance by.
        thinq.resetRecorder()
        dev.setProperty('fan_speed', '2')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401028080808041BB')
    })

    test('setting the lamp level leaves the vent alone', () => {
        const { thinq, dev } = makeDevice()

        // lamp -> 1 while the vent ran at 1. The appliance reported vent=1, lamp=1.
        dev.setProperty('light_level', '1')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220480800101808046BB')
    })

    test('turning a control off sends the off command for that control only', () => {
        const { thinq, dev } = makeDevice()

        // lamp off, vent untouched. The appliance reported vent=0, lamp=0.
        dev.setProperty('light_power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220480800000808044BB')

        thinq.resetRecorder()
        dev.setProperty('fan_power', 'OFF')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220400008080808044BB')
    })

    test('turning a control on restores the level it last reported', () => {
        const { thinq, dev } = makeDevice()

        // the appliance last reported the vent at Turbo and the lamp at High
        thinq.emit('data', SAMPLE_VENT_TURBO_LAMP_HIGH)
        thinq.resetRecorder()

        dev.setProperty('fan_power', 'ON')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401048080808043BB')

        thinq.resetRecorder()
        dev.setProperty('light_power', 'ON')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220480800102808041BB')
    })

    test('out-of-range levels are clamped rather than sent verbatim', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('fan_speed', '9')
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401048080808043BB')

        thinq.resetRecorder()
        dev.setProperty('light_level', 'not a number')
        assert.equal(thinq.outbox.length, 0)
    })

    test('cooking state, mode, power level and remaining time', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_COOKING_FULL_POWER_5MIN)
        let props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Cooking')
        assert.equal(props.cook_mode, 'Microwave')
        assert.equal(props.power_level, 10)
        assert.equal(props.remaining_time, 300)

        thinq.emit('data', SAMPLE_COOKING_4M59S)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 299)

        thinq.emit('data', SAMPLE_COOKING_HALF_POWER_30S)
        props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power_level, 5)
        assert.equal(props.remaining_time, 30)
        // rec[20] is a seconds byte: a sub-minute cook length is not just hours*3600+minutes*60.
        assert.equal(props.cook_time, 30)
    })

    test('a duration over an hour keeps counting in minutes, it does not borrow', () => {
        // 90 minutes reads 90 in the minutes byte, and the cloud reports LWOTimerMinute:90 rather
        // than an hour and thirty. The byte ahead of the pair, which its position would suggest is
        // hours, stays 0 and is deliberately not read.
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TIMER_90_MINUTES)
        assert.equal(ha.devices[DEVICE_ID].properties.timer, 90 * 60)
    })

    test('the cook length is kept apart from what is left of it', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        // A five-minute cook: both read 5 minutes at the start, then the remaining time ticks down
        // while the length it was given holds.
        thinq.emit('data', SAMPLE_COOKING_FULL_POWER_5MIN)
        assert.equal(props().cook_time, 300)
        assert.equal(props().remaining_time, 300)

        thinq.emit('data', SAMPLE_COOKING_4M59S)
        assert.equal(props().cook_time, 300)
        assert.equal(props().remaining_time, 299)

        // 90 minutes is where the two formats diverge: the length is 1 hour 30 in rec[18..19] while
        // the remaining time is a flat 90 in its minutes byte.
        thinq.emit('data', COOKING_90_MINUTES)
        assert.equal(props().cook_time, 90 * 60)
        assert.equal(props().remaining_time, 90 * 60)
    })

    test('paused, done and settings states', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Paused')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 270)

        thinq.emit('data', SAMPLE_DONE)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Done')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 0)

        thinq.emit('data', SAMPLE_SENSOR_COOK_SETTINGS)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Settings')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_mode, 'Sensor cook')
    })

    test('a preset run reports the auto cook mode', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_AUTO_COOK_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Cooking')
        assert.equal(props.cook_mode, 'Auto cook')
        assert.equal(props.power_level, 10)
        assert.equal(props.remaining_time, 70)
    })

    test('the dish is read as one 16-bit id spanning both of its bytes', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_SENSOR_COOK_RICE)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_mode, 'Sensor cook')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_item, 'Rice')

        // 0x0108: the high byte is set here, so a single-byte read would report Shrimp (8).
        thinq.emit('data', SAMPLE_SENSOR_REHEAT_SOUP)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_item, 'Reheat soup or sauce')

        thinq.emit('data', SAMPLE_AUTO_COOK_RUNNING)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_item, 'Kids mac and cheese')

        // Two dishes off the same menu, so the id and not the mode is what tells them apart.
        thinq.emit('data', SAMPLE_SOFTEN_BUTTER)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_mode, 'Auto cook')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_item, 'Soften butter')
        assert.equal(ha.devices[DEVICE_ID].properties.power_level, 2)

        thinq.emit('data', SAMPLE_INITIAL_STATUS)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_item, 'Not selected')
    })

    test('a defrost run reports its mode and the power level the appliance chose', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_DEFROST_RUNNING)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Cooking')
        assert.equal(props.cook_mode, 'Inverter defrost')
        assert.equal(props.power_level, 7)
        assert.equal(props.remaining_time, 600)
    })

    test('the single-record 41 EB reply decodes like the 41 EC current record', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', SAMPLE_INITIAL_STATUS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Idle')
        assert.equal(props.cook_mode, 'Off')
        assert.equal(props.fan_speed, 0)
        assert.equal(props.light_level, 2)
    })

    test('frames of the wrong length or class publish nothing', () => {
        const { ha, thinq } = makeDevice()

        // a 41/3e frame, which carries no state this handler decodes
        thinq.emit('data', buf('AA0B413E000D000D001BBB'))
        // an EC frame truncated by one byte
        thinq.emit('data', buf('AA6141EC003000015500000000000000FFBB'))

        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
