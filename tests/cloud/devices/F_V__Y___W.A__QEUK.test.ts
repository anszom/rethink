import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V__Y___W.A__QEUK'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V__Y___W.A__QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.10.71' }

// All frames are real, captured from a WV9-1409W (firmware 2.10.71) bridged to the LG cloud, and checked
// against the cloud's labels.

// 19 Oct 2026, Ready, one setting changed at the panel per frame.
const D8_ZERO = buf('aa0720d800fcbb')
const D8_36 = buf('aa0720d82498bb')
const POWER_ON = buf(
    'aa4220ec001c00000000000000000000000000000000000000000024007a00000000001c01000000000000000000000000000000000000010024007a000000003bbb',
)
const COTTON = buf(
    'aa4220ec001c01000000000000000000000000000000000000010024007a00000000001c01021502150100030a04010000000000010002010024007a00000400edbb',
)
const COTTON_ECO = buf(
    'aa4220ec001c01021502150100030a04010000000000010002010024007a00000400001c01021202120400030a06010000000000000003010024007a00000200a8bb',
)
const TURBOCLEAN_39 = buf(
    'aa4220ec001c01021202120400030a06010000000000000003010024007a00000200001c01002700273100030904010000000100000001010024007a0000000012bb',
)
const MIXED_FABRIC = buf(
    'aa4220ec001c01002700273100030904010000000100000001010024007a00000000001c01011501150700030704010000000000010002010024007a000003001fbb',
)
const EASY_CARE = buf(
    'aa4220ec001c01011501150700030704010000000000010002010024007a00000300001c01020102010200030a04010000000000010002010024007a000003008dbb',
)
const QUIET_WASH = buf(
    'aa4220ec001c01020102010200030a04010000000000010002010024007a00000300001c01021c021c0900030504010000000000000002010024007a00000500bcbb',
)
const ALLERGY_CARE = buf(
    'aa4220ec001c01021c021c0900030504010000000000000002010024007a00000500001c01023002302d00030a06010000008000000004010024007a00000500a2bb',
)
const DOWNLOAD_CYCLE = buf(
    'aa4220ec001c01023002302d00030a06010000008000000004010024007a00000500001c01000e000e1700000a00000000000000000001017a24007a0000000003bb',
)
const TUB_CLEAN = buf(
    'aa4220ec001c01000e000e1700000a00000000000000000001017a24007a00000000001c01010c010c1200030106010000000000000003010024007a0000020031bb',
)
const DUVET = buf(
    'aa4220ec001c01010c010c1200030106010000000000000003010024007a00000200001c01012101210500030701010000000000000001010024007a0000030050bb',
)
const QUICK_14 = buf(
    'aa4220ec001c01012101210500030701010000000000000001010024007a00000300001c01000e000e0c00030202010000000100000000010024007a00000100aebb',
)
const SPORTSWEAR = buf(
    'aa4220ec001c01000e000e0c00030202010000000100000000010024007a00000100001c01003400340800030504010000000000000002010024007a0000020076bb',
)
const HAND_WOOL = buf(
    'aa4220ec001c01003400340800030504010000000000000002010024007a00000200001c01002400241b00030503010000000000000001010024007a0000030031bb',
)
const DELICATES = buf(
    'aa4220ec001c01002400241b00030503010000000000000001010024007a00000300001c01002d002d2000030502010000000000000001010024007a0000030039bb',
)
const TEMP_60 = buf(
    'aa4220ec001c01021502150100030a04010000000000010002010024007a00000400001c01022902290100030a06010000000000010004010024007a0000040079bb',
)
const TEMP_95 = buf(
    'aa4220ec001c01022902290100030a06010000000000010004010024007a00000400001c01023302330100030a07010000000000010004010024007a0000040038bb',
)
const TEMP_COLD = buf(
    'aa4220ec001c01023302330100030a07010000000000010004010024007a00000400001c01033903390100030a01010000000000010002010024007a00000400ddbb',
)
const TEMP_20 = buf(
    'aa4220ec001c01033903390100030a01010000000000010002010024007a00000400001c01012901290100030a02010000000000010001010024007a000004003fbb',
)
const TEMP_30 = buf(
    'aa4220ec001c01012901290100030a02010000000000010001010024007a00000400001c01013301330100030a03010000000000010002010024007a0000040009bb',
)
const SPIN_NO = buf(
    'aa4220ec001c01021502150100030a04010000000000010002010024007a00000400001c01020802080100030104010000000000010002010024007a0000040088bb',
)
const SPIN_400 = buf(
    'aa4220ec001c01020802080100030104010000000000010002010024007a00000400001c01020b020b0100030204010000000000010002010024007a0000040094bb',
)
const SPIN_800 = buf(
    'aa4220ec001c01020b020b0100030204010000000000010002010024007a00000400001c01020d020d0100030504010000000000010002010024007a000004009abb',
)
const SPIN_1000 = buf(
    'aa4220ec001c01020d020d0100030504010000000000010002010024007a00000400001c01021202120100030704010000000000010002010024007a00000400b7bb',
)
const SPIN_1200 = buf(
    'aa4220ec001c01021202120100030704010000000000010002010024007a00000400001c01021202120100030904010000000000010002010024007a00000400a5bb',
)
const STEAM_ON = buf(
    'aa4220ec001c01021502150100030a04010000000000010002010024007a00000400001c01030003000100030a06010000008000010004010024007a0000040009bb',
)
const TURBO_CLEAN_ON = buf(
    'aa4220ec001c01022902290100030a06010000000000010004010024007a00000400001c01020f020f0100030706010000000100010003010024007a0000040074bb',
)
const PRE_WASH_ON = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01023702370100030706010000004000010004010024007a00000500fcbb',
)
const WRINKLE_CARE_ON = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01030903090100030706010000000020010004010024007a000004007bbb',
)
const RINSE_PLUS_ON = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01023302330100030706020000000000010004010024007a0000050037bb',
)
const INTENSIVE_ON = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01031103110100040706010000000000010004010024007a000004004abb',
)
const CHILD_LOCK_ON = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01022602260100030706010000000080010004010024007a0000040093bb',
)
const DELAY_3H = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01022602260100030706010003000000010004010024007a000004001cbb',
)
const DELAY_19H = buf(
    'aa4220ec001c01022602260100030706010012000000010004010024007a00000400001c01022602260100030706010013000000010004010024007a000004003ebb',
)
const PUSH_REMOTE_START_ON = buf('aa09207200c9005bbb')
const REMOTE_START_ON = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c01022602260100030706010000000002010004010024007a000004001dbb',
)
const REMOTE_START_DOOR_LOCKED = buf(
    'aa4220ec001c01022602260100030706010000000002010004010024007a00000400001c01022602260100030706010000000042010004010024007a00000400dfbb',
)
const PUSH_REMOTE_START_OFF = buf('aa09207200c80058bb')
const POWER_OFF = buf(
    'aa4220ec001c01022602260100030706010000000000010004010024007a00000400001c00022602260100000000000000000000010004000024007a0000040066bb',
)

// 21 Oct 2026, a Quick 14 wash with one pause, started at the panel.
const WASH_STARTED = buf(
    'aa4220ec001c01000e000e0c00030202010000000100000000010024007a00000100001c06000e000e0c00030202010000000102200001060024007a0000000055bb',
)
const BD_DUMP = buf(
    'aa0020bd00010190000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004cbb',
)
const CD_DUMP = buf(
    'aa0020cd000190000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007dbb',
)
const WASH_DOOR_LOCKED = buf(
    'aa4220ec001c06000e000e0c00030202010000000102200001060024007a00000000001c06000e000e0c00030202010000000142200001060024007a0000000039bb',
)
const WASH_13_MIN = buf(
    'aa4220ec001c06000e000e0c00030202010000000142200001060024007a00000000001c06000d000e0c00030202010000000142200001060024007a00000000febb',
)
const PAUSED = buf(
    'aa4220ec001c06000c000e0c00030202010000000142200001060024007a00000000001c02000c000e0c00030202010000000140000000020024007a000001002bbb',
)
const PAUSED_DOOR_UNLOCKED = buf(
    'aa4220ec001c02000c000e0c00030202010000000140000000020024007a00000100001c02000c000e0c00030202010000000100000000020024007a0000010041bb',
)
const RESUMED = buf(
    'aa4220ec001c02000c000e0c00030202010000000100000000020024007a00000100001c06000c000e0c00030202010000000102200001020024007a00000000afbb',
)
const RINSING = buf(
    'aa4220ec001c06000c000e0c00030202010000000142200001060024007a00000000001c07000b000e0c00030200010000000142000001070024007a00000000d2bb',
)
const SPINNING = buf(
    'aa4220ec001c070006000e0c00030200010000000142000001070024007a00000100001c080005000e0c00000200000000000042000001080024007a000001000fbb',
)
const PUSH_WASH_COMPLETE = buf('aa09207200000010bb')
const END = buf(
    'aa4220ec001c080001000e0c00000200000000000042000001080024007a00000100001c0a0000000e0c000000000000000000400000010a0024007a0000010018bb',
)
const E2_END = buf('aa2420e2091c06000e000e0c00030202010000000102200001060024007a00000100a1bb')
const END_DOOR_UNLOCKED = buf(
    'aa4220ec001c0a0000000e0c000000000000000000400000010a0024007a00000100001c0a0000000e0c000000000000000000000000010a0024007a0000010059bb',
)
const OFF_AFTER_END = buf(
    'aa4220ec001c0a0000000e0c000000000000000000000000010a0024007a00000100001c000000000e0c00000000000000000000000000000024007a00000100e2bb',
)
const OFF_AFTER_POWER_OFF = buf(
    'AA4220EC001C01022602260100030706010000000000010004010024007A00000400001C00022602260100000000000000000000010004000024007A0000040066BB',
)

// 21 and 22 Oct 2026: the LG app's own commands, sent through the bridge, and the washer's state just
// before each. LG_* frames are what the LG cloud sent the washer.
const COTTON_REMOTE_START = buf(
    'AA4220EC001C01021502150100030A04010000000002010002010025007A00000400001C01021502150100030A04010000000042010002010025007A0000040013BB',
) // Cotton on the panel, Remote Start armed
const LG_START_COTTON = buf('AA16F02601030A04010000000000030000000000B9BB') // Start in the app, nothing changed
const RESULT_START_OK = buf('AA0820002600ADBB') // the washer's answer: command 26 done
const NO_COURSE_REMOTE_START = buf(
    'AA4220EC001C01000000000000000000000000000002000000010025007A00000000001C01000000000000000000000000000042000000010025007A00000000E3BB',
) // just powered on, dial untouched
const LG_START_QUICK_14 = buf('AA16F0260C030202010000000001030000000000BBBB') // Quick 14 picked in the app, Start
const COTTON_STEAM_WRINKLE_REMOTE_START = buf(
    'AA4220EC001C01031F031F0100030A06010000008022010004010025007A00000400001C01031F031F0100030A06010000008062010004010025007A00000400EFBB',
)
const LG_START_RINSE_PLUS = buf('AA16F02601030A06020000000080230000000000DABB') // Rinse+ picked in the app, Start
const NO_COURSE_REMOTE_START_2 = buf(
    'AA4220EC001C01020E02100000000000000000000002010003010025007A00000100001C01020E02100000000000000000000042010003010025007A0000010051BB',
)
const LG_START_DELAYED = buf('AA16F0260103FF04010003000000030000000000B1BB') // Cotton, "Set delayed cycle" 3 h, Start
const DELAYED = buf(
    'AA4220EC001C04021502150100030A04010003000042210001040025007A00000000001C03003B003B0100030A04010003000042210001030025007A0000000041BB',
) // waiting out the delay: 3 h 0, wash 0:59
const LG_POWER_OFF_DELAYED = buf('AA09F0240101009CBB')
const QUICK_14_WASHING = buf(
    'AA4220EC001C06000E000E0C00030202010000000142200001060025007A00000000001C06000D000E0C00030202010000000142200001060025007A00000000F8BB',
)
const LG_PAUSE = buf('AA09F02404010099BB')
const QUICK_14_PAUSED = buf(
    'AA4220EC001C06000D000E0C00030202010000000142200001060025007A00000000001C02000D000E0C00030202010000000142000000020025007A00000100D1BB',
)
const LG_RESUME = buf('AA16F0260C030202010000000001020000000000B8BB')
const RINSING_SESSION_1 = buf(
    'AA4220EC001C07000B000E0C00030200010000000102200001070025007A00000000001C07000B000E0C00030200010000000142000001070025007A000000001DBB',
)
const LG_POWER_OFF = buf('AA09F0240101009CBB')
const STANDBY = buf(
    'AA4220EC001C01000000000000000000000000000042000000010025007A00000000001C01000000000000000000000000000042000000010025007A00000001A2BB',
) // asleep after 14 idle minutes with Remote Start armed
const LG_WAKE_UP = buf('AA08F02A010098BB') // the app's "Sleep Mode OFF"
const WAKE_RESPONSE = buf('AA08202B0100ABBB')
const LG_ACK_WAKE_RESPONSE = buf('AA08F0002B0484BB')
const AWAKE = buf(
    'AA4220EC001C01000000000000000000000000000002000000010025007A00000000001C01000000000000000000000000000042000000010025007A00000000E3BB',
)
const PUSH_ERROR = buf('AA0C2072006403000000FABB') // Remote Start armed with the door open
const ERROR_DE1 = buf(
    'AA4220EC001C01000000000000000000000000000000000000010025007A00000000001C12000000000002000000000000000000000000120025007A00000000C3BB',
)

// The washer connecting (22 Oct): its hello, LG's status request and the washer's EB answer.
const HELLO = buf(
    'AA372031020153414134313035393332300146AD600000400000000000025341413431303539323230000074BA000040000000000047BB',
)
const LG_ACK_HELLO = buf('AA08F000310482BB')
const LG_STATUS_REQUEST = buf('AA0EF0ED1121010000001800B5BB')
const EB_ON_CONNECT = buf('AA2420EB001C01021502150100030A04010000000000010002010025007A000004008BBB')

// The LG cloud's acks to the washer, byte for byte from the same captures.
const LG_ACK_D8 = 'AA08F000D8042BBB'
const LG_ACK_72 = 'AA08F00072044DBB'
const LG_ACK_E2 = 'AA08F000E204DDBB'

// The washer connected through rethink's bridge, as it runs for real: HA presses arrive as setProperty.
function connect(...frames: Buffer[]) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    new Bridge(ha.asConnection()).newDevice(thinq)
    for (const f of frames) thinq.emit('data', f)
    thinq.resetRecorder()
    return {
        thinq,
        props: () => ha.devices[DEVICE_ID].properties,
        press: (...actions: [string, string?][]) => {
            for (const [prop, value] of actions) ha.emit('setProperty', DEVICE_ID, prop, value ?? '')
        },
        sent: () => thinq.outbox.map(hex),
    }
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, props: () => ha.devices[DEVICE_ID].properties }
}

function decode(...frames: Buffer[]) {
    const { thinq, props } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return props()
}

describe(MODEL_ID, () => {
    test('every dial position reports its panel name and programme time', () => {
        const positions: [Buffer, string, number][] = [
            [COTTON, 'Cotton', 141],
            [COTTON_ECO, 'Cotton Eco', 138],
            [TURBOCLEAN_39, 'TurboClean 39', 39],
            [MIXED_FABRIC, 'Mixed Fabric', 81],
            [EASY_CARE, 'Easy Care', 121],
            [QUIET_WASH, 'Quiet Wash', 148],
            [ALLERGY_CARE, 'Allergy Care', 168],
            [DOWNLOAD_CYCLE, 'Spin', 14], // the downloaded course, Spin
            [TUB_CLEAN, 'Tub Clean', 72],
            [DUVET, 'Duvet', 93],
            [QUICK_14, 'Quick 14', 14],
            [SPORTSWEAR, 'Sportswear', 52],
            [HAND_WOOL, 'Hand/Wool', 36],
            [DELICATES, 'Delicates', 45],
        ]
        for (const [frame, course, minutes] of positions) {
            const props = decode(frame)
            assert.equal(props.course, course)
            assert.equal(props.remaining_time, minutes, course)
            assert.equal(props.initial_time, minutes, course)
        }
    })

    test('Download Cycle has no temperature, rinse or soil level', () => {
        const props = decode(DOWNLOAD_CYCLE)
        assert.equal(props.downloaded_course, 'Spin')
        assert.equal(props.temp, 'Not selected')
        assert.equal(props.rinse, 'Not selected')
        assert.equal(props.soil, 'Not selected')
    })

    test('every temperature and spin speed on the panel', () => {
        const temps: [Buffer, string][] = [
            [TEMP_COLD, 'Cold'],
            [TEMP_20, '20 °C'],
            [TEMP_30, '30 °C'],
            [COTTON, '40 °C'],
            [TEMP_60, '60 °C'],
            [TEMP_95, '95 °C'],
        ]
        for (const [frame, temp] of temps) assert.equal(decode(frame).temp, temp)

        const spins: [Buffer, string][] = [
            [SPIN_NO, 'No spin'],
            [SPIN_400, '400 rpm'],
            [SPIN_800, '800 rpm'],
            [SPIN_1000, '1000 rpm'],
            [SPIN_1200, '1200 rpm'],
            [COTTON, '1400 rpm'],
        ]
        for (const [frame, spin] of spins) assert.equal(decode(frame).spin, spin)
    })

    test('options, including the settings the washer changes with them', () => {
        const plain = decode(COTTON)
        for (const key of ['steam', 'turbo_wash', 'pre_wash', 'wrinkle_care']) assert.equal(plain[key], 'OFF', key)
        assert.equal(plain.rinse, 'Normal')
        assert.equal(plain.soil, 'Normal')

        // Steam moves 40 °C to 60 °C, TurboWash (the panel's Turbo Clean) moves 1400 rpm to 1000 rpm, in the
        // same frame.
        const steam = decode(STEAM_ON)
        assert.equal(steam.steam, 'ON')
        assert.equal(steam.temp, '60 °C')
        const turbo = decode(TURBO_CLEAN_ON)
        assert.equal(turbo.turbo_wash, 'ON')
        assert.equal(turbo.spin, '1000 rpm')

        assert.equal(decode(PRE_WASH_ON).pre_wash, 'ON')
        assert.equal(decode(WRINKLE_CARE_ON).wrinkle_care, 'ON')
        assert.equal(decode(INTENSIVE_ON).soil, 'Intensive')

        // Rinse+ sets rec[12], which F_C's layout reads as the course.
        const rinse = decode(RINSE_PLUS_ON)
        assert.equal(rinse.rinse, 'Rinse+')
        assert.equal(rinse.course, 'Cotton')
    })

    test('child lock, Delay End, and remote start locking the door', () => {
        assert.equal(decode(CHILD_LOCK_ON).child_lock, 'ON')
        assert.equal(decode(COTTON).child_lock, 'OFF')
        assert.equal(decode(DELAY_3H).delay_end, 180)
        assert.equal(decode(DELAY_19H).delay_end, 1140)

        const { thinq, props } = makeDevice()
        thinq.emit('data', REMOTE_START_ON)
        assert.equal(props().remote_start, 'ON')
        assert.equal(props().door_lock, 'OFF') // not locked yet
        thinq.emit('data', REMOTE_START_DOOR_LOCKED)
        assert.equal(props().door_lock, 'ON') // locked about 5 s later
    })

    test('power on, before the dial moves, and power off', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', D8_ZERO)
        assert.equal(props().tub_clean_count, 0) // as the LG cloud also reports it
        thinq.emit('data', D8_36)
        assert.equal(props().tub_clean_count, 36)

        // The dial is on Cotton, but nothing is filled in until it is turned.
        thinq.emit('data', POWER_ON)
        assert.equal(props().status, 'Standby')
        assert.equal(props().power, 'ON')
        assert.equal(props().course, 'None')
        assert.equal(props().remaining_time, 0)
        assert.equal(props().tub_clean_count, 36)

        thinq.emit('data', POWER_OFF)
        assert.equal(props().status, 'Off')
        assert.equal(props().power, 'OFF')
    })

    test('a Quick 14 wash with a pause, through to the washer switching itself off', () => {
        const { thinq, props } = makeDevice()
        const step = (frame: Buffer, expected: Record<string, string | number>) => {
            thinq.emit('data', frame)
            for (const [key, value] of Object.entries(expected)) assert.equal(props()[key], value, key)
        }

        step(WASH_STARTED, { status: 'Washing', course: 'Quick 14', remaining_time: 14, remote_start: 'ON' })
        step(WASH_DOOR_LOCKED, { door_lock: 'ON' })
        step(WASH_13_MIN, { remaining_time: 13 })
        step(PAUSED, { status: 'Paused', remote_start: 'OFF' })
        step(PAUSED_DOOR_UNLOCKED, { door_lock: 'OFF' })
        step(RESUMED, { status: 'Washing', remote_start: 'ON' })
        step(RINSING, { status: 'Rinsing', remaining_time: 11, temp: 'Not selected' })
        step(SPINNING, { status: 'Spinning', remaining_time: 5, rinse: 'Not selected', soil: 'Not selected' })
        step(END, { status: 'End', remaining_time: 0, spin: 'Not selected', remote_start: 'OFF', door_lock: 'ON' })
        step(END_DOOR_UNLOCKED, { door_lock: 'OFF' })
        step(OFF_AFTER_END, { status: 'Off', power: 'OFF' })
    })

    test('acks exactly the frames the LG cloud acks, with its bytes, and nothing else', () => {
        const { thinq } = makeDevice()
        const frames = [D8_ZERO, COTTON, PUSH_REMOTE_START_ON, PUSH_REMOTE_START_OFF, RESULT_START_OK]
        frames.push(WASH_STARTED, BD_DUMP, CD_DUMP, PUSH_WASH_COMPLETE, END, E2_END, HELLO, WAKE_RESPONSE)
        for (const f of frames) thinq.emit('data', f)

        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        const lg = [LG_ACK_D8, LG_ACK_72, LG_ACK_72, LG_ACK_72, LG_ACK_E2, hex(LG_ACK_HELLO), hex(LG_ACK_WAKE_RESPONSE)]
        assert.deepEqual(acks, lg)
        assert.equal(thinq.sent.length, acks.length)
        assert.deepEqual(thinq.outbox, [], 'no packets in reply to anything the washer sends')
    })

    test('connecting: asks for the state as LG does, and reads the EB answer', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        new Bridge(ha.asConnection()).newDevice(thinq)
        assert.deepEqual(thinq.outbox.map(hex), [hex(LG_STATUS_REQUEST)])

        thinq.emit('data', EB_ON_CONNECT)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Standby')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.remaining_time, 141)
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1400 rpm')
    })

    test("each command is byte for byte the LG app's, sent from the same washer state", () => {
        const cases: [string, Buffer, [string, string?][], Buffer][] = [
            ['Start, as set on the panel', COTTON_REMOTE_START, [['start']], LG_START_COTTON],
            [
                'Start, course picked',
                NO_COURSE_REMOTE_START,
                [['set_course', 'Quick 14'], ['start']],
                LG_START_QUICK_14,
            ],
            [
                'Start, rinse changed',
                COTTON_STEAM_WRINKLE_REMOTE_START,
                [['set_rinse', 'Rinse+'], ['start']],
                LG_START_RINSE_PLUS,
            ],
            [
                'Start, delayed',
                NO_COURSE_REMOTE_START_2,
                [['set_course', 'Cotton'], ['set_delay_end', '3'], ['start']],
                LG_START_DELAYED,
            ],
            ['Pause', QUICK_14_WASHING, [['pause']], LG_PAUSE],
            ['Start while paused: resume', QUICK_14_PAUSED, [['start']], LG_RESUME],
            ['Power off, rinsing', RINSING_SESSION_1, [['power_off']], LG_POWER_OFF],
            ['Power off, delayed', DELAYED, [['power_off']], LG_POWER_OFF_DELAYED],
            ['Wake up, in standby', STANDBY, [['wake_up']], LG_WAKE_UP],
        ]
        for (const [name, state, actions, lg] of cases) {
            const washer = connect(state)
            washer.press(...actions)
            assert.deepEqual(washer.sent(), [hex(lg)], name)
        }
    })

    test("Start, Power off and Wake up are greyed out in HA unless the washer's own status allows them", () => {
        const ha = new MockHAConnection()
        new DUT(ha.asConnection(), new MockThinq2Device(DEVICE_ID, META), META)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        const gate = (key: string) => {
            const availability = components[key].availability as { topic: string; payload_available?: string }[]
            const last = availability?.[availability.length - 1]
            return last && [last.topic, last.payload_available]
        }
        assert.deepEqual(gate('start'), ['$this/remote_start', 'ON'])
        assert.deepEqual(gate('power_off'), ['$this/power', 'ON'])
        assert.deepEqual(gate('wake_up'), ['$this/standby', 'ON'])
        assert.equal(gate('pause'), undefined)
        assert.equal(components.resume, undefined, 'Start resumes; there is no Resume button')
        assert.equal(components.start.availability_mode, 'all')

        // What those topics read in the recorded states.
        assert.equal(decode(COTTON_REMOTE_START).remote_start, 'ON')
        assert.equal(decode(COTTON).remote_start, 'OFF')
        assert.equal(decode(OFF_AFTER_POWER_OFF).power, 'OFF')
        assert.equal(decode(STANDBY).standby, 'ON')
        assert.equal(decode(QUICK_14_WASHING).standby, 'OFF')
    })

    test('sends nothing only when there is nothing valid to send', () => {
        const cases: [string, Buffer[], [string, string?][]][] = [
            ['no status from the washer yet: no settings to start or resume with', [], [['start']]],
            ['no course on the washer or chosen', [NO_COURSE_REMOTE_START], [['start']]],
        ]
        for (const [name, frames, actions] of cases) {
            const washer = connect(...frames)
            washer.press(...actions)
            assert.deepEqual(washer.sent(), [], name)
        }
    })

    test('any other press is sent whatever the state, and the washer decides', () => {
        const cases: [string, Buffer, [string, string?][], Buffer][] = [
            ['Pause while ready', COTTON_REMOTE_START, [['pause']], LG_PAUSE],
            [
                'Start while washing: the running programme, start flags',
                QUICK_14_WASHING,
                [['start']],
                LG_START_QUICK_14,
            ],
            // Washing again, though the previous-state byte still reads paused: Start, not resume.
            ['Start just after a resume', RESUMED, [['start']], LG_START_QUICK_14],
            ['Power off while off', OFF_AFTER_POWER_OFF, [['power_off']], LG_POWER_OFF],
            ['Wake up while awake', COTTON_REMOTE_START, [['wake_up']], LG_WAKE_UP],
        ]
        for (const [name, state, actions, bytes] of cases) {
            const washer = connect(state)
            washer.press(...actions)
            assert.deepEqual(washer.sent(), [hex(bytes)], name)
        }
    })

    test('a course picked brings its defaults, and only the choices the app offers for it', () => {
        const washer = connect(NO_COURSE_REMOTE_START)
        washer.press(['set_course', 'Quick 14'])
        const settings = () => {
            const p = washer.props()
            return [p.set_course, p.set_temp, p.set_spin, p.set_rinse, p.set_delay_end]
        }
        assert.deepEqual(settings(), ['Quick 14', '20 °C', '400 rpm', 'Normal', 0])

        // Not offered for Quick 14: 95 °C, 1400 rpm (the app offers "Max"), a 2 h delay.
        washer.press(['set_temp', '95 °C'], ['set_spin', '1400 rpm'], ['set_delay_end', '2'])
        assert.deepEqual(settings(), ['Quick 14', '20 °C', '400 rpm', 'Normal', 0])
        washer.press(['start'])
        assert.deepEqual(washer.sent(), [hex(LG_START_QUICK_14)])

        // Tub Clean: fixed settings, no Delay End.
        const tub = connect(NO_COURSE_REMOTE_START)
        tub.press(['set_course', 'Quick 14'], ['set_delay_end', '3'], ['set_course', 'Tub Clean'])
        tub.press(['set_temp', '40 °C'], ['set_delay_end', '3'])
        const p = tub.props()
        assert.deepEqual([p.set_course, p.set_temp, p.set_spin, p.set_delay_end], ['Tub Clean', '60 °C', 'No spin', 0])
    })

    test('Start resumes a paused programme as it was, whatever was chosen in HA meanwhile', () => {
        const washer = connect(QUICK_14_PAUSED)
        washer.press(['set_course', 'Cotton'], ['start'])
        assert.deepEqual(washer.sent(), [hex(LG_RESUME)])
        assert.equal(washer.props().set_course, 'Quick 14')
    })

    test("the settings show the washer's own until changed, and follow it again after Start", () => {
        const washer = connect(COTTON_STEAM_WRINKLE_REMOTE_START)
        const settings = () => {
            const p = washer.props()
            return [p.set_course, p.set_temp, p.set_spin, p.set_rinse, p.set_delay_end]
        }
        assert.deepEqual(settings(), ['Cotton', '60 °C', '1400 rpm', 'Normal', 0])
        washer.press(['set_rinse', 'Rinse+'])
        assert.deepEqual(settings(), ['Cotton', '60 °C', '1400 rpm', 'Rinse+', 0])
        washer.press(['start'])
        assert.deepEqual(settings(), ['Cotton', '60 °C', '1400 rpm', 'Normal', 0])
    })

    test('the door error: status, code and message, and its push acked', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', PUSH_ERROR)
        thinq.emit('data', ERROR_DE1)
        assert.equal(props().status, 'Error')
        assert.equal(props().error, 'ON')
        assert.equal(props().error_message, 'Door open error (DE1)')
        assert.deepEqual(
            thinq.sent.map((m) => m.data),
            [LG_ACK_72],
        )
        thinq.emit('data', COTTON)
        assert.equal(props().error, 'OFF')
        assert.equal(props().error_message, 'OK')
    })

    test('standby, the delayed start and its countdown', () => {
        assert.equal(decode(STANDBY).standby, 'ON')
        assert.equal(decode(AWAKE).standby, 'OFF')
        const delayed = decode(DELAYED)
        assert.equal(delayed.status, 'Delayed')
        assert.equal(delayed.delay_end, 180)
        assert.equal(delayed.remaining_time, 59)
    })
})
