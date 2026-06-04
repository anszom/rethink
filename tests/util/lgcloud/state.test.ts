import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { loadState, saveState } from '@/util/lgcloud/state'

const COMPLETE = { countryCode: 'US', refreshToken: 'tok' }

test('loadState returns undefined when the file is missing', () => {
    assert.equal(loadState('/tmp/rethink-test-no-such-state.json'), undefined)
})

test('loadState rejects an incomplete state (refresh token without country code)', () => {
    const path = '/tmp/rethink-test-partial-state.json'
    fs.writeFileSync(path, JSON.stringify({ refreshToken: 'tok' }))
    try {
        assert.equal(loadState(path), undefined)
    } finally {
        fs.unlinkSync(path)
    }
})

test('saveState then loadState round-trips a complete state', () => {
    const path = '/tmp/rethink-test-roundtrip-state.json'
    try {
        saveState(COMPLETE, path)
        assert.deepEqual(loadState(path), COMPLETE)
    } finally {
        fs.unlinkSync(path)
    }
})
