import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Enum } from '@/util/enum'

describe('Enum', () => {
    const MODES = Enum.of({
        cool: 0,
        dry: 1,
        fan_only: 2,
        heat: 4,
        auto: 6,
    })

    test('maps codes to labels', () => {
        assert.equal(MODES.map(0), 'cool')
        assert.equal(MODES.map(4), 'heat')
    })

    test('maps labels back to codes', () => {
        assert.equal(MODES.unmap('cool'), 0)
        assert.equal(MODES.unmap('heat'), 4)
    })

    test('returns undefined for codes and labels it does not know', () => {
        assert.equal(MODES.map(3), undefined)
        assert.equal(MODES.map(99), undefined)
        assert.equal(MODES.unmap('eco'), undefined)
        assert.equal(MODES.unmap(''), undefined)
    })

    test('does not answer for inherited Object properties', () => {
        // `forward`/`inverse` are plain objects, so a lookup of 'constructor' or '__proto__' must
        // not walk up the prototype chain and hand back a function as if it were a label.
        assert.equal(MODES.unmap('constructor'), undefined)
        assert.equal(MODES.unmap('toString'), undefined)
        assert.equal(MODES.unmap('__proto__'), undefined)
    })

    test('code 0 maps like any other code', () => {
        // 0 is falsy, so a `??`-less caller would silently lose it.
        assert.equal(MODES.map(0), 'cool')
        assert.equal(MODES.unmap('cool'), 0)
    })

    test('exposes labels in declaration order as an HA option list', () => {
        assert.deepEqual(MODES.options, ['cool', 'dry', 'fan_only', 'heat', 'auto'])
    })

    describe('entry form', () => {
        test('keeps the order it was given, whatever the labels look like', () => {
            // The reason it exists: an object literal cannot express this order, because JS sorts
            // integer-like keys first. The RAC swing modes are listed exactly this way.
            const swing = new Enum([
                ['3', 3],
                ['1', 1],
                ['on', 100],
                ['off', 0],
            ])
            assert.deepEqual(swing.options, ['3', '1', 'on', 'off'])
            assert.equal(swing.map(0), 'off')
            assert.equal(swing.unmap('3'), 3)
        })

        test('Enum.of hands the order to JS, which sorts integer-like labels first', () => {
            const swing = Enum.of({ off: 0, '3': 3, '1': 1, on: 100 })
            assert.deepEqual(swing.options, ['1', '3', 'off', 'on'])
        })
    })

    describe('aliases', () => {
        const DEHUM = Enum.of({
            Smart: [17, 0],
            Jet: [18, 1],
            Silent: [19, 2],
        })

        test('reads every alias back as the same label', () => {
            assert.equal(DEHUM.map(17), 'Smart')
            assert.equal(DEHUM.map(0), 'Smart')
            assert.equal(DEHUM.map(2), 'Silent')
        })

        test('writes the first code of the list', () => {
            assert.equal(DEHUM.unmap('Smart'), 17)
            assert.equal(DEHUM.unmap('Silent'), 19)
        })

        test('lists the label once', () => {
            assert.deepEqual(DEHUM.options, ['Smart', 'Jet', 'Silent'])
        })

        test('accepts a single-element list', () => {
            const one = Enum.of({ Only: [5] })
            assert.equal(one.map(5), 'Only')
            assert.equal(one.unmap('Only'), 5)
        })

        test('ignores a label declared with no code', () => {
            const none = Enum.of({ Nothing: [], Something: 1 })
            assert.equal(none.unmap('Nothing'), undefined)
            assert.equal(none.unmap('Something'), 1)
        })

        test('a later label wins a code claimed twice', () => {
            // Two labels claiming one code is a mistake in the table, but it must stay predictable
            // rather than throwing at import time and taking the whole device down.
            const clash = Enum.of({ First: 1, Second: [2, 1] })
            assert.equal(clash.map(1), 'Second')
            assert.equal(clash.unmap('First'), 1)
            assert.equal(clash.unmap('Second'), 2)
        })
    })

    test('exposes the raw tables for callers that need them', () => {
        // spread to a plain object — the tables themselves are null-prototype
        assert.deepEqual({ ...MODES.inverse }, { cool: 0, dry: 1, fan_only: 2, heat: 4, auto: 6 })
        assert.deepEqual({ ...MODES.forward }, { 0: 'cool', 1: 'dry', 2: 'fan_only', 4: 'heat', 6: 'auto' })
    })

    test('is empty when declared empty', () => {
        const empty = new Enum([])
        assert.deepEqual(empty.options, [])
        assert.equal(empty.map(0), undefined)
    })
})
