import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/F24VDD'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'F24VDD', modelName: 'F24VDD', swVersion: '2.10.97' }

// Real status reply captured from the owner's F24VDD on 2026-09-07 immediately
// after the read-only F0ED status query. The appliance reported INITIAL and all
// three clocks plus error as zero. Unlabelled bytes are deliberately not exposed.
const CURRENT = buf('aa2c20eb0024050000000000000000000000000000020000010033010f000000000002022d1e00000100f5bb')
const POWERING_OFF = buf(
    'aa5220ec0024050000000000000000000000000000020000020033010f000000000002022d1e000001000024000000000000000000000000000000020000020533010f000000000002022d1e00000100ddbb',
)
const OFF = buf('aa2c20eb0024000000000000000000000000000000020000020533010f000000000002022d1e00000100f4bb')
const HISTORICAL_CURRENT = buf(
    'aa2c20eb0024050000000000000000000000000000020000000033310f000000000002022d1e000001009abb',
)
const STANDARD = buf(
    'aa5220ec002405012f012f06000303040300000000020000000033010f000000000002022d1e000001000024050021002107000204030200000000824000000033010f000000000002022d1e000001005ebb',
)
const TEMPERATURE_60 = buf(
    'aa5220ec0024050021002107000204030200000000824000000033010f000000000002022d1e000001000024050037003707000204040200000000820000000033010f000000000002022d1e00000100ccbb',
)
const HEARTBEAT_OFF = buf('aa0720d800fcbb')
const HEARTBEAT_ON = buf('aa0720d801ffbb')
// Real Start captured for Steam Refresh with a 19-hour reservation. Confirms
// course code 1 and that reserveHour reads back exactly what was set.
const RESERVED_STEAM_REFRESH = buf(
    'aa5220ec002406002e002e07000201040100000020860000011733010f010000000002022d1e0000010000240a0014001401000200000000130030060000010633010f050000000000002d1e0000010079bb',
)
// Real Start captured after selecting Standard with rinse=1, spin=delicate,
// temp=60C in the ThinQ app. Confirms course/temperature offsets hold during
// an actual run, not just at rest, with the appliance now in Detecting (20).
const DETECTING_RUN = buf(
    'aa5220ec0024050021002107000204030200000020864000000033010f000000000002022d1e000001000024140032003207000201040100000020860000000533010f000000000002022d1e00000100b2bb',
)
// Real Start captured for Standard with rinse=2, spin=High, temp=40C, and a
// 3-hour reservation, all changed from the previous Standard defaults at
// once. The status record right after reads temperature=40C and reserve=3h.
const CUSTOM_OPTIONS_RUN = buf(
    'aa5220ec0024140021002107000204030200030020864000020633010f000000000002022d1e0000010000240a0134013407000204030200030020c64000001433010f050000000002022d1e00000100c2bb',
)
// A fourth Standard run: rinse=3, spin=Low ("weak"), temp code 2 (30C), 3h
// reservation. Grounds a third TEMPERATURE point (2 -> 30C).
const THIRTY_C_RUN = buf(
    'aa5220ec002414002e002e07000202020300030020c60000000633010f000000000002022d1e0000010000240a0125012507000202020300030020c60000001433010f050000000002022d1e0000010018bb',
)
// A fifth Standard run: rinse=4, spin=Medium, temp code 1 (Cold water), 3h
// reservation. Grounds the fourth and final TEMPERATURE point (1 -> Cold).
const COLD_WATER_RUN = buf(
    'aa5220ec0024060125012507000202020300023920860000000a33010f050000000002022d1e000001000024140039003907000203010400030020c60000000633010f000000000002022d1e000001001bbb',
)
// A sixth Standard run: rinse=5 (model max), spin=Extra high (owner's
// "건조맞춤"), temp code 4 (60C), 3h reservation. Grounds the last spin
// code and rinse count.
const MAX_RINSE_SPIN_RUN = buf(
    'aa5220ec00240a0229022907000205040500030020c60000001433010f050000000002022d1e000001000024170229022907000205040500000020c60000000a33010f050000000002022d1e000001003dbb',
)
// A seventh Standard run: rinse=0/spin=0 (both off), temp code 3 (40C), 4h
// reservation. Confirms 0 is a valid RINSE_0/NO_SPIN value, not a refusal.
const OPTIONS_OFF_RUN = buf(
    'aa5220ec0024140010001007000200030000040020864000000633010f000000000002022d1e0000010000240a0109010907000200030000040020c64000001433010f050000000002022d1e0000010046bb',
)
// The first Quiet (course 9, SILENT) run: rinse=4, spin=Low, temp code 3
// (40C), 3h reservation. Confirms option offsets 4/5/6/7 hold for a second
// course, while offsets 10/12 differ from Standard's own constants.
const QUIET_RUN = buf(
    'aa5220ec0024060109010907000200030000033b20864000000a33010f050000000002022d1e00000100002414003b003b09000202030400030020460000000633010f000000000002022d1e0000010089bb',
)
// A second Quiet run: rinse=1, spin=Low, temp code 4 (60C), still 3h
// reservation. Cross-checks that Quiet's course constants (offsets 10/12)
// stay fixed while only the option bytes move between two Quiet runs.
const QUIET_RUN_2 = buf(
    'aa5220ec0024060014001401000200000000000030060000001733010f050000000000002d1e000001000024140020002009000201040100030020060000000633010f000000000002022d1e00000100dcbb',
)
// A Speedwash (course 8) run: rinse=1, spin=Medium, temp left at 0 (NO_TEMP,
// unselectable per the model's own SPEEDWASH definition), 3h reservation.
const SPEEDWASH_RUN = buf(
    'aa5220ec0024060106010609000201040100030020060000000a33010f010000000002022d1e00000100002414000f000f08000203000100030030c60000010633010f000000000002022d1e000001005abb',
)
// A Colorcare (course 10) run: rinse=3, spin=Low ("weak"), temp code 2 (30C),
// 3h reservation. Colorcare's temp is restricted to Cold/30/40 (no 60) both
// by the owner's report and the model's own COLORCARE.temp.selectable list.
const COLORCARE_RUN = buf(
    'aa5220ec002406000f000f08000203000100023a30860000000a33010f010000000002022d1e00000100002414010201020a000202020300030020060000010633010f000000000002022d1e0000010057bb',
)
// A Rinse+Spin (course 13, RINSE_SPIN) run: rinse=1, spin=Medium ("중"), temp
// fixed off (unselectable, unlike every other captured course), 3h
// reservation. The model's own rinse/spin selectable lists for this course
// both exclude 0/off, matching what the owner reported directly.
const RINSE_SPIN_RUN = buf(
    'aa5220ec002406003b003b0a000202020300023b20060000000a33010f010000000002022d1e0000010000240a001300130d000003000100030020460000000633010f050000000000022d1e0000010073bb',
)
// A Speedboil (course 4, SPEEDBOIL) run: rinse=3, spin=Medium ("중"), temp
// fixed at a new code 5 (95C), 3h reservation. Grounds a fifth TEMPERATURE
// point above the previous 60C maximum; temp cannot be changed for this
// course per the owner's report and the model's SPEEDBOIL.temp shape.
const SPEEDBOIL_RUN = buf(
    'aa5220ec002406001300130d000003000100023a20060000000a33010f050000000000022d1e000001000024140227022704000203050300030020060000000633010f000000000002022d1e000001009dbb',
)
// A Babywear (course 5, BABYWEAR) run: rinse=4, spin=Medium ("중"), temp
// fixed off, 4h reservation. Rinse/spin match Standard/Quiet's full lists;
// temp cannot be changed for this course per the owner's report.
const BABYWEAR_RUN = buf(
    'aa5220ec0024060224022404000203050300000020060000001733010f010000000002022d1e000001000024140123012305000203000400040030060000000633010f000000000002022d1e0000010094bb',
)
// An Allergy Care (course 2, ALLERGYCARE) run: rinse=4, spin=Medium ("중"),
// temp fixed off, 3h reservation. Matches Babywear's shape exactly.
const ALLERGYCARE_RUN = buf(
    'aa5220ec0024060120012005000203000400040030060000000a33010f010000000002022d1e000001000024140123012302000203000400030030060000000633010f000000000002022d1e00000100e2bb',
)
// A Heavy Duty (course 6, HEAVYDUTY) run: rinse=3, spin=Medium ("중"),
// temp=60C, 4h reservation. Temp is restricted to 40/60 for this course per
// the owner's report and the model's own HEAVYDUTY.temp.selectable list.
const HEAVYDUTY_RUN = buf(
    'aa5220ec0024060120012002000203000400030030060000000a33010f010000000002022d1e00000100002414012f012f06000303040300040020060000000633010f000000000002022d1e0000010091bb',
)
// A Functional Wear (course 3, UTILITY) run: rinse=3, spin=Extra low
// ("섬세"), temp fixed off, 3h reservation. Spin is restricted to
// off/Extra low for this course per the owner's report and the model's own
// UTILITY.spin.selectable list.
const FUNCTIONALWEAR_RUN = buf(
    'aa5220ec002406012c012c06000303040300040020060000000a33010f010000000002022d1e000001000024140109010903000201000300030030060000000633010f000000000000002d1e00000100dfbb',
)
// A Duvet (course 11, DUVET) run: rinse=4, spin=Medium ("중"), temp=Cold,
// 3h reservation. Spin restricted to off/Extra low/Low/Medium and temp
// restricted to Cold/30/40 for this course per the owner's report and the
// model's own DUVET.spin/temp.selectable lists.
const DUVET_RUN = buf(
    'aa5220ec0024060106010603000201000300030030060000000a33010f010000000000002d1e00000100002414013401340b000203010400030020060000000633010f000000000002022d1e00000100c0bb',
)
// A Lingerie/Wool (course 12, LINGERIE_WOOL) run: rinse=3, spin=Low ("약"),
// temp=Cold, 4h reservation. Spin restricted to off/Extra low/Low and temp
// to Cold/30/40 per the model's own LINGERIE_WOOL.selectable lists (owner
// reported spin up to Medium, but model limits to Low).
const LINGERIE_WOOL_RUN = buf(
    'aa5220ec002406013401340b000203010400030020060000001433010f000000000002022d1e00000100002414003600360c000202010300040020060000000633010f000000000000002d1e00000100adbb',
)
// A Tub Clean (course 15, TUB_CLEAN) run: rinse=2, spin=Medium, temp=60C,
// 3h reservation. All three option fields are fixed (NO_SELECT) per both
// the model's own TUB_CLEAN definition and the owner's report.
const TUB_CLEAN_RUN = buf(
    'aa5220ec002406003100310c000202010300033720060000010a33010f010000000000002d1e00000100002414020902090f000203040200030020060000020633010f000000000000002d1e000001009ebb',
)
// Real downloadable-course changes captured on 2026-09-10. F025 changed
// record[23] from 15 (Cold Wash) to 4 (Small Load), then back from 4 to 15.
// F026 later started Cold Wash with course=14 (DOWNLOAD).
const SMALL_LOAD_DOWNLOAD = 'aa1df02503150e020300020000108000043400000000000000000084bb'
const COLD_WASH_DOWNLOAD = 'aa1df02503150e0204010300000000000f330000000000000000001bbb'
const SMALL_LOAD_DOWNLOADED = buf(
    'aa5220ec0024000000000000000000000000000000020000070633040f000000000002022d1e0000010000240000000000000000000000000000000200000706340404000000000002022d1e00000100c5bb',
)
const COLD_WASH_DOWNLOADED = buf(
    'aa5220ec00240000000000000000000000000000000200000706340404000000000002022d1e000001000024000000000000000000000000000000020000000633040f000000000002022d1e00000100dcbb',
)
const COLD_WASH_RESERVED_START = 'aa1bf0260e0204010313002000200f33000000000000000000ddbb'
const COLD_WASH_START_NOW = 'aa1bf0260e0204010300002000200f3300000000000000000020bb'
const COLD_WASH_START_7H = 'aa1bf0260e0204010307002000200f3300000000000000000029bb'
const COLD_WASH_RESERVED = buf(
    'aa5220ec002414011401140e000204010300130020460000000533040f000000000002022d1e0000010000240a011001100e000204010300130020460000001433040f010000000002022d1e0000010077bb',
)
// Live Rinsing frames labelled by the owner in the ThinQ app as spin=High,
// temperature=Off and rinse=2, followed by rinse=1. These isolate the status
// record fields at offsets 9, 10 and 11 respectively.
const LIVE_RINSE_2 = buf(
    'aa5220ec00241e000c0104070000040002000000208600007b1733010f010000000002022d1e0000010000241e000b010407000004000200000020860000841733010f010000000002022d1e000001003dbb',
)
const LIVE_RINSE_1 = buf(
    'aa5220ec00241e000b010407000004000200000020860000841733010f010000000002022d1e0000010000241e000a010407000004000100000020860000871733010f010000000002022d1e0000010024bb',
)
const STATUS_REQUEST = 'aa0ef0ed1121010000001800b5bb'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function assertIntact(packet: Buffer) {
    assert.equal(packet[1], packet.length)
    const sum = packet.subarray(0, packet.length - 2).reduce((a, b) => a + b, 0)
    assert.equal(packet[packet.length - 2], (sum & 0xff) ^ 0x55)
}

describe('F24VDD current-state baseline', () => {
    test('real capture fixtures have intact AA/BB envelopes', () => {
        for (const frame of [
            CURRENT,
            POWERING_OFF,
            OFF,
            HISTORICAL_CURRENT,
            STANDARD,
            TEMPERATURE_60,
            DETECTING_RUN,
            RESERVED_STEAM_REFRESH,
            CUSTOM_OPTIONS_RUN,
            THIRTY_C_RUN,
            COLD_WATER_RUN,
            MAX_RINSE_SPIN_RUN,
            OPTIONS_OFF_RUN,
            QUIET_RUN,
            QUIET_RUN_2,
            SPEEDWASH_RUN,
            COLORCARE_RUN,
            RINSE_SPIN_RUN,
            SPEEDBOIL_RUN,
            BABYWEAR_RUN,
            ALLERGYCARE_RUN,
            HEAVYDUTY_RUN,
            FUNCTIONALWEAR_RUN,
            DUVET_RUN,
            LINGERIE_WOOL_RUN,
            TUB_CLEAN_RUN,
            COLD_WASH_RESERVED,
            SMALL_LOAD_DOWNLOADED,
            COLD_WASH_DOWNLOADED,
            buf(SMALL_LOAD_DOWNLOAD),
            buf(COLD_WASH_DOWNLOAD),
            buf(COLD_WASH_RESERVED_START),
            buf(COLD_WASH_START_NOW),
            buf(COLD_WASH_START_7H),
            LIVE_RINSE_2,
            LIVE_RINSE_1,
        ])
            assertIntact(frame)
    })

    test('publishes the currently grounded entities, with power_off writable', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'course',
            'course_select',
            'energy',
            'error',
            'error_message',
            'initial_time',
            'pause',
            'power',
            'power_off',
            'remaining_time',
            'remote_start',
            'reserve_hours',
            'reserve_time',
            'resume',
            'rinse',
            'rinse_count',
            'smart_course',
            'smart_course_select',
            'smart_diagnosis',
            'spin',
            'spin_select',
            'start_course',
            'status',
            'temperature',
            'temperature_select',
        ])
        assert.equal(components.power.platform, 'binary_sensor')
        assert.equal(components.power.icon, 'mdi:power')
        assert.equal(components.smart_diagnosis.device_class, 'problem')
        assert.ok((components.status.options as string[]).includes('Error'))
        assert.ok((components.status.options as string[]).includes('Smart diagnosis'))
        assert.ok(!(components.status.options as string[]).includes('Error auto off'))
        assert.ok(!(components.status.options as string[]).includes('Audible diagnosis'))
        assert.deepEqual(components.smart_course_select.options, ['Small Load', 'Cold Wash'])
        for (const [id, component] of Object.entries(components)) {
            if (
                [
                    'power_off',
                    'pause',
                    'resume',
                    'course_select',
                    'smart_course_select',
                    'reserve_hours',
                    'start_course',
                    'spin_select',
                    'temperature_select',
                    'rinse_count',
                ].includes(id)
            )
                assert.equal(component.command_topic, `$this/${id}/set`)
            else assert.equal(component.command_topic, undefined)
        }
    })

    test('decodes the current captured standby record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CURRENT)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {
            course_select: 'Standard',
            smart_course_select: 'Cold Wash',
            reserve_hours: 0,
            spin_select: 'Extra low',
            temperature_select: '60',
            rinse_count: 1,
            power: 'ON',
            status: 'Standby',
            course: 'None',
            smart_course: 'Cold Wash',
            spin: 'None',
            temperature: 'Off',
            rinse: 0,
            remaining_time: 0,
            initial_time: 0,
            reserve_time: 0,
            error: 'OFF',
            error_message: 'Normal',
            smart_diagnosis: 'OFF',
            energy: 0,
        })
    })

    test('tracks the actually downloaded course from record byte 23', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SMALL_LOAD_DOWNLOADED)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Small Load')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, 'Small Load')

        thinq.emit('data', COLD_WASH_DOWNLOADED)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Cold Wash')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, 'Cold Wash')

        // Synthetic unknown-id guard based on the captured Cold Wash envelope.
        // An unrecognised downloaded-course id must not publish a smart_course
        // value outside SMART_COURSE.options — the safe behaviour is to leave
        // the last known reading in place rather than guess or clear it.
        const unknown = Buffer.from(COLD_WASH_DOWNLOADED)
        unknown[66] = 99 // AA/len + inner current-record offset 41 + record byte 23
        const sum = unknown.subarray(0, unknown.length - 2).reduce((a, b) => a + b, 0)
        unknown[unknown.length - 2] = (sum & 0xff) ^ 0x55
        thinq.emit('data', unknown)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Cold Wash')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, 'Cold Wash')
    })

    test('decodes the user-labelled Standard course with its captured 33-minute estimate', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Standard')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 33)
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 33)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 40)
    })

    test('maps the isolated Standard-course 40C to 60C transition (via the ThinQ app, not the panel)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STANDARD)
        thinq.emit('data', TEMPERATURE_60)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 60)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 55)
        assert.equal(ha.devices[DEVICE_ID].properties.initial_time, 55)
    })

    test('decodes owner-labelled live rinse/spin/temperature status and rinse countdown', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LIVE_RINSE_2)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Rinsing')
        assert.equal(ha.devices[DEVICE_ID].properties.spin, 'High')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.rinse, 2)

        thinq.emit('data', LIVE_RINSE_1)
        assert.equal(ha.devices[DEVICE_ID].properties.rinse, 1)
    })

    test('physical power-on changes the captured D8 heartbeat from 0 to 1', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HEARTBEAT_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        thinq.emit('data', HEARTBEAT_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
    })

    test('uses the current record in a real EB-to-EC power-off transition', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', POWERING_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')

        thinq.emit('data', OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')
    })

    test('unknown changing tail bytes do not corrupt the grounded baseline', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HISTORICAL_CURRENT)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby')
        assert.equal(ha.devices[DEVICE_ID].properties.error, 'OFF')
    })

    test('ignores other AABB payload shapes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CURRENT)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', buf('aa083100240052bb'))
        assert.deepEqual({ ...ha.devices[DEVICE_ID].properties }, before)
    })

    test('start sends only the captured read-only status query', () => {
        const { thinq, dev } = makeDevice()
        dev.start()
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), STATUS_REQUEST)
    })

    test('HA write power_off reproduces the frame captured from a real remote power-off', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('power_off', 'OFF')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa09f0240101009cbb')
    })

    test('remote_start heartbeat C8=OFF / C9=ON', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', Buffer.from('aa09207200c80058bb', 'hex'))
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'OFF')
        thinq.emit('data', Buffer.from('aa09207200c9005bbb', 'hex'))
        assert.equal(ha.devices[DEVICE_ID].properties.remote_start, 'ON')
    })
    test('HA write power=ON is refused: no ON command was ever captured', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 0)
    })

    test('HA write to an unknown property emits no packet', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('nonsense', 'ON')
        assert.equal(thinq.outbox.length, 0)
    })

    test('decodes a real Start (rinse=1, spin=delicate, temp=60C) into Detecting', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DETECTING_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Detecting')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Standard')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 60)
    })

    test('HA write pause reproduces the checksum-verified frame captured mid-run', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('pause', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa09f02404010099bb')
    })

    test('HA write resume with the default selection reproduces the captured Standard resume frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070201040100002080000500000000000000000000dabb')
    })

    test('HA write start_course with the default selection reproduces the captured Standard start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070201040100002080200500000000000000000000fabb')
    })

    test('HA smart-course selection and Start reproduce the separately captured Cold Wash commands', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Cold Wash')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            [COLD_WASH_DOWNLOAD],
        )
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, 'Cold Wash')

        thinq.resetRecorder()
        dev.setProperty('reserve_hours', '19')
        dev.setProperty('start_course', '')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            [COLD_WASH_RESERVED_START],
        )
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course, 'Cold Wash')
    })

    test('HA can download Small Load but refuses to start it without a captured F026 frame', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Small Load')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            [SMALL_LOAD_DOWNLOAD],
        )
        assert.equal(ha.devices[DEVICE_ID].properties.smart_course_select, 'Small Load')

        thinq.resetRecorder()
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('smart-course Resume is refused because no downloadable-course resume frame was captured', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Cold Wash')
        thinq.resetRecorder()
        dev.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('selecting a normal course after a smart course makes normal Start win again', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Cold Wash')
        thinq.resetRecorder()
        dev.setProperty('course_select', 'Standard')
        dev.setProperty('start_course', '')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            ['aa1bf026070201040100002080200500000000000000000000fabb'],
        )
    })

    test('Cold Wash Start with no reservation preserves the captured zero reserve byte', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Cold Wash')
        thinq.resetRecorder()
        dev.setProperty('start_course', '')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            [COLD_WASH_START_NOW],
        )
    })

    test('Cold Wash Start at an intermediate reservation changes only the reserve byte', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Cold Wash')
        thinq.resetRecorder()
        dev.setProperty('reserve_hours', '7')
        dev.setProperty('start_course', '')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            [COLD_WASH_START_7H],
        )
    })

    test('unknown smart-course input sends nothing and does not take over the normal course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('smart_course_select', 'Not captured')
        assert.equal(thinq.outbox.length, 0)

        dev.setProperty('start_course', '')
        assert.deepEqual(
            thinq.outbox.map((packet) => packet.toString('hex')),
            ['aa1bf026070201040100002080200500000000000000000000fabb'],
        )
    })

    test('HA write course_select then start_course reproduces the captured 19-hour Steam Refresh start', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Steam Refresh')
        dev.setProperty('reserve_hours', '19')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf02601020000001300300020010000000000000000000017bb')
    })

    test('HA write reserve_hours then resume reproduces the captured 5-hour Steam Refresh resume', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Steam Refresh')
        dev.setProperty('reserve_hours', '5')
        dev.setProperty('resume', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf02601020000000500300000010000000000000000000041bb')
    })

    test('HA write course_select with an unknown course does not change the selection', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Download')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // unknown course was rejected, so the previous default (Standard) still started
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070201040100002080200500000000000000000000fabb')
    })

    test('HA write reserve_hours out of the captured 0-19 range is refused', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('reserve_hours', '20')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // out-of-range write was rejected, so the default (0) is still what starts
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070201040100002080200500000000000000000000fabb')
    })

    test('decodes the captured Cold Wash reservation as a downloaded course', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COLD_WASH_RESERVED)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Reserved')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Downloaded course')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Cold')
        assert.equal(ha.devices[DEVICE_ID].properties.rinse, 3)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 19 * 60)
    })

    test('decodes a real 19-hour Steam Refresh reservation', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RESERVED_STEAM_REFRESH)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Reserved')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Steam Refresh')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 19 * 60)
    })

    test('decodes a real 3-hour reservation with 40C temperature after a full options change', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', CUSTOM_OPTIONS_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 40)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write spin_select/temperature_select/rinse_count then start_course reproduces the captured frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('spin_select', 'High')
        dev.setProperty('temperature_select', '40')
        dev.setProperty('rinse_count', '2')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070204030203002080200500000000000000000000e0bb')
    })

    test('spin/temperature/rinse writes are refused for a course without a captured options frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Steam Refresh')
        dev.setProperty('spin_select', 'High')
        dev.setProperty('temperature_select', '40')
        dev.setProperty('rinse_count', '2')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // options were tracked locally but not applied to a course outside COURSE_WRITABLE_FIELDS
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260102000000000030002001000000000000000000007abb')
    })

    test('HA write spin_select with an unrecognised value is refused', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('spin_select', 'Ultra Spin')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // rejected write left the default (Extra low) in place
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070201040100002080200500000000000000000000fabb')
    })

    test('HA write rinse_count out of the captured 0-5 range is refused', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('rinse_count', '6')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070201040100002080200500000000000000000000fabb')
    })

    test('decodes a real 30C run (third temperature point)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', THIRTY_C_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 30)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write temperature_select=30 then start_course reproduces the captured 30C frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('spin_select', 'Low')
        dev.setProperty('temperature_select', '30')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070202020303002080200500000000000000000000e6bb')
    })

    test('decodes a real Cold-water run (fourth and final temperature point)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COLD_WATER_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Cold')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write temperature_select=Cold then start_course reproduces the captured cold-water frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('temperature_select', 'Cold')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070203010403002080200500000000000000000000e1bb')
    })

    test('decodes a real rinse=5/spin=Extra high run (last rinse count and spin code)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', MAX_RINSE_SPIN_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 60)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Running')
    })

    test('HA write spin_select=Extra high, rinse_count=5 then start_course reproduces the captured frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('spin_select', 'Extra high')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('rinse_count', '5')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070205040503002080200500000000000000000000efbb')
    })

    test('decodes a real rinse=0/spin=0 (both off) run', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', OPTIONS_OFF_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 40)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 4 * 60)
    })

    test('HA write spin_select=None, rinse_count=0 then start_course reproduces the captured off/off frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('spin_select', 'None')
        dev.setProperty('temperature_select', '40')
        dev.setProperty('rinse_count', '0')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026070200030004002080200500000000000000000000e5bb')
    })

    test('decodes a real Quiet-course (course 9) run', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUIET_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Quiet')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 40)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Quiet with rinse/spin/temp reproduces the captured Quiet start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Quiet')
        dev.setProperty('spin_select', 'Low')
        dev.setProperty('temperature_select', '40')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260902020304030020002007000000000000000000006cbb')
    })

    test('decodes a second real Quiet run with different rinse/spin/temp', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUIET_RUN_2)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Quiet')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 60)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Quiet with a different rinse/spin/temp combo reproduces the second captured frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Quiet')
        dev.setProperty('spin_select', 'Extra low')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('rinse_count', '1')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf02609020104010300200020070000000000000000000063bb')
    })

    test('decodes a real Speedwash (course 8) run with temperature unselectable', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SPEEDWASH_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Speedwash')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Speedwash with rinse/spin reproduces the captured Speedwash start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Speedwash')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '1')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf02608020300010300308020040000000000000000000095bb')
    })

    test('HA write temperature_select for Speedwash is ignored: temp has never been captured varying for it', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Speedwash')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '1')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // temp write was tracked locally but the Speedwash template's own temp byte (0) won
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf02608020300010300308020040000000000000000000095bb')
    })

    test('decodes a real Colorcare (course 10) run', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COLORCARE_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Colorcare')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 30)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Colorcare with rinse/spin/temp reproduces the captured Colorcare start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Colorcare')
        dev.setProperty('spin_select', 'Low')
        dev.setProperty('temperature_select', '30')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260a020202030300200020100000000000000000000014bb')
    })

    test('HA write temperature_select=60 for Colorcare is ignored: 60C is outside its captured Cold/30/40 whitelist', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Colorcare')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('spin_select', 'Low')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // temp write was tracked locally but rejected by the Colorcare whitelist; template's
        // own captured temp byte (2, 30C) is what actually goes out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260a020202030300200020100000000000000000000014bb')
    })

    test('decodes a real Rinse+Spin (course 13) run with temperature fixed off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RINSE_SPIN_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Rinse+Spin')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Rinse+Spin with rinse/spin reproduces the captured Rinse+Spin start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Rinse+Spin')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '1')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260d000300010300200020110000000000000000000015bb')
    })

    test('HA write rinse_count=0/spin_select=None for Rinse+Spin are both ignored: this course has no off value', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Rinse+Spin')
        dev.setProperty('rinse_count', '0')
        dev.setProperty('spin_select', 'None')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // both writes were tracked locally but rejected by the Rinse+Spin whitelist; the
        // template's own captured rinse=1/spin=Medium bytes are what actually go out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260d000300010300200020110000000000000000000015bb')
    })

    test('decodes a real Speedboil (course 4) run with a new 95C temperature point', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', SPEEDBOIL_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Speedboil')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 95)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Speedboil with rinse/spin reproduces the captured Speedboil start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Speedboil')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026040203050303002000200d0000000000000000000069bb')
    })

    test('HA write temperature_select for Speedboil is ignored: 95C cannot be changed for this course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Speedboil')
        dev.setProperty('temperature_select', '30')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // temp write was tracked locally but rejected; the template's own captured 95C byte
        // (5) is what actually goes out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026040203050303002000200d0000000000000000000069bb')
    })

    test('decodes a real Babywear (course 5) run with temperature fixed off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', BABYWEAR_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Babywear')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 4 * 60)
    })

    test('HA write course_select=Babywear with rinse/spin reproduces the captured Babywear start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Babywear')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026050203000404003000200b000000000000000000001dbb')
    })

    test('HA write temperature_select for Babywear is ignored: temperature is fixed off for this course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Babywear')
        dev.setProperty('temperature_select', '30')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // temp write was tracked locally but rejected; the template's own captured off byte
        // (0) is what actually goes out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026050203000404003000200b000000000000000000001dbb')
    })

    test('decodes a real Allergy Care (course 2) run with temperature fixed off', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ALLERGYCARE_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Allergy Care')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Allergy Care with rinse/spin reproduces the captured Allergy Care start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Allergy Care')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260202030004030030002002000000000000000000006ebb')
    })

    test('HA write temperature_select for Allergy Care is ignored: temperature is fixed off for this course', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Allergy Care')
        dev.setProperty('temperature_select', '30')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // temp write was tracked locally but rejected; the template's own captured off byte
        // (0) is what actually goes out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260202030004030030002002000000000000000000006ebb')
    })

    test('decodes a real Heavy Duty (course 6) run', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', HEAVYDUTY_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Heavy Duty')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 60)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 4 * 60)
    })

    test('HA write course_select=Heavy Duty with rinse/spin/temp reproduces the captured Heavy Duty start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Heavy Duty')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026060303040304002000200e0000000000000000000015bb')
    })

    test('HA write temperature_select=Cold for Heavy Duty is ignored: outside its captured 40/60 whitelist', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Heavy Duty')
        dev.setProperty('temperature_select', 'Cold')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // temp write was tracked locally but rejected by the Heavy Duty whitelist; the
        // template's own captured temp byte (4, 60C) is what actually goes out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf026060303040304002000200e0000000000000000000015bb')
    })

    test('decodes a real Functional Wear (course 3) run with restricted spin options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FUNCTIONALWEAR_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Functional Wear')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Off')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Functional Wear with rinse/spin reproduces the captured Functional Wear start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Functional Wear')
        dev.setProperty('spin_select', 'Extra low')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260302010003030030002003000000000000000000006fbb')
    })

    test('HA write spin_select=Medium/temperature_select for Functional Wear are both ignored: outside their whitelists', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Functional Wear')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('temperature_select', '30')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // both writes were tracked locally but rejected by the Functional Wear whitelist;
        // the template's own captured spin=Extra low/temp=off bytes are what actually go out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260302010003030030002003000000000000000000006fbb')
    })

    test('decodes a real Duvet (course 11) run with restricted spin/temp options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DUVET_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Duvet')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Cold')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Duvet with rinse/spin/temp reproduces the captured Duvet start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Duvet')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('temperature_select', 'Cold')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260b020301040300200020090000000000000000000069bb')
    })

    test('HA write spin_select=High/temperature_select=60 for Duvet are both ignored: outside their whitelists', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Duvet')
        dev.setProperty('spin_select', 'High')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('rinse_count', '4')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // both writes were tracked locally but rejected by the Duvet whitelist; the
        // template's own captured spin=Medium/temp=Cold bytes are what actually go out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260b020301040300200020090000000000000000000069bb')
    })

    test('decodes a real Lingerie/Wool (course 12) run with restricted spin/temp options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LINGERIE_WOOL_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Lingerie/Wool')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 'Cold')
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 4 * 60)
    })

    test('HA write course_select=Lingerie/Wool with rinse/spin/temp reproduces the captured Lingerie/Wool start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Lingerie/Wool')
        dev.setProperty('spin_select', 'Low')
        dev.setProperty('temperature_select', 'Cold')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260c02020103040020002008000000000000000000006ebb')
    })

    test('HA write spin_select=Medium/temperature_select=60 for Lingerie/Wool are both ignored: outside their whitelists', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Lingerie/Wool')
        dev.setProperty('spin_select', 'Medium')
        dev.setProperty('temperature_select', '60')
        dev.setProperty('rinse_count', '3')
        dev.setProperty('reserve_hours', '4')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // Medium (3) is not in Lingerie/Wool spin whitelist [0,1,2] per model, and 60 is not in temp [1,2,3]; both rejected
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260c02020103040020002008000000000000000000006ebb')
    })

    test('decodes a real Tub Clean (course 15) run with all options fixed', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TUB_CLEAN_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'Tub Clean')
        assert.equal(ha.devices[DEVICE_ID].properties.temperature, 60)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time, 3 * 60)
    })

    test('HA write course_select=Tub Clean reproduces the captured Tub Clean start frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Tub Clean')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260f0203040203002000200a0000000000000000000017bb')
    })

    test('HA write rinse/spin/temp for Tub Clean are all ignored: all fields fixed', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Tub Clean')
        dev.setProperty('rinse_count', '5')
        dev.setProperty('spin_select', 'Extra high')
        dev.setProperty('temperature_select', 'Cold')
        dev.setProperty('reserve_hours', '3')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        // all three writes rejected by empty whitelists; template's fixed rinse=2/spin=Medium/temp=60C is what goes out
        assert.equal(thinq.outbox[0].toString('hex'), 'aa1bf0260f0203040203002000200a0000000000000000000017bb')
    })
})
