import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Connection } from '@/cloud/homeassistant'
import type { IPublishPacket } from 'mqtt'

test('MQTT routes explicit commands but never replays retained commands', () => {
    const received: unknown[][] = []
    const connection = {
        config: { rethink_prefix: 'rethink', discovery_prefix: 'homeassistant' },
        emit: (...args: unknown[]) => received.push(args),
    } as unknown as Connection
    for (const retain of [true, false]) {
        Connection.prototype.received.call(connection, 'rethink/device/temp/set', Buffer.from('Warm'), {
            retain,
        } as IPublishPacket)
        Connection.prototype.received.call(connection, 'rethink/device/washer/temp/set', Buffer.from('Cold'), {
            retain,
        } as IPublishPacket)
    }
    for (const retain of [true, false])
        Connection.prototype.received.call(connection, 'rethink/device/current_time_display/set', Buffer.from('OFF'), {
            retain,
        } as IPublishPacket)
    assert.deepEqual(received, [
        ['setProperty', 'device', 'temp', 'Warm'],
        ['setProperty', 'device', 'washer/temp', 'Cold'],
        ['setProperty', 'device', 'current_time_display', 'OFF'],
    ])
})
