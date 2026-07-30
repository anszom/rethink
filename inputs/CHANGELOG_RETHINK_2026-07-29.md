# Changelog for 2REF12EII_P_2 (LG ThinQ Refrigerator)

## Date: 2026-07-29

### Files touched inside the project

- `cloud/devices/2REF12EII_P_2.ts` — device driver refactored (see below)
- `tests/cloud/devices/2REF12EII_P_2.test.ts` — revised to match all changes, plus one broken test capture fixed

---

### Scope (from introduction.md)

Three best-practice items had to be implemented:

1. Use `unpackStatus` / `packStatus` from `fridge_common.ts` instead of raw byte offsets in `processStatus`.
2. Door state should also come from the 0x10EC status block so it is correct at startup.
3. The `_F017` test captures were inconsistent — one had a wrong body length.

Additionally an overall investigation of the "ack flag" mystery was requested.

---

### Follow-up: Startup initialization for all entities (2026-07-30)

#### Problem

The `start()` method was empty (`start() {}`), so no query was sent when the fridge connected at boot.
Live captures in `fridge_study.jsonl` show multiple sessions where only `0x10AF` keepalives arrive —
**no `0x10EC` status block** until you send a command manually (see Session #2, lines 58–63).
This meant ALL entities stayed `undefined` at startup in those scenarios, including the newly added
`pure_n_fresh_replace` and `water_filter` sensors.

#### Solution

Following the same pattern as `2REF11EBIVPC4.ts` and `2REF11EIDA__4.ts`:

1. **`start()` now sends F0ED status query** — triggers the device to push its complete 9-byte initial state immediately on connect
2. **Added `0x10EB` handler in `processAABB`** — handles `[cmd 2B][status 9B]` responses from the F0ED query, feeding them through the same `processStatus()` pipeline as `0x10EC`

#### Changes to `cloud/devices/2REF12EII_P_2.ts`

```diff
- start() {}
+ start() {
+     this.send(Buffer.from('F0ED1211010000010400', 'hex'))
+ }

  processAABB(buf: Buffer) {
      if (buf.length === 20 && buf[0] == 0x10 && buf[1] == 0xec) { ... }
+     if (buf.length === 2 + 9 && buf[0] == 0x10 && buf[1] == 0xeb) {
+         this.processStatus(buf.subarray(2, 2 + 9))
+     }
```

#### Changes to `tests/cloud/devices/2REF12EII_P_2.test.ts`

| Old Test                                                                                      | New Test                                                                                                                         | Reason                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"start() sends no packet (device self-reports on connect)"` — expected `outbox.length === 0` | `"start() sends the F0ED status-query packet so all entities initialize at boot"` — expects one packet with `[2]=0xf0, [3]=0xed` | start() now queries for initial state                                                                                                                                |
| None                                                                                          | `"0x10EB initial status (9-byte variant) populates all seven entities at startup"`                                               | Tests that fridge_setpoint, freezer_setpoint, door, express_freeze, pure_option, pure_n_fresh_replace, and water_filter are ALL populated from a single 0x10EB frame |
| `"door state is reported via 0x10A8 frames, not from the 0x10EC status block"`                | `"door state is also reported via 0x10A8 frames (secondary source)"`                                                             | Corrected description — 0x10EC and 0x10EB are both primary sources for door                                                                                          |

**All 29 device tests pass. Full test suite: 319/319 ✅**

### Changes to `cloud/devices/2REF12EII_P_2.ts`

#### 1. Replaced manual byte-offset decoding with `unpackStatus` (fridge_common best practice)

**Before** (`processStatus`):

```ts
const fridgeTemp = 7 - curStatus[1] // raw offsets
const freezerRaw = curStatus[2]
const expressOn = curStatus[3] === 0x02
const pureNFreshRaw = curStatus[4]
// door NOT extracted here ❌
```

**After**:

```ts
const status = unpackStatus(curStatus) // named fields from STATUS_FIELDS
const fridgeTemp = 7 - status.fridgeSetpoint
const freezerTemp = -(status.freezerSetpoint + 15)
const expressOn = status.expressFreeze === 0x02
const pureNFreshName = PURE_RAW_TO_NAME[status.freshAirFilter] ?? 'Automatic'
const doorOpen = status.anyDoorOpen === 0x01 // ✅ now decoded here too
```

`unpackStatus` maps each byte index to the named `STATUS_FIELDS` from `fridge_common.ts`:

- Index 1 → `fridgeSetpoint` (raw)
- Index 2 → `freezerSetpoint` (raw)
- Index 3 → `expressFreeze`
- Index 4 → `freshAirFilter` (Pure N Fresh)
- **Index 7 → `anyDoorOpen`** ← this is what the introduction.md meant by door state from status

The temperature formulas are device-specific (`C = 7 - raw`, `C = -(raw + 15)`), NOT the generic `convert*()` helpers shared across models. Those helpers have different constants for a different fridge model and would produce wrong °C values here.

#### **New import**:

```ts
import { freezerRange, fridgeRange, unpackStatus } from './fridge_common'
```

---

#### 2. Door state decoded from 0x10EC status block (byte[7] = `anyDoorOpen`)

Previously door was only reported via separate 0x10A8 frames. On startup this meant the
entity value was `undefined` until the first door event arrived on the wire.

**Evidence**: All 24 live 0x10EC status captures have byte[7] matching exactly with
the corresponding cloud-reported `refState.atLeastOneDoorOpen`:

- 0x00 → cloud reports `"CLOSE"`
- 0x01 → cloud reports `"OPEN"`

**After fix**: Door entity is populated immediately after the first 0x10EC status push on every boot.

Line added in `processStatus`:

```ts
this.publishProperty('door', doorOpen ? 'ON' : 'OFF')
```

The existing 0x10A8 handler is kept as a secondary/confirming source — both mechanisms now
publish the same property, and `publishCache` deduplicates unchanged values.

---

#### 3. "Ack flag" clarification → it's actually **tempUnit**

The introduction.md asked what the mysterious `body[10] = 0x01` on temperature writes was.

Analysis of all 12 live F017 captures from `fridge_study.jsonl`:

| Byte[10] | Operation type                                  | Examples                                               |
| -------- | ----------------------------------------------- | ------------------------------------------------------ |
| **0x01** | Temperature change (fridge OR freezer)          | fridge to 5°C, 2°C, 3°C; freezer to -19°C, -18°C       |
| **0xFF** | Non-temp command (express freeze, pure N fresh) | All 4 Pure options toggles, both Express Freeze on/off |

From `fridge_common.ts`:

```ts
STATUS_FIELDS[8] = 'tempUnit' // 0=fahrenheit, 1=celsius
```

This device is **always Celsius**. The F017 layout mirrors the same field at body[10].
The original code labeled it "ack flag" — technically inaccurate. It's the `tempUnit` field
which tells the device to interpret the write value as Celsius (0x01). Keeping `0xFF` on
non-temperature commands means "don't change the unit".

**No functional change required** — the previous behavior (`body[10] = 0x01` on temp changes)
was already correct. The comment was updated for accuracy:

```ts
baseMessage[10] = 0x01 // tempUnit (C=0x01) — live captures show body[10], not body[8]
```

---

### Changes to `tests/cloud/devices/2REF12EII_P_2.test.ts`

#### Fixed broken test capture

`FREEZER_SET_M18C_F017` was **44 bytes** instead of the correct 43. No matching live traffic
found for that hex string — it appeared to be an authoring error (extra `ff` byte after the command header).

Replaced with the actual live capture from `fridge_study.jsonl` line 76:

```diff
- FREEZER_SET_M18C_F017: buf('aa2ff017ffffffffff03ffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffdbbb'),
+ FREEZER_SET_M18C_F017: buf('aa2ff017ffff03ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff97bb'),
```

#### Revised test expectations

| Old Test                                                                                                  | New Test                                                                                             | Reason                                            |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `"0x10EC baseline decodes four properties (door comes from 0x10A8 only)"` — expected `door === undefined` | `"baseline decodes all five properties including door from status block"` — expects `door === 'OFF'` | Door now decoded in processStatus                 |
| `"door state is reported via 0x10A8 frames, not from the 0x10EC status block"`                            | `"door state from 0x10EC status block reports open when anyDoorOpen=1"`                              | Tests door from 0x10EC                            |
| New: `"door state is also reported via 0x10A8 frames"`                                                    | —                                                                                                    | Verifies 0x10A8 still works as a secondary source |

All 26 device tests pass. **Full test suite: 323/323 ✅**

---

### Temporary files (analysis)

`inputs/fridge_analysis.py` — Python script that validated all protocol hypotheses against the live capture data before making changes. Can be deleted or kept as reference.
