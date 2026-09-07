import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import AABBDevice from '@/cloud/devices/aabb_device'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'AABB', modelName: 'AABB', swVersion: '0.0.0' }

// The properties map alone cannot tell "published 'None'" apart from "the cache swallowed it", since
// an absent key reads as undefined either way. These tests record what actually reached the HA
// connection instead.
function makeDevice() {
    const ha = new MockHAConnection()
    const published: { prop: string; value: string | number | undefined }[] = []
    const inner = ha.publishProperty.bind(ha)
    ha.publishProperty = (id: string, prop: string, value: string | number | undefined) => {
        published.push({ prop, value })
        inner(id, prop, value)
    }

    const dev = new AABBDevice(ha.asConnection(), new MockThinq2Device(DEVICE_ID, META))
    return { ha, dev, published }
}

describe('AABBDevice.publishProperty', () => {
    // The regression: with a plain `cache[prop] === value` check, an undefined value on a property
    // that has never been published looks like a cache hit and is dropped. HA would then keep showing
    // whatever was retained from the previous run.
    test('an undefined value on a never-published property is published', () => {
        const { ha, dev, published } = makeDevice()

        dev.publishProperty('course', undefined)

        assert.deepEqual(published, [{ prop: 'course', value: undefined }])
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
    })

    test('a repeated undefined is published only once', () => {
        const { dev, published } = makeDevice()

        dev.publishProperty('course', undefined)
        dev.publishProperty('course', undefined)

        assert.equal(published.length, 1)
    })

    test('every transition into and out of undefined is published', () => {
        const { ha, dev, published } = makeDevice()

        dev.publishProperty('course', undefined)
        dev.publishProperty('course', 'Cotton')
        dev.publishProperty('course', 'Cotton')
        dev.publishProperty('course', undefined)

        assert.deepEqual(published, [
            { prop: 'course', value: undefined },
            { prop: 'course', value: 'Cotton' },
            { prop: 'course', value: undefined },
        ])
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'None')
    })

    test('an unchanged value is published once, a changed one every time', () => {
        const { dev, published } = makeDevice()

        dev.publishProperty('remaining_time', 41)
        dev.publishProperty('remaining_time', 41)
        dev.publishProperty('remaining_time', 40)

        assert.deepEqual(published, [
            { prop: 'remaining_time', value: 41 },
            { prop: 'remaining_time', value: 40 },
        ])
    })

    test('the cache is kept per property', () => {
        const { dev, published } = makeDevice()

        dev.publishProperty('spin', undefined)
        dev.publishProperty('temp', undefined)

        assert.deepEqual(published, [
            { prop: 'spin', value: undefined },
            { prop: 'temp', value: undefined },
        ])
    })

    // The cache is a Map so that property names taken off the wire cannot collide with Object.prototype.
    // A plain object would report `'toString' in cache` as true before anything was ever published.
    test('a property named after an Object.prototype member is not swallowed', () => {
        const { ha, dev, published } = makeDevice()

        dev.publishProperty('toString', undefined)
        dev.publishProperty('constructor', 'Cotton')

        assert.deepEqual(published, [
            { prop: 'toString', value: undefined },
            { prop: 'constructor', value: 'Cotton' },
        ])
        assert.equal(ha.devices[DEVICE_ID].properties.toString, 'None')
    })
})
