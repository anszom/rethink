import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { make, splitter } from '@/util/length_prefixed_frame'

describe('length-prefixed frame', () => {
    test('make + splitter round-trip', () => {
        const out: Buffer[] = []
        const split = splitter((buf) => out.push(buf))
        split(make(Buffer.from('hello')))
        split(make('world'))
        assert.deepEqual(
            out.map((b) => b.toString()),
            ['hello', 'world'],
        )
    })

    test('splitter handles chunked deliveries', () => {
        const framed = Buffer.concat([make('abc'), make('defg')])
        const out: Buffer[] = []
        const split = splitter((b) => out.push(b))
        // feed one byte at a time
        for (let i = 0; i < framed.length; i++) split(framed.subarray(i, i + 1))
        assert.deepEqual(
            out.map((b) => b.toString()),
            ['abc', 'defg'],
        )
    })

    test('splitter handles two frames in single chunk', () => {
        const framed = Buffer.concat([make('one'), make('two')])
        const out: Buffer[] = []
        const split = splitter((b) => out.push(b))
        split(framed)
        assert.deepEqual(
            out.map((b) => b.toString()),
            ['one', 'two'],
        )
    })

    test('splitter handles real-world ThinQ1 provisioning frame', () => {
        const json =
            '{"Header":{"x-lgedm-deviceId":"48552db0-1ab4-11e9-b4fb-7c1c4ec8cc53"},' +
            '"Body":{"CmdWId":"e5d59e90-99a2-11f0-8ef9-7c1c4ec8cc53","Cmd":"DevInfo","Format":"B64",' +
            '"Data":"UnVsZVZlcj0xLjMsRndWZXI9UUNfTW9kZW1fMS4yLjgwLHJlZ0ZhaWw9Tg=="}}'
        assert.equal(json.length, 0xe4)
        const framed = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0xe4]), Buffer.from(json, 'utf-8')])

        const out: Buffer[] = []
        const split = splitter((b) => out.push(b))
        split(framed)

        assert.equal(out.length, 1)
        assert.equal(out[0].toString('utf-8'), json)
    })

    test('splitter enforces maxPayloadLength', () => {
        const framed = make(Buffer.alloc(100))
        const split = splitter(() => {}, { maxPayloadLength: 50 })
        assert.throws(() => split(framed), /Payload length exceeded/)
    })
})
