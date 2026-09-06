import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/1WPD6CMIDR__3'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = '1WPD6CMIDR__3'
const META: Metadata = { modelId: MODEL_ID, modelName: '1WPD6CMIDR__3', swVersion: '1.0' }

// ─────────────────────────────────────────────────────────────────────────────
// Real captured frames from the owner's LG water purifier (2026-09-06).
// Every field below was cross-validated against LG cloud `wpState` values
// reported at the same timestamp — see
// rethink-mapping/analysis/wp/FINDINGS.md for the derivation.
//
// Two frame families arrive, both AA..BB framed. AABBDevice hands
// processAABB() `raw.subarray(2, len-2)`, so handler offsets are raw-2.
//
//   raw 336/337  state frame   — dispense amounts + on-screen mode
//   raw 270      config frame  — locks, features, ice, hot-water temp
//
// State frames need normalisation: raw index 12 holds the length of a variable
// region starting at index 14. Stripping it makes every state frame 334 bytes,
// which is why 336- and 337-byte captures both appear below.
// ─────────────────────────────────────────────────────────────────────────────

// state, idle: no water flowing (raw 336)
const IDLE = buf(
    'AAFF120A0150007F920002010200F50B070601033015980167FF0332000100390C0D3C01000000000000000000000000000000000006A3C119230DF901370138014E0158000F0113FFBA021BFFA9FFE00000000000000000000001008400DF0F2C0B3401C900640C1932640103370000000001010C5A0000000000000000000000000000000000000E0015000300FF00FF0057F0000500070000350000000029302961017AA3000000C701000000000000010000000000320005A000000000000100004600390102000451FFDA1E0800000000000144220A0001000000000000000000000000000000000003E803F602F201A5022C0300000000002000303436425700390104004503000082000000004734101F1FD91E06D22F010EFDFDFDEBC50AFCFC01FC0100004801E00000000000000000000000000000000000000000000000007847D90EEB2D1800E01B64BB',
)

// state, hot water selected and preparing to dispense (hotWaterAmount == 2) — 14:28:24.
// Nothing else is flowing in this capture, so it isolates the prepare stage.
const HOT_PREPARE = buf(
    'AAFF120A0151007FB40002010300F6050B070601033015980167FF01195A0100390C0D3C0A010000000000000000000000000000020006A8F9181C0EF9011B012C02C8022800340111FFB10230FFE0000300000080000001000000010186060A0E250C3401C100640C1932640103370000000001010C5A0000000000000000000000000000000000000E0015000300FF00FF00638E00050007000035010001002D302961017AA3037000C0053A003802AF03730877087A003F3205A000000000000100017F0044000208045100B17E0000000000000144200A0001000000F900000000000E0000000100000003E803F602F201A5024402000000000020003034364257008701040045030000820000000047300F1A1A011F06C02C0330FDFDFDE1F809FCFC01FC0100004901E000000000000000000000000000000000000000000000000078470130E12A1800E069F5BB',
)

// state, hot water preparing while a cold dispense is still finishing — 14:18:43.
// Cold reads 120 here, so the frame must report DISPENSING rather than PREPARING.
const HOT_PREPARE_DURING_COLD = buf(
    'AAFF120A0151007FA70002010300F6010B070601033015980167FF010C5A0100390C0D3C01000000000000000000000000007800020006A4A72B120EF9005C011A01370135000B0112FFC90228FF81FFA1000000000000000000000100847273211B0C3401C900640C1932640103370000000001010C5A0000000000000000000000000000000000000E0015000300FF00FF006110000500070000350101010033302961017AA301B800C4053A003B01640164046104E7003C3205A000000000000100016400440003030451FF341A0800000000000142220A0001000000000000000000000000000000000003E803F602F201A50232030000000000200030343642570092010400450300008200000000472F0E1D1DD91E05BD2A0106FDFDFDE1EE09FCFC01FC0100004801E00000000000000000000000000000000000000000000000007847D906E12A1800E02231BB',
)

// state, hot water actually dispensing 120 ml — 14:19:08. Cloud: hotWaterAmount 120
const HOT_DISPENSE = buf(
    'AAFF120A0151007FA80002010300F6030B070601033015980167FF010C5A0100390C0D3C01000101000001000000000000000000780006A5F908130EF903C0012203D203D8001F0111FFC30299FF79FF9F0000000000000100DA0001018902EA3A1B0C3401C900640C1932640103370000000001010C5A0000000000000000000000000000000000000E0015000300FF00FF006142000500070000340001010032302961017AA301AE00C0053A003B018C00F904E004A7003B3205A000000000000100016400450003030451FF33120800000000000142220A0001000000000000000000000000000000000003E803F602F201A50232030000000000200030343642570067010400450300008200000000472F0E1D1DD91E05BD2A0106FDFDFDE1EE09FCFC01FC0100004801E00000000000000000000000000000000000000000000000007847D906E12A1800E0EDE4BB',
)

// state, filtered ("normal") water dispensing 120 ml — 14:20:41. Cloud: normalWaterAmount 120
const NORMAL120 = buf(
    'AAFF120A0151007FAD0002010300F6030B070601033015980167FF020C000100390C0D3C01000101000100000000000078000000000006A71929140EF900F20123037D02AD001F0113FFB30240FF65FF960000000000000100E00001018902A81F1D0C3401C900640C1932640103370000000001010C5A0000000000000000000000000000000000000E0015000300FF00FF0061FC000500070000340001010033302961017AA3019000C5053A00390146014C0405045700393205A000000000000100016400440003030451FF21120800000000000142220A0001000000000000000000000000000000000003E803F602F201A5023203000000000020003034364257003401040045030000820000000047300F3A3A191E05BE2B0118FDFDFDE1F309FCFC01FC0100004801E000000000000000000000000000000000000000000000000078471918E12A1800E0DA03BB',
)

// state, cold water dispensing 250 ml — 14:23:19. Cloud: coldWaterAmount 250
const COLD250 = buf(
    'AAFF120A0151007FAF0002010300F6030B070601033015980167FF0319000100390C0D3C0100010100000000000100000000FA00000006A8F913170EF90070012303300295002F0111FFA00234FF57FF8D0000000000000101D90001018902C209200C3401C900640C1932640103370000000001010C5A0000000000000000000000000000000000000E0015000300FF00FF006338000500070000350101010033302961017AA3018600C3053A0039017F020604B7046500253205A000000000000100016400440003030451FF20120800000000000140200A000100770077007700050007000D010101000303E803F602F201A5023203000000000020003034364257005101040045030000820000000047300F3A3A191E05BE2B0118FDFDFDE1F309FCFC01FC0100004801E000000000000000000000000000000000000000000000000078471918E12A1800E0F845BB',
)

// config, everything unlocked / all features on — 13:41:15
const CFG_IDLE = buf(
    'AAFF120A010E007FFF000100EC00FC020003FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000020103FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000151CBB',
)

// config, hot-water tank at 90 °C — 14:18:44. Cloud: hotWaterTemp 90
const HOTTEMP90 = buf(
    'AAFF120A010E007FFF000100EC00FC020003FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000020001FF01015AFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A0000000000000000000000010000640000040101000000010200005EF7BB',
)

// config, hot-water lock engaged — 14:24:00. Cloud: hotWaterLock LOCK
const HOTLOCK_ON = buf(
    'AAFF120A010E007FFF000100EC00FC020003FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000020003FF0101FFFF0001010201003C090D0C390001000100000000FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A00000000000000000000000100006400000401010000000102000029CDBB',
)

// config, ice lock engaged — 14:24:25. Cloud: iceLock ON
const ICELOCK_ON = buf(
    'AAFF120A010E007FFF000100EC00FC020003FF0101FFFF0001010201003C090D0C390001000100000000FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000020003FF0101FFFF0001010201003C090D0C390001000100000000FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A0000000000000000000000010100640000040101000000010200002E56BB',
)

// config, child lock engaged — 14:19:14. Cloud: deviceLock ON
const CHILDLOCK_ON = buf(
    'AAFF120A010E007FFF000100EC00FC020001FF01015AFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000020001FF01015AFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A00000000000000000000000100006400010401010000000102000092C1BB',
)

// config, ice maker switched off — 14:26:24. Cloud: iceMaker OFF
const ICEMAKER_OFF = buf(
    'AAFF120A010E007FFF000100EC00FC020003FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000001000064000004010100000001020000020003FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000000000064000004010100000001020000088FBB',
)

// config, outlet high-temperature sterilisation running — 14:28:24. Cloud: highSterilizeState FLUSH
const STERILIZING = buf(
    'AAFF120A010E007FFF000100EC00FC020003FF0101FFFF0001010201003C090D0C390001000100000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000000000064000002010100000001020000020003FF0101FFFF0001010201003C090D0C390001000104000001FF0000000C193264FC03003701015A0C010000000000000000FFFFFFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF000E001500FFFF0328465A000000005A000000000000000000000000000064000002010100000001020000216ABB',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('publishes its discovery config on construction', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID]?.config?.components as Record<string, Record<string, unknown>>
        assert.ok(components, 'config published')

        // read-only integration: nothing may expose a command topic
        for (const [name, comp] of Object.entries(components)) {
            assert.equal(comp.command_topic, undefined, `${name} must be read-only`)
        }
    })

    describe('state frames — dispensing', () => {
        test('idle: no dispense in progress', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', IDLE)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.dispensing, 'OFF')
            assert.equal(p.hot_water_amount, 0)
            assert.equal(p.cold_water_amount, 0)
            assert.equal(p.normal_water_amount, 0)
        })

        test('hot water: "preparing" is not yet dispensing', () => {
            // The owner described the UI as 출수 준비중 → 출수; the appliance encodes the
            // prepare stage as amount 2, which must not be reported as 2 ml poured.
            const { ha, thinq } = makeDevice()
            thinq.emit('data', HOT_PREPARE)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.dispense_state, 'PREPARING')
            assert.equal(p.dispensing, 'OFF')
            assert.equal(p.hot_water_amount, 0)
        })

        test('a real pour outranks another outlet that is still preparing', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', HOT_PREPARE_DURING_COLD)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.dispense_state, 'DISPENSING')
            assert.equal(p.dispensing, 'ON')
            assert.equal(p.cold_water_amount, 120)
            assert.equal(p.hot_water_amount, 0) // still only preparing
        })

        test('hot water: dispensing 120 ml', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', HOT_DISPENSE)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.dispense_state, 'DISPENSING')
            assert.equal(p.dispensing, 'ON')
            assert.equal(p.hot_water_amount, 120)
            assert.equal(p.last_water_type, 'HOT_WATER')
        })

        test('filtered water: dispensing 120 ml', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', NORMAL120)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.dispensing, 'ON')
            assert.equal(p.normal_water_amount, 120)
            assert.equal(p.last_water_type, 'NORMAL_WATER')
        })

        test('cold water: dispensing 250 ml', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', COLD250)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.dispensing, 'ON')
            assert.equal(p.cold_water_amount, 250)
            assert.equal(p.last_water_type, 'COLD_WATER')
        })

        test('the last dispensed water type persists once the pour ends', () => {
            // This byte only advances when a dispense begins. Cycling the panel between
            // cold/hot/filtered without pouring leaves the state frame byte-identical, so
            // it records the last pour and is not an on-screen mode indicator.
            const { ha, thinq } = makeDevice()
            thinq.emit('data', IDLE)
            assert.equal(ha.devices[DEVICE_ID].properties.last_water_type, 'COLD_WATER')
        })

        test('337- and 336-byte state frames decode to the same field offsets', () => {
            // 337-byte frames carry one extra byte in the variable region; without
            // normalisation every field after it would be off by one.
            const a = makeDevice()
            a.thinq.emit('data', COLD250) // raw 337
            assert.equal(a.ha.devices[DEVICE_ID].properties.cold_water_amount, 250)

            const b = makeDevice()
            b.thinq.emit('data', IDLE) // raw 336
            assert.equal(b.ha.devices[DEVICE_ID].properties.cold_water_amount, 0)
        })
    })

    describe('config frames — locks and features', () => {
        test('all locks released, all features on', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', CFG_IDLE)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.hot_water_lock, 'OFF')
            assert.equal(p.ice_lock, 'OFF')
            assert.equal(p.child_lock, 'OFF')
            assert.equal(p.cold_water_enabled, 'ON')
            assert.equal(p.ice_maker, 'ON')
            assert.equal(p.sterilizing, 'OFF')
        })

        test('hot water lock engaged', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', HOTLOCK_ON)
            assert.equal(ha.devices[DEVICE_ID].properties.hot_water_lock, 'ON')
        })

        test('ice lock engaged', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', ICELOCK_ON)
            assert.equal(ha.devices[DEVICE_ID].properties.ice_lock, 'ON')
        })

        test('child lock engaged', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', CHILDLOCK_ON)
            assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        })

        test('ice maker switched off', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', ICEMAKER_OFF)
            assert.equal(ha.devices[DEVICE_ID].properties.ice_maker, 'OFF')
        })

        test('high-temperature sterilisation running', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', STERILIZING)
            const p = ha.devices[DEVICE_ID].properties
            assert.equal(p.sterilizing, 'ON')
            assert.equal(p.sterilize_state, 'FLUSH')
        })

        test('hot water tank temperature', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', HOTTEMP90)
            assert.equal(ha.devices[DEVICE_ID].properties.hot_water_temp, 90)
        })

        test('hot water temperature clears when the pour ends', () => {
            // The reading is live only during a hot pour and reverts to 0xFF afterwards.
            // Holding the last pour's value would leave a stale temperature on display.
            const { ha, thinq } = makeDevice()
            thinq.emit('data', HOTTEMP90)
            assert.equal(ha.devices[DEVICE_ID].properties.hot_water_temp, 90)

            thinq.emit('data', CFG_IDLE) // this capture carries 0xFF in the temp slot
            assert.equal(ha.devices[DEVICE_ID].properties.hot_water_temp, 'unknown')
        })

        test('ice status is decoded', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', CFG_IDLE)
            assert.equal(ha.devices[DEVICE_ID].properties.ice_status, 'FULL')

            const off = makeDevice()
            off.thinq.emit('data', ICEMAKER_OFF)
            assert.equal(off.ha.devices[DEVICE_ID].properties.ice_status, 'FULL')
        })

        test('cock state is decoded', () => {
            // This capture was taken while the outlet was still running, so it reads ON.
            const { ha, thinq } = makeDevice()
            thinq.emit('data', CFG_IDLE)
            assert.equal(ha.devices[DEVICE_ID].properties.cock_state, 'ON')
        })
    })

    describe('malformed input (synthetic, not captured)', () => {
        test('frames without the AA..BB envelope are ignored', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf('001122'))
            assert.equal(ha.devices[DEVICE_ID].properties.dispensing, undefined)
        })

        test('an AA..BB frame of unknown length is ignored', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf('AA06FFFFFF55BB'))
            assert.equal(ha.devices[DEVICE_ID].properties.dispensing, undefined)
        })

        test('a truncated state frame does not throw or publish', () => {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf('AAFF120A0151007FA8000201030000BB'))
            assert.equal(ha.devices[DEVICE_ID].properties.dispensing, undefined)
        })

        test('a state frame whose variable-region length overruns the buffer is ignored', () => {
            const bad = Buffer.from(IDLE)
            bad[12] = 0xff // claim a 255-byte variable region
            const { ha, thinq } = makeDevice()
            thinq.emit('data', bad)
            assert.equal(ha.devices[DEVICE_ID].properties.dispensing, undefined)
        })
    })

    test('does not transmit anything to the appliance', () => {
        // A read-only handler must never write to a live appliance.
        const { thinq, dev } = makeDevice()
        const sent: Buffer[] = []
        thinq.send_packet = (p: Buffer) => void sent.push(p)
        dev.start()
        thinq.emit('data', HOT_DISPENSE)
        thinq.emit('data', CFG_IDLE)
        assert.deepEqual(sent, [])
    })

    describe('HA enum contract', () => {
        // device_class 'enum' rejects any state outside `options`, with 'unknown' as the
        // sole exception, so every value the handler can emit must be declared.
        test('every published enum value is declared in its options list', () => {
            const { ha, thinq } = makeDevice()
            for (const frame of [
                IDLE,
                COLD250,
                HOT_PREPARE,
                HOT_PREPARE_DURING_COLD,
                HOT_DISPENSE,
                NORMAL120,
                CFG_IDLE,
                HOTTEMP90,
                HOTLOCK_ON,
                ICELOCK_ON,
                CHILDLOCK_ON,
                ICEMAKER_OFF,
                STERILIZING,
            ]) {
                thinq.emit('data', frame)
            }

            const components = ha.devices[DEVICE_ID].config!.components as Record<
                string,
                { device_class?: string; options?: string[] } | undefined
            >
            const props = ha.devices[DEVICE_ID].properties

            const enums = Object.entries(components).filter(([, c]) => c?.device_class === 'enum')
            assert.ok(enums.length > 0, 'expected enum-classed entities')

            for (const [id, component] of enums) {
                const value = props[id]
                if (value === undefined || component === undefined) continue
                assert.ok(
                    value === 'unknown' || component.options?.includes(String(value)),
                    `${id} published ${JSON.stringify(value)}, absent from options ${JSON.stringify(component.options)}`,
                )
            }
        })
    })
})
