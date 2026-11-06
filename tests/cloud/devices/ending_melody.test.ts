import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Washer from '@/cloud/devices/FAFXU22007'
import Dryer from '@/cloud/devices/BDVG_FX0003_US'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

// Captured singleton E5 commands and EC reports from both models, 2026-11-01.
// Labels were checked at the panel; audible playback was not separately verified.
const COMMANDS: [string, string][] = [
    ['Normal', 'aa0df0e5000201ff0150008abb'],
    ['Vivaldi Winter', 'aa0df0e5000201ff015001b5bb'],
    ["Bach's Minuet in G major", 'aa0df0e5000201ff015002b4bb'],
    ['Sweet Home', 'aa0df0e5000201ff015003b7bb'],
    ['Breeze', 'aa0df0e5000201ff015004b6bb'],
    ['Old MacDonald', 'aa0df0e5000201ff015005b1bb'],
    ['Verdi La Traviata Drinking Song', 'aa0df0e5000201ff015006b0bb'],
    ['Bubble', 'aa0df0e5000201ff015007b3bb'],
    ['Beethoven Symphony No. 5', 'aa0df0e5000201ff015008b2bb'],
    ['Arirang', 'aa0df0e5000201ff015009bdbb'],
    ["Pachelbel's Canon", 'aa0df0e5000201ff01500abcbb'],
    ['Beethoven Symphony No. 9', 'aa0df0e5000201ff01500bbfbb'],
]

for (const { Model, modelId, recordLength, melodyOffset, reports } of [
    {
        Model: Washer,
        modelId: 'FAFXU22007',
        recordLength: 51,
        melodyOffset: 45,
        reports: [
            'aaff200a0078005981000100ec006600030d0e0f2e00000000000000002e002e0001002e010006000000010f020200301e20000000000c380000000007090401000400030d0e0f2e00000000000000002e002e0001002e010006000000010f020200301e20000000000c3800000000000904010004b2a0bb',
            'aaff200a0078005953000100ec006600030d0e0f2e00000000000000002e002e0000002e010006000000010f020200301e20000000000c380000000001090401000400030d0e0f2e00000000000000002e002e0000002e010006000000010f020200301e20000000000c38000000000909040100041a68bb',
            'aaff200a0078005975000100ec006600030d0e0f2e00000000000000002e002e0000002e010006000000010f020200301e20000000000c380000000008090401000400030d0e0f2e00000000000000002e002e0001002e010006000000010f020200301e20000000000c38000000000b0904010004eebcbb',
        ],
    },
    {
        Model: Dryer,
        modelId: 'BDVG_FX0003_US',
        recordLength: 42,
        melodyOffset: 32,
        reports: [
            'aaff300a006600edca000100ec0054000300040007000000002900290100000200000303000000000000810300000007090000000000000000000300040007000000002900290100000200000303000000000000810300000000090000000000000000c0d2bb',
            'aaff300a006600ed94000100ec0054000300040007000000002900290100000200000303000000200000810300000004090000000000000000000300040007000000002900290100000200000303000000200000810300000009090000000000000000f6b0bb',
            'aaff300a006600edc5000100ec005400030004000700000000290029010000020000030300000000000081030000000809000000000000000000030004000700000000290029010000020000030300000000000081030000000b0900000000000000003e03bb',
        ],
    },
]) {
    const makeDevice = () => {
        const meta = { modelId, modelName: modelId, swVersion: '0.0.0' }
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device('test-id', meta)
        const dev = new Model(ha.asConnection(), thinq, meta)
        return { ha, thinq, dev }
    }

    describe(`${modelId} ending melody`, () => {
        test('discovery offers the captured labels and routes commands to singleton property50 writes', () => {
            for (const [label, command] of COMMANDS) {
                const { ha, thinq, dev } = makeDevice()
                dev.publishConfig()
                const c = ha.devices['test-id'].config!.components.melody as Record<string, unknown>
                assert.equal(c.platform, 'select')
                assert.equal(c.entity_category, 'config')
                assert.deepEqual(
                    c.options,
                    COMMANDS.map(([name]) => name),
                )
                thinq.emit('data', buf(reports[0]))
                assert.equal(ha.lookupTopic('test-id', 'melody', 'command'), 'melody/set')
                dev.setProperty('melody', label)
                assert.deepEqual(thinq.outbox, [buf(command)], label)
                assert.equal(ha.devices['test-id'].properties.melody, 'Normal')
                dev.drop()
            }
        })

        test('captured EC readback uses the current half independently of splash screen and clock', () => {
            for (const [index, expected] of [
                [0, 'Normal'],
                [1, 'Arirang'],
                [2, 'Beethoven Symphony No. 9'],
            ] as const) {
                const { ha, thinq, dev } = makeDevice()
                const frame = buf(reports[index])
                assert.notEqual(frame[15 + melodyOffset], frame[15 + recordLength + melodyOffset])
                thinq.emit('data', frame)
                const p = ha.devices['test-id'].properties
                assert.equal(p.melody, expected)
                assert.equal(p.splash_screen, 'Halloween')
                assert.equal(p.current_time_display, 'OFF')
                dev.drop()
            }
        })

        test('invalid labels send no command', () => {
            const { thinq, dev } = makeDevice()
            for (const label of ['', '12', 'arirang', 'Arirang ', 'ON']) dev.setProperty('melody', label)
            assert.deepEqual(thinq.outbox, [])
            dev.drop()
        })
    })
}
