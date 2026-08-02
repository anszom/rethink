import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CloudFeedController, DeviceCaptureController } from '@/tools/mcp-server'

class MockSocket extends EventEmitter {
    closeCalls = 0

    close() {
        this.closeCalls++
    }
}

type Deferred<T> = {
    promise: Promise<T>
    resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

describe('MCP lifecycle controllers', () => {
    test('device stop/start keeps the replacement socket tracked when the old socket closes late', async () => {
        const sockets: MockSocket[] = []
        const captures = new DeviceCaptureController(() => {
            const socket = new MockSocket()
            sockets.push(socket)
            return socket as never
        })

        const first = captures.start('localhost', 'device-1')
        captures.stop('device-1')
        assert.equal(await first, 'stopped')

        const second = captures.start('localhost', 'device-1')
        assert.equal(sockets.length, 2)
        sockets[0].emit('close')
        assert.equal(captures.has('device-1'), true)

        sockets[1].emit('message', Buffer.from(JSON.stringify({ status: 'online' })))
        assert.equal(await second, 'online')
        captures.stop('device-1')
        assert.equal(sockets[1].closeCalls, 1)
    })

    test('concurrent device starts create only one tracked socket', async () => {
        const sockets: MockSocket[] = []
        const captures = new DeviceCaptureController(() => {
            const socket = new MockSocket()
            sockets.push(socket)
            return socket as never
        })

        const first = captures.start('localhost', 'device-1')
        const second = captures.start('localhost', 'device-1')
        assert.equal(await second, 'already-capturing')
        assert.equal(sockets.length, 1)

        captures.stop('device-1')
        assert.equal(await first, 'stopped')
    })

    test('device start timeout closes and releases the capture slot for retry', async () => {
        const sockets: MockSocket[] = []
        const captures = new DeviceCaptureController(() => {
            const socket = new MockSocket()
            sockets.push(socket)
            return socket as never
        }, 5)

        assert.equal(await captures.start('localhost', 'device-1'), 'unknown')
        assert.equal(captures.has('device-1'), false)
        assert.equal(sockets[0].closeCalls, 1)

        const retry = captures.start('localhost', 'device-1')
        assert.equal(sockets.length, 2)
        captures.stop('device-1')
        assert.equal(await retry, 'stopped')
    })

    test('an unavailable cloud start releases the single-flight slot for retry', async () => {
        let stateCalls = 0
        let connectCalls = 0
        const client = {
            end() {},
        }
        const controller = new CloudFeedController(
            (() => (++stateCalls === 1 ? undefined : { token: 'state' })) as never,
            (async () => {
                connectCalls++
                return client
            }) as never,
        )

        assert.equal(await controller.ensure(), 'unavailable')
        assert.equal(await controller.status(), 'disabled')
        assert.equal(await controller.ensure(), 'connected')
        assert.equal(connectCalls, 1)
        controller.stop()
    })

    test('cloud stop invalidates an in-flight connect and ends every late client', async () => {
        const connects = [deferred<any>(), deferred<any>()]
        let connectIndex = 0
        const controller = new CloudFeedController(
            (() => ({ token: 'state' })) as never,
            (() => connects[connectIndex++].promise) as never,
        )
        const oldClient = {
            endCalls: 0,
            end() {
                this.endCalls++
            },
        }
        const newClient = {
            endCalls: 0,
            end() {
                this.endCalls++
            },
        }

        const first = controller.ensure()
        assert.equal(controller.ensure(), first, 'connect is single-flight')
        controller.stop()
        const second = controller.ensure()

        connects[0].resolve(oldClient)
        assert.equal(await first, 'unavailable')
        assert.equal(oldClient.endCalls, 1)

        connects[1].resolve(newClient)
        assert.equal(await second, 'connected')
        controller.stop()
        assert.equal(newClient.endCalls, 1)
        assert.equal(await controller.status(), 'disabled')
    })
})
