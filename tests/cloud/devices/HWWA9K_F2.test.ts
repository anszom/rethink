import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/HWWA9K_F2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'HWWA9K_F2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '4.5' }

// STATE was captured from the appliance. The single-byte variants were injected through LG's
// cloud decoder to confirm which field and value each offset represents.

// Real: docked and fully charged. LG's snapshot for this exact frame read
// monStatus CHARGING_COMPLETE, cleanMode OFF, filterState NORMAL, passageClogged NORMAL,
// nozzle IGNORE, batteryLevel NOT_USE, mopWithSucking OFF, completeClean OFF,
// suctionForce HIGH, chargingMelody MELODY_1, volume HIGH, brightness LOW.
const STATE = buf('aa14d2eb000c04010101ff00010102010103c3bb')

const MON_CHARGING = buf('aa14d2eb000c03010101ff00010102010103c0bb') // byte[6]=3  -> monStatus CHARGING
const SUCTION_TURBO = buf('aa14d2eb000c04010101ff00010103010103c2bb') // byte[14]=3 -> suctionForce TURBO
const BRIGHT_HIGH = buf('aa14d2eb000c04010101ff00010102010102c0bb') // byte[17]=2 -> brightness HIGH
const NOZZLE_MOP = buf('aa14d2eb000c040101010300010102010103cfbb') // byte[10]=3 -> nozzle WATER_MOP
// completeClean's OFFSET is from the probe (byte[13]=3 read back as code 3); its ON code is LG's
// own valueMapping (ON = index 2, and note OFF is 1, not 0).
const CLEAN_DONE = buf('aa14d2eb000c04010101ff00010202010103c2bb') // byte[13]=2 -> completeClean ON

// Captured echo after five settings were written. It contains the previous record followed by
// the current one under tag d2/ec.
const ECHO_TWO_RECORDS = buf('aa22d2ec000c04010101ff00020101030304000c04010101ff000201020303049ebb')

// The 44-byte settings frame the appliance also sends. It is a capability list, not values:
// all four "VC-n" records read 01 while the state frame above says suction 2 and brightness 3.
// It must therefore be ignored, not decoded.
const CAPABILITY = buf('aaffd20a002c00005200010a85001a00040456432d31010456432d32010456432d33010456432d34014880bb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('publishes only entities the 12-field frame actually fills', () => {
        const { ha } = makeDevice()
        const cfg = ha.devices[DEVICE_ID].config
        assert.ok(cfg, 'config published')
        const components = cfg!.components as Record<string, Record<string, unknown>>
        for (const c of [
            'status',
            'clean_mode',
            'suction_force',
            'battery',
            'nozzle',
            'filter_state',
            'passage',
            'mop_with_sucking',
            'charging_melody',
            'volume',
            'brightness',
            'complete_clean',
        ]) {
            assert.ok(components[c], `component ${c} present`)
        }
        // Twelve fields decoded, twelve entities — no field is published twice and none is
        // invented. The remaining entries are the generic driver's removals, which carry a
        // platform and nothing else.
        const real = Object.values(components).filter((c) => c.unique_id !== undefined)
        assert.equal(real.length, 12)
    })

    test('closed-set sensors declare their enum contract', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<
            string,
            { device_class?: string; options?: string[] }
        >
        const enums = {
            status: ['Standby', 'Cleaning', 'Charging', 'Charging complete'],
            clean_mode: ['Off', 'Standard', 'High', 'Turbo', 'Mop', 'Auto'],
            battery: ['Off', 'High', 'Mid', 'Low', 'Warning'],
            nozzle: ['Auxiliary inlet', 'PowerDrive Floor', 'PowerDrive Carpet', 'PowerDrive Mop'],
            filter_state: ['Normal', 'Cleaning needed'],
            passage: ['Normal', 'Check for debris'],
        }
        for (const [name, options] of Object.entries(enums)) {
            assert.equal(components[name].device_class, 'enum', `${name} is an enum sensor`)
            assert.deepEqual(components[name].options, options, `${name} declares every accepted value`)
        }
    })

    // Writable exactly where a command frame was captured off LG's own capability API and seen
    // to take (CL-0000). modelJSON declares five commands for this model and all five are here;
    // anything else would be a guess.
    const WRITABLE = new Set(['suction_force', 'mop_with_sucking', 'charging_melody', 'volume', 'brightness'])

    test('exactly the fields with a captured command frame are writable', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [name, comp] of Object.entries(components)) {
            if (comp.unique_id === undefined) continue // a removal, not an entity
            if (WRITABLE.has(name)) {
                assert.equal(comp.command_topic, `$this/${name}/set`, `${name} is writable`)
                assert.equal(comp.platform, 'select', `${name} is a select`)
            } else {
                assert.equal(comp.command_topic, undefined, `${name} stays read-only`)
                assert.ok(
                    comp.platform === 'sensor' || comp.platform === 'binary_sensor',
                    `${name} is a sensor platform, got ${comp.platform}`,
                )
            }
        }
    })

    test("every select's options are exactly the labels it can report", () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<
            string,
            { platform?: string; options?: string[]; optimistic?: boolean }
        >
        const expected = {
            suction_force: ['Standard', 'High', 'Turbo'],
            mop_with_sucking: ['Mop only', 'Mop and suction together'],
            charging_melody: ['Lucky', 'Marble', 'Ice', 'Breeze', 'Nebula'],
            volume: ['High', 'Normal', 'Low'],
            brightness: ['Very bright', 'Bright', 'Normal', 'Dim', 'Off'],
        }
        for (const [name, options] of Object.entries(expected)) {
            assert.deepEqual(components[name].options, options, `${name} declares every accepted value`)
            assert.equal(components[name].optimistic, true, `${name} uses HA optimistic state`)
        }
    })

    /*
     * The frames below are REAL. LG's capability API was asked to change each setting
     * (`convert/control`; every one answered CL-0000) and these are the cloud→appliance frames
     * rethink relayed as a result, on 2026-07-28. So the assertion is that this driver emits byte
     * for byte what LG emits — not that it agrees with its own idea of the format.
     *
     * Every option of every command is here, seventeen frames, because a select that ships an
     * option nobody ever drove is shipping a guess for that option.
     */
    test('each write reproduces the frame LG itself sent for that command', () => {
        for (const [prop, value, want] of [
            // MOP_SETTING (controlDataType 0x01)
            ['mop_with_sucking', 'Mop only', 'aa09f0240101019fbb'],
            ['mop_with_sucking', 'Mop and suction together', 'aa09f0240101029ebb'],
            // SUCTION_FORCE (0x02)
            ['suction_force', 'Standard', 'aa09f0240201019ebb'],
            ['suction_force', 'High', 'aa09f02402010299bb'],
            ['suction_force', 'Turbo', 'aa09f02402010398bb'],
            // CHARGING_MELODY (0x03)
            ['charging_melody', 'Lucky', 'aa09f02403010199bb'],
            ['charging_melody', 'Marble', 'aa09f02403010298bb'],
            ['charging_melody', 'Ice', 'aa09f0240301039bbb'],
            ['charging_melody', 'Breeze', 'aa09f0240301049abb'],
            ['charging_melody', 'Nebula', 'aa09f02403010585bb'],
            // VOLUME (0x04)
            ['volume', 'High', 'aa09f02404010198bb'],
            ['volume', 'Normal', 'aa09f0240401029bbb'],
            ['volume', 'Low', 'aa09f0240401039abb'],
            // BRIGHTNESS (0x05)
            ['brightness', 'Very bright', 'aa09f0240501019bbb'],
            ['brightness', 'Bright', 'aa09f0240501029abb'],
            ['brightness', 'Normal', 'aa09f02405010385bb'],
            ['brightness', 'Dim', 'aa09f02405010484bb'],
            ['brightness', 'Off', 'aa09f02405010587bb'],
        ] as [string, string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty(prop, value)
            assert.equal(thinq.outbox.length, 1, `${prop}=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `${prop}=${value}`)
        }
    })

    test('an unknown option is refused rather than guessed', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('suction_force', 'InvalidForce')
        dev.setProperty('brightness', 'InvalidBrightness')
        dev.setProperty('status', 'Charging') // read-only
        assert.equal(thinq.outbox.length, 0)
    })

    test('real captured frame decodes to what LG read from the same frame', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const p = ha.devices[DEVICE_ID].properties
        assert.equal(p.status, 'Charging complete')
        assert.equal(p.clean_mode, 'Off')
        assert.equal(p.filter_state, 'Normal')
        assert.equal(p.passage, 'Normal')
        assert.equal(p.mop_with_sucking, 'Mop only')
        assert.equal(p.suction_force, 'High')
        assert.equal(p.charging_melody, 'Lucky')
        assert.equal(p.volume, 'High')
        assert.equal(p.brightness, 'Normal')
        assert.equal(p.complete_clean, 'OFF')
        // nozzle 0xff and batteryLevel 0 are LG's IGNORE sentinels on this model, not real values.
        assert.equal(p.nozzle, 'unknown')
        assert.equal(p.battery, 'Off')
    })

    test('each probed offset moves exactly the field LG said it moves', () => {
        for (const [frame, key, want] of [
            [MON_CHARGING, 'status', 'Charging'],
            [SUCTION_TURBO, 'suction_force', 'Turbo'],
            [BRIGHT_HIGH, 'brightness', 'Bright'],
            [NOZZLE_MOP, 'nozzle', 'PowerDrive Mop'],
            [CLEAN_DONE, 'complete_clean', 'ON'],
        ] as [Buffer, string, string][]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', STATE)
            thinq.emit('data', frame)
            assert.equal(ha.devices[DEVICE_ID].properties[key], want, `${key} after single-byte probe`)
        }
    })

    test('a single-byte probe changes nothing else', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', SUCTION_TURBO)
        const after = ha.devices[DEVICE_ID].properties
        for (const key of Object.keys(before)) {
            if (key === 'suction_force') continue
            assert.equal(after[key], before[key], `${key} unchanged`)
        }
    })

    test('the 44-byte capability frame is ignored, not decoded as state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        thinq.emit('data', CAPABILITY)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })

    test('the two-record echo is read, and its LAST record is the current state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        thinq.emit('data', ECHO_TWO_RECORDS)
        const p = ha.devices[DEVICE_ID].properties
        // The trailing record's five settings, not the leading record's (which still says
        // mopWithSucking 1 and suctionForce 1).
        assert.equal(p.mop_with_sucking, 'Mop and suction together')
        assert.equal(p.suction_force, 'High')
        assert.equal(p.charging_melody, 'Ice')
        assert.equal(p.volume, 'Low')
        assert.equal(p.brightness, 'Dim')
        // ...and the rest of the record still decodes on the same offsets.
        assert.equal(p.status, 'Charging complete')
        assert.equal(p.clean_mode, 'Off')
        assert.equal(p.battery, 'Off')
        assert.equal(p.nozzle, 'unknown')
    })

    test("an unrecognized enum code publishes HA's accepted 'unknown' fallback", () => {
        const { ha, thinq } = makeDevice()
        const odd = Buffer.from(STATE)
        odd[6] = 9
        thinq.emit('data', odd)
        assert.equal(ha.devices[DEVICE_ID].properties.status, 'unknown')
    })

    test('a code the table does not list leaves the select where it was', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        assert.equal(ha.devices[DEVICE_ID].properties.suction_force, 'High')
        const odd = Buffer.from(STATE)
        odd[14] = 9 // not a suctionForce code; publishing it would be an invalid select state
        odd[odd.length - 2] = (odd.subarray(0, odd.length - 2).reduce((a, c) => a + c, 0) & 0xff) ^ 0x55
        thinq.emit('data', odd)
        assert.equal(ha.devices[DEVICE_ID].properties.suction_force, 'High')
    })

    test('a frame whose field count is not 12 is left alone', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE)
        const before = { ...ha.devices[DEVICE_ID].properties }
        const short = Buffer.from(STATE)
        short[5] = 3 // a different record shape; decoding it with this map would publish nonsense
        thinq.emit('data', short)
        assert.deepEqual(ha.devices[DEVICE_ID].properties, before)
    })
})

describe(`${MODEL_ID} discovery contract`, () => {
    test("no read-only component claims entity_category 'config'", () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        new DUT(ha.asConnection(), thinq, META)
        const components = ha.devices[DEVICE_ID].config!.components as Record<
            string,
            { platform?: string; entity_category?: string }
        >
        for (const [name, comp] of Object.entries(components)) {
            if (comp.platform !== 'sensor' && comp.platform !== 'binary_sensor') continue
            assert.notEqual(comp.entity_category, 'config', `${name} must not be entity_category 'config'`)
        }
    })
})
