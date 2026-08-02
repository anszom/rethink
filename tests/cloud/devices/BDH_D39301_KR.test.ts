import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DRYER_MODEL } from '@/cloud/devices/washtower_common'

test('BDH_D39301_KR maps the complete official 51-byte record', () => {
    assert.equal(DRYER_MODEL.recordLength, 51)
    assert.equal(DRYER_MODEL.liveRecordLength, 50)
    assert.equal(DRYER_MODEL.fields.length, 84)
    assert.deepEqual(DRYER_MODEL.fields.find((field) => field.key === 'ecoHybrid')?.values, {
        '0': 'Off',
        '1': 'Energy',
        '2': 'Auto',
        '3': 'Speed',
    })
})
