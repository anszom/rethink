import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WASHER_MODEL } from '@/cloud/devices/washtower_common'

test('FAKPK21021 maps the complete official 72-byte record', () => {
    assert.equal(WASHER_MODEL.recordLength, 72)
    assert.equal(WASHER_MODEL.liveRecordLength, 67)
    assert.equal(WASHER_MODEL.fields.length, 148)
})
