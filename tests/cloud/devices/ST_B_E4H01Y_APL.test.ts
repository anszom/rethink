import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/ST_B_E4H01Y_APL'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'ST_B_E4H01Y_APL'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '2.11.255' }

/*
 * Fixtures.
 *
 * STATE and STATE2 are REAL frames captured from the appliance on 2026-07-28 (same content,
 * different sequence number). The rest are STATE with ONE byte changed and the CRC16 recomputed;
 * every one of them was injected into LG's cloud that day, so what each test expects is LG's own
 * decode of that exact frame.
 */

// Real, appliance idle. LG read this as state POWEROFF, preState INITIAL, course NONE,
// error ERROR_NO, childLock OFF, buzzer BUZZER_4, applyBuzzer ON, applyRemoteMaintain ON,
// remoteMaintain OFF, endMelody END_MELODY_0, currentDownloadCourse1 FUR_LEATHER (78),
// currentDownloadCourseCount 1, TCLCount 37, energyMonitoring 0.
const STATE = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000000000014e420000040300000000000000257205bb',
)
const STATE2 = buf(
    'aaff310a003a005504000100eb002800000000010001000001000000000000200000000000000000014e420000040300000000000000251351bb',
)

const READY = buf(
    'aaff310a003a0053ea000100eb002800000100010001000001000000000000200000000000000000014e42000004030000000000000025969ebb',
) // byte[17]=1 -> state INITIAL
const COURSE_STANDARD = buf(
    'aaff310a003a0053ea000100eb002800000000010001010001000000000000200000000000000000014e42000004030000000000000025ffd9bb',
) // byte[22]=1 -> course STANDARD (id 1)
const ERROR_TE1 = buf(
    'aaff310a003a0053ea000100eb002800000000010001000101000000000000200000000000000000014e420000040300000000000000252b43bb',
) // byte[23]=1 -> error ERROR_TE1
const PRESTATE_RUNNING = buf(
    'aaff310a003a0053ea000100eb002800000000010001000002000000000000200000000000000000014e42000004030000000000000025f05fbb',
) // byte[24]=2 -> preState RUNNING
const FLAGS_A_ALL = buf(
    'aaff310a003a0053ea000100eb0028000000000100010000010000000000000f0000000000000000014e42000004030000000000000025df93bb',
) // byte[31]=0x0f -> childLock + nightDry + initialBit + remoteStart all ON
const REMOTE_MAINTAIN = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000000000014e42000004040000000000000025c3aebb',
) // byte[46]=0x04 -> remoteMaintain ON (and both apply* bits cleared)
const FLAGS_C_ALL = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000000000014e420000040300003f0000000025988abb',
) // byte[49]=0x3f -> isLastCourse + 3x smartCare + smartPairing + currentTimeDisplay all ON
const BUZZER_LOW = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000000000014e42000001030000000000000025b075bb',
) // byte[45]=1 -> buzzer BUZZER_1
const MELODY_1 = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000000000014e4200000403010000000000002535d6bb',
) // byte[47]=1 -> endMelody END_MELODY_1
const ENERGY_HI = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000010000000000014e42000004030000000000000025a7f3bb',
) // byte[34]=1 -> energyMonitoring 256, i.e. the byte is the high half of a 16-bit value
const SMART_COURSE_1 = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000010000014e420000040300000000000000258234bb',
) // byte[37]=1 -> smartCourse PAIRING_PANEL_COURSE (id 1)
const TCL_1 = buf(
    'aaff310a003a0053ea000100eb002800000000010001000001000000000000200000000000000000014e4200000403000000000000000116e3bb',
) // byte[54]=1 -> TCLCount 1

// REAL 98-byte two-record frames, captured 2026-07-28 the moment the appliance was switched on and
// a course selected. LG read these as state INITIAL, course STANDARD, remoteStart ON — while a
// decoder keyed on "58 bytes" was still publishing Power off off the last idle frame. Record B (the
// trailing one) is the current state.
const RUNNING_READY = buf(
    'aaff310a0062005cd0000100ec005000000000010001000001000000000000200000000000000000014e4200000403000000000000002500000100010001000000000000000000200000000000000000014e42000004030000000000000025ee3ebb',
) // record B: state 1 (Standby)
const RUNNING_COURSE = buf(
    'aaff310a0062005ce5000100ec0050000001011e011e0f0000000000000000280000000000000000014e4200000403000000000000002500000100230023010000000000000000280000000000000000014e42000004030000000000000025042abb',
) // record B: state 1, course 1 (Styling Standard), 35 min, flagsA 0x28 -> remoteStart ON
// The downloadable-course name list — 112 bytes, which is NOT a whole number of 40-byte records.
const COURSE_LIST = buf(
    'aaff310a0070005ccc00010a86005e0d053230332d3101073230332d312d3101073230332d312d3201073230332d312d3301073230332d312d34010453542d34010453542d35010453542d36010453542d37010453542d38010453542d39010553542d3130000553542d313201ed79bb',
)

// The 35-byte frame shares the header but is NOT state: probing bytes 9..31 of it with 0xff moved
// no field in LG's snapshot at all.
const NOT_STATE_35 = buf('aaff310a00230053ed000101030011100b0306100000008a00000000000000059317bb')
// Heartbeat.
const HEARTBEAT = buf('aa0731c302f2bb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    /*
     * Writable exactly where a command frame was captured off LG's own capability API and seen to
     * take (CL-0000). Deliberately absent: `remoteControlStatus setRemoteControlType`, which
     * answers CL-0000 but sends the SAME frame for on and off, and course start/pause/resume,
     * which were never driven — an entity for either would be a control that guesses.
     */
    const WRITABLE = new Set([
        'power',
        'buzzer',
        'end_melody',
        'keep_last_course',
        'smart_care_finedust',
        'smart_care_humidity',
        'smart_care_nightcare',
        'night_care_start',
        'night_care_end',
        'remote_maintain',
        'course_select',
        'start_course',
        'pause_course',
        'resume_course',
    ])

    test('exactly the fields with a captured command frame are writable', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [name, comp] of Object.entries(components)) {
            if (comp.unique_id === undefined) continue // a removal, not an entity
            if (WRITABLE.has(name)) {
                assert.equal(comp.command_topic, `$this/${name}/set`, `${name} is writable`)
            } else if (comp.platform === 'button') {
                assert.fail(`${name} is a button with no command topic`)
            } else {
                assert.equal(comp.command_topic, undefined, `${name} stays read-only`)
                assert.ok(
                    comp.platform === 'sensor' || comp.platform === 'binary_sensor',
                    `${name} is a sensor platform, got ${comp.platform}`,
                )
            }
        }
    })

    /*
     * The frames below are REAL. LG's capability API was asked to make each change
     * (`convert/control`; every one answered CL-0000, and the appliance ACKed each with
     * `aa 08 31 00 24 00 …`) and these are the cloud→appliance frames rethink relayed as a
     * result, on 2026-07-28. So the assertion is that this driver emits byte for byte what LG
     * emits — not that it agrees with its own idea of the format.
     *
     * Every option of every enum is here, because a select that offers an option nobody ever
     * drove is shipping a guess for that option.
     */
    test('each write reproduces the frame LG itself sent for that command', () => {
        for (const [prop, value, want] of [
            // POWERON / POWEROFF (controlDataType 0x01)
            ['power', 'ON', 'aa09f0240101019fbb'],
            ['power', 'OFF', 'aa09f0240101009cbb'],
            // UPCENTER 0x13, sub 0x01 ENDMELODY — the value is the melody's index
            ['end_melody', 'Default sound', 'aa0af0241301010088bb'],
            ['end_melody', 'Vivaldi Winter', 'aa0af024130101018bbb'],
            ['end_melody', 'Bach Minuet', 'aa0af024130101028abb'],
            ['end_melody', 'Home Sweet Home', 'aa0af02413010103b5bb'],
            ['end_melody', 'Breeze', 'aa0af02413010104b4bb'],
            ['end_melody', 'Old MacDonald', 'aa0af02413010105b7bb'],
            ['end_melody', 'Verdi Brindisi', 'aa0af02413010106b6bb'],
            ['end_melody', 'Bubble', 'aa0af02413010107b1bb'],
            ['end_melody', 'Beethoven Symphony No.5 5', 'aa0af02413010108b0bb'],
            ['end_melody', 'Arirang', 'aa0af02413010109b3bb'],
            ['end_melody', 'Pachelbel Canon', 'aa0af0241301010ab2bb'],
            ['end_melody', 'Beethoven Choral', 'aa0af0241301010bbdbb'],
            // sub 0x03 UPBUZZER
            ['buzzer', 'Mute', 'aa0af024130103008abb'],
            ['buzzer', 'Small', 'aa0af02413010301b5bb'],
            ['buzzer', 'Normal', 'aa0af02413010302b4bb'],
            ['buzzer', 'Large', 'aa0af02413010303b7bb'],
            ['buzzer', 'Very large', 'aa0af02413010304b6bb'],
            // subs 0x04 / 0x05 / 0x06 — the three smart-care flags
            ['smart_care_finedust', 'ON', 'aa0af02413010401b4bb'],
            ['smart_care_finedust', 'OFF', 'aa0af02413010400b5bb'],
            ['smart_care_humidity', 'ON', 'aa0af02413010501b7bb'],
            ['smart_care_humidity', 'OFF', 'aa0af02413010500b4bb'],
            ['smart_care_nightcare', 'ON', 'aa0af02413010601b6bb'],
            ['smart_care_nightcare', 'OFF', 'aa0af02413010600b7bb'],
            // sub 0x09 CTRL_IS_LAST_COURSE
            ['keep_last_course', 'ON', 'aa0af02413010901b3bb'],
            ['keep_last_course', 'OFF', 'aa0af02413010900b0bb'],
        ] as [string, string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty(prop, value)
            assert.equal(thinq.outbox.length, 1, `${prop}=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `${prop}=${value}`)
        }
    })

    /*
     * Remote control allowed has no LG-emitted ON frame: setRemoteControlType answers CL-0000 for every
     * argument and always emits the OFF frame. The ON frame below was built and sent to the
     * appliance directly on 2026-07-28; it ACKed (`aa 08 31 00 24 00`) and the next state frame
     * came back with the bit set, which is the appliance confirming it and not a guess.
     */
    test('Remote control allowed writes the frame the appliance acknowledged', () => {
        for (const [value, want] of [
            ['ON', 'aa09f0241001018cbb'],
            ['OFF', 'aa09f0241001008dbb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('remote_maintain', value)
            assert.equal(thinq.outbox[0].toString('hex'), want, `remote_maintain=${value}`)
        }
    })

    /*
     * REAL start frames: LG's converter was asked to run Standard and Quick
     * (`operationState startCycle {"cycle":{"id":"1"}}` / `"3"`, both CL-0000) and these are the
     * frames rethink relayed, on 2026-07-28. The appliance ran the course each time.
     *
     * Only two of the twenty-one courses were driven, and the rest of the table is the same rule
     * applied to the same modelJSON declaration — so these two are what proves the rule, and
     * they have to match to the byte, checksum included.
     */
    test('Start course reproduces the frame LG itself sent, for both captured courses', () => {
        for (const [course, want] of [
            [
                'Styling Standard',
                'aa34f02601010004000000000002645a00000005005a05b45a01b4001ab40000000000000000000000000000000000000000fabb',
            ],
            [
                'Styling Quick',
                'aa34f02603010004000000000082645a00000003005a00000001b4000eb4000000000000000000000000000000000000000045bb',
            ],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course_select', course)
            thinq.resetRecorder()
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1, `${course} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, course)
        }
    })

    test('Pause and Resume reproduce their captured frames', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('course_select', 'Styling Standard')
        thinq.resetRecorder()
        dev.setProperty('pause_course', '')
        // PAUSE, LG's controlDataType 0x04, value 0 — exactly modelJSON's pauseCourse dataForm
        assert.equal(thinq.outbox[0].toString('hex'), 'aa09f02404010099bb')
        thinq.resetRecorder()
        dev.setProperty('resume_course', '')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa33f026010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a1bb',
        )
    })

    test('a write shows up straight away instead of waiting for the appliance', () => {
        // The appliance reports on its own schedule — a course start can go a minute without a
        // state frame — so a control that waits for confirmation reads as broken and gets
        // pressed twice. What is published here is overwritten by the next real frame.
        const { ha, thinq, dev } = makeDevice()
        const enabled = Buffer.from(READY)
        enabled[49] |= 0x08 // smartCareNightCare ON
        thinq.emit('data', enabled)
        dev.setProperty('buzzer', 'Small')
        dev.setProperty('smart_care_humidity', 'ON')
        dev.setProperty('night_care_start', '22:30')
        dev.setProperty('course_select', 'Styling Standard')
        dev.setProperty('start_course', '')
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.buzzer, 'Small')
        assert.equal(p.smart_care_humidity, 'ON')
        assert.equal(p.night_care_start, '22:30')
        assert.equal(p.course, 'Styling Standard')
        // ...and the appliance still has the last word.
        thinq.emit('data', enabled)
        assert.equal(p.buzzer, 'Very large')
        assert.equal(p.course, 'None')
    })

    test('a setting rejected while powered off is not optimistically published', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', STATE)
        thinq.resetRecorder()

        dev.setProperty('buzzer', 'Small')
        dev.setProperty('smart_care_humidity', 'ON')
        dev.setProperty('course_select', 'Styling Standard')
        dev.setProperty('start_course', '')

        const p = ha.devices[DEVICE_ID].properties
        assert.equal(thinq.outbox.length, 3, 'commands are still sent so the appliance has the final say')
        assert.equal(p.buzzer, 'Very large')
        assert.equal(p.smart_care_humidity, 'OFF')
        assert.equal(p.course, 'None')
        assert.equal(p.course_select, 'Styling Standard', 'the local-only course choice still updates')
    })

    test('night-care times rejected while night care is disabled are not optimistically published', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', READY)
        thinq.resetRecorder()

        dev.setProperty('night_care_start', '22:30')
        dev.setProperty('night_care_end', '06:00')

        assert.equal(thinq.outbox.length, 2, 'valid command frames are still sent')
        assert.equal(ha.devices[DEVICE_ID].properties.night_care_start, '00:00')
        assert.equal(ha.devices[DEVICE_ID].properties.night_care_end, '00:00')
    })

    test('no setting is optimistically published before the first authoritative state', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('buzzer', 'Small')
        dev.setProperty('course_select', 'Styling Standard')
        dev.setProperty('start_course', '')

        assert.equal(thinq.outbox.length, 2, 'valid frames still reach the appliance')
        assert.equal(ha.devices[DEVICE_ID].properties.buzzer, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.course, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Styling Standard')
    })

    test('a course rejected by a standing error is not optimistically published', () => {
        const { ha, thinq, dev } = makeDevice()
        const poweredError = Buffer.from(ERROR_TE1)
        poweredError[17] = 1 // state INITIAL: powered on while error TE1 is standing
        thinq.emit('data', poweredError)
        thinq.resetRecorder()

        dev.setProperty('course_select', 'Styling Standard')
        dev.setProperty('start_course', '')

        assert.equal(thinq.outbox.length, 1, 'the appliance still receives the valid course frame')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.problem, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
    })

    test('Course select chooses without commanding the appliance', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('course_select', 'Sterilize Standard')
        assert.equal(thinq.outbox.length, 0, 'selecting sends nothing')
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Sterilize Standard')
        // ...and Start course then runs the one that was chosen.
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][4], 11, 'course id 11 leads the block')
    })

    test('a course the appliance is running takes over the selection', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COURSE_STANDARD)
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Styling Standard')
        // Idle it reports NONE, which is no course at all — the last choice has to stand.
        thinq.emit('data', STATE)
        assert.equal(ha.devices[DEVICE_ID].properties.course_select, 'Styling Standard')
    })

    test('an unknown course is refused rather than started', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('course_select', 'InvalidCourse')
        assert.equal(thinq.outbox.length, 0)
    })

    test('the night-care window writes hour and minute in one frame', () => {
        for (const [prop, value, want] of [
            // subs 0x07 / 0x08, valueLength 2 — exactly as LG's own setStartTime/setEndTime sent them
            ['night_care_start', '23:30', 'aa0bf024130207171e4fbb'],
            ['night_care_start', '00:00', 'aa0bf0241302070000b0bb'],
            ['night_care_end', '06:00', 'aa0bf0241302080600b9bb'],
            ['night_care_end', '00:00', 'aa0bf0241302080000b3bb'],
        ] as [string, string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty(prop, value)
            assert.equal(thinq.outbox[0].toString('hex'), want, `${prop}=${value}`)
        }
    })

    test('a time the appliance would refuse is not written', () => {
        // LG's own schema is `^(0[0-9]|1[0-9]|2[0-3]):(00|30)$` — whole and half hours only.
        for (const bad of ['23:45', '24:00', '9:30', 'abc', '', '07:1']) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('night_care_start', bad)
            assert.equal(thinq.outbox.length, 0, `refused ${JSON.stringify(bad)}`)
        }
    })

    test('an unknown option is refused rather than guessed', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('buzzer', 'InvalidVolume')
        dev.setProperty('end_melody', 'Jingle Bells (intro)') // a read label, but not one LG offers here
        dev.setProperty('course', 'Styling Standard') // read-only
        assert.equal(thinq.outbox.length, 0)
    })

    test('the power switch reports OFF as soon as it is switched off', () => {
        // Powered off, this appliance stops sending any frame this driver can decode, so a switch
        // that waited for confirmation would never leave ON.
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', READY)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        dev.setProperty('power', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        // ...and a real frame still has the last word.
        thinq.emit('data', READY)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
    })

    test('every user-facing name and enum option is English', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, { name?: string | null }>
        for (const [key, comp] of Object.entries(components)) {
            if (comp.name == null) continue
            assert.match(comp.name, /[A-Za-z]/, `${key} name is English: ${comp.name}`)
        }
        const p = ha.devices[DEVICE_ID].properties
        for (const key of ['status', 'previous_status', 'course', 'smart_course', 'buzzer', 'end_melody', 'error']) {
            assert.match(String(p[key]), /[A-Za-z]/, `${key} value is English: ${p[key]}`)
        }
    })

    test('real captured frame decodes to what LG read from the same frame', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Power off')
        assert.equal(p.previous_status, 'Standby')
        assert.equal(p.course, 'None')
        assert.equal(p.smart_course, 'None')
        assert.equal(p.error, 'Normal')
        assert.equal(p.remaining, 1)
        assert.equal(p.total, 1)
        assert.equal(p.reserved_at, 'No reservation')
        assert.equal(p.child_lock, 'OFF')
        assert.equal(p.night_dry, 'OFF')
        assert.equal(p.remote_start, 'OFF')
        assert.equal(p.remote_maintain, 'OFF')
        assert.equal(p.buzzer, 'Very large')
        assert.equal(p.end_melody, 'Default sound')
        assert.equal(p.smart_care_finedust, 'OFF')
        assert.equal(p.smart_care_humidity, 'OFF')
        assert.equal(p.smart_care_nightcare, 'OFF')
        assert.equal(p.keep_last_course, 'OFF')
        assert.equal(p.night_care_start, '00:00')
        assert.equal(p.night_care_end, '00:00')
        assert.equal(p.power, 'OFF')
        assert.equal(p.tcl_count, 37)
        assert.equal(p.energy, 0)
        // Slot 1 holds course id 78, which LG names FUR_LEATHER.
        assert.equal(p.download_course, 'Fur/Leather Care')
    })

    test('a second real frame with a different sequence number decodes identically', () => {
        const { ha: a, thinq: ta } = makeDevice()
        ta.emit('data', STATE)
        const { ha: b, thinq: tb } = makeDevice()
        tb.emit('data', STATE2)
        assert.deepEqual(b.devices[DEVICE_ID].properties, a.devices[DEVICE_ID].properties)
    })

    test('each probed offset moves exactly the field LG said it moves', () => {
        for (const [frame, key, want] of [
            [READY, 'status', 'Standby'],
            [COURSE_STANDARD, 'course', 'Styling Standard'],
            [ERROR_TE1, 'error', 'TE1'],
            [PRESTATE_RUNNING, 'previous_status', 'Styling'],
            [BUZZER_LOW, 'buzzer', 'Small'],
            [MELODY_1, 'end_melody', 'Vivaldi Winter'],
            [ENERGY_HI, 'energy', 256],
            [SMART_COURSE_1, 'smart_course', 'Panel course'],
            [TCL_1, 'tcl_count', 1],
            [REMOTE_MAINTAIN, 'remote_maintain', 'ON'],
        ] as [Buffer, string, string | number][]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', STATE)
            thinq.emit('data', frame)
            assert.equal(ha.devices[DEVICE_ID].properties[key], want, `${key} after single-byte probe`)
        }
    })

    /*
     * The state codes are not the declaration order, and believing they were is what published
     * `Code 52` while the appliance was mid-course. Each pair below was measured by injecting that
     * code and reading LG's own name back on 2026-07-28; 10..49 answered NOT_DEFINE_VALUE.
     */
    test('the running-state codes decode, not just the idle ones', () => {
        for (const [code, want] of [
            [0, 'Power off'],
            [3, 'Pause'],
            [9, 'Power-save running'],
            [50, 'Steam preparing'], // PRESTEAM
            [52, 'Refreshing'], // STEAM
            [55, 'Drying'], // DRYING
            [57, 'Sterilizing'], // STERILIZE
            [58, 'Course complete'], // RUNNINGEND
        ] as [number, string][]) {
            const { ha, thinq } = makeDevice()
            const frame = Buffer.from(STATE)
            frame[17] = code
            thinq.emit('data', frame)
            assert.equal(ha.devices[DEVICE_ID].properties.status, want, `state ${code}`)
        }
    })

    test('a code LG itself does not define is shown as a code, not as a wrong name', () => {
        const { ha, thinq } = makeDevice()
        const frame = Buffer.from(STATE)
        frame[17] = 20 // NOT_DEFINE_VALUE on this model
        thinq.emit('data', frame)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Code 20')
    })

    /*
     * Same lesson as the state codes: LG's Error table skips values, so a positional reading
     * drifts from E2 onward. Each pair was measured by injection on 2026-07-28.
     */
    test('the error codes decode, and Water refill is not off by one', () => {
        for (const [code, want, problem] of [
            [0, 'Normal', 'OFF'],
            [8, 'Water refill', 'ON'], // ERROR_E3 — the one that stops a course every day
            [11, 'AE', 'ON'],
            [18, 'LE', 'ON'],
            [23, 'Normal', 'OFF'], // ERROR_NONE, LG's second way of saying nothing is wrong
            [25, 'Water drain', 'ON'],
            [26, 'Door open', 'ON'],
            [34, 'No filter', 'ON'],
            [12, 'Code 12', 'ON'], // NOT_DEFINE_VALUE on this model
        ] as [number, string, string][]) {
            const { ha, thinq } = makeDevice()
            const frame = Buffer.from(STATE)
            frame[23] = code
            thinq.emit('data', frame)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.error, want, `error ${code}`)
            assert.equal(p.problem, problem, `problem for error ${code}`)
        }
    })

    test('byte 31 is a bitfield, not an enum', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FLAGS_A_ALL)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.child_lock, 'ON')
        assert.equal(p.night_dry, 'ON')
        assert.equal(p.remote_start, 'ON')
        // Bit 0x04 (initialBit) is LG's internal first-boot marker and gets no entity; bit 0x20,
        // set in every captured frame, moved no field and is deliberately not decoded.
    })

    test('byte 49 is a bitfield carrying six independent flags', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FLAGS_C_ALL)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.smart_care_finedust, 'ON')
        assert.equal(p.smart_care_humidity, 'ON')
        assert.equal(p.smart_care_nightcare, 'ON')
        assert.equal(p.keep_last_course, 'ON')
    })

    test('the night-care window reads back as two clock times', () => {
        const { ha, thinq } = makeDevice()
        const scheduled = Buffer.from(STATE)
        scheduled[50] = 23 // nightCareStartTime_Hour
        scheduled[51] = 30 // nightCareStartTime_Minute
        scheduled[52] = 6 // nightCareEndTime_Hour
        scheduled[53] = 0 // nightCareEndTime_Minute
        thinq.emit('data', scheduled)
        assert.equal(ha.devices[DEVICE_ID].properties.night_care_start, '23:30')
        assert.equal(ha.devices[DEVICE_ID].properties.night_care_end, '06:00')
    })

    test('the retired night-care summary is published as a removal', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        // Its two settable halves replace it, but dropping it from the config would leave the old
        // entity behind, frozen at whatever it last read.
        assert.deepEqual(components.night_care_window, { platform: 'sensor' })
    })

    test('the 35-byte frame and the heartbeat carry no state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', NOT_STATE_35)
        thinq.emit('data', HEARTBEAT)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('hours and minutes are folded into one duration', () => {
        const { ha, thinq } = makeDevice()
        const running = Buffer.from(STATE)
        running[18] = 1 // remainTimeHour
        running[19] = 25 // remainTimeMinute
        running[20] = 2 // initialTimeHour
        running[21] = 0 // initialTimeMinute
        thinq.emit('data', running)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining, 85)
        assert.equal(ha.devices[DEVICE_ID].properties.total, 120)
    })

    test('a two-record frame is decoded, and it is the LAST record that counts', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE) // idle: 58 bytes, one record
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Power off')
        thinq.emit('data', RUNNING_READY)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'Standby', 'the 98-byte frame must decode')
        thinq.emit('data', RUNNING_COURSE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Standby')
        assert.equal(p.course, 'Styling Standard')
        assert.equal(p.remaining, 35)
        assert.equal(p.total, 35)
        // flagsA 0x28 = the always-set 0x20 bit | 0x08 remoteStart
        assert.equal(p.remote_start, 'ON')
        assert.equal(p.child_lock, 'OFF')
    })

    test('the course-name list frame is not mistaken for state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', COURSE_LIST)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('a set reservation reads as a clock time', () => {
        const { ha, thinq } = makeDevice()
        const reserved = Buffer.from(STATE)
        reserved[29] = 7
        reserved[30] = 5
        thinq.emit('data', reserved)
        assert.equal(ha.devices[DEVICE_ID].properties.reserved_at, '07:05')
    })
})

/*
 * Two failure modes that are invisible from the add-on side: Home Assistant accepts the
 * discovery payload, writes the entity into its registry, and then never creates it. Both cost
 * real entities on the first live rebuild of these drivers.
 */
describe(`${MODEL_ID} discovery contract`, () => {
    test("no read-only component claims entity_category 'config'", () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<
            string,
            { platform?: string; entity_category?: string }
        >
        for (const [name, comp] of Object.entries(components)) {
            if (comp.platform !== 'sensor' && comp.platform !== 'binary_sensor') continue
            assert.notEqual(comp.entity_category, 'config', `${name} must not be entity_category 'config'`)
        }
    })
})
