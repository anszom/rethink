import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F_V8_Y___W.B_2QEUK'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'F_V8_Y___W.B_2QEUK'
const META: Metadata = { modelId: MODEL_ID, modelName: 'F_V8_Y___W.B_2QEUK', swVersion: '0.0.0' }

// All hex dumps below are captured status telegrams from issue #75 (F6WV710P2S.ABLQPDG).
// The decoder parses the second record (starting at buf[42]); the option state lives at
// buf[50] (wash intensity), buf[53] (extra rinse count) and the buf[57] options bitfield.

// Cotton, 40°C, 1600 RPM — no extra options selected.
const SAMPLE_COTTON_STD = buf(
    'aa5420ec002501000000000000000000000000000000000000000001006400000000000000000000000000002501033a033a0100030b04010000000000010002000001006400000400000000000000000000e0bb',
)

// Allergy Care, 60°C, Steam, 1600 RPM.
const SAMPLE_ALLERGY_STEAM = buf(
    'aa5420ec002501021c021c0900030504010000000000000002000001006400000500000000000000000000002501023002302d00030b06010000008000000003000001006400000500000000000000000000f2bb',
)

// Cotton, 60°C, Steam, 1600 RPM.
const SAMPLE_COTTON_STEAM = buf(
    'aa5420ec002501031c031c0100030b03010000000000010002000001006400000400000000000000000000002501041104110100030b0601000000800001000300000100640000040000000000000000000015bb',
)

// Cotton with TurboWash pressed (auto-adjusts to 1000 RPM).
const SAMPLE_TURBOWASH = buf(
    'aa5420ec002501041104110100030b06010000008000010003000001006400000400000000000000000000002501031d031d010003070601000000010001000300000100640000040000000000000000000016bb',
)

// Cotton with Rinse+ pressed (extra rinse count -> 2).
const SAMPLE_RINSE_PLUS = buf(
    'aa5420ec002501033703370100030706010000000000010004000001006400000400000000000000000000002501040c040c0100030706020000000000010004000001006400000500000000000000000000b9bb',
)

// Cotton with Pre-wash pressed.
const SAMPLE_PREWASH = buf(
    'aa5420ec002501033703370100030706010000000000010004000001006400000400000000000000000000002501040c040c01000307060100000040000100040000010064000005000000000000000000007ebb',
)

// Cotton with Intensive Wash pressed (wash intensity -> 4).
const SAMPLE_INTENSIVE = buf(
    'aa5420ec002501033703370100030706010000000000010004000001006400000400000000000000000000002501041604160100040706010000000000010004000001006400000400000000000000000000aabb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('Cotton 40°C 1600 RPM decodes with no options set', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STD)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '40 °C')
        assert.equal(props.spin, '1600 rpm')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Allergy Care 60°C Steam 1600 RPM decodes steam=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_ALLERGY_STEAM)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Allergy Care')
        assert.equal(props.temp, '60 °C')
        assert.equal(props.spin, '1600 rpm')
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Cotton 60°C Steam decodes steam=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_COTTON_STEAM)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.course, 'Cotton')
        assert.equal(props.temp, '60 °C')
        assert.equal(props.steam, 'ON')
        assert.equal(props.turbowash, 'OFF')
    })

    test('TurboWash decodes turbowash=ON and 1000 RPM', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_TURBOWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.turbowash, 'ON')
        assert.equal(props.spin, '1000 rpm')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Rinse+ decodes extra_rinse=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_RINSE_PLUS)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.extra_rinse, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Pre-wash decodes prewash=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_PREWASH)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.prewash, 'ON')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.soil, 'Normal')
    })

    test('Intensive Wash decodes soil=Intensive', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SAMPLE_INTENSIVE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.soil, 'Intensive')
        assert.equal(props.turbowash, 'OFF')
        assert.equal(props.prewash, 'OFF')
        assert.equal(props.steam, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
    })
})

// F4WV909P2TE (firmware 2.10.123): 32-byte records, live captures
describe(`${MODEL_ID} with 32-byte records`, () => {
    const EB_PAUSED = 'AA2620EB001F02000E000E0C0003020201000000014200000006003000640000010000005FBB'
    const EC_COTTON =
        'AA4620EC001F01002D002D20000305020100000000000000010000300064000003000000001F01033B033B0100030A040100000000000100030000300064000004000000D1BB'
    const EC_COTTON_95 =
        'AA4620EC001F01033B033B0100030A060100000000000100040000300064000004000000001F01021D021D0100030A0701000000000001000400003000640000040000000EBB'
    const EC_NO_SPIN =
        'AA4620EC001F01033B033B0100030A040100000000000100030000300064000004000000001F01032E032E010003010401000000000001000200003000640000040000003BBB'
    const EC_DELAY_3H =
        'AA4620EC001F01033B033B0100030A040100000000000100030000300064000004000000001F01033B033B0100030A040100030000000100030000300064000004000000C0BB'
    const EC_STEAM =
        'AA4620EC001F01033B033B0100030A040100000000000100030000300064000004000000001F01041204120100030A06010000008000010004000030006400000400000090BB'
    const EC_TURBOWASH =
        'AA4620EC001F01033B033B0100030A060100000000000100040000300064000004000000001F01031E031E010003070601000000010001000300003000640000040000000EBB'
    const EC_RINSE_PLUS =
        'AA4620EC001F010338033801000307060100000000000100040000300064000004000000001F01040D040D0100030706020000000000010004000030006400000500000061BB'
    const EC_PREWASH =
        'AA4620EC001F010338033801000307060100000000000100040000300064000004000000001F01040D040D0100030706010000004000010004000030006400000500000026BB'
    const EC_INTENSIVE =
        'AA4620EC001F010338033801000307060100000000000100040000300064000004000000001F01041704170100040706010000000000010004000030006400000400000012BB'
    const EC_REMOTE_START =
        'AA4620EC001F010338033801000307060100000000000100040000300064000004000000001F010338033801000307060100000000020100040000300064000004000000DDBB'
    const EC_RUNNING =
        'AA4620EC001F010338033801000307060100000000420100040000300064000004000000001F06000E000E0C00030202010000000142200001010030006400000400000080BB'

    test('panel settings: course, temperature, spin, time and options', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties
        const emit = (f: string) => thinq.emit('data', buf(f))

        emit(EC_COTTON)
        assert.deepEqual(
            [props().status, props().course, props().temp, props().spin, props().remaining_time, props().cycles],
            ['Ready', 'Cotton', '40 °C', '1400 rpm', 239, 48],
        )
        emit(EC_COTTON_95)
        assert.deepEqual([props().temp, props().remaining_time], ['95 °C', 149])
        emit(EC_NO_SPIN)
        assert.equal(props().spin, 'No spin')
        emit(EC_DELAY_3H)
        assert.equal(props().reserve_time, 3)

        const options = () => [props().steam, props().turbowash, props().extra_rinse, props().prewash, props().soil]
        emit(EC_STEAM)
        assert.deepEqual(options(), ['ON', 'OFF', 'OFF', 'OFF', 'Normal'])
        emit(EC_TURBOWASH)
        assert.deepEqual(options(), ['OFF', 'ON', 'OFF', 'OFF', 'Normal'])
        emit(EC_RINSE_PLUS)
        assert.deepEqual(options(), ['OFF', 'OFF', 'ON', 'OFF', 'Normal'])
        emit(EC_PREWASH)
        assert.deepEqual(options(), ['OFF', 'OFF', 'OFF', 'ON', 'Normal'])
        emit(EC_INTENSIVE)
        assert.deepEqual(options(), ['OFF', 'OFF', 'OFF', 'OFF', 'Intensive'])

        emit(EC_REMOTE_START)
        assert.equal(props().remote_start, 'ON')
    })

    test('a Quick 14 started from the app runs and pauses', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', buf(EC_RUNNING))
        assert.deepEqual(
            [props().status, props().course, props().temp, props().spin, props().remaining_time],
            ['Washing', 'Quick 14', '20 °C', '400 rpm', 14],
        )
        thinq.emit('data', buf(EB_PAUSED))
        assert.equal(props().status, 'Paused')
    })

    // A full Cotton 60 / 1000 / Steam + TurboWash run
    const EC_RINSING =
        'AA4620EC001F060015011A0100030706010000000142010004040030006400000400038A001F070014011A0100030700010000000142010004060030006400000400038AFDBB'
    const EC_RUN_END =
        'AA4620EC001F080001011A010000070000000000004201000407003000640000040003AF001F0A0000011A010000000000000000004201000408003000640000040003AFE8BB'

    test('a full run rinses, ends, and reports the energy the LG app showed (943 Wh)', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties
        thinq.emit('data', buf(EC_RINSING))
        assert.deepEqual([props().status, props().remaining_time, props().energy], ['Rinsing', 20, 906])
        thinq.emit('data', buf(EC_RUN_END))
        assert.deepEqual([props().status, props().remaining_time, props().energy], ['End', 0, 943])
    })

    const EC_SPINNING =
        'AA4620EC001F080001000101000001000000000000022000010100300064000000000000001F080001000101000001000000000000420000010100300064000000000000B7BB'
    const EC_END =
        'AA4620EC001F080001000101000001000000000000420000010100300064000000000000001F0A000000010100000000000000000040000001080030006400000000000052BB'
    const EC_END_UNLOCKED =
        'AA4620EC001F0A0000000101000000000000000000400000010800300064000000000000001F0A000000010100000000000000000000000001080030006400000000000099BB'
    // Started with the door left open
    const EC_DOOR_ERROR =
        'AA4620EC001F01033B033B0100030A040100000000000100030000300064000004000000001F12033B033B0102030A040100000000020100030400300064000004000000FEBB'

    // lock device class: ON = unlocked
    test('a spin-only run ends and unlocks the door', () => {
        const { ha, thinq } = makeDevice()
        const props = () => ha.devices[DEVICE_ID].properties

        thinq.emit('data', buf(EC_SPINNING))
        assert.deepEqual([props().status, props().door_lock], ['Spinning', 'OFF'])
        thinq.emit('data', buf(EC_END))
        assert.deepEqual([props().status, props().remaining_time, props().door_lock], ['End', 0, 'OFF'])
        thinq.emit('data', buf(EC_END_UNLOCKED))
        assert.equal(props().door_lock, 'ON')
    })

    test('starting with the door open reports the DE1 error', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_DOOR_ERROR))
        const props = ha.devices[DEVICE_ID].properties
        assert.deepEqual(
            [props.status, props.error, props.error_message, props.door_lock],
            ['Error', 'ON', 'Door open error (DE1)', 'ON'],
        )
    })
})

describe(`${MODEL_ID} 32-byte record: child lock and options`, () => {
    const EC_CHILD_LOCK_ON =
        'AA4620EC001F01002D002D20000305020100000000000000010000310064000003000000001F01002D002D20000305020100000000800000010000310064000003000000ADBB'
    const EC_CHILD_LOCK_OFF =
        'AA4620EC001F01002D002D20000305020100000000800000010000310064000003000000001F01002D002D20000305020100000000000000010000310064000003000000ADBB'
    // Quick 14 + Pre-wash + Intensive, accepted live
    const EC_STARTED_WITH_OPTIONS =
        'AA4620EC001F010000000000000000000000000000020000000000310065000000000000001F06001100110C0004020201000000410220000101003100650000000000005EBB'

    test('child lock follows bit 0x80 of the lock byte', () => {
        const { ha, thinq } = makeDevice()
        // lock device class: OFF = locked
        thinq.emit('data', buf(EC_CHILD_LOCK_ON))
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
        thinq.emit('data', buf(EC_CHILD_LOCK_OFF))
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
    })

    test('the washer reports the added options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EC_STARTED_WITH_OPTIONS))
        const props = ha.devices[DEVICE_ID].properties
        assert.deepEqual(
            [props.status, props.turbowash, props.prewash, props.soil],
            ['Washing', 'ON', 'ON', 'Intensive'],
        )
    })
})

describe(`${MODEL_ID} remote start`, () => {
    // ThinQ app remote starts
    const APP_START_QUICK14 = 'AA16F0260C030202010000000001030000000000BBBB'
    const APP_START_COTTON_30_400_RINSE_PLUS = 'AA16F02601030203020000000000030000000000B1BB'

    test('Start program sends the same frames as the ThinQ app', () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('program_course', 'Quick 14')
        dev.setProperty('program_temp', '20 °C')
        dev.setProperty('program_spin', '400 rpm')
        dev.setProperty('start_program', '')

        dev.setProperty('program_course', 'Cotton')
        dev.setProperty('program_temp', '30 °C')
        dev.setProperty('program_rinse_plus', 'ON')
        dev.setProperty('start_program', '')

        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            [APP_START_QUICK14, APP_START_COTTON_30_400_RINSE_PLUS],
        )
    })

    test('a temperature or spin the course does not offer falls back to its default', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('program_course', 'Wool')
        dev.setProperty('program_temp', '95 °C')
        dev.setProperty('program_spin', '1400 rpm')
        dev.setProperty('start_program', '')
        const cmd = thinq.outbox[0].subarray(2, -2)
        assert.deepEqual([cmd[2], cmd[4], cmd[5]], [0x1b, 5, 3]) // Wool, 800, 30
    })
})

describe(`${MODEL_ID} resume on the 32-byte models`, () => {
    // paused after a remote start
    const EB_PAUSED_REMOTE = 'AA2620EB001F02001700170C00030A03010000000142000001060030006400000100000073BB'
    // what resumed it live
    const RESUME = 'AA17F0260C030A0301000000000101000000000000A3BB'

    test('Start resumes the paused cycle with its own selection', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', buf(EB_PAUSED_REMOTE))
        dev.setProperty('start', '')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            [RESUME],
        )
    })

    test('without a 32-byte record Start keeps the original command', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('start', '')
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex').toUpperCase()),
            ['AA09F02405010098BB'],
        )
    })
})

describe(`${MODEL_ID} remote start options`, () => {
    test('option switches add the panel bits and intensive raises the intensity', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('program_course', 'Cotton')
        dev.setProperty('program_temp', '60 °C')
        dev.setProperty('program_spin', '1000 rpm')
        dev.setProperty('program_turbowash', 'ON')
        dev.setProperty('program_steam', 'ON')
        dev.setProperty('program_intensive', 'ON')
        dev.setProperty('start_program', '')
        const cmd = thinq.outbox[0].subarray(2, -2)
        // Cotton, intensive, 1000, 60, normal rinse, Steam + TurboWash
        assert.deepEqual([cmd[2], cmd[3], cmd[4], cmd[5], cmd[6], cmd[11], cmd[12]], [0x01, 4, 7, 6, 1, 0x81, 3])
    })
})

describe(`${MODEL_ID} delay end`, () => {
    const APP_START_DELAYED = 'AA16F0260103FF0401000A000000030000000000BEBB'

    test('Start program carries the delay in hours where the app put it', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('program_course', 'Cotton')
        dev.setProperty('program_temp', '40 °C')
        dev.setProperty('program_spin', '1400 rpm')
        dev.setProperty('program_delay', '10')
        dev.setProperty('start_program', '')
        const ours = thinq.outbox[0].subarray(2, -2)
        const app = buf(APP_START_DELAYED).subarray(2, -2)
        // the app sends Max (FF) for 1400 (0A)
        assert.equal(ours[4], 0x0a)
        assert.equal(app[4], 0xff)
        ours[4] = app[4]
        assert.deepEqual(hexOf(ours), hexOf(app))
    })

    test('a delay the washer does not offer is ignored', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('program_delay', '2')
        dev.setProperty('program_delay', '25')
        assert.equal(ha.devices[DEVICE_ID].properties.program_delay, 0)
    })
})

describe(`${MODEL_ID} options added to a remote start`, () => {
    // Quick 14 + Pre-wash + Intensive, accepted live
    const LIVE_START_WITH_OPTIONS = 'AA16F0260C0402020100000000410300000000007ABB'

    test('Start program adds the switched-on options as the washer accepted them', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('program_course', 'Quick 14')
        dev.setProperty('program_temp', '20 °C')
        dev.setProperty('program_spin', '400 rpm')
        dev.setProperty('program_prewash', 'ON')
        dev.setProperty('program_intensive', 'ON')
        dev.setProperty('start_program', '')
        assert.deepEqual(thinq.outbox.map(hex), [LIVE_START_WITH_OPTIONS])
    })
})

describe(`${MODEL_ID} remote controls`, () => {
    // paused after a remote start: a 32-byte model
    const EB_PAUSED_REMOTE = 'AA2620EB001F02001700170C00030A03010000000142000001060030006400000100000073BB'
    const remote = (ha: MockHAConnection) =>
        Object.keys(ha.devices[DEVICE_ID].config!.components).filter(
            (c) => c.startsWith('program_') || c === 'start_program',
        )

    test('the config waits for the first record', () => {
        const { ha, thinq } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID]?.config, undefined)
        thinq.emit('data', SAMPLE_COTTON_STD) // a 39-byte model
        assert.ok(ha.devices[DEVICE_ID].config!.components.status)
        assert.deepEqual(remote(ha), [])
    })

    test('the 32-byte models get the remote controls with the first config', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', buf(EB_PAUSED_REMOTE))
        assert.ok(remote(ha).includes('start_program'))
        assert.ok(remote(ha).includes('program_delay'))
        assert.ok(remote(ha).includes('program_download'))
    })
})

describe(`${MODEL_ID} smart courses`, () => {
    // ThinQ app downloads
    const APP_DOWNLOADS: Record<string, string> = {
        'Kids Wear': 'AA18F0250315010309060100000000400200340000002CBB',
        'School Uniform': 'AA18F02503150203070401000000000002003500000062BB',
        'Swimming Wear': 'AA18F02503151B0302020100000000000200360000001FBB',
        'Rainy Season': 'AA18F02503150103FF0401000000000002003700000065BB',
        'Gym Clothes': 'AA18F0250315080305010100000000000200380000006EBB',
        Jeans: 'AA18F02503152003FF020100000000000200390000001ABB',
        Blanket: 'AA18F02503150503020101000000000002003A00000062BB',
        'Sweat Stain': 'AA18F02503150103FF0401000000000002003B00000061BB',
        'Single Garment': 'AA18F02503150C03020201000000000102003E00000011BB',
        'Colour Protection': 'AA18F02503152003050201000000000002003F0000000EBB',
        'Noise Minimize': 'AA18F0250315090307040100000000000200400000001CBB',
        'Baby Care': 'AA18F025031501030706020000000050020047000000CEBB',
        Hygiene: 'AA18F02503150A03FF0601000000008002004800000099BB',
        'Small Load': 'AA18F02503150C0302020100000000010200490000001ABB',
        Lingerie: 'AA18F02503152003050201000000000002004A00000033BB',
        'Skin Care': 'AA18F02503150103FF0402000000001002004C00000003BB',
        'Cold Wash': 'AA18F02503150103FF0101000000000002004D00000016BB',
        'Rinse + Spin': 'AA18F02503150E03FF0001000000000002006400000033BB',
        'Lightly Soiled Items': 'AA18F02503151B0302020100000000000200650000002CBB',
        'Minimize Detergent Residue': 'AA18F02503150103FF0402000000000002006600000035BB',
        'Sleeve Hems and Collars': 'AA18F02503150103070601000000004002006B000000FBBB',
        'Juice and Food Stains': 'AA18F02503150103070401000000004002006C000000F8BB',
        'Minimize Wrinkles': 'AA18F02503150103FF0401000000000002006F0000003DBB',
        'Quick Tub Clean': 'AA18F025031530030201000000000000020071000000CDBB',
        Drain: 'AA18F025031517000100000000000000020079000000D7BB',
        Spin: 'AA18F02503151700FF0000000000000002007A000000D4BB',
    }
    // Lightly Soiled Items started from the app
    const EC_SMART_STARTED =
        'AA4620EC001F01002200221B000302020100000000420000010065310065000003000000001F06002200221B000302020100000000422000010165310065000003000000E7BB'
    const APP_START_SMART = 'AA16F0261B03020201000000000003006500000034BB'

    test('Download sends the same frame as the ThinQ app, for every smart course', () => {
        const { thinq, dev } = makeDevice()
        for (const name of Object.keys(APP_DOWNLOADS)) {
            dev.setProperty('program_download', name)
            dev.setProperty('download', '')
        }
        assert.deepEqual(thinq.outbox.map(hex), Object.values(APP_DOWNLOADS))
    })

    test('the active smart course is the course, and Download Cycle starts it as the app did', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', buf(EC_SMART_STARTED))
        const props = ha.devices[DEVICE_ID].properties
        assert.deepEqual(
            [props.status, props.course, props.downloaded_course],
            ['Washing', 'Lightly Soiled Items', 'Lightly Soiled Items'],
        )

        thinq.resetRecorder()
        dev.setProperty('program_course', 'Download Cycle')
        dev.setProperty('start_program', '')
        assert.deepEqual(thinq.outbox.map(hex), [APP_START_SMART])
    })

    test('Download Cycle sends nothing before the washer has reported what it has loaded', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('program_course', 'Download Cycle')
        dev.setProperty('start_program', '')
        assert.deepEqual(thinq.outbox, [])
    })
})

function hexOf(b: Buffer) {
    return b.toString('hex').toUpperCase()
}
