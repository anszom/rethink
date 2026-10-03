import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import DUT from '@/cloud/devices/F_V7_Y___W.A__QEUK'
import Bridge from '@/cloud/ha_bridge'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const ID = 'test-washer'
const META = { modelId: 'F_V7_Y___W.A__QEUK', modelName: 'WV5-1275W', swVersion: 'test' }
type Event = { packet?: string; direction?: string; type?: string; lg?: Record<string, unknown> }
function fixture(name: string): Event[] {
    return JSON.parse(readFileSync(new URL(`../../fixtures/F_V7_Y___W.A__QEUK/${name}.json`, import.meta.url), 'utf8'))
}
function setup() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, META)
    const bridge = new Bridge(ha.asConnection())
    bridge.newDevice(thinq)
    const device = bridge.haDevices.get(ID) as DUT
    const set = (component: string, value: string) => ha.setProperty(ID, component, 'command', value)
    const press = (component: string) => set(component, 'PRESS')
    const receive = (e: Event) => {
        if (e.packet && e.direction !== 'toDevice') thinq.emit('data', Buffer.from(e.packet, 'hex'))
    }
    const report = (name: string, matches: (record: Buffer) => boolean) => {
        const e = fixture(name).find(
            (e) =>
                e.direction !== 'toDevice' &&
                e.packet?.slice(4, 8) === '20ec' &&
                matches(Buffer.from(e.packet!, 'hex').subarray(34, -2)),
        )
        assert.ok(e, 'fixture has the required real status report')
        receive(e)
    }
    return { ha, thinq, device, bridge, set, press, receive, report, properties: ha.devices[ID].properties }
}
const outgoing = (events: Event[], type: string) =>
    events.filter((e) => e.direction === 'toDevice' && e.type === 'packet' && e.packet?.slice(4, 8) === type)

test('current-course Start keeps panel settings, with LG rather than HA door-lock flags', () => {
    const { thinq, report, press } = setup()
    report('controls', (r) => r[2] === 1 && r[7] === 1 && r[10] === 9 && r[11] === 4)
    press('start')
    const captured = Buffer.from(outgoing(fixture('start-pause-resume'), 'f026')[0].packet!, 'hex')
    const generated = thinq.outbox[0]
    // HA echoed the door-lock bit (0x43); LG's captured custom and delayed starts use 0x03.
    // Every setting byte is identical; the checksum must change with that one flag.
    assert.equal(captured[14], 0x43)
    assert.equal(generated[14], 3)
    captured[14] &= ~0x40
    captured[captured.length - 2] = (captured.subarray(0, -2).reduce((s, b) => s + b, 0) & 255) ^ 0x55
    assert.deepEqual(generated, captured)
})

test('failed command replies are logged without changing state or automatically retrying', (t) => {
    const warning = t.mock.method(console, 'warn', () => {})
    const { thinq, press, receive, properties } = setup()
    press('power_off')
    const before = { ...properties }
    // Captured success response, with only the result changed to exercise a rejection.
    const reply = Buffer.from(fixture('controls').find((e) => e.packet?.slice(4, 12) === '20002400')!.packet!, 'hex')
    reply[5] = 1
    reply[6] = (reply.subarray(0, -2).reduce((s, b) => s + b, 0) & 255) ^ 0x55
    receive({ direction: 'fromDevice', packet: reply.toString('hex') })
    assert.equal(warning.mock.callCount(), 1)
    assert.deepEqual(properties, before)
    assert.equal(thinq.outbox.length, 1)
})

test('standby is separate from Idle; Wake up matches LG and only reports clear standby', () => {
    const { thinq, receive, press, properties, set } = setup()
    const events = fixture('standby-wake')
    const wake = outgoing(events, 'f02a')[0]
    assert.ok(wake)
    for (const e of events) {
        if (e === wake) break
        receive(e)
    }
    assert.equal(properties.status, 'Idle')
    assert.equal(properties.standby, 'ON')
    assert.equal(properties.remote_start, 'ON')
    set('wake_up', 'ON')
    assert.equal(thinq.outbox.length, 0)
    press('wake_up')
    assert.equal(thinq.outbox.length, 1)
    assert.equal(thinq.outbox[0].toString('hex'), wake.packet)
    assert.equal(properties.standby, 'ON', 'sending Wake up does not claim the washer is awake')
    const response = events.find((e) => e.packet?.slice(4, 12) === '20002a00')!
    assert.ok(response)
    receive(response)
    assert.equal(properties.standby, 'ON', 'acknowledgement alone is not a fresh state')
    const awake = events.find((e) => {
        if (e.packet?.slice(4, 8) !== '20ec') return false
        const r = Buffer.from(e.packet, 'hex').subarray(34, -2)
        return r[2] === 1 && r[29] === 0
    })!
    assert.ok(awake)
    receive(awake)
    assert.equal(properties.status, 'Idle')
    assert.equal(properties.standby, 'OFF')
    assert.equal(properties.remote_start, 'ON')
    assert.equal(thinq.outbox.length, 1, 'fresh awake state never starts a queued wash')
    thinq.emit('close')
    press('wake_up')
    assert.equal(thinq.outbox.length, 1, 'no wake on a disconnected device')
})

test('native cycles finish, Tub Clean resets the counter, and standby is distinct from power-off', () => {
    const { receive, properties, thinq } = setup()
    let tubFinished = false,
        counterReset = false,
        standbyAfterTub = false
    let quickRunning = false,
        quickFinished = false,
        quickPoweredOff = false,
        counterAdvanced = false
    for (const e of fixture('native-controls')) {
        receive(e)
        if (properties.course === 'Tub Clean' && properties.status === 'Finished') tubFinished = true
        if (tubFinished && properties.tub_clean_count === 0) counterReset = true
        if (counterReset && properties.standby === 'ON') {
            standbyAfterTub = true
            assert.equal(properties.remote_start, 'ON')
        }
        if (properties.course === 'Quick 30' && properties.status === 'Washing') {
            quickRunning = true
            assert.equal(properties.spin, 0)
            assert.equal(properties.standby, 'OFF')
        }
        if (quickRunning && properties.course === 'Quick 30' && properties.status === 'Finished') {
            quickFinished = true
            assert.equal(properties.completed, 'ON')
            assert.equal(properties.remaining_time, 0)
        }
        if (quickFinished && properties.status === 'Off') {
            quickPoweredOff = true
            assert.equal(properties.power, 'OFF')
            assert.equal(properties.remote_start, 'OFF')
            assert.equal(properties.standby, 'OFF')
        }
        if (quickPoweredOff && properties.tub_clean_count === 1) counterAdvanced = true
    }
    assert.ok(tubFinished && counterReset && standbyAfterTub)
    assert.ok(quickRunning && quickFinished && quickPoweredOff && counterAdvanced)
    assert.equal(thinq.outbox.length, 0, 'replaying sensor reports never actuates the washer')
})

test('only the five basic commands are discovered; unsupported controls cannot send packets', () => {
    const { ha, thinq } = setup()
    const components = ha.devices[ID].config!.components
    const controls = Object.entries(components).filter(([, c]) => !['sensor', 'binary_sensor'].includes(c.platform))
    assert.deepEqual(controls.map(([key]) => key).sort(), ['pause', 'power_off', 'resume', 'start', 'wake_up'])
    for (const [, c] of controls) assert.equal(c.platform, 'button')
    for (const [key, value] of [
        ['download', 'PRESS'],
        ['diagnosis', 'PRESS'],
        ['start_programme', 'Cotton'],
        ['start_delay', '3 h'],
        ['start', 'ON'],
    ])
        ha.emit('setProperty', ID, key, value)
    assert.equal(thinq.outbox.length, 0)
})

test('Pause and Resume match captured requests and preserve the reported cycle', () => {
    const { thinq, press, receive, properties } = setup()
    let count = 0
    for (const e of fixture('start-pause-resume')) {
        if (e.direction === 'toDevice' && e.type === 'packet') {
            const type = e.packet!.slice(4, 8)
            if (type === 'f024') press('pause')
            else if (type === 'f026' && properties.status === 'Paused') press('resume')
            else continue // The initial HA Start is tested separately.
            assert.equal(thinq.outbox[count++].toString('hex'), e.packet)
        } else receive(e)
    }
    assert.equal(count, 2)
    assert.equal(properties.status, 'Washing')
})

test('Power off matches the captured cancellation and changes state only on the washer report', () => {
    const { thinq, press, receive, properties } = setup()
    const events = fixture('controls')
    const off = outgoing(events, 'f024')[0]
    for (const e of events) {
        if (e === off) {
            assert.equal(properties.status, 'Delayed')
            press('power_off')
            assert.equal(thinq.outbox[0].toString('hex'), off.packet)
            assert.equal(properties.status, 'Delayed')
        } else receive(e)
        if (thinq.outbox.length && properties.status === 'Off') break // Capture later includes physical power-on.
    }
    assert.equal(thinq.outbox.length, 1)
    assert.equal(properties.status, 'Off')
    assert.equal(properties.delay_remaining, 0)
})

test('Start and Resume require a valid snapshot from the current connection', (t) => {
    t.mock.method(console, 'warn', () => {})
    const { thinq, ha, bridge, press, report, receive } = setup()
    press('start')
    press('resume')
    assert.equal(thinq.outbox.length, 0)
    report('controls', (r) => r[2] === 1 && r[7] === 1)
    const invalid = Buffer.from(fixture('controls').find((e) => e.packet?.slice(4, 8) === '20ec')!.packet!, 'hex')
    invalid[41] = 255
    invalid[invalid.length - 2] = (invalid.subarray(0, -2).reduce((s, b) => s + b, 0) & 255) ^ 0x55
    receive({ direction: 'fromDevice', packet: invalid.toString('hex') })
    press('start')
    press('resume')
    assert.equal(thinq.outbox.length, 0, 'an unknown programme invalidates the previous settings')
    thinq.emit('close')
    press('power_off')
    assert.equal(thinq.outbox.length, 0)
    const next = new MockThinq2Device(ID, META)
    bridge.newDevice(next)
    ha.emit('setProperty', ID, 'start', 'PRESS')
    assert.equal(next.outbox.length, 0, 'a new connection must get its own snapshot')
})

test('all 24 captured downloaded programmes decode and can be started using their reported settings', () => {
    const { properties, receive, press, thinq } = setup()
    const reports: { name: string; packet: string }[] = JSON.parse(
        readFileSync(new URL('../../fixtures/F_V7_Y___W.A__QEUK/downloaded-courses.json', import.meta.url), 'utf8'),
    )
    assert.equal(reports.length, 24)
    for (const e of reports) {
        receive(e)
        assert.equal(properties.course, e.name)
        assert.equal(properties.downloaded_course, e.name)
        const r = Buffer.from(e.packet, 'hex').subarray(34, -2)
        for (const command of ['start', 'resume']) {
            const count = thinq.outbox.length
            press(command)
            assert.equal(thinq.outbox.length, count + 1)
            const packet = thinq.outbox[count]
            for (const [out, record] of [
                [4, 7],
                [5, 9],
                [6, 10],
                [7, 11],
                [8, 12],
                [13, 16],
                [16, 22],
            ])
                assert.equal(packet[out], r[record], `${e.name}: setting ${record}`)
            assert.equal(packet[14], command === 'start' ? 3 : 2)
        }
    }
})
