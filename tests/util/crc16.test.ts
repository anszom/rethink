import { test } from 'node:test'
import assert from 'node:assert/strict'
import crc16 from '@/util/crc16'

// Frame: "01010400000065020101077E447E837F902AF936"
test('crc16 matches captured packet', () => {
    const body = Buffer.from('0400000065020101077E447E837F902A', 'hex')
    assert.equal(crc16(body), 0xf936)
})
