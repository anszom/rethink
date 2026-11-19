import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/T17A1EFHU_F'
import AABBDevice from '@/cloud/devices/aabb_device'
import Bridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'T17A1EFHU_F'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WT7305CV', swVersion: '' }

// Long AABB envelopes contain one 29-byte record for EB, or old/current records for EC.
// Fixtures combine the local query reply below with the handoff's WT7305CV captures from
// 2026-11-01, 14:38-15:59 UTC. The handoff identifies the panel selections for those logs.

// Live WT7305CV reply after sending AA0EF0ED1121010000001800B5BB through the local Monitor.
// EB contains a single 29-byte snapshot: standby on Heavy Duty, 1:37, Heavy/High/Warm.
const STATUS_REPLY = buf(
    'aaff200a002f006dc1000100eb001d000001012504350200050304000000000000000000000000007b0000005a57bb',
)

// Dial on Pre Wash+Normal at its defaults: 1:24, Normal/High/Warm, Turbo Wash on.
const PREWASH_NORMAL = buf(
    'AAFF200A004C0067D7000100EC003A000001003B003B0000000000000000000080000000000000007B000000000001011804282900030304000000004000000000000000007B000000DFEDBB',
)
// Dial turned to Heavy Duty: 1:37, Heavy/High/Warm (the defaults the WT7300CW driver documents for
// Heavy Duty), Turbo Wash off. The old record is the Pre Wash+Normal state just above.
const HEAVY_DUTY = buf(
    'AAFF200A004C0067F7000100EC003A000001011804282900030304000000004000000000000000007B000000000001012504350200050304000000000000000000000000007B000000512ABB',
)
// Remote Start held on Heavy Duty: record byte 18 changes first, then the lid locks a frame later.
// Remote Start is then switched off again.
const REMOTE_ARMED = buf(
    'AAFF200A004C0067FA000100EC003A000001012504350200050304000000000000000000000000007B000000000001012504350200050304000000000000010000000000007B0000002463BB',
)
const REMOTE_LOCKED = buf(
    'AAFF200A004C0067FB000100EC003A000001012504350200050304000000000000010000000000007B000000000001012504350200050304000000000400010000000000007B000000B7D9BB',
)
const REMOTE_DISARMED = buf(
    'AAFF200A004C006806000100EC003A000001012504350200050304000000000400010000000000007B000000000001012504350200050304000000000000000000000000007B000000E0C9BB',
)
// Dial turned to Normal: 0:59, Normal/High/Warm, Turbo Wash on by default. The OLD record is still
// Heavy Duty, so this frame also shows that the current state is the LAST record.
const NORMAL = buf(
    'AAFF200A004C006818000100EC003A000001012504350200050304000000000000000000000000007B000000000001003B003B0100030304000000004000000000000000007B000000C405BB',
)
// Start pressed on Normal (Detecting, lid locked), then Pause, then the paused cycle is cancelled.
const DETECTING = buf(
    'AAFF200A004C006821000100EC003A000001003B003B0100030304000000004000000000000000007B000000000003003B003B0100030304000000004400000000010000007B0000008A2ABB',
)
const PAUSED = buf(
    'AAFF200A004C00682D000100EC003A000003003B003B0100030304000000004400000000010000007B000001000002003B003B0100030304000000004400000000030000007B0000015228BB',
)
const CANCELLED = buf(
    'AAFF200A004C006833000100EC003A000002003B003B0100030304000000004400000000030000007B000001000001003B003B0100030304000000004000000000020000007B0000019B2BBB',
)
// Normal temperature changed from Warm to Hot at 14:47:40, before selecting Deep Wash.
const NORMAL_HOT = buf(
    'AAFF200A004C006856000100EC003A000001003B003B0100030304000000004000000000020000007B000001000001003B003B0100030305000000004000000000020000007B000001C4D9BB',
)

// ── One full Deep Wash cycle with Extra Rinse, Medium spin and Cold ──────────────────────────────
const DEEP_WASH_STARTED = buf(
    'AAFF200A004C00685B000100EC003A000001003B003B0100030305000000004000000000020000007B000001000003011204221900030202020000000401000000010000007B0000007610BB',
)
const WASHING = buf(
    'AAFF200A004C00688A000100EC003A000005010304151900030202020000000405000000030000007B000001000005010204151900030202020000000405000000030000007B000001DED9BB',
)
const RINSING = buf(
    'AAFF200A004C006A02000100EC003A000005002A04151900030202020000000401000000030000007B00001F000006002A04151900000202020000000401000000050000007B00001F0D03BB',
)
const SPINNING = buf(
    'AAFF200A004C006BAF000100EC003A000006000B04151900000202020000000401000000050000007B00002F000007000B04151900000200020000000401000000060000007B00002F820EBB',
)
const END = buf(
    'AAFF200A004C006C69000100EC003A000007000104151900000200020000000401000000060000007B00003C000008000104151900000200020000000001000002070000007B00003C2186BB',
)
// 0xE2 settings echo, two seconds after END. Its record is the cycle's STARTING state (Detecting,
// 1:18 remaining). Decoding it would put a finished machine back at the start of its wash.
const E2_AFTER_END = buf(
    'AAFF200A002F006C6A00010AE2001D000003011204221900030202020000000001000002010000007B00003C2442BB',
)

// Frames that carry no status: the settings sync after a dial change, the Remote Start echo
// (20 72 00 C9 = on), and the heartbeat.
const SETTINGS_SYNC = buf(
    'AAFF200A005B006815000101030049010A010301F80103018A1800000800020003030104000002003B003B0000007B21010201040103010301030103010301030103010301030103013901030139010401040104010401033F6EBB',
)
// Periodic telemetry at 14:52:30 has 58 payload bytes too, but its envelope type is 0x02, not 0xEC.
const PERIODIC_DATA = buf(
    'AAFF200A004C00689C00010102003A0A010365FD0503018B33000401010501020000222A29272522290F0F0F0F0F0F0F472E3D45474735012C001E01580037000000010000000000019771BB',
)
const REMOTE_ECHO = buf('AA09207200C9005BBB')
const HEARTBEAT = buf('AA0720D82D83BB')

// Local command test on WT7305CV: this packet physically started Heavy Duty with Heavy soil,
// High spin and Warm water. START_ACK and START_SETTINGS_SYNC are the owner's captured replies.
const START_COMMAND = buf('AA15F026020503040000000000000000000003B3BB')
const START_ACK = buf('aa0820002600adbb')
const START_SETTINGS_SYNC = buf(
    'aaff200a005b006de4000101030049010a0103011a0103018c1800000800020203040104000000012501250000007b30023b01040104010100000000000000000000000000000000000000000000000000000000000000009fd3bb',
)
// Status query after the owner confirmed that AA09F02404010099BB paused the Heavy Duty cycle.
const LOCAL_PAUSED = buf(
    'aaff200a002f006e54000100eb001d000002011204260200050304000000000000000000050000007b000002b0d5bb',
)
// Sent from the LOCAL_PAUSED settings; the owner confirmed that the washer resumed. The reply
// was START_ACK again, followed by this periodic telemetry (not an EB/EC status record).
const RESUME_COMMAND = buf('aa15f026020503040000000000000000000001b1bb')
const RESUME_TELEMETRY = buf(
    'aaff200a004c006e7400010102003a0a0103651f0203018c3300050201160112000028322f30302f2e0f0f0f0f0f0f0f47343737363937019400000158003700000001000000000002d5ccbb',
)
// The owner confirmed this command powered off the washer. Neither reply contains a status record.
const POWER_OFF_COMMAND = buf('aa09f0240101009cbb')
const POWER_OFF_ACK = buf('aa0820002400a3bb')
const POWER_OFF_SETTINGS_SYNC = buf('aaff200a0022006e9e0001010300100e0a01030e210503018c0800070000046dd9bb')

// The panel was set to Heavy Duty / Warm. The owner confirmed that this command started it with
// Cold instead, and the following status query reports Heavy / High / Cold in Detecting (1:46).
const COLD_START_COMMAND = buf('AA15F026020503020000000000000000000003B1BB')
const COLD_START_SETTINGS_SYNC = buf(
    'aaff200a005b006f44000101030049010a010301250103018d1800000800020202040104000000012e012e0000007b3a023b0139010401040101023f00000000000000000000000000000000000000000000000000000000a120bb',
)
const COLD_START_STATUS = buf(
    'aaff200a002f006f51000100eb001d000003012e05020200050302000000000400010000010000007b000000db2fbb',
)
// Remote Start armed on Normal / High / Warm / Turbo Wash, immediately before the next test.
const LOCAL_NORMAL_ARMED = buf(
    'aaff200a002f006f75000100eb001d000001003b003b0100030304000000004400010000000000007b0000011823bb',
)
// This command changed that selection to Deep Wash / Medium / Cold / Extra Rinse. The owner
// confirmed the panel settings, and the query reply reports Washing with those same settings.
const DEEP_WASH_COMMAND = buf('AA15F026190302020200000000000000000103AEBB')
const DEEP_WASH_SETTINGS_SYNC = buf(
    'aaff200a005b006f7a000101030049010a010301270103018e1800000800020a02030303000040012501250000007b3f023b013901040101010100000000000000000000000000000000000000000000000000000000000067babb',
)
const LOCAL_DEEP_WASH = buf(
    'aaff200a002f006f89000100eb001d000005011104211900030202040000000405010000030000007b000000acf9bb',
)
// Sent with Heavy Duty selected at the panel. The reply confirms Normal / Normal soil / High /
// Warm with Turbo Wash on and Extra Rinse off, verifying soil selection and the Turbo Wash flag.
const NORMAL_TURBO_COMMAND = buf('AA15F02601030304000000000000000040000376BB')
const NORMAL_TURBO_SETTINGS_SYNC = buf(
    'aaff200a005b006fc2000101030049010a010301290103018f1800000800020003030104000002003b003b0000007b4b023b013901040101010101020102010201030102010201020000000000000000000000000000000009a9bb',
)
const NORMAL_TURBO_STATUS = buf(
    'aaff200a002f006fc3000100eb001d000003003b003b0100030304000000004400010000010000007b000001bc58bb',
)

// Local downloads while idle on Downloaded. F025 writes the slot without starting a wash.
const DOWNLOAD_ACK = buf('AA0820002500A2BB')
const SMALL_LOAD_COMMAND = buf('AA17F025030F010102040000000000000064400000C1BB')
const SMALL_LOAD_UPDATE = buf(
    'aaff200a004c0072f5000100ec003a000001011e042e0100030404020000004001000000007b00007b000000000001003b003b010001020400000000400000000000640000640000008c35bb',
)
const SMALL_LOAD_STATUS = buf(
    'aaff200a002f0072fc000100eb001d000001003b003b010001020400000000400000000000640000640000002eb3bb',
)
// Command rinse values 2 and 1 produced status rinse bytes 4 and 2, both while in Standby.
// Requesting options 0x21 without data[8] did NOT turn Soak on; these captures report it off.
const JUICE_TWO_RINSES = buf(
    'aaff200a002f007327000100eb001d000001020608260200050305040000004001000000007400007400000025aebb',
)
const JUICE_ONE_RINSE = buf(
    'aaff200a002f007347000100eb001d000001012b043b02000503050200000040010000000074000074000000eebebb',
)
// Turning Soak on at the panel changes options 0x01 -> 0x21 and byte 26 from 0 to 1.
const PANEL_SOAK_UPDATE = buf(
    'aaff200a004c007381000100ec003a000001012b043b02000503050200000040010000000074000074000000000001020d082d0200050305020000004021000000007400007401000090b5bb',
)
const PANEL_SOAK_STATUS = buf(
    'aaff200a002f007386000100eb001d000001020d082d02000503050200000040210000000074000074010000c99bbb',
)
// Re-sending the download with options 0x21 but data[8]=0 clears panel-selected Soak.
const DOWNLOAD_CLEARS_SOAK = buf(
    'aaff200a004c0073d2000100ec003a000001020d082d02000503050200000040210000000074000074010000000001012b043b02000503050200000040010000000074000074000000400fbb',
)

// F026 with options 0x20 was also accepted without enabling Soak. A successful Start ACK
// cannot be used as confirmation that an option was applied.
const START_IGNORES_SOAK = buf(
    'aaff200a002f007438000100eb001d000003003b003b01000303040000000044000100000100000074000000fd89bb',
)
// Collar Stains download physically enabled Stain Care. The appliance overrides requested
// Turbo Wash/Warm/no-rinse to Turbo off/Semi Warm/one rinse, matching its panel behaviour.
const COLLAR_STAINS_COMMAND = buf('AA17F025030F02050304000000000000006E400800F9BB')
const COLLAR_STAINS_UPDATE = buf(
    'aaff200a004c00745d000100ec003a000001003b003b01000303040000000040000000000000000074000000000001011504250200050303020000000008000000006e00006e0000006a7abb',
)
const COLLAR_STAINS_STATUS = buf(
    'aaff200a002f007463000100eb001d000001011504250200050303020000000008000000006e00006e000000e13dbb',
)
// Complete labelled Special Care sweep: Soak, Stain Care, Speed Wash, Rinse+Spin, Off.
const SPECIAL_CARE_SWEEP = [
    'aaff200a004c00740c000100ec003a000001003b003b01000303040000000040000000000000000074000000000001011d042d01000303040000000040200000000000000074010000135dbb',
    'aaff200a004c007410000100ec003a000001011d042d01000303040000000040200000000000000074010000000001011f042f0100030303020000000008000000000000007400000062c9bb',
    'aaff200a004c007412000100ec003a000001011f042f01000303030200000000080000000000000074000000000001001e001e07000103040000000040000000000000000074000000e8cebb',
    'aaff200a004c007414000100ec003a000001001e001e070001030400000000400000000000000000740000000000010021002111000003010000000000000000000000000074000000a957bb',
    'aaff200a004c007415000100ec003a0000010021002111000003010000000000000000000000000074000000000001003b003b0100030304000000004000000000000000007400000004cfbb',
].map(buf)

// Labelled panel captures: Deep Fill from Normal selects Deep Wash; Delay Wash 1 h then 2 h.
const DEEP_FILL_FROM_NORMAL = buf(
    'aaff200a004c0074a8000100ec003a000001003b003b010003030400000000400000000000000000740000000000010039003919000302040000000000020000000000000074000000655fbb',
)
const DELAY_ONE_HOUR = buf(
    'aaff200a004c0074ba000100ec003a0000010039003919000302040000000000020000000000000074000000000001003900391900030204000001000002000000000000007400000002a1bb',
)
const DELAY_TWO_HOURS = buf(
    'aaff200a004c0074bf000100ec003a000001003900391900030204000001000002000000000000007400000000000100390039190003020400000200000200000000000000740000002c36bb',
)

// F025 with Deep Fill enabled and reserveHour=2: Deep Fill took effect, delay did not.
const DOWNLOAD_DEEP_FILL_STATUS = buf(
    'aaff200a002f0074e1000100eb001d000001003b003b01000102040000000040020000000064000064000000539fbb',
)
// F026 with that same proposed delay field physically started immediately, without a delay.
const START_IGNORES_DELAY = buf(
    'aaff200a002f007512000100eb001d000003003b003b0100030304000000004400010000010000007400000079ecbb',
)

// LG cloud -> washer: downloading Sweat Stains sets data[8] as well as options bit 0x20.
// This enabled Soak where the earlier bit-only requests failed.
const SWEAT_STAINS_COMMAND = buf('aa17f025030f020303040000000001000069402000ebbb')
const SWEAT_STAINS_UPDATE = buf(
    'aaff200a004c00759d000100ec003a000001011804282900030304000000004000000000000000007400000100000101300504020003030400000000402000000000690000690100015180bb',
)

// LG Start with Sweat Stains, Soak, and a two-hour Delay Wash. The reply enters phase 9.
const SOAK_DELAY_ARMED = buf(
    'aaff200a004c0075ae000100ec003a00000101300504020003030400000200402001000000690000690100010000010130050402000303040000020044200100000069000069010001cc01bb',
)
const SOAK_DELAY_START_COMMAND = buf('aa15f026020303040000000001020069402003e5bb')
const SOAK_DELAY_STARTED = buf(
    'aaff200a004c0075ba000100ec003a0000010130050402000303040000020044200100000069000069010001000009013005040200030304000002004420010000016900006901000102f7bb',
)

// Deep Wash: hold Deep Fill for Max, then hold Signal to enable and disable Control Lock.
const MAX_FILL_ON = buf(
    'aaff200a004c0075fe000100ec003a00000100390039190003020400000000000000000002000000690000000000010039003919000302040000000000000800000200000069000000b5e7bb',
)
const CONTROL_LOCK_ON = buf(
    'aaff200a004c007605000100ec003a0000010039003919000302040000000000000800000200000069000000000001003900391900030204000000000100080000020000006900000031f4bb',
)
const CONTROL_LOCK_OFF = buf(
    'aaff200a004c007607000100ec003a000001003900391900030204000000000100080000020000006900000000000100390039190003020400000000000008000002000000690000004322bb',
)

// LG's Start with Max adds 0x08 to the final command byte. The appliance consumes/clears the
// reported Max flag as it starts; do not keep publishing it as enabled after this real report.
const MAX_FILL_ARMED = buf(
    'aaff200a004c00761a000100ec003a0000010039003919000302040000000000000900000200000069000000000001003900391900030204000000000400090000020000006900000032c3bb',
)
const MAX_FILL_START_COMMAND = buf('aa15f02619030204000000000000000000000b57bb')
const MAX_FILL_STARTED = buf(
    'aaff200a004c007622000100ec003a00000100390039190003020400000000040009000002000000690000000000030039003919000302040000000004000100000100000069000000b078bb',
)
const COLD_WASH_ON = buf(
    'aaff200a004c007635000100ec003a000001003b003b01000303040000000040000000000000000069000000000001011c042c01000303020000000020000000000000000069000000df63bb',
)

// LG's Normal + Cold Wash Start: Cold temperature, Turbo Wash off, option flag 0x20.
const COLD_WASH_ARMED = buf(
    'aaff200a004c007648000100ec003a000001011c042c01000303020000000020000100000000000069000000000001011c042c01000303020000000024000100000000000069000000c261bb',
)
const COLD_WASH_COMMAND = buf('aa15f02601030302000000000000000020000354bb')
const COLD_WASH_STARTED = buf(
    'aaff200a004c00765c000100ec003a000001011c042c01000303020000000024000100000000000069000000000003011c042c010003030200000000240001000001000000690000008d6bbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe(MODEL_ID, () => {
    test('the bridge requests a snapshot on connect and decodes the captured reply', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        assert.ok(bridge.haDevices.get(DEVICE_ID) instanceof DUT)
        assert.deepEqual(thinq.outbox, [buf('AA0EF0ED1121010000001800B5BB')])
        thinq.emit('data', STATUS_REPLY)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.remaining_time, 97)
        assert.equal(p.soil, 'Heavy')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.turbo_wash, 'OFF')
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.door_lock, 'ON')
        assert.equal(p.remote_start, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].config?.device.model, 'WT7305CV')
    })

    test('the current state is the last record of the envelope', () => {
        // old record Heavy Duty, current record Normal
        const p = feed([NORMAL])
        assert.equal(p.course, 'Normal')
        assert.equal(p.remaining_time, 59)
    })

    test('status retransmissions and settings sync are acknowledged by sequence number', () => {
        // unacked, this washer repeats each envelope every ~1.6 s
        const { thinq } = makeDevice()
        thinq.emit('data', NORMAL)
        thinq.emit('data', NORMAL)
        thinq.emit('data', SETTINGS_SYNC)
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, [
            AABBDevice.frame(buf('f0000a046818')).toString('hex').toUpperCase(),
            AABBDevice.frame(buf('f0000a046818')).toString('hex').toUpperCase(),
            AABBDevice.frame(buf('f0000a046815')).toString('hex').toUpperCase(),
        ])
    })

    test('dial selections decode their captured settings', () => {
        const prewash = feed([PREWASH_NORMAL])
        assert.equal(prewash.course, 'Pre Wash+Normal')
        assert.equal(prewash.remaining_time, 84)
        assert.equal(prewash.turbo_wash, 'ON')

        const heavy = feed([HEAVY_DUTY])
        assert.equal(heavy.course, 'Heavy Duty')
        assert.equal(heavy.remaining_time, 97)
        assert.equal(heavy.soil, 'Heavy')
        assert.equal(heavy.spin, 'High')
        assert.equal(heavy.temp, 'Warm')
        assert.equal(heavy.turbo_wash, 'OFF')

        const normal = feed([NORMAL])
        assert.equal(normal.power, 'ON')
        assert.equal(normal.status, 'Standby')
        assert.equal(normal.soil, 'Normal')
        assert.equal(normal.spin, 'High')
        assert.equal(normal.temp, 'Warm')
        assert.equal(normal.turbo_wash, 'ON')
        assert.equal(normal.extra_rinse, 'OFF')

        assert.equal(feed([NORMAL_HOT]).temp, 'Hot')
    })

    test('Deep Wash with Extra Rinse, Medium spin and Cold', () => {
        const p = feed([DEEP_WASH_STARTED])
        assert.equal(p.status, 'Detecting')
        assert.equal(p.course, 'Deep Wash')
        assert.equal(p.remaining_time, 78)
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'Medium')
        assert.equal(p.temp, 'Cold')
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.turbo_wash, 'OFF')
    })

    test('remote start arms first, the lid locks a frame later, and both clear together', () => {
        const armed = feed([REMOTE_ARMED])
        assert.equal(armed.remote_start, 'ON')
        assert.equal(armed.door_lock, 'ON') // device_class lock: ON = unlocked

        const locked = feed([REMOTE_LOCKED])
        assert.equal(locked.remote_start, 'ON')
        assert.equal(locked.door_lock, 'OFF')

        const disarmed = feed([REMOTE_DISARMED])
        assert.equal(disarmed.remote_start, 'OFF')
        assert.equal(disarmed.door_lock, 'ON')
    })

    test('start, pause and cancel', () => {
        const detecting = feed([DETECTING])
        assert.equal(detecting.status, 'Detecting')
        assert.equal(detecting.door_lock, 'OFF')

        assert.equal(feed([PAUSED]).status, 'Paused')

        const cancelled = feed([CANCELLED])
        assert.equal(cancelled.status, 'Standby')
        assert.equal(cancelled.door_lock, 'ON')
    })

    test('a whole cycle walks through every phase with a falling countdown', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        for (const [frame, status, minutes] of [
            [DEEP_WASH_STARTED, 'Detecting', 78],
            [WASHING, 'Washing', 62],
            [RINSING, 'Rinsing', 42],
            [SPINNING, 'Spinning', 11],
            [END, 'End', 1],
        ] as const) {
            thinq.emit('data', frame)
            assert.equal(p.status, status)
            assert.equal(p.remaining_time, minutes)
            assert.equal(p.extra_rinse, 'ON')
            assert.equal(p.turbo_wash, 'OFF')
            assert.equal(p.remote_start, 'OFF')
        }
        assert.equal(p.soil, 'Not selected')
        assert.equal(p.temp, 'Not selected')
        assert.equal(p.door_lock, 'ON')
        assert.equal(p.power, 'ON')
    })

    test('the settings echo after End does not throw the machine back into its wash', () => {
        assert.equal(feed([E2_AFTER_END]).power, undefined)

        const p = feed([END, E2_AFTER_END])
        assert.equal(p.status, 'End')
        assert.equal(p.remaining_time, 1)
    })

    test('other packet types do not publish or overwrite status', () => {
        for (const junk of [
            SETTINGS_SYNC,
            PERIODIC_DATA,
            REMOTE_ECHO,
            HEARTBEAT,
            START_ACK,
            START_SETTINGS_SYNC,
            COLD_START_SETTINGS_SYNC,
            DEEP_WASH_SETTINGS_SYNC,
            NORMAL_TURBO_SETTINGS_SYNC,
            DOWNLOAD_ACK,
            POWER_OFF_ACK,
            POWER_OFF_SETTINGS_SYNC,
        ]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', junk)
            assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
            thinq.emit('data', WASHING)
            const before = { ...ha.devices[DEVICE_ID].properties }
            thinq.emit('data', junk)
            assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
        }
    })

    test('the fixed 04 15 field is not published as an initial time', () => {
        // it read 04 15 through this whole 62-minute cycle
        const { ha, thinq } = makeDevice()
        for (const f of [DEEP_WASH_STARTED, WASHING, RINSING, SPINNING, END]) thinq.emit('data', f)
        const dev = ha.devices[DEVICE_ID]
        assert.equal(dev.properties.initial_time, undefined)
        assert.equal(dev.config?.components.initial_time, undefined)
    })

    test('start reproduces the command that physically started Heavy Duty', () => {
        const { ha, thinq, dev } = makeDevice()
        // A captured armed Heavy Duty snapshot with the same settings as the local command test.
        // Its lid-lock bit must be cleared in the command, leaving the course options untouched.
        thinq.emit('data', REMOTE_LOCKED)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [START_COMMAND])

        thinq.emit('data', START_ACK)
        thinq.emit('data', START_SETTINGS_SYNC)
        thinq.emit('data', START_SETTINGS_SYNC)
        const syncAcks = thinq.sent.filter((m) => m.cmd === 'ack').slice(-2)
        assert.deepEqual(
            syncAcks.map((m) => m.data),
            ['AA0AF0000A046DE456BB', 'AA0AF0000A046DE456BB'],
        )
        // The acknowledgement and settings sync do not report a phase; wait for an EB/EC update.
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
        assert.deepEqual(thinq.outbox, [START_COMMAND])
    })

    test('start waits for actual settings before constructing a command', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        dev.setProperty('set_course', 'Heavy Duty')
        dev.setProperty('set_temp', 'Cold')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [buf('AA0EF0ED1121010000001800B5BB')])

        thinq.emit('data', STATUS_REPLY)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [buf('AA0EF0ED1121010000001800B5BB'), COLD_START_COMMAND])
    })

    test('the HA temperature control stages a change and reproduces the verified Cold start', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        thinq.emit('data', REMOTE_LOCKED)
        thinq.resetRecorder()
        const p = ha.devices[DEVICE_ID].properties

        ha.setProperty(DEVICE_ID, 'set_temp', 'command', 'Cold')
        assert.equal(p.set_temp, 'Cold')
        assert.equal(p.temp, 'Warm', 'the sensor still reports the appliance, not the pending choice')
        assert.deepEqual(thinq.outbox, [], 'selecting a setting does not start a wash')

        ha.setProperty(DEVICE_ID, 'start', 'command', 'PRESS')
        assert.deepEqual(thinq.outbox, [COLD_START_COMMAND])
        thinq.emit('data', START_ACK)
        thinq.emit('data', COLD_START_SETTINGS_SYNC)
        assert.equal(p.status, 'Standby')
        assert.equal(p.temp, 'Warm', 'acknowledgements do not pretend the requested setting took effect')

        thinq.emit('data', COLD_START_STATUS)
        assert.equal(p.status, 'Detecting')
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.soil, 'Heavy')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Cold')
        assert.equal(p.set_temp, 'Cold')
        assert.equal(p.remaining_time, 106)

        // After submitting the selection, the controls follow later panel settings again.
        thinq.emit('data', NORMAL_HOT)
        assert.equal(p.set_temp, 'Hot')
    })

    test('all setting controls can reconstruct the captured Heavy Duty start from different settings', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        thinq.emit('data', DEEP_WASH_STARTED) // Normal soil, Medium spin, Cold, Extra Rinse on
        thinq.resetRecorder()

        for (const [setting, value] of [
            ['set_course', 'Heavy Duty'],
            ['set_soil', 'Heavy'],
            ['set_spin', 'High'],
            ['set_temp', 'Warm'],
            ['set_turbo_wash', 'OFF'],
            ['set_extra_rinse', 'OFF'],
        ])
            ha.setProperty(DEVICE_ID, setting, 'command', value)

        assert.deepEqual(thinq.outbox, [])
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Deep Wash')
        ha.setProperty(DEVICE_ID, 'start', 'command', 'PRESS')
        assert.deepEqual(thinq.outbox, [START_COMMAND])
    })

    test('changing Normal to Deep Wash enables one Extra Rinse and reads back actual settings', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', LOCAL_NORMAL_ARMED)
        for (const [setting, value] of [
            ['set_course', 'Deep Wash'],
            ['set_soil', 'Normal'],
            ['set_spin', 'Medium'],
            ['set_temp', 'Cold'],
            ['set_turbo_wash', 'OFF'],
            ['set_extra_rinse', 'ON'],
        ])
            dev.setProperty(setting, value)
        assert.deepEqual(thinq.outbox, [])
        dev.setProperty('start', 'PRESS')
        // The physical test sent two extra rinses. The switch now enables one; every other
        // field still matches that captured command.
        const oneRinse = Buffer.from(DEEP_WASH_COMMAND.subarray(2, -2))
        oneRinse[6] = 1
        assert.deepEqual(thinq.outbox, [AABBDevice.frame(oneRinse)])

        thinq.emit('data', START_ACK)
        thinq.emit('data', DEEP_WASH_SETTINGS_SYNC)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Normal')
        thinq.emit('data', LOCAL_DEEP_WASH)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Washing')
        assert.equal(p.course, 'Deep Wash')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'Medium')
        assert.equal(p.temp, 'Cold')
        assert.equal(p.turbo_wash, 'OFF')
        assert.equal(p.extra_rinse, 'ON')
        assert.equal(p.remaining_time, 77)

        // Re-selecting ON preserves the reported two-rinse selection, converting status 4 to command 2.
        thinq.resetRecorder()
        dev.setProperty('set_extra_rinse', 'ON')
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[0][8], 2)
    })

    test('pending choices survive reports while untouched settings follow the latest record', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL)
        dev.setProperty('set_soil', 'Heavy')
        thinq.emit('data', NORMAL_HOT)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.soil, 'Normal')
        assert.equal(p.set_soil, 'Heavy')
        assert.equal(p.temp, 'Hot')
        assert.equal(p.set_temp, 'Hot')

        dev.setProperty('start', 'PRESS')
        const command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[3], 5, 'pending Heavy soil')
        assert.equal(command[5], 5, 'latest reported Hot temperature')
    })

    test('soil and Turbo Wash selections reproduce the verified Normal start', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', REMOTE_LOCKED) // Heavy Duty, Heavy soil, Turbo Wash off
        for (const [setting, value] of [
            ['set_course', 'Normal'],
            ['set_soil', 'Normal'],
            ['set_spin', 'High'],
            ['set_temp', 'Warm'],
            ['set_turbo_wash', 'ON'],
            ['set_extra_rinse', 'OFF'],
        ])
            dev.setProperty(setting, value)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [NORMAL_TURBO_COMMAND])

        thinq.emit('data', START_ACK)
        thinq.emit('data', NORMAL_TURBO_SETTINGS_SYNC)
        assert.equal(ha.devices[DEVICE_ID].properties.turbo_wash, 'OFF')
        thinq.emit('data', NORMAL_TURBO_STATUS)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Detecting')
        assert.equal(p.course, 'Normal')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.remaining_time, 59)
    })

    test('option edits preserve other live bits and keep the Extra Rinse field consistent', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', DEEP_WASH_STARTED)
        dev.setProperty('set_turbo_wash', 'ON')
        dev.setProperty('set_extra_rinse', 'OFF')
        // An otherwise unexplained 0x04 bit appears in the options after these choices were made.
        thinq.emit('data', WASHING)
        dev.setProperty('start', 'PRESS')
        const off = thinq.outbox[0].subarray(2, -2)
        assert.equal(off[6], 0, 'Extra Rinse selection cleared')
        assert.equal(off[14], 0x40, 'Turbo Wash enabled and the door-lock bit excluded')
        assert.equal(off[15], 0x04, 'only the Extra Rinse bit cleared; live unknown bit preserved')

        thinq.resetRecorder()
        thinq.emit('data', STATUS_REPLY)
        dev.setProperty('set_extra_rinse', 'ON')
        dev.setProperty('start', 'PRESS')
        const on = thinq.outbox[0].subarray(2, -2)
        assert.equal(on[6], 1, 'one Extra Rinse in command units')
        assert.equal(on[15], 0x01, 'matching Extra Rinse option bit')
    })

    test('use washer setting releases one selection and reset releases every pending choice', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_REPLY)
        dev.setProperty('set_temp', 'Cold')
        dev.setProperty('set_soil', 'Normal')
        dev.setProperty('set_turbo_wash', 'ON')
        dev.setProperty('set_extra_rinse', 'ON')
        dev.setProperty('set_temp', 'Use washer setting')
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.set_temp, 'Warm')
        assert.equal(p.set_soil, 'Normal')
        assert.equal(p.set_extra_rinse, 'ON')

        dev.setProperty('reset_settings', 'PRESS')
        assert.equal(p.set_soil, 'Heavy')
        assert.equal(p.set_turbo_wash, 'OFF')
        assert.equal(p.set_extra_rinse, 'OFF')
        assert.deepEqual(thinq.outbox, [], 'reset affects only the staged choices')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [START_COMMAND])
    })

    test('an explicit No Spin selection stays zero when a later report has High spin', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_REPLY)
        // This model's MonitoringValue.spin table defines NO_SPIN as index 0, a valid selection.
        dev.setProperty('set_spin', 'No Spin')
        thinq.emit('data', NORMAL_HOT)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.spin, 'High')
        assert.equal(p.set_spin, 'No Spin')
        assert.equal(thinq.outbox.length, 0)

        dev.setProperty('start', 'PRESS')
        const command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[4], 0, 'zero is sent instead of falling back to the reported High spin')
        assert.equal(command[5], 5, 'untouched temperature follows the latest Hot report')
        assert.equal(p.set_spin, 'High', 'after sending, the selector follows the last actual report')
    })

    test('invalid settings cannot overwrite a pending choice or turn an option off', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', STATUS_REPLY)
        dev.setProperty('set_temp', 'Cold')
        dev.setProperty('set_extra_rinse', 'ON')
        for (const [setting, value] of [
            ['set_temp', 'Boiling'],
            ['set_temp', 'Not selected'],
            ['set_course', 'Not selected'],
            ['set_spin', '0'],
            ['set_turbo_wash', 'yes'],
            ['set_extra_rinse', '2'],
            ['set_constructor', 'ON'],
            ['set_toString', 'ON'],
        ])
            dev.setProperty(setting, value)
        assert.deepEqual(thinq.outbox, [])
        assert.equal(ha.devices[DEVICE_ID].properties.set_extra_rinse, 'ON')
        dev.setProperty('set_extra_rinse', 'OFF')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [COLD_START_COMMAND])
    })

    test('pause reproduces the command that physically paused the washer', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', WASHING)
        dev.setProperty('pause', 'PRESS')
        assert.deepEqual(thinq.outbox, [buf('AA09F02404010099BB')])
        thinq.emit('data', LOCAL_PAUSED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Paused')
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.remaining_time, 78)
        assert.equal(p.soil, 'Heavy')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
    })

    test('start while paused reproduces the verified resume command', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', LOCAL_PAUSED)
        // This real paused snapshot has Remote Start off; resume still worked on the appliance.
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [RESUME_COMMAND])

        thinq.emit('data', START_ACK)
        thinq.emit('data', RESUME_TELEMETRY)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Paused')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 78)
    })

    test('the HA power-off button sends the command that physically powered off the washer', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'set_temp', 'command', 'Cold')
        ha.setProperty(DEVICE_ID, 'power_off', 'command', 'PRESS')
        assert.deepEqual(thinq.outbox, [POWER_OFF_COMMAND])
        assert.equal(ha.devices[DEVICE_ID].properties.set_temp, 'Use washer setting')

        thinq.emit('data', POWER_OFF_ACK)
        thinq.emit('data', POWER_OFF_SETTINGS_SYNC)
        thinq.emit('data', POWER_OFF_SETTINGS_SYNC)
        const acks = thinq.sent.filter((m) => m.cmd === 'ack').map((m) => m.data)
        assert.deepEqual(acks, ['AA0AF0000A046E9EEBBB', 'AA0AF0000A046E9EEBBB'])
        // A successful command acknowledgement is not a status snapshot.
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.status, undefined)
    })

    test('the HA download selector writes Small Load and waits for the actual slot report', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        thinq.emit('data', STATUS_REPLY)
        thinq.resetRecorder()
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.smart_course, 'Not selected')
        assert.equal(p.downloaded_course, 'Full Load Wash')
        ha.setProperty(DEVICE_ID, 'set_temp', 'command', 'Hot')
        ha.setProperty(DEVICE_ID, 'downloaded_course', 'command', 'Small Load')
        assert.deepEqual(thinq.outbox, [SMALL_LOAD_COMMAND])
        assert.equal(p.downloaded_course, 'Full Load Wash')
        thinq.emit('data', DOWNLOAD_ACK)
        assert.equal(p.downloaded_course, 'Full Load Wash', 'ACK alone is not a setting confirmation')
        thinq.emit('data', SMALL_LOAD_UPDATE)
        assert.equal(p.status, 'Standby', 'downloading did not start the wash')
        assert.equal(p.course, 'Normal')
        assert.equal(p.smart_course, 'Small Load')
        assert.equal(p.downloaded_course, 'Small Load')
        assert.equal(p.soil, 'Light')
        assert.equal(p.spin, 'Medium')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.set_temp, 'Warm', 'download cleared the old pending temperature')
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.extra_rinse, 'OFF')
        const before = { ...p }
        thinq.emit('data', SMALL_LOAD_STATUS)
        assert.deepEqual(p, before, 'EB and EC agree on the downloaded preset')
    })

    test('a download can be sent before a status report but invalid names cannot change the slot', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('set_temp', 'Cold')
        for (const name of ['Not selected', 'Unknown course', 'constructor', 'toString', '__proto__']) {
            dev.setProperty('downloaded_course', name)
        }
        assert.deepEqual(thinq.outbox, [])
        assert.equal(ha.devices[DEVICE_ID].properties.set_temp, 'Cold')
        dev.setProperty('downloaded_course', 'Small Load')
        assert.deepEqual(thinq.outbox, [SMALL_LOAD_COMMAND])
    })

    test('start preserves the active smart course and a base-course override clears it', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', SMALL_LOAD_STATUS)
        dev.setProperty('set_temp', 'Cold')
        dev.setProperty('start', 'PRESS')
        let command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[13], 0x64)
        assert.equal(command[5], 2)
        thinq.resetRecorder()
        dev.setProperty('set_course', 'Normal')
        dev.setProperty('start', 'PRESS')
        command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[2], 1)
        assert.equal(command[13], 0, 'explicit base-course choice leaves the downloaded programme')
    })

    test('downloaded rinse counts are converted back to command units without doubling', () => {
        for (const [report, rinse] of [
            [JUICE_ONE_RINSE, 1],
            [JUICE_TWO_RINSES, 2],
        ] as const) {
            const { ha, thinq, dev } = makeDevice()
            thinq.emit('data', report)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.course, 'Heavy Duty')
            assert.equal(p.smart_course, 'Juice & Food Stains')
            assert.equal(p.downloaded_course, 'Juice & Food Stains')
            assert.equal(p.soak, 'OFF')
            dev.setProperty('set_extra_rinse', 'ON')
            dev.setProperty('start', 'PRESS')
            assert.equal(thinq.outbox[0][8], rinse)
        }
    })

    test('Soak follows panel and download reports instead of assuming a preset enabled it', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', JUICE_ONE_RINSE)
        assert.equal(p.soak, 'OFF')
        for (const report of [PANEL_SOAK_UPDATE, PANEL_SOAK_STATUS]) {
            thinq.emit('data', report)
            assert.equal(p.soak, 'ON')
            assert.equal(p.remaining_time, 133)
        }
        thinq.emit('data', DOWNLOAD_CLEARS_SOAK)
        assert.equal(p.soak, 'OFF')
        assert.equal(p.remaining_time, 103)
        thinq.emit('data', START_IGNORES_SOAK)
        assert.equal(p.status, 'Detecting')
        assert.equal(p.soak, 'OFF')
        assert.equal(p.remaining_time, 59)
    })

    test('the labelled Special Care sweep separates options from base courses', () => {
        const { ha, thinq } = makeDevice()
        const expected = [
            ['Normal', 'ON', 'OFF', 89],
            ['Normal', 'OFF', 'ON', 91],
            ['Speed Wash', 'OFF', 'OFF', 30],
            ['Rinse+Spin', 'OFF', 'OFF', 33],
            ['Normal', 'OFF', 'OFF', 59],
        ]
        for (const [i, frame] of SPECIAL_CARE_SWEEP.entries()) {
            thinq.emit('data', frame)
            const p = ha.devices[DEVICE_ID].properties
            assert.deepEqual([p.course, p.soak, p.stain_care, p.remaining_time], expected[i])
            assert.equal(p.smart_course, 'Not selected')
            assert.equal(p.downloaded_course, 'Juice & Food Stains', 'leaving Downloaded preserves its stored slot')
        }
    })

    test('Collar Stains sends the verified download and reports appliance-adjusted settings', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL)
        dev.setProperty('downloaded_course', 'Collar Stains')
        assert.deepEqual(thinq.outbox, [COLLAR_STAINS_COMMAND])
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', DOWNLOAD_ACK)
        assert.equal(p.stain_care, 'OFF')
        for (const report of [COLLAR_STAINS_UPDATE, COLLAR_STAINS_STATUS]) {
            thinq.emit('data', report)
            assert.equal(p.downloaded_course, 'Collar Stains')
            assert.equal(p.smart_course, 'Collar Stains')
            assert.equal(p.course, 'Heavy Duty')
            assert.equal(p.stain_care, 'ON')
            assert.equal(p.set_stain_care, 'ON')
            assert.equal(p.turbo_wash, 'OFF')
            assert.equal(p.temp, 'Semi Warm')
            assert.equal(p.remaining_time, 81)
        }
    })

    test('Stain Care stages independently and follows reports again after Reset', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL)
        dev.setProperty('set_stain_care', 'ON')
        dev.setProperty('set_stain_care', 'invalid')
        thinq.emit('data', NORMAL_HOT)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.stain_care, 'OFF')
        assert.equal(p.set_stain_care, 'ON')
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[0].subarray(2, -2)[15], 0x08)
        assert.equal(p.set_stain_care, 'OFF', 'Start clears the submitted override')
        thinq.emit('data', COLLAR_STAINS_STATUS)
        dev.setProperty('set_stain_care', 'OFF')
        assert.equal(p.stain_care, 'ON')
        assert.equal(p.set_stain_care, 'OFF')
        dev.setProperty('reset_settings', 'PRESS')
        assert.equal(p.set_stain_care, 'ON')
    })

    test('Deep Fill and Delay Wash follow the labelled panel settings', () => {
        const { ha, thinq, dev } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', NORMAL)
        assert.equal(p.deep_fill, 'OFF')
        thinq.emit('data', DEEP_FILL_FROM_NORMAL)
        assert.equal(p.course, 'Deep Wash')
        assert.equal(p.deep_fill, 'ON')
        assert.equal(p.reserve_time, 0)
        thinq.emit('data', DELAY_ONE_HOUR)
        assert.equal(p.reserve_time, 60)
        thinq.emit('data', DELAY_TWO_HOURS)
        assert.equal(p.reserve_time, 120)
        dev.setProperty('start', 'PRESS')
        const command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[15] & 2, 2, 'Start preserves panel-selected Deep Fill')
    })

    test('Deep Fill control uses the verified bit and delay monitoring reports what actually took effect', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SMALL_LOAD_STATUS)
        dev.setProperty('set_deep_fill', 'ON')
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[0].subarray(2, -2)[15], 2)
        thinq.emit('data', DOWNLOAD_DEEP_FILL_STATUS)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.deep_fill, 'ON')
        assert.equal(p.set_deep_fill, 'ON')
        assert.equal(p.reserve_time, 0)
        dev.setProperty('set_deep_fill', 'OFF')
        assert.equal(p.deep_fill, 'ON')
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[1].subarray(2, -2)[15], 0)
        thinq.emit('data', START_IGNORES_DELAY)
        assert.equal(p.status, 'Detecting')
        assert.equal(p.reserve_time, 0)
    })

    test('Sweat Stains download matches LG exactly and confirms Soak from the appliance', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())
        bridge.newDevice(thinq)
        thinq.emit('data', SMALL_LOAD_STATUS)
        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'downloaded_course', 'command', 'Sweat Stains')
        assert.deepEqual(thinq.outbox, [SWEAT_STAINS_COMMAND])
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', DOWNLOAD_ACK)
        assert.equal(p.soak, 'OFF', 'wait for the actual setting even with a known command')
        thinq.emit('data', SWEAT_STAINS_UPDATE)
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Heavy Duty')
        assert.equal(p.smart_course, 'Sweat Stains')
        assert.equal(p.downloaded_course, 'Sweat Stains')
        assert.equal(p.soak, 'ON')
        assert.equal(p.set_soak, 'ON')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.spin, 'High')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.remaining_time, 108)
    })

    test('Soak overrides and panel selections encode both command fields together', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SMALL_LOAD_STATUS)
        dev.setProperty('set_soak', 'ON')
        dev.setProperty('set_soak', 'invalid')
        thinq.emit('data', SMALL_LOAD_STATUS)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.soak, 'OFF')
        assert.equal(p.set_soak, 'ON')
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('start', 'PRESS')
        let command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[10], 1, 'Soak data byte')
        assert.equal(command[15], 0x20, 'matching Soak options bit')
        assert.equal(p.set_soak, 'OFF', 'submitted override is reset until confirmed')

        thinq.emit('data', PANEL_SOAK_STATUS) // Soak + Extra Rinse, selected at the panel
        thinq.resetRecorder()
        dev.setProperty('start', 'PRESS')
        command = thinq.outbox[0].subarray(2, -2)
        assert.equal(command[10], 1, 'untouched panel-selected Soak is preserved')
        assert.equal(command[15], 0x21)
        dev.setProperty('set_soak', 'OFF')
        dev.setProperty('start', 'PRESS')
        command = thinq.outbox[1].subarray(2, -2)
        assert.equal(command[10], 0)
        assert.equal(command[15], 1, 'disabling Soak preserves Extra Rinse')
        dev.setProperty('set_soak', 'OFF')
        dev.setProperty('reset_settings', 'PRESS')
        assert.equal(p.set_soak, 'ON', 'Reset follows the latest actual report')
    })

    test('Start preserves Soak and Delay Wash exactly as captured from LG', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SOAK_DELAY_ARMED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.reserve_time, 120)
        assert.equal(p.set_delay_wash, 2)
        assert.equal(p.soak, 'ON')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [SOAK_DELAY_START_COMMAND])
        thinq.emit('data', START_ACK)
        assert.equal(p.status, 'Standby')
        thinq.emit('data', SOAK_DELAY_STARTED)
        assert.equal(p.status, 'Delayed')
        assert.equal(p.reserve_time, 120)
        assert.equal(p.soak, 'ON')
        assert.equal(p.smart_course, 'Sweat Stains')
    })

    test('staged Soak and delay reconstruct the captured LG Start from an unmodified preset', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', SWEAT_STAINS_UPDATE)
        dev.setProperty('set_soak', 'ON')
        dev.setProperty('set_delay_wash', '2')
        for (const value of ['', ' ', '-1', '20', '1.5', 'NaN', 'Infinity', '2 hours']) {
            dev.setProperty('set_delay_wash', value)
        }
        thinq.emit('data', SWEAT_STAINS_UPDATE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.reserve_time, 0)
        assert.equal(p.set_delay_wash, 2)
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [SOAK_DELAY_START_COMMAND])
        assert.equal(p.set_delay_wash, 0, 'submitted override clears until confirmed')

        thinq.emit('data', SOAK_DELAY_ARMED)
        thinq.resetRecorder()
        dev.setProperty('set_delay_wash', '0')
        dev.setProperty('start', 'PRESS')
        const data = thinq.outbox[0].subarray(4, -2)
        assert.equal(data[8], 1, 'clearing delay preserves Soak')
        assert.equal(data[9], 0, 'zero overrides the panel delay instead of falling back')
        assert.equal(data[10], 0)
        dev.setProperty('set_delay_wash', '3')
        dev.setProperty('reset_settings', 'PRESS')
        assert.equal(p.set_delay_wash, 2)
    })

    test('choosing two extra rinses reconstructs the physically verified Deep Wash Start', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', LOCAL_NORMAL_ARMED)
        for (const [setting, value] of [
            ['set_course', 'Deep Wash'],
            ['set_soil', 'Normal'],
            ['set_spin', 'Medium'],
            ['set_temp', 'Cold'],
            ['set_turbo_wash', 'OFF'],
            ['set_extra_rinses', '2'],
        ])
            dev.setProperty(setting, value)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.extra_rinse, 'OFF')
        assert.equal(p.set_extra_rinse, 'ON')
        assert.equal(p.set_extra_rinses, 2)
        for (const value of ['', ' ', '-1', '3', '1.5', 'NaN', 'Infinity', 'two']) {
            dev.setProperty('set_extra_rinses', value)
        }
        dev.setProperty('set_extra_rinse', 'ON') // Re-selecting ON preserves a staged count of 2.
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [DEEP_WASH_COMMAND])
        thinq.emit('data', LOCAL_DEEP_WASH)
        assert.equal(p.set_extra_rinses, 2)
    })

    test('the rinse switch and count control stay consistent and preserve automatic base rinses', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', COLLAR_STAINS_STATUS) // Automatic rinse, Extra Rinse off.
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.set_extra_rinses, 0)
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[0][8], 1, 'untouched automatic rinse remains in the command')
        dev.setProperty('set_extra_rinses', '2')
        dev.setProperty('set_extra_rinse', 'OFF')
        assert.equal(p.set_extra_rinses, 0)
        assert.equal(p.set_extra_rinse, 'OFF')
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[1][8], 1, 'OFF when already off preserves the base rinse')
        dev.setProperty('set_extra_rinses', '0')
        dev.setProperty('set_extra_rinse', 'ON')
        assert.equal(p.set_extra_rinses, 1)
        dev.setProperty('set_extra_rinses', '0')
        dev.setProperty('start', 'PRESS')
        assert.equal(thinq.outbox[2][8], 0, 'explicit zero clears the command override')
        dev.setProperty('set_extra_rinses', '2')
        dev.setProperty('reset_settings', 'PRESS')
        assert.equal(p.set_extra_rinses, 0)
        assert.equal(p.set_extra_rinse, 'OFF')
    })

    test('Max and Control Lock are independent of Deep Fill, Remote Start and the lid lock', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', MAX_FILL_ON)
        assert.equal(p.course, 'Deep Wash')
        assert.equal(p.deep_fill, 'OFF')
        assert.equal(p.deep_fill_max, 'ON')
        assert.equal(p.remote_start, 'OFF')
        assert.equal(p.child_lock, 'OFF')
        thinq.emit('data', CONTROL_LOCK_ON)
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.door_lock, 'ON', 'control lock does not lock the lid')
        assert.equal(p.deep_fill_max, 'ON')
        thinq.emit('data', CONTROL_LOCK_OFF)
        assert.equal(p.child_lock, 'OFF')
        assert.equal(p.deep_fill_max, 'ON')
    })

    test('Max Start matches LG and follows the consumed flag in the actual reply', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', MAX_FILL_ARMED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.deep_fill_max, 'ON')
        assert.equal(p.remote_start, 'ON')
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [MAX_FILL_START_COMMAND])
        thinq.emit('data', MAX_FILL_STARTED)
        assert.equal(p.status, 'Detecting')
        assert.equal(p.deep_fill_max, 'OFF')
        assert.equal(p.set_deep_fill_max, 'OFF')
        assert.equal(p.remote_start, 'ON')
    })

    test('staging Max changes the final byte without changing other options', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', MAX_FILL_STARTED)
        dev.setProperty('set_deep_fill_max', 'ON')
        dev.setProperty('set_deep_fill_max', 'invalid')
        assert.equal(ha.devices[DEVICE_ID].properties.deep_fill_max, 'OFF')
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [MAX_FILL_START_COMMAND])
        thinq.emit('data', MAX_FILL_ARMED)
        dev.setProperty('set_deep_fill_max', 'OFF')
        thinq.resetRecorder()
        dev.setProperty('start', 'PRESS')
        const withoutMax = Buffer.from(MAX_FILL_START_COMMAND.subarray(2, -2))
        withoutMax[withoutMax.length - 1] = 3
        assert.deepEqual(thinq.outbox, [AABBDevice.frame(withoutMax)])
    })

    test('Cold Wash is a separate option from selecting Cold temperature', () => {
        const { ha, thinq } = makeDevice()
        const p = ha.devices[DEVICE_ID].properties
        thinq.emit('data', COLD_START_STATUS)
        assert.equal(p.temp, 'Cold')
        assert.equal(p.cold_wash, 'OFF')
        thinq.emit('data', COLD_WASH_ON)
        assert.equal(p.course, 'Normal')
        assert.equal(p.cold_wash, 'ON')
        assert.equal(p.temp, 'Cold')
        assert.equal(p.turbo_wash, 'OFF')
        assert.equal(p.remaining_time, 88)
    })

    test('Cold Wash selected at the panel reproduces LG Start and reads back the actual running state', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', COLD_WASH_ARMED)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [COLD_WASH_COMMAND])
        thinq.emit('data', COLD_WASH_STARTED)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Detecting')
        assert.equal(p.cold_wash, 'ON')
        assert.equal(p.turbo_wash, 'OFF')
        assert.equal(p.temp, 'Cold')
    })

    test('enabling Cold Wash stages the panel combination and reconstructs LG Start', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', NORMAL)
        dev.setProperty('set_cold_wash', 'ON')
        dev.setProperty('set_cold_wash', 'invalid')
        thinq.emit('data', NORMAL_HOT)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.cold_wash, 'OFF')
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.temp, 'Hot')
        assert.equal(p.set_cold_wash, 'ON')
        assert.equal(p.set_turbo_wash, 'OFF')
        assert.equal(p.set_temp, 'Cold')
        assert.equal(thinq.outbox.length, 0)
        dev.setProperty('start', 'PRESS')
        assert.deepEqual(thinq.outbox, [COLD_WASH_COMMAND])
        assert.equal(p.set_cold_wash, 'OFF', 'submitted choice resets until confirmed')
        thinq.emit('data', COLD_WASH_STARTED)
        dev.setProperty('set_cold_wash', 'OFF')
        thinq.resetRecorder()
        dev.setProperty('start', 'PRESS')
        const withoutColdWash = Buffer.from(COLD_WASH_COMMAND.subarray(2, -2))
        withoutColdWash[14] = 0
        assert.deepEqual(thinq.outbox, [AABBDevice.frame(withoutColdWash)])
    })

    test('unverified controls send nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', PAUSED)
        for (const prop of ['power_on', 'nonsense']) dev.setProperty(prop, 'PRESS')
        assert.deepEqual(thinq.outbox, [])
    })
})
