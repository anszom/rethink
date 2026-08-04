import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import type { MqttClient } from 'mqtt'
import { Connection } from '@/bridge/thinq2connection'
import { Thinq2Device, type Thinq2DeviceState } from '@/bridge/thinqApi'
import { setFilter } from '@/util/logging'

setFilter(() => false)

class MockMqttClient extends EventEmitter {
    publications: Array<{ topic: string; payload: string }> = []
    publishCallbacks: Array<(err?: Error) => void> = []
    subscribeCalls: string[] = []
    subscribeError: Error | undefined
    completeSubscriptions = true
    endCalls = 0
    endForces: Array<boolean | undefined> = []

    publish(topic: string, payload: string, optionsOrCallback?: unknown, callback?: (err?: Error) => void) {
        this.publications.push({ topic, payload })
        const publishCallback =
            typeof optionsOrCallback === 'function' ? (optionsOrCallback as (err?: Error) => void) : callback
        if (publishCallback) this.publishCallbacks.push(publishCallback)
        return this
    }

    subscribe(topic: string, callback?: (err?: Error) => void) {
        this.subscribeCalls.push(topic)
        if (callback && this.completeSubscriptions) callback(this.subscribeError)
        return this
    }

    end(force?: boolean) {
        this.endCalls++
        this.endForces.push(force)
        return this
    }
}

const state: Thinq2DeviceState = {
    countryCode: 'XX',
    apiServer: 'https://api.example',
    mqttServer: 'ssl://mqtt.example',
    caCertificate: '',
    privateKey: '',
    certificate: '',
    pubTopic: 'clip/message/devices/test-device',
    provTopic: 'clip/provisioning/devices/test-device',
    subTopic: 'lime/devices/test-device',
}

function connection(mqtt: MockMqttClient) {
    const device = new Thinq2Device('test-device', { modelId: 'model', modelName: 'model' }, state)
    return new Connection(device, mqtt as unknown as MqttClient)
}

test('connect subscribes and publishes preDeploy through completion callbacks', async () => {
    const mqtt = new MockMqttClient()
    const conn = connection(mqtt)

    mqtt.emit('connect')
    await new Promise((resolve) => setImmediate(resolve))
    for (const done of mqtt.publishCallbacks.splice(0)) done()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(mqtt.subscribeCalls, [state.subTopic])
    assert.equal(mqtt.publications.length, 1)
    assert.equal(mqtt.publications[0].topic, state.provTopic)
    assert.equal(JSON.parse(mqtt.publications[0].payload).cmd, 'preDeploy')
    conn.destroy()
})

test('a failed startup subscribe is reported as an error, not an unhandled rejection', async () => {
    const mqtt = new MockMqttClient()
    mqtt.subscribeError = new Error('subscribe refused')
    const conn = connection(mqtt)

    const reported = once(conn, 'error')
    mqtt.emit('connect')

    assert.equal(((await reported)[0] as Error).message, 'subscribe refused')
    // the failure tears the connection down instead of leaving a half-started session
    assert.equal(mqtt.endCalls, 1)
    assert.deepEqual(mqtt.endForces, [true])
    assert.equal(mqtt.publications.length, 0)
})

test('destroy settles an in-flight operation whose callback will never fire', async () => {
    const mqtt = new MockMqttClient()
    mqtt.completeSubscriptions = false // the broker never answers the subscribe
    const conn = connection(mqtt)
    conn.on('error', () => {})

    mqtt.emit('connect')
    await new Promise((resolve) => setImmediate(resolve))
    conn.destroy()
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(mqtt.endCalls, 1)
    // destroy is idempotent and send after destroy is a no-op
    conn.destroy()
    conn.send('AA')
    assert.equal(mqtt.endCalls, 1)
    assert.equal(mqtt.publications.length, 0)
})

test('an MQTT error is forwarded to the connection error event', () => {
    const mqtt = new MockMqttClient()
    const conn = connection(mqtt)
    const seen: Error[] = []
    conn.on('error', (err) => seen.push(err))

    const failure = new Error('broker unavailable')
    mqtt.emit('error', failure)
    assert.deepEqual(seen, [failure])
    conn.destroy()
})
