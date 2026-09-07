import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FAKPK21021 as Washer, BDH_D39301_KR as Dryer } from '@/cloud/devices/washtower'
import {
    buildWashtowerControlFrame,
    buildWashtowerDownloadPayload,
    buildWashtowerExtendedFrame,
    buildWashtowerStartPayload,
    DRYER_MODEL,
    isWashtowerPowerOnSuccess,
    selectCurrentWashtowerRecord,
    WASHER_MODEL,
    WASH_TOWER_SIMPLE_CONTROLS,
    type WashTowerModel,
} from '@/cloud/devices/washtower'
import type HADevice from '@/cloud/devices/base'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import { setFilter } from '@/util/logging'

// 2026-07-28 running add-on log, packet-only sanitized (no UUID/SSID/secret).
const WASHER_EB = Buffer.from(
    'aaff330a005500bc84000100eb004300000000000000000000000000000000000002005e01009a000000001a0400000000000000410000300000000000000400006000000000000000f00000000408000000fc1cbb',
    'hex',
)
const DRYER_EB = Buffer.from(
    'aaff340a0044006320000100eb003200000000000000000000000000000100000000040000008f20000000070000870100000000000000000000000000000000008343bb',
    'hex',
)
const DRYER_EC = Buffer.from(
    'aaff340a0076008217000100ec006400000000000000000000000000010000000000040000008f200000800700008701000000000000000000000000000000000000000000000000000000000000010000000000040000008f20000082070000870100000000000000000000000000000000008320bb',
    'hex',
)
const DRYER_POWER_ON_E6 = Buffer.from(
    'aa3f34e6000201ff01020000000000000000000000000000000100000000040000008f00000000070000870100000000000000000000000000000000007ebb',
    'hex',
)

function make(
    Driver: new (HA: ReturnType<MockHAConnection['asConnection']>, thinq: MockThinq2Device, meta: Metadata) => HADevice,
    modelId: string,
    ha = new MockHAConnection(),
) {
    const meta: Metadata = {
        modelId,
        modelName: modelId,
        swVersion: 'test',
    }
    const thinq = new MockThinq2Device('test-device', meta)
    const dev = new Driver(ha.asConnection(), thinq, meta)
    return { ha, thinq, dev }
}

function setRaw(record: Buffer, model: WashTowerModel, key: string, raw: number) {
    const field = model.fields.find((candidate) => candidate.key === key)!
    if (field.bit === undefined) {
        record.writeUIntBE(raw, field.offset, field.length)
    } else {
        const width = field.bits || 1
        const mask = ((1 << width) - 1) << field.bit
        record[field.offset] = (record[field.offset] & ~mask) | ((raw << field.bit) & mask)
    }
}

function label(model: WashTowerModel, key: string, raw: number) {
    return model.fields.find((field) => field.key === key)!.values![String(raw)]
}

function powerOnResponse(model: WashTowerModel, returnCode = 0, snapshot = Buffer.alloc(0)) {
    const frame = Buffer.concat([
        Buffer.from([0xaa, 13 + snapshot.length, model.tag, 0xe6, 0x00, 0x02, 0x01, 0xff, 0x01, 0x02, returnCode]),
        snapshot,
        Buffer.from([0, 0xbb]),
    ])
    frame[frame.length - 2] = (frame.subarray(0, -2).reduce((sum, byte) => sum + byte, 0) & 0xff) ^ 0x55
    return frame
}

describe('WashTower official codec', () => {
    test('real short 0xEB captures publish only the hand-picked HA surface', () => {
        const washer = make(Washer, 'FAKPK21021')
        washer.thinq.emit('data', WASHER_EB)
        assert.deepEqual(Object.keys(washer.ha.devices['test-device'].properties).sort(), [
            'child_lock',
            'course',
            'door',
            'door_lock',
            'error',
            'initial_time',
            'power',
            'power_transition',
            'remaining_time',
            'remote_maintain',
            'remote_start',
            'reserve_time',
            'setting_course',
            'setting_fresh_care',
            'setting_rinse',
            'setting_soil_wash',
            'setting_spin',
            'setting_steam',
            'setting_temp',
            'setting_turbo_wash',
            'state',
        ])
        assert.equal(washer.ha.devices['test-device'].properties.state, 'On')
        assert.equal(washer.ha.devices['test-device'].properties.error, 'No error')
        assert.equal(washer.ha.devices['test-device'].properties.door, 'On')

        const dryer = make(Dryer, 'BDH_D39301_KR')
        dryer.thinq.emit('data', DRYER_EB)
        assert.deepEqual(Object.keys(dryer.ha.devices['test-device'].properties).sort(), [
            'child_lock',
            'course',
            'door_lock',
            'error',
            'initial_time',
            'power',
            'power_transition',
            'remaining_time',
            'remote_maintain',
            'remote_start',
            'reserve_time',
            'setting_course',
            'setting_dry_level',
            'setting_eco_hybrid',
            'setting_steam',
            'setting_wrinkle_care',
            'state',
        ])
        assert.equal(dryer.ha.devices['test-device'].properties.state, 'Power off')
        assert.equal(dryer.ha.devices['test-device'].properties.error, 'No error')
    })

    test('frame builder reproduces both real 0xEB captures byte-for-byte', () => {
        assert.deepEqual(buildWashtowerExtendedFrame(0x33, 0xeb, WASHER_EB.subarray(15, -3), 0x84bc), WASHER_EB)
        assert.deepEqual(buildWashtowerExtendedFrame(0x34, 0xeb, DRYER_EB.subarray(15, -3), 0x2063), DRYER_EB)
    })

    test('captured short dryer 0xEC selects the current record and publishes live controls', () => {
        assert.equal(DRYER_EC.readUInt16BE(13), DRYER_MODEL.liveRecordLength * 2)
        assert.deepEqual(
            selectCurrentWashtowerRecord(DRYER_EC, DRYER_MODEL),
            DRYER_EC.subarray(15 + DRYER_MODEL.liveRecordLength, -3),
        )

        const dryer = make(Dryer, 'BDH_D39301_KR')
        dryer.thinq.emit('data', DRYER_EC)
        assert.equal(dryer.ha.devices['test-device'].properties.state, 'On')
        assert.equal(dryer.ha.devices['test-device'].properties.remote_maintain, 'On')
        assert.equal(dryer.ha.devices['test-device'].properties.power, 'ON')
    })

    test('washer 0xEC distinguishes exact short and full previous+current layouts', () => {
        for (const recordLength of [WASHER_MODEL.liveRecordLength, WASHER_MODEL.recordLength]) {
            const previous = Buffer.alloc(recordLength)
            const current = Buffer.alloc(recordLength)
            setRaw(previous, WASHER_MODEL, 'state', 0)
            setRaw(current, WASHER_MODEL, 'state', 1)
            current[recordLength - 1] = recordLength
            const frame = buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xec, Buffer.concat([previous, current]))
            assert.deepEqual(selectCurrentWashtowerRecord(frame, WASHER_MODEL), current)
        }

        const mixed = Buffer.alloc(WASHER_MODEL.liveRecordLength + WASHER_MODEL.recordLength)
        assert.equal(
            selectCurrentWashtowerRecord(buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xec, mixed), WASHER_MODEL),
            undefined,
        )
    })

    test('0xEC accepts exactly two official short or full records and selects current', () => {
        for (const model of [WASHER_MODEL, DRYER_MODEL]) {
            for (const recordLength of [model.liveRecordLength, model.recordLength]) {
                const previous = Buffer.alloc(recordLength)
                const current = Buffer.alloc(recordLength)
                setRaw(previous, model, 'state', 0)
                setRaw(current, model, 'state', 1)
                const frame = buildWashtowerExtendedFrame(model.tag, 0xec, Buffer.concat([previous, current]))
                assert.deepEqual(selectCurrentWashtowerRecord(frame, model), current)
                assert.equal(
                    selectCurrentWashtowerRecord(buildWashtowerExtendedFrame(model.tag, 0xec, current), model),
                    undefined,
                )
            }
        }
    })

    test('both models reject a wrong tag, three 0xEC records, and a trailing byte', () => {
        for (const model of [WASHER_MODEL, DRYER_MODEL]) {
            const record = Buffer.alloc(model.recordLength)
            const twoRecords = Buffer.concat([record, record])
            const wrongTag = model.tag === WASHER_MODEL.tag ? DRYER_MODEL.tag : WASHER_MODEL.tag
            const invalid = [
                buildWashtowerExtendedFrame(wrongTag, 0xec, twoRecords),
                buildWashtowerExtendedFrame(model.tag, 0xec, Buffer.concat([twoRecords, record])),
                buildWashtowerExtendedFrame(model.tag, 0xec, Buffer.concat([twoRecords, Buffer.from([0])])),
            ]

            for (const frame of invalid) assert.equal(selectCurrentWashtowerRecord(frame, model), undefined)
        }
    })

    test('course lists, heartbeat, ACK, unknown FID, bad CRC and bad length are ignored', () => {
        const { ha, thinq } = make(Washer, 'FAKPK21021')
        const invalid = [
            Buffer.from('aa0733c302fcbb', 'hex'),
            Buffer.from('aa083300240000bb', 'hex'),
            buildWashtowerExtendedFrame(0x33, 0x0a86, Buffer.alloc(72)),
            buildWashtowerExtendedFrame(0x33, 0xeb, Buffer.alloc(66)),
            Buffer.from(WASHER_EB),
        ]
        invalid[invalid.length - 1][invalid[invalid.length - 1].length - 2] ^= 1
        for (const frame of invalid) thinq.emit('data', frame)
        assert.deepEqual(ha.devices['test-device'].properties, {})
    })

    test('discovery is lean and gives public values correct HA semantics', () => {
        for (const [Driver, modelId, name] of [
            [Washer, 'FAKPK21021', 'LG WashTower Washer'],
            [Dryer, 'BDH_D39301_KR', 'LG WashTower Dryer'],
        ] as const) {
            const { ha } = make(Driver, modelId)
            const config = ha.devices['test-device'].config!
            assert.equal(config.device.name, name)
            const power = config.components.power as unknown as
                | { platform: string; state_topic: string; command_topic: string }
                | undefined
            assert.ok(power)
            assert.equal(power.platform, 'switch')
            assert.equal(power.state_topic, '$this/power')
            assert.equal(power.command_topic, '$this/power/set')
            assert.equal(config.components.wake.name, 'Exit power-save')
            assert.equal(config.components.power.name, 'Power')
            assert.equal(config.components.power_transition.name, 'Power transition state')
            assert.equal(config.components.remote_maintain.name, 'Keep remote start')
            assert.equal(config.components.send_course, undefined)
            assert.equal(config.components.start_course.name, 'Start course')
            for (const key of ['reserve_time', 'remaining_time', 'initial_time']) {
                assert.equal(config.components[key].device_class, 'duration')
                assert.equal(config.components[key].unit_of_measurement, 'min')
            }
            for (const key of ['state', 'course', 'error']) {
                assert.equal(config.components[key].device_class, 'enum')
                assert.ok((config.components[key].options as string[]).includes('unknown'))
            }
            assert.ok(Object.keys(config.components).length <= (modelId === 'FAKPK21021' ? 25 : 22))
            for (const component of Object.values(config.components)) {
                if (typeof component.name === 'string') assert.match(component.name, /[A-Za-z]/)
            }
        }
    })

    test('course selects expose only control-enabled built-in model courses', () => {
        const washer = make(Washer, 'FAKPK21021').ha.devices['test-device'].config!.components.setting_course as {
            options?: string[]
        }
        const dryer = make(Dryer, 'BDH_D39301_KR').ha.devices['test-device'].config!.components.setting_course as {
            options?: string[]
        }
        assert.deepEqual(washer.options, ['Bedding', 'Standard', 'Small Quick', 'Eco Boil', 'Tub Sterilize', 'AI Wash'])
        assert.deepEqual(dryer.options, [
            'Steam Refresh',
            'Bedding',
            'Standard',
            'Small Quick',
            'Bedding shake',
            'Steam Sterilize',
            'Condenser Care',
            'Tub Sterilize',
            'Timed Dry',
            'AI Dry',
        ])
    })

    test('dryer Course raw 2 publishes the English towels label', () => {
        const { ha, thinq } = make(Dryer, 'BDH_D39301_KR')
        const record = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(record, DRYER_MODEL, 'course', 2)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, record))
        assert.equal(ha.devices['test-device'].properties.course, 'Towels')
    })

    test('unknown public enum values use the exact safe fallback', () => {
        const { ha, thinq } = make(Dryer, 'BDH_D39301_KR')
        const record = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(record, DRYER_MODEL, 'state', 250)
        setRaw(record, DRYER_MODEL, 'course', 250)
        setRaw(record, DRYER_MODEL, 'error', 250)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, record))
        assert.equal(ha.devices['test-device'].properties.state, 'unknown')
        assert.equal(ha.devices['test-device'].properties.course, 'unknown')
        assert.equal(ha.devices['test-device'].properties.error, 'unknown')
    })
})

describe('WashTower official control frame', () => {
    test('power-on/wake/off/stop/remoteMaintain frames are byte exact', () => {
        const expected = {
            powerOn: 'aa0df0e5000201ff010201c7bb',
            statusQuery: 'aa12f0ed1121010000001804111200005ebb',
            wake: 'aa08f02a010098bb',
            off: 'aa09f0240101009cbb',
            stop: 'aa09f02404010099bb',
            remoteMaintainOn: 'aa09f0241001018cbb',
            remoteMaintainOff: 'aa09f0241001008dbb',
        }
        for (const key of [
            'powerOn',
            'statusQuery',
            'wake',
            'off',
            'stop',
            'remoteMaintainOn',
            'remoteMaintainOff',
        ] as const) {
            const command = WASH_TOWER_SIMPLE_CONTROLS[key]
            assert.equal(buildWashtowerControlFrame(command.frameId, command.payload).toString('hex'), expected[key])
        }
    })

    test('power-on E6 accepts only the three explicit official response shapes', () => {
        assert.equal(DRYER_POWER_ON_E6.length, 13 + DRYER_MODEL.liveRecordLength)
        assert.equal(isWashtowerPowerOnSuccess(DRYER_POWER_ON_E6, DRYER_MODEL), true)

        for (const model of [WASHER_MODEL, DRYER_MODEL]) {
            assert.equal(isWashtowerPowerOnSuccess(powerOnResponse(model), model), true)
            assert.equal(
                isWashtowerPowerOnSuccess(powerOnResponse(model, 0, Buffer.alloc(model.liveRecordLength)), model),
                true,
            )
            assert.equal(
                isWashtowerPowerOnSuccess(powerOnResponse(model, 0, Buffer.alloc(model.recordLength)), model),
                true,
            )
            assert.equal(isWashtowerPowerOnSuccess(powerOnResponse(model, 0, Buffer.alloc(1)), model), false)
            assert.equal(
                isWashtowerPowerOnSuccess(powerOnResponse(model, 0, Buffer.alloc(model.liveRecordLength - 1)), model),
                false,
            )
        }

        assert.equal(isWashtowerPowerOnSuccess(DRYER_POWER_ON_E6.subarray(0, -1), DRYER_MODEL), false)
    })

    test('WMDownload builders reproduce official offsets and option bit packing', () => {
        const washer = new Map<string, number>([
            ['course', 46],
            ['soilWash', 3],
            ['spin', 6],
            ['temp', 3],
            ['rinse', 2],
            ['turboWash', 1],
            ['freshCare', 1],
            ['remoteStart', 1],
        ])
        assert.equal(
            buildWashtowerDownloadPayload(WASHER_MODEL, washer).toString('hex'),
            '03152e0306030200002000402e00000000000000000000',
        )
        const dryer = new Map<string, number>([
            ['course', 7],
            ['ecoHybrid', 2],
            ['moreLessTime', 5],
            ['reserveTimeMinute', 30],
            ['wrinkleCare', 1],
            ['remoteStart', 1],
            ['dryLevel', 4],
        ])
        assert.equal(
            buildWashtowerDownloadPayload(DRYER_MODEL, dryer).toString('hex'),
            '03150002050000001e0800000700000000040000000000',
        )
        assert.equal(
            buildWashtowerControlFrame(0x25, buildWashtowerDownloadPayload(WASHER_MODEL, washer)).toString('hex'),
            'aa1df02503152e0306030200002000402e00000000000000000000ebbb',
        )
    })

    test('WMStart builders reproduce official model lengths, offsets and option bit packing', () => {
        const washer = new Map<string, number>([
            ['course', 46],
            ['soilWash', 3],
            ['spin', 6],
            ['temp', 3],
            ['rinse', 2],
            ['reserveTimeMinute', 30],
            ['turboWash', 1],
            ['freshCare', 1],
            ['downloadCourse', 9],
            ['dryLevel', 4],
        ])
        const washerPayload = buildWashtowerStartPayload(WASHER_MODEL, washer)
        assert.equal(washerPayload.length, 21)
        assert.equal(washerPayload.toString('hex'), '2e0306030200002000402e09000000040000000000')

        const dryer = new Map<string, number>([
            ['course', 7],
            ['dryLevel', 4],
            ['ecoHybrid', 2],
            ['moreLessTime', 5],
            ['reserveTimeMinute', 30],
            ['wrinkleCare', 1],
            ['downloadCourse', 9],
        ])
        const dryerPayload = buildWashtowerStartPayload(DRYER_MODEL, dryer)
        assert.equal(dryerPayload.length, 14)
        assert.equal(dryerPayload.toString('hex'), '070402050000001e000800000900')
        assert.equal(
            buildWashtowerControlFrame(0x26, washerPayload).toString('hex'),
            'aa1bf0262e0306030200002000402e09000000040000000000e7bb',
        )
        assert.equal(
            buildWashtowerControlFrame(0x26, dryerPayload).toString('hex'),
            'aa14f026070402050000001e00080000090040bb',
        )
    })

    test('state/remote gates reject unsafe commands without optimistic actual-state echo', () => {
        const { ha, thinq, dev } = make(Washer, 'FAKPK21021')
        const off = Buffer.alloc(WASHER_MODEL.recordLength)
        setRaw(off, WASHER_MODEL, 'state', 0)
        thinq.emit('data', buildWashtowerExtendedFrame(0x33, 0xeb, off))
        dev.setProperty('wake', '')
        assert.equal(thinq.outbox.length, 1)
        const before = ha.devices['test-device'].properties.state
        dev.setProperty('off', '')
        dev.setProperty('stop', '')
        dev.setProperty('send_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(ha.devices['test-device'].properties.state, before)
    })

    test('all packet commands fail closed as Status unknown before the first valid state observation', () => {
        const commands = [
            ['wake', ''],
            ['power', 'ON'],
            ['power', 'OFF'],
            ['remote_maintain', 'On'],
            ['remote_maintain', 'Off'],
            ['send_course', ''],
            ['start_course', ''],
            ['off', ''],
            ['stop', ''],
        ] as const
        // Rejections go through the logging utility, which writes via console.log. The test mocks
        // disable the log filter globally, so turn it back on for this capture.
        const originalLog = console.log
        const logged: string[] = []
        console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '))
        setFilter(() => true)
        try {
            for (const [Driver, modelId, deviceName] of [
                [Washer, 'FAKPK21021', 'LG WashTower Washer'],
                [Dryer, 'BDH_D39301_KR', 'LG WashTower Dryer'],
            ] as const) {
                const { thinq, dev } = make(Driver, modelId)
                logged.length = 0
                for (const [prop, value] of commands) dev.setProperty(prop, value)
                assert.equal(thinq.outbox.length, 0, deviceName)
                for (const [prop] of commands) {
                    const message =
                        prop === 'send_course'
                            ? 'Built-in course can only be applied via the start-course command'
                            : 'Status unknown'
                    assert.ok(
                        logged.some((line) => line.includes(deviceName) && line.includes(message)),
                        `${deviceName}: ${prop} -> ${message}`,
                    )
                }
            }
        } finally {
            console.log = originalLog
            setFilter(() => false)
        }
    })

    test('power switch uses vtCtrl power for ON, preserves state echo, and remote-gates OFF', () => {
        for (const [Driver, model, modelId] of [
            [Washer, WASHER_MODEL, 'FAKPK21021'],
            [Dryer, DRYER_MODEL, 'BDH_D39301_KR'],
        ] as const) {
            const { ha, thinq, dev } = make(Driver, modelId)
            const record = Buffer.alloc(model.recordLength)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            assert.equal(ha.devices['test-device'].properties.power, 'OFF')

            dev.setProperty('power', 'ON')
            assert.equal(thinq.outbox[thinq.outbox.length - 1]!.toString('hex'), 'aa0df0e5000201ff010201c7bb')
            assert.equal(ha.devices['test-device'].properties.power, 'OFF')

            setRaw(record, model, 'state', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            assert.equal(ha.devices['test-device'].properties.power, 'ON')
            dev.setProperty('power', 'OFF')
            assert.equal(thinq.outbox.length, 1)

            setRaw(record, model, 'remoteStart', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            dev.setProperty('power', 'OFF')
            assert.equal(thinq.outbox[thinq.outbox.length - 1]!.toString('hex'), 'aa09f0240101009cbb')
            assert.equal(ha.devices['test-device'].properties.power, 'ON')
        }
    })

    test('power-on pending suppresses duplicate ON and a strict successful E6 triggers one best-effort refresh', () => {
        for (const [Driver, model, modelId] of [
            [Washer, WASHER_MODEL, 'FAKPK21021'],
            [Dryer, DRYER_MODEL, 'BDH_D39301_KR'],
        ] as const) {
            const { ha, thinq, dev } = make(Driver, modelId)
            const record = Buffer.alloc(model.recordLength)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Standby')

            dev.setProperty('power', 'ON')
            dev.setProperty('power', 'ON')
            assert.equal(thinq.outbox.length, 1)
            assert.equal(thinq.outbox[0].toString('hex'), 'aa0df0e5000201ff010201c7bb')
            assert.equal(ha.devices['test-device'].properties.power, 'OFF')
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Turning on')

            const malformed = [
                Buffer.from(powerOnResponse(model).map((byte, index) => (index === 2 ? byte ^ 1 : byte))),
                Buffer.from(powerOnResponse(model).map((byte, index) => (index === 11 ? byte ^ 1 : byte))),
                powerOnResponse(model, 1),
            ]
            for (const frame of malformed) {
                assert.equal(isWashtowerPowerOnSuccess(frame, model), false)
                thinq.emit('data', frame)
            }
            assert.equal(thinq.outbox.length, 1)

            const success = powerOnResponse(model)
            assert.equal(isWashtowerPowerOnSuccess(success, model), true)
            thinq.emit('data', success)
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Command accepted')
            thinq.emit('data', success)
            dev.setProperty('power', 'ON')
            assert.equal(thinq.outbox.length, 2)
            assert.equal(thinq.outbox[1].toString('hex'), 'aa12f0ed1121010000001804111200005ebb')

            setRaw(record, model, 'state', 1)
            thinq.emit(
                'data',
                buildWashtowerExtendedFrame(
                    model.tag,
                    model === DRYER_MODEL ? 0xec : 0xeb,
                    model === DRYER_MODEL ? Buffer.concat([Buffer.alloc(model.recordLength), record]) : record,
                ),
            )
            assert.equal(ha.devices['test-device'].properties.power, 'ON')
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Complete')
            setRaw(record, model, 'state', 0)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Complete')
        }
    })

    test('power-on pending times out at 120s with fake time and allows one new attempt', () => {
        const originalNow = Date.now
        const originalSetTimeout = globalThis.setTimeout
        const originalClearTimeout = globalThis.clearTimeout
        let now = 1_000
        let timeoutCallback: (() => void) | undefined
        let clearTimeoutCalls = 0
        Date.now = () => now
        globalThis.setTimeout = ((callback: () => void) => {
            timeoutCallback = callback
            return 1 as unknown as NodeJS.Timeout
        }) as typeof setTimeout
        globalThis.clearTimeout = (() => {
            clearTimeoutCalls++
        }) as typeof clearTimeout
        try {
            const { ha, thinq, dev } = make(Washer, 'FAKPK21021')
            const off = Buffer.alloc(WASHER_MODEL.recordLength)
            thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, off))
            dev.setProperty('power', 'ON')
            assert.equal(thinq.outbox.length, 1)

            now += 119_999
            dev.setProperty('power', 'ON')
            assert.equal(thinq.outbox.length, 1)

            now += 1
            timeoutCallback!()
            assert.equal(ha.devices['test-device'].properties.power, 'OFF')
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Timeout')
            thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, off))
            assert.equal(ha.devices['test-device'].properties.power_transition, 'Timeout')

            dev.setProperty('power', 'ON')
            assert.equal(thinq.outbox.length, 2)
            assert.equal(thinq.outbox[1].toString('hex'), 'aa0df0e5000201ff010201c7bb')
            dev.drop()
            assert.equal(clearTimeoutCalls, 1)
        } finally {
            Date.now = originalNow
            globalThis.setTimeout = originalSetTimeout
            globalThis.clearTimeout = originalClearTimeout
        }
    })

    test('failed power-on send does not leave a stuck pending attempt', () => {
        const { thinq, dev } = make(Washer, 'FAKPK21021')
        const off = Buffer.alloc(WASHER_MODEL.recordLength)
        thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, off))
        const sendPacket = thinq.send_packet.bind(thinq)
        let fail = true
        thinq.send_packet = ((frame: Buffer) => {
            if (fail) {
                fail = false
                throw new Error('synthetic send failure')
            }
            sendPacket(frame)
        }) as typeof thinq.send_packet

        assert.throws(() => dev.setProperty('power', 'ON'), /synthetic send failure/)
        dev.setProperty('power', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa0df0e5000201ff010201c7bb')
        dev.drop()
    })

    test('remoteMaintain follows the POWEROFF/INITIAL state matrix without remoteStart and remains non-optimistic', () => {
        for (const [Driver, model, modelId] of [
            [Washer, WASHER_MODEL, 'FAKPK21021'],
            [Dryer, DRYER_MODEL, 'BDH_D39301_KR'],
        ] as const) {
            const { ha, thinq, dev } = make(Driver, modelId)
            const record = Buffer.alloc(model.recordLength)
            setRaw(record, model, 'state', 0)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            assert.equal(ha.devices['test-device'].properties.remote_maintain, 'Off')

            dev.setProperty('remote_maintain', 'On')
            assert.equal(thinq.outbox[0]!.toString('hex'), 'aa09f0241001018cbb')
            assert.equal(ha.devices['test-device'].properties.remote_maintain, 'Off')
            dev.setProperty('remote_maintain', 'Off')
            assert.equal(thinq.outbox.length, 1)

            setRaw(record, model, 'state', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            dev.setProperty('remote_maintain', 'On')
            dev.setProperty('remote_maintain', 'Off')
            assert.equal(thinq.outbox[1]!.toString('hex'), 'aa09f0241001018cbb')
            assert.equal(thinq.outbox[2]!.toString('hex'), 'aa09f0241001008dbb')
            assert.equal(ha.devices['test-device'].properties.remote_maintain, 'Off')

            thinq.emit('data', Buffer.from(`aa08${model.tag.toString(16)}00240000bb`, 'hex'))
            assert.equal(ha.devices['test-device'].properties.remote_maintain, 'Off')

            setRaw(record, model, 'state', 2)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            dev.setProperty('remote_maintain', 'On')
            dev.setProperty('remote_maintain', 'Off')
            assert.equal(thinq.outbox.length, 3)
        }
    })

    test('observed remoteMaintain keeps stop and OFF available after remoteStart drops', () => {
        for (const [Driver, model, modelId] of [
            [Washer, WASHER_MODEL, 'FAKPK21021'],
            [Dryer, DRYER_MODEL, 'BDH_D39301_KR'],
        ] as const) {
            for (const prop of ['off', 'stop', 'power'] as const) {
                const { thinq, dev } = make(Driver, modelId)
                const record = Buffer.alloc(model.recordLength)
                setRaw(record, model, 'state', 1)
                setRaw(record, model, 'remoteStart', 1)
                setRaw(record, model, 'remoteMaintain', 1)
                thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))

                setRaw(record, model, 'state', 2)
                setRaw(record, model, 'remoteStart', 0)
                thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
                dev.setProperty(prop, prop === 'power' ? 'OFF' : '')

                assert.equal(thinq.outbox.length, 1, `${model.deviceName} ${prop}`)
                assert.equal(
                    thinq.outbox[0].toString('hex'),
                    prop === 'stop' ? 'aa09f02404010099bb' : 'aa09f0240101009cbb',
                )
            }
        }
    })

    test('gate matrix: send_course is unsupported and start needs INITIAL, valid draft, and actual remoteStart', () => {
        const attempt = (
            Driver: typeof Washer | typeof Dryer,
            model: WashTowerModel,
            prop: 'send_course' | 'start_course',
            state: number,
            remoteKey?: 'remoteStart' | 'remoteMaintain',
            validDraft = true,
        ) => {
            const { thinq, dev } = make(Driver, model === WASHER_MODEL ? 'FAKPK21021' : 'BDH_D39301_KR')
            const record = Buffer.alloc(model.recordLength)
            setRaw(record, model, 'state', state)
            if (remoteKey) setRaw(record, model, remoteKey, 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, record))
            if (validDraft) {
                dev.setProperty('setting_course', label(model, 'course', model === WASHER_MODEL ? 46 : 7))
            } else if (model === WASHER_MODEL) {
                dev.setProperty('setting_temp', label(model, 'temp', 6))
            } else {
                dev.setProperty('setting_eco_hybrid', label(model, 'ecoHybrid', 0))
            }
            dev.setProperty(prop, '')
            return thinq.outbox.length
        }

        for (const [Driver, model] of [
            [Washer, WASHER_MODEL],
            [Dryer, DRYER_MODEL],
        ] as const) {
            assert.equal(attempt(Driver, model, 'send_course', 1), 0)
            assert.equal(attempt(Driver, model, 'send_course', 0, 'remoteStart'), 0)
            assert.equal(attempt(Driver, model, 'send_course', 1, undefined, false), 0)

            assert.equal(attempt(Driver, model, 'start_course', 1), 0)
            assert.equal(attempt(Driver, model, 'start_course', 1, 'remoteStart'), 1)
            assert.equal(attempt(Driver, model, 'start_course', 1, 'remoteMaintain'), 0)
            assert.equal(attempt(Driver, model, 'start_course', 2, 'remoteStart'), 0)
            assert.equal(attempt(Driver, model, 'start_course', 1, 'remoteStart', false), 0)
        }
    })

    test('restart reconciles a retained staged course to NORMAL without sending and starts the valid default draft', () => {
        const ha = new MockHAConnection()
        const previous = make(Dryer, 'BDH_D39301_KR', ha)
        previous.dev.setProperty('setting_course', label(DRYER_MODEL, 'course', 15))
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Bedding shake')

        const restarted = make(Dryer, 'BDH_D39301_KR', ha)
        const ready = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(ready, DRYER_MODEL, 'state', 1)
        setRaw(ready, DRYER_MODEL, 'remoteStart', 1)
        setRaw(ready, DRYER_MODEL, 'course', 0)
        restarted.thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, ready))

        assert.equal(restarted.thinq.outbox.length, 0)
        assert.equal(ha.devices['test-device'].properties.course, 'None')
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Standard')
        for (const key of [
            'setting_course',
            'setting_eco_hybrid',
            'setting_wrinkle_care',
            'setting_steam',
            'setting_dry_level',
        ])
            assert.match(String(ha.devices['test-device'].properties[key]), /[A-Za-z]/, key)

        restarted.dev.setProperty('start_course', '')
        const expectedDraft = new Map<string, number>([
            ['course', 7],
            ['dryLevel', 3],
            ['ecoHybrid', 2],
            ['moreLessTime', 0],
            ['reserveTimeMinute', 0],
            ['steam', 0],
            ['wrinkleCare', 0],
            ['baseDownloadCourseData', 0],
            ['downloadCourse', 0],
        ])
        assert.deepEqual(restarted.thinq.outbox, [
            buildWashtowerControlFrame(0x26, buildWashtowerStartPayload(DRYER_MODEL, expectedDraft)),
        ])
    })

    test('first supported telemetry initializes its official draft and later telemetry preserves a user-dirty draft', () => {
        const { ha, thinq, dev } = make(Dryer, 'BDH_D39301_KR')
        const ready = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(ready, DRYER_MODEL, 'state', 1)
        setRaw(ready, DRYER_MODEL, 'remoteStart', 1)
        setRaw(ready, DRYER_MODEL, 'course', 15)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, ready))

        assert.equal(thinq.outbox.length, 0)
        assert.equal(ha.devices['test-device'].properties.course, 'Bedding shake')
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Bedding shake')
        assert.equal(ha.devices['test-device'].properties.setting_eco_hybrid, label(DRYER_MODEL, 'ecoHybrid', 2))

        dev.setProperty('setting_course', label(DRYER_MODEL, 'course', 7))
        dev.setProperty('setting_dry_level', label(DRYER_MODEL, 'dryLevel', 4))
        setRaw(ready, DRYER_MODEL, 'course', 15)
        setRaw(ready, DRYER_MODEL, 'dryLevel', 0)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, ready))

        assert.equal(ha.devices['test-device'].properties.course, 'Bedding shake')
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Standard')
        assert.equal(ha.devices['test-device'].properties.setting_dry_level, label(DRYER_MODEL, 'dryLevel', 4))
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][4], 7)
        assert.equal(thinq.outbox[0][5], 4)
    })

    test('a course selected before first telemetry survives NOT_SELECTED reconciliation', () => {
        const { ha, thinq, dev } = make(Dryer, 'BDH_D39301_KR')
        dev.setProperty('setting_course', label(DRYER_MODEL, 'course', 15))
        const ready = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(ready, DRYER_MODEL, 'state', 1)
        setRaw(ready, DRYER_MODEL, 'remoteStart', 1)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, ready))

        assert.equal(thinq.outbox.length, 0)
        assert.equal(ha.devices['test-device'].properties.course, 'None')
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Bedding shake')
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][4], 15)
    })

    test('a compatible dryer option selected before first telemetry is preserved in the reconciled F026 draft', () => {
        const { ha, thinq, dev } = make(Dryer, 'BDH_D39301_KR')
        dev.setProperty('setting_dry_level', label(DRYER_MODEL, 'dryLevel', 4))
        const ready = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(ready, DRYER_MODEL, 'state', 1)
        setRaw(ready, DRYER_MODEL, 'remoteStart', 1)
        setRaw(ready, DRYER_MODEL, 'course', 7)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, ready))

        assert.equal(thinq.outbox.length, 0)
        assert.equal(ha.devices['test-device'].properties.course, 'Standard')
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Standard')
        assert.equal(ha.devices['test-device'].properties.setting_dry_level, label(DRYER_MODEL, 'dryLevel', 4))
        for (const key of [
            'setting_course',
            'setting_eco_hybrid',
            'setting_wrinkle_care',
            'setting_steam',
            'setting_dry_level',
        ])
            assert.equal(typeof ha.devices['test-device'].properties[key], 'string', key)

        dev.setProperty('start_course', '')
        const expectedDraft = new Map<string, number>([
            ['course', 7],
            ['dryLevel', 4],
            ['ecoHybrid', 2],
            ['moreLessTime', 0],
            ['reserveTimeMinute', 0],
            ['steam', 0],
            ['wrinkleCare', 0],
            ['baseDownloadCourseData', 0],
            ['downloadCourse', 0],
        ])
        assert.deepEqual(thinq.outbox, [
            buildWashtowerControlFrame(0x26, buildWashtowerStartPayload(DRYER_MODEL, expectedDraft)),
        ])
    })

    test('an incompatible washer option selected before first telemetry stays visible and start fails closed', () => {
        const { ha, thinq, dev } = make(Washer, 'FAKPK21021')
        dev.setProperty('setting_temp', label(WASHER_MODEL, 'temp', 6))
        const ready = Buffer.alloc(WASHER_MODEL.recordLength)
        setRaw(ready, WASHER_MODEL, 'state', 1)
        setRaw(ready, WASHER_MODEL, 'remoteStart', 1)
        thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, ready))

        assert.equal(thinq.outbox.length, 0)
        assert.equal(ha.devices['test-device'].properties.course, 'None')
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Standard')
        assert.equal(ha.devices['test-device'].properties.setting_temp, label(WASHER_MODEL, 'temp', 6))
        for (const key of [
            'setting_course',
            'setting_soil_wash',
            'setting_spin',
            'setting_temp',
            'setting_rinse',
            'setting_fresh_care',
            'setting_steam',
            'setting_turbo_wash',
        ])
            assert.equal(typeof ha.devices['test-device'].properties[key], 'string', key)

        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 0)
        assert.equal(ha.devices['test-device'].properties.setting_course, 'Standard')
        assert.equal(ha.devices['test-device'].properties.setting_temp, label(WASHER_MODEL, 'temp', 6))
    })

    test('selected command draft survives interleaved telemetry until start', () => {
        const { thinq, dev } = make(Washer, 'FAKPK21021')
        const ready = Buffer.alloc(WASHER_MODEL.recordLength)
        setRaw(ready, WASHER_MODEL, 'state', 1)
        setRaw(ready, WASHER_MODEL, 'remoteStart', 1)
        setRaw(ready, WASHER_MODEL, 'course', 27)
        setRaw(ready, WASHER_MODEL, 'temp', 8)
        thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, ready))

        dev.setProperty('setting_course', label(WASHER_MODEL, 'course', 46))
        dev.setProperty('setting_temp', label(WASHER_MODEL, 'temp', 5))

        const interleaved = Buffer.from(ready)
        setRaw(interleaved, WASHER_MODEL, 'course', 27)
        setRaw(interleaved, WASHER_MODEL, 'temp', 8)
        thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, interleaved))
        dev.setProperty('start_course', '')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0][3], 0x26)
        assert.equal(thinq.outbox[0][4], 46)
        assert.equal(thinq.outbox[0][7], 5)
    })

    test('interleaved dryer telemetry still updates non-setting reservation bytes', () => {
        const { thinq, dev } = make(Dryer, 'BDH_D39301_KR')
        const ready = Buffer.alloc(DRYER_MODEL.recordLength)
        setRaw(ready, DRYER_MODEL, 'state', 1)
        setRaw(ready, DRYER_MODEL, 'remoteStart', 1)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, ready))

        dev.setProperty('setting_course', label(DRYER_MODEL, 'course', 7))

        const interleaved = Buffer.from(ready)
        setRaw(interleaved, DRYER_MODEL, 'reserveTimeMinute', 30)
        thinq.emit('data', buildWashtowerExtendedFrame(DRYER_MODEL.tag, 0xeb, interleaved))
        dev.setProperty('start_course', '')

        const expectedDraft = new Map<string, number>([
            ['course', 7],
            ['dryLevel', 3],
            ['ecoHybrid', 2],
            ['moreLessTime', 0],
            ['reserveTimeMinute', 30],
            ['steam', 0],
            ['wrinkleCare', 0],
            ['baseDownloadCourseData', 0],
            ['downloadCourse', 0],
        ])
        assert.equal(thinq.outbox.length, 1)
        assert.deepEqual(
            thinq.outbox[0],
            buildWashtowerControlFrame(0x26, buildWashtowerStartPayload(DRYER_MODEL, expectedDraft)),
        )
    })

    test('washer WMStart rejects observed nonzero reservation time', () => {
        for (const reserveTimeMinute of [1, 0x0100]) {
            const { thinq, dev } = make(Washer, 'FAKPK21021')
            const ready = Buffer.alloc(WASHER_MODEL.recordLength)
            setRaw(ready, WASHER_MODEL, 'state', 1)
            setRaw(ready, WASHER_MODEL, 'remoteStart', 1)
            setRaw(ready, WASHER_MODEL, 'reserveTimeMinute', reserveTimeMinute)
            thinq.emit('data', buildWashtowerExtendedFrame(WASHER_MODEL.tag, 0xeb, ready))

            dev.setProperty('setting_course', label(WASHER_MODEL, 'course', 46))
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 0)
        }
    })

    test('course defaults/selectable and ControlValidator reject every unsafe example', () => {
        const attempt = (
            Driver: typeof Washer | typeof Dryer,
            model: WashTowerModel,
            course: number,
            fieldKey: string,
            raw: number,
        ) => {
            const { thinq, dev } = make(Driver, model === WASHER_MODEL ? 'FAKPK21021' : 'BDH_D39301_KR')
            const ready = Buffer.alloc(model.recordLength)
            setRaw(ready, model, 'state', 1)
            setRaw(ready, model, 'remoteStart', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, ready))
            dev.setProperty('setting_course', label(model, 'course', course))
            const settingKey = fieldKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
            dev.setProperty('setting_' + settingKey, label(model, fieldKey, raw))
            dev.setProperty('start_course', '')
            return thinq.outbox
        }

        assert.equal(attempt(Washer, WASHER_MODEL, 46, 'temp', 6).length, 0) // NORMAL + 95 ℃
        assert.equal(attempt(Washer, WASHER_MODEL, 27, 'spin', 8).length, 0) // DUVET + 1200 rpm
        assert.equal(attempt(Washer, WASHER_MODEL, 85, 'turboWash', 1).length, 0) // TUB_CLEAN override
        assert.equal(attempt(Dryer, DRYER_MODEL, 44, 'dryLevel', 4).length, 0) // AI dry level
        assert.equal(attempt(Dryer, DRYER_MODEL, 9, 'ecoHybrid', 2).length, 0) // QUICKDRY non-TURBO
        assert.equal(attempt(Dryer, DRYER_MODEL, 1, 'steam', 0).length, 0) // REFRESH steam OFF
        assert.equal(attempt(Dryer, DRYER_MODEL, 18, 'wrinkleCare', 1).length, 0) // CONDENSERCARE wrinkle
    })

    test('official positive course combinations start once and do not echo actual state', () => {
        for (const [Driver, model, course, settings] of [
            [Washer, WASHER_MODEL, 46, { temp: 5, spin: 8, turboWash: 0 }],
            [Dryer, DRYER_MODEL, 7, { ecoHybrid: 3, dryLevel: 4, steam: 1 }],
        ] as const) {
            const { ha, thinq, dev } = make(Driver, model === WASHER_MODEL ? 'FAKPK21021' : 'BDH_D39301_KR')
            const ready = Buffer.alloc(model.recordLength)
            setRaw(ready, model, 'state', 1)
            setRaw(ready, model, 'remoteStart', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, ready))
            const stateBefore = ha.devices['test-device'].properties.state
            dev.setProperty('setting_course', label(model, 'course', course))
            for (const [key, raw] of Object.entries(settings))
                dev.setProperty(
                    'setting_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
                    label(model, key, raw),
                )
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1)
            assert.equal(thinq.outbox[0][3], 0x26)
            assert.equal(ha.devices['test-device'].properties.state, stateBefore)
        }
    })

    test('changing course atomically resets fixed defaults before start', () => {
        const { thinq, dev } = make(Washer, 'FAKPK21021')
        const ready = Buffer.alloc(WASHER_MODEL.recordLength)
        setRaw(ready, WASHER_MODEL, 'state', 1)
        setRaw(ready, WASHER_MODEL, 'remoteStart', 1)
        thinq.emit('data', buildWashtowerExtendedFrame(0x33, 0xeb, ready))

        dev.setProperty('setting_course', label(WASHER_MODEL, 'course', 46))
        dev.setProperty('setting_temp', label(WASHER_MODEL, 'temp', 3))
        dev.setProperty('setting_turbo_wash', label(WASHER_MODEL, 'turboWash', 1))
        dev.setProperty('setting_course', label(WASHER_MODEL, 'course', 85))
        dev.setProperty('start_course', '')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].subarray(4, -2).toString('hex'), '550304050200000000005500000000000000000000')
    })

    test('built-in Course stays local, send_course emits nothing, and start emits exact F026 once', () => {
        for (const [Driver, model, modelId, course, expectedFrame] of [
            [Washer, WASHER_MODEL, 'FAKPK21021', 46, 'aa1bf0262e0306030200002000002e0000000000000000000030bb'],
            [Dryer, DRYER_MODEL, 'BDH_D39301_KR', 7, 'aa14f0260703020000000000000000000000b5bb'],
        ] as const) {
            const { thinq, dev } = make(Driver, modelId)
            const ready = Buffer.alloc(model.recordLength)
            setRaw(ready, model, 'state', 1)
            setRaw(ready, model, 'remoteStart', 1)
            setRaw(ready, model, 'baseDownloadCourseData', 9)
            setRaw(ready, model, 'downloadCourse', 9)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, ready))

            dev.setProperty('setting_course', label(model, 'course', course))
            assert.equal(thinq.outbox.length, 0, model.deviceName + ' local draft selection')
            dev.setProperty('send_course', '')
            assert.equal(thinq.outbox.length, 0, model.deviceName + ' unsupported send_course')
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1, model.deviceName + ' WMStart count')
            assert.equal(thinq.outbox[0].toString('hex'), expectedFrame)
        }
    })

    // The individual gates are covered above one at a time. This pins the whole
    // operator journey — Power ON, the appliance's own acknowledgement, the
    // standard course and Start course — as one ordered frame sequence, so a change
    // that keeps every single gate passing but breaks the run still fails here.
    test('Power ON → Standard Course → Start course emits exactly the official frames in order', () => {
        for (const [Driver, model, modelId, standard, startFrame] of [
            [Washer, WASHER_MODEL, 'FAKPK21021', 46, 'aa1bf0262e0306030200002000002e0000000000000000000030bb'],
            [Dryer, DRYER_MODEL, 'BDH_D39301_KR', 7, 'aa14f0260703020000000000000000000000b5bb'],
        ] as const) {
            const { ha, thinq, dev } = make(Driver, modelId)
            const properties = () => ha.devices['test-device'].properties
            assert.equal(label(model, 'course', standard), 'Standard', model.deviceName + ' Standard course index')

            // 1. The appliance reports Power off, so Start course must fail closed.
            const powerOff = Buffer.alloc(model.recordLength)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, powerOff))
            assert.equal(properties().power, 'OFF')
            assert.equal(properties().power_transition, 'Standby')
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 0, model.deviceName + ' start before power on')

            // 2. Power ON, and a second press while the appliance has not answered
            //    must not put a second frame on the wire.
            dev.setProperty('power', 'ON')
            assert.equal(properties().power_transition, 'Turning on')
            assert.equal(properties().power, 'OFF', model.deviceName + ' no optimistic power echo')
            dev.setProperty('power', 'ON')

            // 3. The appliance acknowledges, which buys exactly one state refresh.
            thinq.emit('data', powerOnResponse(model))
            thinq.emit('data', powerOnResponse(model))

            // 4. It then reports On with Remote start armed.
            const ready = Buffer.alloc(model.recordLength)
            setRaw(ready, model, 'state', 1)
            setRaw(ready, model, 'remoteStart', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(model.tag, 0xeb, ready))
            assert.equal(properties().power, 'ON')
            assert.equal(properties().power_transition, 'Complete')
            assert.equal(properties().remote_start, 'On')

            // 5. Standard Course only moves the local draft.
            dev.setProperty('setting_course', 'Standard')
            assert.equal(thinq.outbox.length, 2, model.deviceName + ' course selection is local')

            // 6. Start course.
            dev.setProperty('start_course', '')

            assert.deepEqual(
                thinq.outbox.map((frame) => frame.toString('hex')),
                [
                    'aa0df0e5000201ff010201c7bb', // vtCtrl 0xE5 Power ON
                    'aa12f0ed1121010000001804111200005ebb', // 0xED State Cho x, once
                    startFrame, // WMStart 0x26 Standard Course
                ],
                model.deviceName + ' full journey frames',
            )
            assert.equal(properties().state, 'On', model.deviceName + ' no optimistic state echo')
        }
    })

    test('dryer fixed steam defaults pass for REFRESH, ALLERGYCARE and TUBCLEAN', () => {
        for (const course of [1, 16, 19]) {
            const { thinq, dev } = make(Dryer, 'BDH_D39301_KR')
            const ready = Buffer.alloc(DRYER_MODEL.recordLength)
            setRaw(ready, DRYER_MODEL, 'state', 1)
            setRaw(ready, DRYER_MODEL, 'remoteStart', 1)
            thinq.emit('data', buildWashtowerExtendedFrame(0x34, 0xeb, ready))
            dev.setProperty('setting_course', label(DRYER_MODEL, 'course', course))
            dev.setProperty('start_course', '')
            assert.equal(thinq.outbox.length, 1)
        }
    })
})
