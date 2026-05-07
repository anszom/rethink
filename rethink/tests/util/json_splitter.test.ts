import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import jsonSplitter from '@/util/json_splitter'

function feed(stream: string): unknown[] {
    const split = jsonSplitter()
    const out: unknown[] = []
    for (const byte of Buffer.from(stream)) split(byte, (msg) => out.push(msg))
    return out
}

describe('JSON spiltter', () => {
    test('splits two adjacent objects', () => {
        assert.deepEqual(feed('{"a":1}{"b":2}'), [{ a: 1 }, { b: 2 }])
    })

    test('splits nested objects correctly', () => {
        assert.deepEqual(feed('{"a":{"b":[1,2,{"c":3}]}}{"d":4}'), [{ a: { b: [1, 2, { c: 3 }] } }, { d: 4 }])
    })

    test('quoted braces inside strings do not affect depth', () => {
        assert.deepEqual(feed('{"s":"}{"}{"x":1}'), [{ s: '}{' }, { x: 1 }])
    })

    test('escaped quote inside string handled', () => {
        assert.deepEqual(feed('{"s":"a\\"b"}{"x":1}'), [{ s: 'a"b' }, { x: 1 }])
    })

    test('arrays at top level supported', () => {
        assert.deepEqual(feed('[1,2,3][4]'), [[1, 2, 3], [4]])
    })

    test('throws on too-many closing tokens', () => {
        const split = jsonSplitter()
        assert.throws(() => {
            for (const byte of Buffer.from('{}}')) split(byte, () => {})
        }, /too many closing tokens/)
    })
})
