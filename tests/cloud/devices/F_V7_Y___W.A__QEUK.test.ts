import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V7_Y___W.A__QEUK'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, captureLog } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-washer'
const MODEL_ID = 'F_V7_Y___W.A__QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WV5-1275W', swVersion: '2.9.61' }

// Real WV5-1275W captures. Settings and Quick 30 reports were cross-checked with
// independent LG cloud state notifications. EC contains previous/current records;
// the differing fields in these packets exercise selection of the current record.
const COTTON_READY = buf(
    'aa4220ec001c01000000000100000000000000000000000000010030006400000000001c01023a023a0100030904010000000000000003010030006400000400bbbb',
)
const QUICK30_SELECTED = buf(
    'aa4220ec001c01003400340800030504010000000000000002010030006400000200001c01001e001e22000305020100000000000000010100300064000002001cbb',
)
const QUICK30_WASHING = buf(
    'aa4220ec001c06001e001e2200030502010000000000000001060030006400000200001c06001e001e2200030502010000000040000001060030006400000200ddbb',
)
const QUICK30_RINSING = buf(
    'aa4220ec001c060013001e2200030502010000000040000001060030006400000200001c070012001e2200030500010000000040000001070030006400000200e4bb',
)
const QUICK30_SPINNING = buf(
    'aa4220ec001c07000b001e2200030500010000000040000002070030006400000200001c08000a001e2200000500000000000040000002080030006400000200f4bb',
)
const QUICK30_END = buf(
    'aa4220ec001c080001001e2200000500000000000040000004080030006400000200001c0a0000001e2200000000000000000040000004080030006400000200d9bb',
)
const END_ALERT = buf('aa2420e2091c06001e001e220003050201000000000000000406003000640000020051bb')
const QUICK30_UNLOCKED = buf(
    'aa4220ec001c0a0000001e22000000000000000000400000040a0030006400000200001c0a0000001e22000000000000000000000000040a003000640000020019bb',
)
const QUICK30_OFF = buf(
    'aa4220ec001c0a0000001e22000000000000000000000000040a0030006400000200001c000000001e2200000000000000000000000001000030006400000200a0bb',
)
const COTTON_600_RPM = buf(
    'aa4220ec001c01020502050100030207010000000000000004010031006400000400001c01020602060100030307010000000000000004010031006400000400fcbb',
)
const COTTON_RINSE_PLUS = buf(
    'aa4220ec001c01020c020c0100030907010000000000000004010031006400000400001c01021902190100030907020000000000000004010031006400000500b9bb',
)
const COTTON_INTENSIVE = buf(
    'aa4220ec001c01020c020c0100030907010000000000000004010031006400000400001c0102270227010004090701000000000000000401003100640000040052bb',
)
const COTTON_PRE_WASH = buf(
    'aa4220ec001c01020c020c0100030907010000000000000004010031006400000400001c01021d021d010003090701000000400000000401003100640000050066bb',
)
const CHILD_LOCK_ON = buf(
    'aa4220ec001c01020c020c0100000000000000000000000004010031006400000000001c01020c020c010000000000000000008000000401003100640000000075bb',
)
const DELICATE_WASHING = buf(
    'aa4220ec001c01023a023a0100030904010000000042000003010032006400000400001c0600380038200003050302000000004200000106003200640000040074bb',
)
const BABY_CARE_SELECTED = buf(
    'aa4220ec001c01023a023a0100030904010000000042000003010033006400000400001c0104080408010003070602000000504200000501473300470000050073bb',
)
const SPIN_DELAY_5H = buf(
    'aa4220ec001c01000b000b1700000900000000000042000001017a33007a00000000001c03000b000b1700000900000005000042000001037a33007a0000000028bb',
)
const SPIN_DELAY_4H59 = buf(
    'aa4220ec001c03000b000b1700000900000005000042000001037a33007a00000000001c03000b000b17000009000000043b0042000001037a33007a0000000095bb',
)
const SPIN_CANCELLED = buf(
    'aa4220ec001c00000b000b1700000000000000000040000001007a33007a00000000001c00000b000b1700000000000000000000000001007a33007a000000004fbb',
)
const COURSE_DETAILS = buf(
    'aa4b20dc0301010004050607000000001000000000fd0000fdfdfd00fdfdfd0000fdfdfdfd00fd00fd00fdfdfd000004373304000b0200012102000478000000120c000006091a091a20bb',
)
const COUNT_51 = buf('aa0720d83389bb')
const STATUS_NOTIFICATION = buf('aa09207200000010bb')
const COTTON_DETECTING = buf(
    'aa4220ec001c01023a023a0100030904010000000042000003010031006400000400001c04023a023a01000309040100000000420000010400310064000004005dbb',
)
const COTTON_WASHING = buf(
    'aa4220ec001c04023a023a0100030904010000000042000001040031006400000400001c0601150115010003090401000000004200000106003100640000040091bb',
)
const COTTON_PAUSED = buf(
    'aa4220ec001c06011501150100030904010000000042000001060031006400000400001c0201150115010003090401000000004200000202003100640000040020bb',
)
const COTTON_RESUMED = buf(
    'aa4220ec001c02011501150100030904010000000042000002020031006400000400001c0601150115010003090401000000004200000106003100640000040020bb',
)
const ASLEEP = buf(
    'aa4220ec001c01023a023a0000000000000000000042000003010033007a00000401001c01023a023a0000000000000000000002000003010033007a0000040187bb',
)
const WAKE_ACK = buf('aa0820002a00a9bb')
const WAKE_REPORT = buf('aa08202b0100abbb')
const AWAKE = buf(
    'aa4220ec001c01023a023a0000000000000000000002000003010033007a00000401001c01000000000100000000000000000002000000010033007a0000000046bb',
)
const TUB_CLEAN_PAUSED = buf(
    'aa4220ec001c070019010c1200030100010000000042000006070033007a00000000001c020019010c1200030100010000000042000003020033007a00000200f0bb',
)
const TUB_CLEAN_END = buf(
    'aa4220ec001c080001010c1200000100000000000042000006080033007a00000200001c0a0000010c12000000000000000000400000060a0033007a00000200d5bb',
)
const COUNT_RESET = buf('aa0720d800fcbb')
const ASLEEP_AFTER_TUB_CLEAN = buf(
    'aa4220ec001c010000010c0000000000000000000042000003010000007a00000001001c010000010c0000000000000000000002000003010000007a00000001dbbb',
)
const QUICK30_NO_SPIN = buf(
    'aa4220ec001c01000000000100000000000000000002000000010000007a00000000001c01001500152200030102010000000002000000010000007a00000000d5bb',
)
const COUNT_INCREMENTED = buf('aa0720d801ffbb')

const BABY_STEAM_CARE = buf(
    'aa4220ec001c01022d022d2d00030906010000008000000004010031006400000500001c01023b023b2c0003070601000000900000000401003100640000040081bb',
)

const DUVET_COLD = buf(
    'aa4220ec001c01010c010c1200030106010000000000000003010031006400000200001c01012101210500030701010000000000000001010031006400000300a6bb',
)

// Native dial selections, with the names confirmed in LG state notifications.
const NATIVE_COURSES: [string, Buffer][] = [
    [
        'Cotton',
        buf(
            'aa4220ec001c01001e001e0100000000000000000000000001010031006400000000001c01023a023a010003090401000000000000000301003100640000040078bb',
        ),
    ],
    [
        'Cotton+',
        buf(
            'aa4220ec001c01023a023a0100030904010000000000000003010031006400000400001c01020f020f040003090601000000000000000301003100640000020078bb',
        ),
    ],
    [
        'Mix',
        buf(
            'aa4220ec001c01020f020f0400030906010000000000000003010031006400000200001c01011501150700030704010000000000000002010031006400000300b6bb',
        ),
    ],
    [
        'Easy Care',
        buf(
            'aa4220ec001c01011501150700030704010000000000000002010031006400000300001c01021502150200030904010000000000000002010031006400000300bebb',
        ),
    ],
    [
        'Silent Wash',
        buf(
            'aa4220ec001c01021502150200030904010000000000000002010031006400000300001c01021c021c0900030504010000000000000002010031006400000500a8bb',
        ),
    ],
    [
        'Allergy Care',
        buf(
            'aa4220ec001c01021c021c0900030504010000000000000002010031006400000500001c01022d022d2d000309060100000080000000040100310064000005008bbb',
        ),
    ],
    ['Baby Steam Care', BABY_STEAM_CARE],
    [
        'Rinse + Spin',
        buf(
            'aa4220ec001c01023b023b2c00030706010000009000000004010031006400000400001c01001000100e000309000100000000000000010164310064000001001bbb',
        ),
    ],
    [
        'Tub Clean',
        buf(
            'aa4220ec001c01001000100e00030900010000000000000001016431006400000100001c01010c010c12000301060100000000000000030100310064000002006ebb',
        ),
    ],
    ['Duvet', DUVET_COLD],
    [
        'Quick 30',
        buf(
            'aa4220ec001c01012101210500030701010000000000000001010031006400000300001c01001e001e220003050201000000000000000101003100640000020076bb',
        ),
    ],
    [
        'Sports Wear',
        buf(
            'aa4220ec001c01001e001e2200030502010000000000000001010031006400000200001c010034003408000305040100000000000000020100310064000002001ebb',
        ),
    ],
    [
        'Wool',
        buf(
            'aa4220ec001c01003400340800030504010000000000000002010031006400000200001c01002400241b0003050301000000000000000101003100640000030007bb',
        ),
    ],
    [
        'Delicate',
        buf(
            'aa4220ec001c01002400241b00030503010000000000000001010031006400000300001c01002d002d20000305020100000000000000010100310064000003000fbb',
        ),
    ],
]

// All 24 downloaded programmes, captured after selecting each one in the LG app.
const DOWNLOADED_COURSES: [string, Buffer][] = [
    [
        'Baby Care',
        buf(
            'aa4220ec001c01011c011c0500030201010000000042000001013a01003a00000300001c01040804080100030706020000005042000005014701004700000500debb',
        ),
    ],
    [
        'Blanket',
        buf(
            'aa4220ec001c01040804080100030706020000005042000005014701004700000500001c01011c011c0500030201010000000042000001013a01003a00000300debb',
        ),
    ],
    [
        'Cold Wash',
        buf(
            'aa4220ec001c01011c011c0500030201010000000042000001013a01003a00000300001c01031003100100030901010000000042000002014d01004d0000040018bb',
        ),
    ],
    [
        'Colour Protection',
        buf(
            'aa4220ec001c01031003100100030901010000000042000002014d01004d00000400001c01002d002d2000030502010000000042000001013f01003f00000300c3bb',
        ),
    ],
    [
        'Drain',
        buf(
            'aa4220ec001c01002d002d2000030502010000000042000001013f01003f00000300001c010001000117000001000000000000420000010179010079000000009bbb',
        ),
    ],
    [
        'Gym Clothes',
        buf(
            'aa4220ec001c01000100011700000100000000000042000001017901007900000000001c01002c002c0800030501010000000042000001013801003800000200f1bb',
        ),
    ],
    [
        'Hygiene',
        buf(
            'aa4220ec001c01002c002c0800030501010000000042000001013801003800000200001c01022d022d0a000309060100000080420000040148010048000005007ebb',
        ),
    ],
    [
        'Jeans',
        buf(
            'aa4220ec001c01022d022d0a00030906010000008042000004014801004800000500001c0100300030200003090201000000004200000101390100390000030006bb',
        ),
    ],
    [
        'Juice and Food Stains',
        buf(
            'aa4220ec001c01003000302000030902010000000042000001013901003900000300001c01030f030f0100030704010000004042000003016c01006c0000050046bb',
        ),
    ],
    [
        'Kids Wear',
        buf(
            'aa4220ec001c01030f030f0100030704010000004042000003016c01006c00000500001c010323032301000309060100000040420000040134010034000005004abb',
        ),
    ],
    [
        'Lightly Soiled Items',
        buf(
            'aa4220ec001c01032303230100030906010000004042000004013401003400000500001c01002200221b0003020201000000004200000101650100650000030055bb',
        ),
    ],
    [
        'Lingerie',
        buf(
            'aa4220ec001c01002200221b00030202010000000042000001016501006500000300001c01002d002d2000030502010000000042000001014a01004a0000030059bb',
        ),
    ],
    [
        'Minimize Detergent Residue',
        buf(
            'aa4220ec001c01002d002d2000030502010000000042000001014a01004a00000300001c01030b030b01000309040200000000420000030166010066000005008fbb',
        ),
    ],
    [
        'Noise Minimize',
        buf(
            'aa4220ec001c01030b030b0100030904020000000042000003016601006600000500001c01021d021d0900030704010000000042000002014001004000000500cfbb',
        ),
    ],
    [
        'Quick Tub Clean',
        buf(
            'aa4220ec001c01021d021d0900030704010000000042000002014001004000000500001c0100120012300003020100000000004200000101710100710000010080bb',
        ),
    ],
    [
        'Rainy Season',
        buf(
            'aa4220ec001c01001200123000030201000000000042000001017101007100000100001c01023a023a0100030904010000000042000003013701003700000400a2bb',
        ),
    ],
    [
        'Rinse + Spin',
        buf(
            'aa4220ec001c01023a023a0100030904010000000042000003013701003700000400001c01001000100e00030900010000000042000001016401006400000100ebbb',
        ),
    ],
    [
        'Single Garment',
        buf(
            'aa4220ec001c01001000100e00030900010000000042000001016401006400000100001c01001e001e2200030502010000000042000001013e01003e00000200f2bb',
        ),
    ],
    [
        'Skin Care',
        buf(
            'aa4220ec001c01001e001e2200030502010000000042000001013e01003e00000200001c01031f031f0100030904020000001042000004014c01004c00000500ffbb',
        ),
    ],
    [
        'Sleeve Hems and Collars',
        buf(
            'aa4220ec001c01031f031f0100030904020000001042000004014c01004c00000500001c01032303230100030706010000004042000004016b01006b000005006abb',
        ),
    ],
    [
        'Small Load',
        buf(
            'aa4220ec001c01032303230100030706010000004042000004016b01006b00000500001c01001e001e220003050201000000004200000101490100490000020060bb',
        ),
    ],
    [
        'Spin',
        buf(
            'aa4220ec001c01001e001e2200030502010000000042000001014901004900000200001c01000b000b1700000900000000000042000001017a01007a00000000b6bb',
        ),
    ],
    [
        'Sweat Stain',
        buf(
            'aa4220ec001c01000b000b1700000900000000000042000001017a01007a00000000001c01023a023a0100030904010000000042000003013b01003b00000400b9bb',
        ),
    ],
    [
        'Swimming Wear',
        buf(
            'aa4220ec001c01023a023a0100030904010000000042000003013b01003b00000400001c01002200221b00030202010000000042000001013601003600000300cdbb',
        ),
    ],
]

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, props: ha.devices[DEVICE_ID].properties }
}

describe(MODEL_ID, () => {
    test('the bridge selects this handler and routes Home Assistant commands', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        assert.ok(bridge.haDevices.get(DEVICE_ID) instanceof DUT)
        assert.equal(thinq.outbox.length, 0) // No unverified status query on connect.
        ha.setProperty(DEVICE_ID, 'pause', 'command', 'PRESS')
        assert.deepEqual(thinq.outbox, [buf('aa09f02404010099bb')])
    })

    test('Cotton settings decode from the current record', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', COTTON_READY)
        assert.equal(props.status, 'Standby')
        assert.equal(props.power, 'ON')
        assert.equal(props.course, 'Cotton')
        assert.equal(props.downloaded_course, 'Rinse + Spin')
        assert.equal(props.spin, '1200 rpm')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.rinse, 'Normal')
        assert.equal(props.wash_mode, 'Normal')
        assert.equal(props.remaining_time, 178)
        assert.equal(props.initial_time, 178)
        assert.equal(props.tub_clean_count, 48)
        assert.equal(props.door_lock, 'ON') // HA lock class: ON = unlocked.
    })

    test('native dial selections use this model’s course codes', () => {
        const { thinq, props } = makeDevice()
        for (const [name, packet] of NATIVE_COURSES) {
            thinq.emit('data', packet)
            assert.equal(props.course, name)
        }
    })

    test('all captured downloaded programmes decode and are accepted by Start/Resume', () => {
        const { thinq, dev, props } = makeDevice()
        for (const [name, packet] of DOWNLOADED_COURSES) {
            thinq.emit('data', packet)
            assert.equal(props.course, name)
            assert.equal(props.downloaded_course, name)
            thinq.resetRecorder()
            dev.setProperty('start', 'PRESS')
            dev.setProperty('resume', 'PRESS')
            assert.equal(thinq.outbox.length, 2, name)
        }
    })

    test('spin, rinse, soil level and option changes follow the panel', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', COTTON_600_RPM)
        assert.equal(props.spin, '600 rpm')
        assert.equal(props.temp, '95 °C')
        thinq.emit('data', COTTON_RINSE_PLUS)
        assert.equal(props.rinse, 'Rinse+')
        thinq.emit('data', COTTON_INTENSIVE)
        assert.equal(props.wash_mode, 'Intensive')
        thinq.emit('data', COTTON_PRE_WASH)
        assert.equal(props.pre_wash, 'ON')
        thinq.emit('data', CHILD_LOCK_ON)
        assert.equal(props.child_lock, 'ON')
        thinq.emit('data', BABY_CARE_SELECTED)
        assert.equal(props.child_lock, 'OFF')
        assert.equal(props.pre_wash, 'ON')
        assert.equal(props.medic_rinse, 'ON')
        assert.equal(props.steam, 'OFF')
        // Baby Steam Care has steam + medic rinse, with pre-wash off.
        thinq.emit('data', BABY_STEAM_CARE)
        assert.equal(props.steam, 'ON')
        assert.equal(props.medic_rinse, 'ON')
        assert.equal(props.pre_wash, 'OFF')
    })

    test('Cold, No spin and Not selected remain distinct settings', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', DUVET_COLD) // Duvet selected cold.
        assert.equal(props.temp, 'Cold')
        thinq.emit('data', QUICK30_NO_SPIN)
        assert.equal(props.spin, 'No spin')
        assert.equal(props.temp, '20 °C')
        thinq.emit('data', QUICK30_RINSING)
        assert.equal(props.temp, 'Not selected')
    })

    test('Quick 30 progresses through washing, rinsing, spinning, end and off', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', QUICK30_SELECTED)
        assert.equal(props.course, 'Quick 30')
        assert.equal(props.remaining_time, 30)
        thinq.emit('data', QUICK30_WASHING)
        assert.equal(props.status, 'Washing')
        assert.equal(props.door_lock, 'OFF')
        thinq.emit('data', QUICK30_RINSING)
        assert.equal(props.status, 'Rinsing')
        assert.equal(props.remaining_time, 18)
        thinq.emit('data', QUICK30_SPINNING)
        assert.equal(props.status, 'Spinning')
        assert.equal(props.remaining_time, 10)
        assert.equal(props.initial_time, 30)
        thinq.emit('data', QUICK30_END)
        assert.equal(props.status, 'End')
        assert.equal(props.completed, 'ON')
        assert.equal(props.remaining_time, 0)
        const beforeAlert = { ...props }
        thinq.emit('data', END_ALERT)
        assert.deepEqual(props, beforeAlert) // E2 has another layout, despite its 30-byte payload.
        thinq.emit('data', QUICK30_UNLOCKED)
        assert.equal(props.door_lock, 'ON')
        thinq.emit('data', QUICK30_OFF)
        assert.equal(props.status, 'Off')
        assert.equal(props.power, 'OFF')
        assert.equal(props.completed, 'OFF')
        assert.equal(thinq.outbox.length, 0)
    })

    test('load detection updates the initial time when washing begins', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', COTTON_DETECTING)
        assert.equal(props.status, 'Detecting')
        assert.equal(props.initial_time, 178)
        thinq.emit('data', COTTON_WASHING)
        assert.equal(props.status, 'Washing')
        assert.equal(props.initial_time, 81)
        assert.equal(props.remaining_time, 81)
    })

    test('D8 reports the cleaning counter without changing the door lock', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', TUB_CLEAN_END)
        assert.equal(props.course, 'Tub Clean')
        assert.equal(props.status, 'End')
        assert.equal(props.tub_clean_count, 51)
        assert.equal(props.door_lock, 'OFF')
        thinq.emit('data', COUNT_RESET)
        assert.equal(props.tub_clean_count, 0)
        assert.equal(props.door_lock, 'OFF')
        thinq.emit('data', ASLEEP_AFTER_TUB_CLEAN)
        assert.equal(props.standby, 'ON')
        assert.equal(props.remote_start, 'ON')
        thinq.emit('data', COUNT_INCREMENTED)
        assert.equal(props.tub_clean_count, 1)
    })

    test('delivery acknowledgements match the captured bridge', () => {
        const { thinq, props } = makeDevice()
        thinq.emit('data', COTTON_READY)
        const baseline = { ...props }
        thinq.emit('data', STATUS_NOTIFICATION)
        thinq.emit('data', END_ALERT)
        thinq.emit('data', COURSE_DETAILS)
        assert.deepEqual(props, baseline)
        thinq.emit('data', COUNT_51)
        assert.equal(props.tub_clean_count, 51)
        assert.deepEqual(
            thinq.sent.map(({ cmd, data }) => [cmd, data]),
            [
                ['ack', 'AA08F00072044DBB'],
                ['ack', 'AA08F000E204DDBB'],
                ['ack', 'AA08F000DC04D7BB'],
                ['ack', 'AA08F000D8042BBB'],
            ],
        )
        assert.equal(thinq.outbox.length, 0)
    })

    test('Wake up uses the captured command and waits for the awake status report', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', ASLEEP)
        assert.equal(props.status, 'Standby')
        assert.equal(props.standby, 'ON')
        assert.equal(props.remote_start, 'ON')
        dev.setProperty('wake_up', 'PRESS')
        assert.deepEqual(thinq.outbox, [buf('aa08f02a010098bb')])
        thinq.emit('data', WAKE_ACK)
        thinq.emit('data', WAKE_REPORT)
        assert.equal(props.standby, 'ON')
        thinq.emit('data', AWAKE)
        assert.equal(props.status, 'Standby')
        assert.equal(props.standby, 'OFF')
        assert.equal(props.remote_start, 'ON')
        assert.equal(thinq.outbox.length, 1) // Waking never queues a wash.
    })

    test('Start reproduces LG’s captured settings and initial flags', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', DELICATE_WASHING)
        dev.setProperty('start', 'PRESS')
        thinq.emit('data', QUICK30_NO_SPIN)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [
            buf('aa16f0262003050302000000000003000000000053bb'),
            buf('aa16f0262203010201000000000003000000000057bb'),
        ])
    })

    test('Pause and Resume reproduce the captured Cotton and Tub Clean commands', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', COTTON_WASHING)
        dev.setProperty('pause', 'PRESS')
        assert.equal(props.status, 'Washing')
        thinq.emit('data', COTTON_PAUSED)
        assert.equal(props.status, 'Paused')
        dev.setProperty('resume', 'PRESS')
        assert.equal(props.status, 'Paused')
        thinq.emit('data', COTTON_RESUMED)
        assert.equal(props.status, 'Washing')
        thinq.emit('data', TUB_CLEAN_PAUSED)
        dev.setProperty('resume', 'PRESS')
        assert.deepEqual(thinq.outbox, [
            buf('aa09f02404010099bb'),
            buf('aa16f02601030904010000000000020000000000bfbb'),
            buf('aa16f02612030100010000000000020000000000babb'),
        ])
    })

    test('Start and Resume retain downloaded settings and use their distinct control flags', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', BABY_CARE_SELECTED)
        dev.setProperty('start', 'PRESS')
        dev.setProperty('resume', 'PRESS')
        // Expected encoding from the captured Baby Care settings: base Cotton, 1000 rpm,
        // 60 °C, Rinse+, pre-wash + medic rinse, downloaded code 71. These commands are
        // encoding regressions, not additional captures of Start/Resume for Baby Care.
        assert.deepEqual(
            thinq.outbox.map((p) => p.subarray(2, -2)),
            [buf('f02601030706020000000050030047000000'), buf('f02601030706020000000050020047000000')],
        )
    })

    test('delay counts down; Resume retains it and Start clears it', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', SPIN_DELAY_5H)
        assert.equal(props.status, 'Delayed')
        assert.equal(props.course, 'Spin')
        assert.equal(props.delay_remaining, 300)
        assert.equal(props.initial_time, 11)
        thinq.emit('data', SPIN_DELAY_4H59)
        assert.equal(props.delay_remaining, 299)
        dev.setProperty('resume', 'PRESS')
        dev.setProperty('start', 'PRESS')
        // Encoding regression based on a real delayed report, not captured delayed Resume.
        assert.deepEqual(
            thinq.outbox.map((p) => p.subarray(2, -2)),
            [buf('f026170009000000043b000002007a000000'), buf('f0261700090000000000000003007a000000')],
        )
    })

    test('Power off matches LG’s cancellation and changes state only on a report', () => {
        const { thinq, dev, props } = makeDevice()
        thinq.emit('data', SPIN_DELAY_5H)
        dev.setProperty('power_off', 'PRESS')
        assert.deepEqual(thinq.outbox, [buf('aa09f0240101009cbb')])
        assert.equal(props.status, 'Delayed')
        thinq.emit('data', SPIN_CANCELLED)
        assert.equal(props.status, 'Off')
        assert.equal(props.delay_remaining, 0)
    })

    test('unsupported commands and non-press payloads send nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', COTTON_READY)
        dev.setProperty('download', 'PRESS')
        dev.setProperty('start', 'ON')
        dev.setProperty('wake_up', 'ON')
        assert.equal(thinq.outbox.length, 0)
    })

    test('Start and Resume need current settings, and reject unknown encoding', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('start', 'PRESS')
        dev.setProperty('resume', 'PRESS')
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', COTTON_READY)
        // Deliberately changed course byte exercises command validation, not sensor decoding.
        const unknownCourse = Buffer.from(COTTON_READY)
        unknownCourse[41] = 255
        thinq.emit('data', unknownCourse)
        dev.setProperty('start', 'PRESS')
        dev.setProperty('resume', 'PRESS')
        assert.equal(thinq.outbox.length, 0)
        thinq.emit('data', COTTON_READY)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox.length, 1)
    })

    test('a reconnect does not reuse the previous connection’s settings', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        const oldDevice = bridge.haDevices.get(DEVICE_ID)!
        thinq.emit('data', COTTON_READY)
        thinq.emit('close')
        assert.equal(ha.devices[DEVICE_ID].availability, 'offline')
        oldDevice.setProperty('power_off', 'PRESS')
        assert.equal(thinq.outbox.length, 0)
        const next = new MockThinq2Device(DEVICE_ID, META)
        bridge.newDevice(next)
        ha.setProperty(DEVICE_ID, 'start', 'command', 'PRESS')
        assert.equal(next.outbox.length, 0)
        next.emit('data', QUICK30_NO_SPIN)
        ha.setProperty(DEVICE_ID, 'start', 'command', 'PRESS')
        assert.deepEqual(next.outbox, [buf('aa16f0262203010201000000000003000000000057bb')])
    })

    test('rejected commands are logged without changing state or retrying', () => {
        const { thinq, dev, props } = makeDevice()
        const log = captureLog()
        try {
            thinq.emit('data', COTTON_READY)
            dev.setProperty('power_off', 'PRESS')
            const before = { ...props }
            // Captured success reply with the result changed to exercise rejection logging.
            thinq.emit('data', buf('aa0820002401a2bb'))
            assert.equal(log.calls.length, 1)
            assert.deepEqual(props, before)
            assert.equal(thinq.outbox.length, 1)
        } finally {
            log.restore()
        }
    })
})
