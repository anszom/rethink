import assert from 'node:assert/strict'
import { test } from 'node:test'
import AABBDevice from '@/cloud/devices/aabb_device'
import HABridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { buf, MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const modelId = 'VIC2_799_US_FACTORY'
const meta: Metadata = { modelId, modelName: modelId, swVersion: '2.8.57', deviceType: '201' }
const CURRENT_RECORD_OFFSET = 29 // Marker in the unframed 0xEC payload

// WM3500CW frames from the bridged capture. Each 0xEC frame contains the previous and current status.
const NORMAL_SELECTED = buf(
    'aa3a20ec001805000000000000000000000000000000000000006a2d0000001805010f010f0500030504020000000000000000006a2d0000debb',
)
const DELICATES_SELECTED = buf(
    'aa3a20ec001805010f010f0500030504020000000000000000006a2d0000001805002900290700030302020000000000000000006a2d0007a0bb',
)
const SPEED_WASH_STARTED = buf(
    'aa3a20ec001805000f000f0900010506010000000000000000006a2d0007001817000f000f0900010506010000000080000000056a2d000730bb',
)
const POWERED_OFF = buf(
    'aa3a20ec001817000f000f0900010506010000000080020000056a2d000700180000010000fe00000000000000000000020000176a2d00006abb',
)
const HEARTBEAT = buf('aa09207200c9005bbb')
const REMOTE_ARMED = buf(
    'aa3a20ec001805000000000000000000000000000080000000006a2d0000001805000000000000000000000000000080020000006a2d00000fbb',
)
const NORMAL_DETECTING = buf(
    'aa3a20ec001805000000000000000000000000000080020000006a2d0000001814010f010f0500030504020000000080020000056a2d0000f6bb',
)
const NORMAL_PAUSED = buf(
    'aa3a20ec001814010f010f0500030504020000000080020000056a2d0000001806010f010f0500030504020000000080020000146a2d0000bebb',
)

function connectWasher() {
    const ha = new MockHAConnection()
    const device = new MockThinq2Device('wm3500cw', meta)
    const bridge = new HABridge(ha.asConnection())
    bridge.newDevice(device)
    return { ha, device, discovery: ha.devices[device.id] }
}

test('requests the status snapshot when the washer connects', () => {
    const { device } = connectWasher()
    assert.deepEqual(device.outbox, [buf('aa0ef0ed1121010000001800b5bb')])
})

test('discovers the WM3500CW and reads the current course, time and settings', () => {
    const { device, discovery } = connectWasher()
    assert.equal(discovery.config?.device.model, 'WM3500CW')

    device.inject(NORMAL_SELECTED)
    assert.equal(discovery.properties.course, 'Normal')
    assert.equal(discovery.properties.remaining_time, 75)
    assert.equal(discovery.properties.initial_time, 75)

    device.inject(DELICATES_SELECTED)
    assert.equal(discovery.properties.course, 'Delicates')
    assert.equal(discovery.properties.remaining_time, 41)
    assert.equal(discovery.properties.temp, 'Cold')
    assert.equal(discovery.properties.spin, 'Medium')

    device.inject(SPEED_WASH_STARTED)
    assert.equal(discovery.properties.power, 'ON')
    assert.equal(discovery.properties.status, 'Washing')
    assert.equal(discovery.properties.course, 'Speed Wash')
    assert.equal(discovery.properties.remaining_time, 15)
    assert.equal(discovery.properties.initial_time, 15)
    assert.equal(discovery.properties.temp, 'Hot')
    assert.equal(discovery.properties.spin, 'High')
    assert.equal(discovery.properties.soil, 'Light')
})

test('uses the High panel label for both ThinQ high-spin codes', () => {
    const { device, discovery } = connectWasher()
    const status = Buffer.from(AABBDevice.unframe(SPEED_WASH_STARTED)!)
    for (const spinCode of [4, 5]) {
        status[CURRENT_RECORD_OFFSET + 9] = spinCode
        device.inject(AABBDevice.frame(status))
        assert.equal(discovery.properties.spin, 'High')
    }
})

test('maps each of the remaining dial positions from the labeled sweep', () => {
    const { device, discovery } = connectWasher()
    const selections = [
        [
            'Perm. Press',
            'aa3a20ec001805010f010f0500030504020000000000000000006a2d0000001805003b003b0600030304020000000000000000006a2d000046bb',
        ],
        [
            'Towels',
            'aa3a20ec001805002900290700030302020000000000000000006a2d0007001805010101010800030504030000000000000000006a2d000088bb',
        ],
        [
            'Downloaded',
            'aa3a20ec001805000f000f0900010506010000000000000000006a2d0007001805012301230a00030502020000000010000000006a2d060052bb',
        ],
        [
            'Tub Clean',
            'aa3a20ec001805012301230a00030502020000000010000000006a2d0600001805011d011d0100000300020000000400000000006a2d000047bb',
        ],
        [
            'Whites',
            'aa3a20ec001805011d011d0100000300020000000400000000006a2d0000001805010c010c0200030506030000000000000000006a2d00009ebb',
        ],
        [
            'Bedding',
            'aa3a20ec001805010c010c0200030506030000000000000000006a2d0000001805010001000300030304020000000000000000006a2d0007c8bb',
        ],
        [
            'Heavy Duty',
            'aa3a20ec001805010001000300030304020000000000000000006a2d0007001805021502150400050504020000000000000000006a2d0000e7bb',
        ],
    ]

    for (const [course, frame] of selections) {
        device.inject(buf(frame))
        assert.equal(discovery.properties.course, course)
    }
})

test('clears the selected course and stale timers when the washer powers off', () => {
    const { device, discovery } = connectWasher()
    device.inject(SPEED_WASH_STARTED)
    device.inject(POWERED_OFF)

    assert.equal(discovery.properties.power, 'OFF')
    assert.equal(discovery.properties.status, 'Off')
    assert.equal(discovery.properties.course, 'None')
    assert.equal(discovery.properties.remaining_time, 0)
    assert.equal(discovery.properties.initial_time, 0)
})

test('reads the rinse count for the selected cycle and clears it on power-off', () => {
    const { device, discovery } = connectWasher()
    device.inject(NORMAL_SELECTED)
    assert.equal(discovery.properties.rinse_count, 2)

    device.inject(SPEED_WASH_STARTED)
    assert.equal(discovery.properties.rinse_count, 1)

    device.inject(POWERED_OFF)
    assert.equal(discovery.properties.rinse_count, 0)
})

test('reports the washer’s Tub Clean count across standby and power-off', () => {
    const { device, discovery } = connectWasher()
    device.inject(NORMAL_SELECTED)
    assert.equal(discovery.properties.tub_clean_count, 45)

    device.inject(POWERED_OFF)
    assert.equal(discovery.properties.tub_clean_count, 45)
})

test('reports the door lock from the lock bit as the cycle starts and the washer powers off', () => {
    const { device, discovery } = connectWasher()
    device.inject(DELICATES_SELECTED)
    assert.equal(discovery.properties.door_lock, 'OFF')

    device.inject(SPEED_WASH_STARTED)
    assert.equal(discovery.properties.door_lock, 'ON')

    device.inject(POWERED_OFF)
    assert.equal(discovery.properties.door_lock, 'OFF')
})

test('acknowledges a heartbeat like the LG cloud without changing the published state', () => {
    const { device, discovery } = connectWasher()
    device.inject(SPEED_WASH_STARTED)
    const washing = { ...discovery.properties }

    device.inject(HEARTBEAT)

    assert.deepEqual(device.sent, [{ cmd: 'ack', type: 1, data: 'AA08F00072044DBB' }])
    assert.deepEqual(discovery.properties, washing)
})

test('reports Pre Wash, Fresh Care and ColdWash from the labeled toggles', () => {
    const { device, discovery } = connectWasher()
    const toggles = [
        [
            'pre_wash',
            'OFF',
            'aa3a20ec001805010a010a0700030302220007004a01000000006a2d0007001805003700370700030302220007004201000000006a2d0007bdbb',
        ],
        [
            'pre_wash',
            'ON',
            'aa3a20ec001805003700370700030302220007004201000000006a2d0007001805010a010a0700030302220007004a01000000006a2d0007bdbb',
        ],
        [
            'fresh_care',
            'OFF',
            'aa3a20ec001805010a010a0700030302220007004a01000000006a2d0007001805010a010a0700030302220007004a00000000006a2d0007c2bb',
        ],
        [
            'fresh_care',
            'ON',
            'aa3a20ec001805010a010a0700030302220007004a00000000006a2d0007001805010a010a0700030302220007004a01000000006a2d0007c2bb',
        ],
        [
            'cold_wash',
            'ON',
            'aa3a20ec001805010a010a0700030302220000004801000001006a2d0007001805010f010f0700030302220000004811000001006a2d0007f7bb',
        ],
        [
            'cold_wash',
            'OFF',
            'aa3a20ec001805010f010f0700030302220000004811000001006a2d0007001805010a010a0700030302220000004801000001006a2d0007f7bb',
        ],
    ]

    for (const [property, state, frame] of toggles) {
        device.inject(buf(frame))
        assert.equal(discovery.properties[property], state, property)
    }
})

test('uses hours for the Delay Wash sensor and publishes the exact total minutes on MQTT', () => {
    const { device, discovery } = connectWasher()
    const delaySensor = discovery.config?.components.reserve_time
    assert.ok(delaySensor && 'unit_of_measurement' in delaySensor)
    assert.equal(delaySensor.unit_of_measurement, 'h')
    const delay8Hours = buf(
        'aa3a20ec001805010a010a0700030302220007004a01000000006a2d0007001805010a010a0700030302220008004a01000001006a2d0007cfbb',
    )
    const delay19Hours = buf(
        'aa3a20ec001805010a010a0700030302220012004a01000001006a2d0007001805010a010a0700030302220013004a01000001006a2d0007e4bb',
    )
    const noDelay = buf(
        'aa3a20ec001805010a010a0700030302220013004a01000001006a2d0007001805010a010a0700030302220000004801000001006a2d0007c8bb',
    )

    device.inject(delay8Hours)
    assert.equal(discovery.properties.delay_wash, 'ON')
    assert.equal(discovery.properties.reserve_time, 480)
    const delay8Hours5Minutes = Buffer.from(AABBDevice.unframe(delay8Hours)!)
    delay8Hours5Minutes[CURRENT_RECORD_OFFSET + 14] = 5
    device.inject(AABBDevice.frame(delay8Hours5Minutes))
    assert.equal(discovery.properties.reserve_time, 485)
    device.inject(delay19Hours)
    assert.equal(discovery.properties.reserve_time, 1140)
    device.inject(noDelay)
    assert.equal(discovery.properties.delay_wash, 'OFF')
    assert.equal(discovery.properties.reserve_time, 0)
})

test('reports all four Extra Rinse settings separately from the base rinse count', () => {
    const { device, discovery } = connectWasher()
    const selections = [
        [
            3,
            'aa3a20ec001805010a010a0700030302220000004801000001006a2d0007001805011101110700030302320000004801000001006a2d0007f3bb',
        ],
        [
            0,
            'aa3a20ec001805011101110700030302320000004801000001006a2d0007001805003800380700030302020000000801000001006a2d0007f5bb',
        ],
        [
            1,
            'aa3a20ec001805003800380700030302020000000801000001006a2d0007001805010301030700030302120000004801000001006a2d000731bb',
        ],
        [
            2,
            'aa3a20ec001805010301030700030302120000004801000001006a2d0007001805010a010a0700030302220000004801000001006a2d00073fbb',
        ],
    ] as const

    for (const [count, frame] of selections) {
        device.inject(buf(frame))
        assert.equal(discovery.properties.rinse_count, 2)
        assert.equal(discovery.properties.extra_rinse_count, count)
        assert.equal(discovery.properties.extra_rinse, count === 0 ? 'OFF' : 'ON')
    }
})

test('sends the captured ThinQ power-off packet for a button press and waits for the washer state', () => {
    const { ha, device, discovery } = connectWasher()
    const confirmedOff = buf(
        'aa3a20ec001805010a010a0700030302220000004801000001006a2d000700180000010000fe00000000000000000000000001056a2d0000a5bb',
    )
    device.inject(DELICATES_SELECTED)
    device.resetRecorder()

    ha.setProperty(device.id, 'power_off', 'command', 'ON')
    assert.deepEqual(device.outbox, [])
    ha.setProperty(device.id, 'power_off', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [buf('aa09f0240101009cbb')])
    assert.equal(discovery.properties.power, 'ON')

    device.inject(confirmedOff)
    assert.equal(discovery.properties.power, 'OFF')
})

test('reports Control Lock and Rinse+Spin from the labeled toggles', () => {
    const { device, discovery } = connectWasher()
    const toggles = [
        [
            'child_lock',
            'ON',
            'aa3a20ec001805000000000000000000000000000000000000006a2d0000001805000000000000000000000000000100000000006a2d00000cbb',
        ],
        [
            'child_lock',
            'OFF',
            'aa3a20ec001805000000000000000000000000000100000000006a2d0000001805000000000000000000000000000000000000006a2d00000cbb',
        ],
        [
            'rinse_spin',
            'ON',
            'aa3a20ec001805010f010f0500030504020000000000000000006a2d0000001805001b001b0500000500010000002000000000006a2d0007a6bb',
        ],
        [
            'rinse_spin',
            'OFF',
            'aa3a20ec001805001b001b0500000500010000002000000000006a2d0007001805010501050500030504020000000000000000006a2d00008abb',
        ],
    ]

    for (const [property, state, frame] of toggles) {
        device.inject(buf(frame))
        assert.equal(discovery.properties[property], state, property)
    }
})

test('starts Normal only in armed standby and sends the captured ThinQ packet', () => {
    const { ha, device, discovery } = connectWasher()
    device.inject(NORMAL_SELECTED)
    device.resetRecorder()

    assert.equal(discovery.properties.remote_start_ready, 'OFF')
    ha.setProperty(device.id, 'start_normal', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [])

    device.inject(
        buf(
            'aa3a20ec001805000000000000000000000000000000000000006a2d0000001805000000000000000000000000000080000000006a2d00008dbb',
        ),
    )
    assert.equal(discovery.properties.remote_start_ready, 'OFF')
    ha.setProperty(device.id, 'start_normal', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [])

    device.inject(REMOTE_ARMED)
    assert.equal(discovery.properties.remote_start_ready, 'ON')
    ha.setProperty(device.id, 'start_normal', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [buf('aa1bf026050305040000000080200600000000000000000000c7bb')])
    assert.equal(discovery.properties.status, 'Standby')

    device.inject(NORMAL_DETECTING)
    assert.equal(discovery.properties.remote_start_ready, 'OFF')
    assert.equal(discovery.properties.status, 'Detecting')
})

test('sends the distinct captured Pause and Resume packets in their corresponding states', () => {
    const { ha, device, discovery } = connectWasher()
    device.inject(NORMAL_DETECTING)
    device.resetRecorder()

    ha.setProperty(device.id, 'resume', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [])
    ha.setProperty(device.id, 'pause', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [buf('aa09f02404010099bb')])
    assert.equal(discovery.properties.status, 'Detecting')

    device.inject(NORMAL_PAUSED)
    device.resetRecorder()
    ha.setProperty(device.id, 'pause', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [])
    ha.setProperty(device.id, 'resume', 'command', 'PRESS')
    assert.deepEqual(device.outbox, [buf('aa1bf02605030504020000008000060000000000000000000021bb')])
    assert.equal(discovery.properties.status, 'Paused')
})

test('keeps Resume disabled when a paused cycle has settings other than the captured Normal defaults', () => {
    const { ha, device } = connectWasher()
    const paused = AABBDevice.unframe(NORMAL_PAUSED)!
    const changed = Buffer.from(paused)
    changed[CURRENT_RECORD_OFFSET + 10] = 2 // Cold instead of the captured Warm setting
    device.inject(AABBDevice.frame(changed))
    device.resetRecorder()

    ha.setProperty(device.id, 'resume', 'command', 'PRESS')

    assert.deepEqual(device.outbox, [])
})
