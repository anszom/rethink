import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FAFXU25006'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'FAFXU25006'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '0.0.0' }

// All fixtures are REAL frames captured live from the appliance via rethink-capture, each cross-checked
// against the LG cloud's own decoded washerDryer state at matching timestamps, not guessed from static
// analysis. The comments name the cloud field that confirmed each one.

// Powered off after a finished Duvet cycle, as a single-record 0xEB frame: cloud state:"POWEROFF".
// rec[22] still holds 16 (End), the state the machine came from, and rec[18:20] still holds the 127 Wh
// that cycle used.
const EB_POWER_OFF = buf(
    'aaff200a005a000fa8000100eb00480aff00ffff1b0000000000000000010000007f001b001000020000ff2004ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100000e45bb',
)

// Normal selected, idle: cloud course:"NORMAL", soilWash:"SOILWASH_NORMAL", temp:"TEMP_WARM",
// spin:"SPIN_HIGH", turboWash:"TURBOWASH_ON", state:"INITIAL", remainTimeMinute and
// initialTimeMinute both 39, which appear on the wire as 27 00, little-endian.
const NORMAL_IDLE = buf(
    'aaff200a00a2001002000100ec00900aff000e000000000000000000000100000001002e0001006400000e2004ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000002700270000002e0101006400000e2004ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff01000049b8bb',
)

// Speed Wash: cloud course:"SPEEDWASH", soilWash:"SOILWASH_LIGHT", temp:"TEMP_HOT",
// spin:"SPIN_EXTRA_HIGH", turboWash:"TURBOWASH_OFF", remainTimeMinute:14.
const SPEED_WASH = buf(
    'aaff200a00a2001005000100ec00900a03090e0f2e00000000000000001d001d0000002e0101000200000e2004ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100000a010a0e104a00000000000000000e000e0000004a0101000200000e2004ffff2d3c000000420004300000000000000400004000000000000000f00064000400000000ffff0100003e62bb',
)

// Heavy Duty: cloud course:"HEAVYDUTY", soilWash:"SOILWASH_HEAVY", turboWash:"TURBOWASH_ON",
// remainTimeMinute:108.
const HEAVY_DUTY = buf(
    'aaff200a00a2001006000100ec00900a010a0e104a00000000000000000e000e0000004a0101000200000e2004ffff2d3c000000420004300000000000000400004000000000000000f00064000400000000ffff0100000a05090e102300000000000000006c006c000000230101000200000e2004ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100005323bb',
)

// Tub Clean: cloud course:"TUB_CLEAN", steam:"STEAM_ON", and the two "not applicable" sentinels this
// course uses: soilWash:"SOILWASH_DASH" (0xff) and temp:"NO_TEMP" (0x00).
const TUB_CLEAN = buf(
    'aaff200a00a2001009000100ec00900a03090e10540000000000000000380038000000540101000200000e2004ffff2d3c000000420004300000000000000400004000000000000000f00064000400000000ffff0100000aff000e0e550000000000000000570057000000550101000200000e2004ffff2d3c001000420004300000000000000400004000000000000000f00064000400000000ffff010000d18ebb',
)

// Spin Only: cloud course:"SPIN_ONLY", rinse:"RINSE_DASH", the 0xff sentinel in rec[3], on a course
// that does not rinse at all.
const SPIN_ONLY = buf(
    'aaff200a00a200100a000100ec00900aff000e0e550000000000000000570057000000550101000200000e2004ffff2d3c001000420004300000000000000400004000000000000000f00064000400000000ffff0100000aff00ff0f4e00000000000000000b000b0000004e010100020000ff2004ffff2d3c000000420004300000000000000400004000000000000000f00064000400000000ffff0100001641bb',
)

// Pet Care: cloud course:"PET_CARE", preWash:"PREWASH_ON" (rec[34] bit 0x40) with
// turboWash:"TURBOWASH_OFF" in the same notification, temp:"TEMP_EXTRA_HOT", remainTimeMinute:118.
const PET_CARE = buf(
    'aaff200a00a200100e000100ec00900a03090e0f8800000000000000003a003a000000880101000200000e2004ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100000a030b0e0e770000000000000000760076000000770101000200000e2004ffff2d3c400000420004300000000000000400004000000000000000f00064000400000000ffff0100005f27bb',
)

// Allergy Care: cloud course:"ALLERGYCARE" with steam:"STEAM_ON" and preWash:"PREWASH_OFF" together,
// which is what separates the two bitfields: steam is rec[35], pre-wash is rec[34].
const ALLERGY_CARE = buf(
    'aaff200a00a200100f000100ec00900a030b0e0e770000000000000000760076000000770101000200000e2004ffff2d3c400000420004300000000000000400004000000000000000f00064000400000000ffff0100000aff000e0f050000000000000000630063000000050101000200000e2004ffff2d3c001000420004300000000000000400004000000000000000f00064000400000000ffff0100007d45bb',
)

// A step of the Rinse button on Normal: cloud rinse:"RINSE_PLUS3" and rinseCount:"RINSE_PLUS3" (0x11),
// the top of that scale. Each extra rinse also stretches the estimate, here to 61 minutes.
const RINSE_PLUS3 = buf(
    'aaff200a00a200104a000100ec00900a010810102e00000000000000003700370002002e010100020000102004ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0100000a010811102e00000000000000003d003d0002002e010100020000112004ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0100005c9abb',
)

// The start of the cycle: rec[21] 1 -> 11, cloud state:"RUNNING".
const STARTS_RUNNING = buf(
    'aaff200a00a2001057000100ec00900a03070e0e1b00000000000000003600360002001b0101000200000e2004ffff2d3c000000020004300000000000000400004000000000000000f00064000400000000ffff0100000a03070e0e1b00000000000000003600360000001b0b01000200000e200400002d3c000000100004300000000000000400004000000000000000f00064000400000000ffff01000038d4bb',
)

// A second later the door locks. The cloud reported exactly two things in this notification,
// doorLock:"DOORLOCK_ON" and preState:"RUNNING", and exactly two bytes moved: rec[38] 0 -> 1 and
// rec[22] 1 -> 11. That pairing is what tells the door lock and the previous-state byte apart.
const DOOR_LOCKS = buf(
    'aaff200a00a2001058000100ec00900a03070e0e1b00000000000000003600360000001b0b01000200000e200400002d3c000000100004300000000000000400004000000000000000f00064000400000000ffff0100000a03070e0e1b00000000000000003600360000001b0b0b000200000e200400002d3c000000100104300000000000000400004000000000000000f00064000400000000ffff010000486dbb',
)

// Two minutes into the run: cloud remainTimeMinute:52 while initialTimeMinute stays at 54, and
// courseSpendPower:1, the separate countdown and cycle-length fields, plus the energy counter.
const RUNNING_COUNTDOWN = buf(
    'aaff200a00a200105a000100ec00900a03070e0e1b00000000000000003500360000001b0b0b000200000e200400002d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100000a03070e0e1b00000000000000003400360001001b0b0b000200000e200400002d3c000000100104300000000000000400004000000000000000f00064000400000000ffff010000a195bb',
)

// Later in an earlier cycle: cloud state:"RINSING" (rec[21] = 12) with rec[22] holding the Running it
// came from.
const RINSING = buf(
    'aaff200a00a2000e6e000100ec00900a03080e0e1b00000000000000001d00360039001b0b0b000200000e1f0400002d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100000aff000e0e1b00000000000000001c0036003b001b0c0b000200000e1f04ff002d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100007e18bb',
)

// And the spin: cloud state:"SPINNING" (rec[21] = 14) with rec[22] holding the Rinsing before it.
const SPINNING = buf(
    'aaff200a00a2000f5c000100ec00900aff000e0e1b0000000000000000070036006f001b0c0c000200000e1f04ff002d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ff0e1b00000000000000000600360071001b0e0c00020000ff1f04ffff2d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100007d4ebb',
)

// End of a cycle, as a 0xEB single-record frame: rec[21] = 16 with rec[22] = 14, the spin it just
// finished. This one is wire-only, the cloud feed having lapsed by then, so it is used for the frame
// shape and the state chain, not as an independent confirmation of the End code.
const EB_ENDS = buf(
    'aaff200a005a000df6000100eb00480aff00ffff54000000000000000001000000630054100e00010000ff1f04ffff2d3c000000400104300000000000000400004000000000000000f00064000400000000ffff010000bcd7bb',
)

// The rest of that same Bedding cycle, captured after the cloud feed had lapsed, so these six are
// wire-only: no cloud field confirms them. They are here because the state chain and the door lock
// behave exactly as the frames above established, at moments that were driven by hand and timed.

// Paused by hand during the spin with 5 minutes left: rec[21] 14 -> 2, and rec[22] keeps the Spinning.
const PAUSES = buf(
    'aaff200a00a20011ef000100ec00900aff00ff0e1b00000000000000000500360086001b0e0e00020000ff2004ffff2d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ff0e1b00000000000000000500360086001b020e00020000ff2004ffff2d3c000000400104300000000000000400004000000000000000f00064000400000000ffff0100000934bb',
)

// Two seconds after the pause the door unlocks, rec[38] 1 -> 0 with the state already settled at 2.
const UNLOCKS_ON_PAUSE = buf(
    'aaff200a00a20011f0000100ec00900aff00ff0e1b00000000000000000500360086001b020e00020000ff2004ffff2d3c000000400104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ff0e1b00000000000000000500360086001b020200020000ff2004ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff010000c9e9bb',
)

// Resumed 20 seconds later, back to Spinning with the countdown still at 5.
const RESUMES = buf(
    'aaff200a00a20011f5000100ec00900aff00ff0e1b00000000000000000500360086001b020200020000ff2004ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100000aff00ff0e1b00000000000000000500360086001b0e0200020000ff2004ffff2d3c000000100004300000000000000400004000000000000000f00064000400000000ffff010000ef01bb',
)

// The cycle finishes: rec[21] 14 -> 16, and the cycle-length field drops to 0 while the countdown
// stops at 1 rather than 0. 144 Wh for the whole Bedding cycle.
const ENDS = buf(
    'aaff200a00a2001223000100ec00900aff00ff0e1b0000000000000000010036008f001b0e0e00020000ff2004ffff2d3c000000100104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ffff1b00000000000000000100000090001b100e00020000ff2104ffff2d3c000000400104300000000000000400004000000000000000f00064000400000000ffff010000d0a1bb',
)

// A second after that the door unlocks again.
const UNLOCKS_AT_END = buf(
    'aaff200a00a2001224000100ec00900aff00ffff1b00000000000000000100000090001b100e00020000ff2104ffff2d3c000000400104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ffff1b00000000000000000100000090001b101000020000ff2104ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100009031bb',
)

// And seven seconds later the machine powers itself off, with rec[22] holding the End it came from.
const POWERS_OFF = buf(
    'aaff200a00a2001225000100ec00900aff00ffff1b00000000000000000100000090001b101000020000ff2104ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100000aff00ffff1b00000000000000000100000090001b001000020000ff2104ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff010000af44bb',
)

// A one-hour Delay Wash set from the panel: cloud delay:"DELAY_ON" and reserveTimeMinute:60, and
// exactly two bytes moved for it: 60 into rec[12:14] and bit 0x80 into rec[39].
const DELAY_WASH = buf(
    'aaff200a00a2001273000100ec00900a03090e0f2e00000000000000001d001d0000002e0101000200000e2104ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e0000000000003c001d001d0000002e0101000200000e2104ffff2d3c200000420084300000000000000400004000000000000000f00064000400000000ffff0100002141bb',
)

// The delay starting: state 1 INITIAL gives way to 7 RESERVED, cloud state:"RESERVED". rec[30] and
// rec[31] leave the 255 dash for 0 in the same frame, matching ezCSDetergentSetVal:"EZCSDT_OFF" and
// ezCSSoftenerSetVal:"EZCSSO_OFF", and rec[37] drops the drum light for cloud drumLight:"DRUMLIGHT_OFF".
const DELAY_STARTS = buf(
    'aaff200a00a200134f000100ec00900a03090e0f2e0000000000003c003500350000002e0101000500000e2204ffff2d3c200000420084300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e0000000000003c003500350000002e0701000500000e220400002d3c200000100084300000000000000400004000000000000000f00064000400000000ffff0100001c7dbb',
)

// Half an hour into that delay: the two stacked records in one frame hold 31 and 30 minutes, which is
// the countdown itself caught mid-tick. The cloud reported reserveTimeMinute:30 alongside.
const DELAY_COUNTS_DOWN = buf(
    'aaff200a00a2001377000100ec00900a03090e0f2e0000000000001f003500350005002e0707000500000e220400002d3c200000100184300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e0000000000001e003500350005002e0707000500000e220400002d3c200000100184300000000000000400004000000000000000f00064000400000000ffff010000e3abbb',
)

// The delay firing an hour later: the countdown reaches 0, rec[39] drops the 0x80 delay bit and the
// state goes 7 RESERVED to 11 RUNNING, all in one frame. Cloud: delay:"DELAY_OFF",
// reserveTimeMinute:0, state:"RUNNING". Note the wash starts directly, without passing DETECTING,
// which a cycle started at the panel does: the load was already weighed before the delay began.
const DELAY_FIRES = buf(
    'aaff200a00a200139e000100ec00900a03090e0f2e0000000000000100350035000b002e0707000500000e220400002d3c200000100184300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e0000000000000000350035000b002e0b07000500000e220400002d3c200000100104300000000000000400004000000000000000f00064000400000000ffff010000c095bb',
)

// Rinsing giving way to Spinning at the end of a Normal wash. rec[31] leaves 0 for the 255 dash while
// rec[30] is already there, having dashed a phase earlier at the end of the wash itself. The cloud
// named this one alone, ezCSSoftenerSetVal:"EZCSSO_DASH" with no detergent field in the notification,
// which is what tells the two dispensers apart. Also cloud state:"SPINNING" with remainTimeMinute:17.
const SPIN_STARTS = buf(
    'aaff200a00a20013d7000100ec00900aff000e0f2e0000000000000000120035002a002e0c0c000500000e2204ff002d3c200000100104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ff0f2e0000000000000000110035002b002e0e0c00050000ff2204ffff2d3c200000100104300000000000000400004000000000000000f00064000400000000ffff0100003fbfbb',
)

// The wash finishing: state 14 SPINNING gives way to 16 END, cloud state:"END" with drumLight
// "DRUMLIGHT_ON" and initialTimeMinute:0. The cycle length clears while the countdown stops at 1
// rather than 0, and the energy the run used stays in rec[18:20].
const CYCLE_ENDS = buf(
    'aaff200a00a20013fb000100ec00900aff00ff0f2e0000000000000000010035004e002e0e0e00050000ff2204ffff2d3c200000100104300000000000000400004000000000000000f00064000400000000ffff0100000aff00ffff2e00000000000000000100000053002e100e00050000ff2304ffff2d3c000000400104300000000000000400004000000000000000f00064000400000000ffff010000af56bb',
)

// And the machine powering itself off seven seconds later, cloud state:"POWEROFF" with preState END.
// The energy total survives it.
const POWERS_OFF_AT_END = buf(
    'aaff200a00a20013fe000100ec00900aff00ffff2e00000000000000000100000053002e101000050000ff2304ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff0100000aff00ffff2e00000000000000000100000053002e001000050000ff2304ffff2d3c000000400004300000000000000400004000000000000000f00064000400000000ffff01000077d3bb',
)

// The drum light timing out on its own, three minutes later: cloud drumLight:"DRUMLIGHT_OFF" with
// courseSpendPower:1 in the same notification, and rec[37] bit 0x40 clearing alongside the energy byte.
const DRUM_LIGHT_OFF = buf(
    'aaff200a00a2001278000100ec00900a03090e0f2e0000000000003c001d001d0000002e0101000200000e2104ffff2d3c200000420084300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e0000000000003c001d001d0001002e0101000200000e2104ffff2d3c200000020084300000000000000400004000000000000000f00064000400000000ffff010000d1c0bb',
)

// The load being weighed: rec[24] drops from the 100 sentinel to 2, matching the cloud going from
// loadLevel:"NOT_DEFINE_VALUE value:100" to "LOAD_LEVEL_2".
const LOAD_WEIGHED = buf(
    'aaff200a00a200123b000100ec00900a03090e0f2e00000000000000002700270000002e0101006400000e2104ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000001d001d0000002e0101000200000e2104ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff010000ab21bb',
)

// A second settings pass on 2026-09-04 with the oracle live, one control at a time.

// Auto Soak on: cloud autoSoak:"AUTOSOAK_ON", rec[34] going 0x20 to 0xa0, bit 0x80 added alongside
// the TurboWash bit that was already set. The estimate stretches with it, which is the other byte.
const AUTO_SOAK_ON = buf(
    'aaff200a00a20012b2000100ec00900a03090e0f2e00000000000000001d001d0000002e0101000200000e2104ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000003b003b0000002e0101000200000e2104ffff2d3ca00000020004300000000000000400004000000000000000f00064000400000000ffff010000bc8dbb',
)

// FreshCare on: cloud freshCare:"FRESHCARE_ON", and rec[36] bit 0x40 was the ONLY byte in the record
// to move.
const FRESH_CARE_ON = buf(
    'aaff200a00a20012b5000100ec00900a03090e0f2e00000000000000001d001d0001002e0101000200000e2104ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000001d001d0001002e0101000200000e2104ffff2d3c200040020004300000000000000400004000000000000000f00064000400000000ffff0100007bf6bb',
)

// The buzzer stepped down a notch: cloud buzzer:"BUZZER_3", rec[29] alone going 4 to 3.
const BUZZER_3 = buf(
    'aaff200a00a20012bb000100ec00900a03090e0f2e00000000000000001d001d0001002e0101000200000e2104ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000001d001d0001002e0101000200000e2103ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff01000011efbb',
)

// The bottom of that scale: cloud buzzer:"BUZZER_OFF" and endMelodyOnOff:"OFF" together, with rec[29]
// going 1 to 0 and rec[69] going 1 to 0 in the same frame, the reason the two are not yet separated.
const BUZZER_OFF = buf(
    'aaff200a00a20012be000100ec00900a03090e0f2e00000000000000001d001d0001002e0101000200000e2101ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000001d001d0001002e0101000200000e2100ffff2d3c200000020004300000000000000400004000000000000000f00064000400000000ffff0000007d39bb',
)

// Child lock on: cloud childLock:"CHILDLOCK_ON", rec[37] going 0x42 to 0x62 and nothing else moving,
// so bit 0x20 is the lock and the 0x40 drum-light bit beside it is undisturbed.
const CHILD_LOCK_ON = buf(
    'aaff200a00a20012c5000100ec00900a03090e0f2e00000000000000001d001d0001002e0101000200000e2104ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000001d001d0001002e0101000200000e2104ffff2d3c200000620004300000000000000400004000000000000000f00064000400000000ffff010000b699bb',
)

// Remote Maintain: cloud remoteMaintain:"REMOTE_MAINTAIN_ON", rec[40] bit 0x04. Captured while a Delay
// Wash was armed, so rec[12:14] and rec[39] carry the delay in this frame too.
const REMOTE_MAINTAIN_ON = buf(
    'aaff200a00a200127c000100ec00900a03090e0f2e0000000000003c001d001d0001002e0101000200000e2104ffff2d3c200000020084300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e0000000000003c001d001d0002002e0101000200000e2104ffff2d3c200000020084340000000000000400004000000000000000f00064000400000000ffff0100000314bb',
)

// The start of a cycle begun at the panel: rec[21] 1 -> 3, cloud state:"DETECTING", with the two
// EZDispense bytes leaving their 0xff sentinel for 0 in the same frame the cloud reported
// ezCSDetergentSetVal:"EZCSDT_OFF" and ezCSSoftenerSetVal:"EZCSSO_OFF".
const DETECTING = buf(
    'aaff200a00a20012e1000100ec00900a03090e0f2e00000000000000002700270000002e0101006400000e2104ffff2d3c200000420004300000000000000400004000000000000000f00064000400000000ffff0100000a03090e0f2e00000000000000002700270000002e0301006400000e210400002d3c200000100004300000000000000400004000000000000000f00064000400000000ffff0100002a7cbb',
)

// The door being opened, and then shut 35 seconds later. These are inner type 0x03 event frames, not
// status records: the 72-byte record does not move for a door at all and the cloud sent no
// notification either, so the pair below is the whole evidence. Each was driven on its own with
// nothing else touched, and buf[22] is the only field that differs between them apart from the two
// event counters and the checksum.
const DOOR_OPENS = buf(
    'aaff200a004900141c00020103000e610f0201610840010001000f02010105002546414658553235303036000000000000000000000102c586a2f40a09000000000000000000bd49bb',
)
const DOOR_SHUTS = buf(
    'aaff200a004900141d00020103000e610f0201610841010002000f02010105002546414658553235303036000000000000000000000102c686a2f40a0900000000000000000071febb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

function feed(frames: Buffer[]) {
    const { ha, thinq } = makeDevice()
    for (const f of frames) thinq.emit('data', f)
    return ha.devices[DEVICE_ID].properties
}

describe('FAFXU25006', () => {
    test('a selected course decodes with all of its options', () => {
        const p = feed([NORMAL_IDLE])
        assert.equal(p.power, 'ON')
        assert.equal(p.status, 'Initial')
        assert.equal(p.course, 'Normal')
        assert.equal(p.soil, 'Normal')
        assert.equal(p.temp, 'Warm')
        assert.equal(p.spin, 'High')
        assert.equal(p.rinse, 'Normal')
        assert.equal(p.turbo_wash, 'ON')
        assert.equal(p.pre_wash, 'OFF')
        assert.equal(p.steam, 'OFF')
        assert.equal(p.door_lock, 'OFF')
    })

    test('the minute counters are little-endian, unlike the LG dryers', () => {
        // 39 arrives as 27 00. Read big-endian this would be 9984 minutes.
        const p = feed([NORMAL_IDLE])
        assert.equal(p.remaining_time, 39)
        assert.equal(p.initial_time, 39)

        // and a course whose estimate does not fit in a byte
        const heavy = feed([HEAVY_DUTY])
        assert.equal(heavy.remaining_time, 108)
        assert.equal(heavy.initial_time, 108)
    })

    test('the course table covers the whole selector', () => {
        assert.equal(feed([SPEED_WASH]).course, 'Quick Wash')
        assert.equal(feed([HEAVY_DUTY]).course, 'Heavy Duty')
        assert.equal(feed([TUB_CLEAN]).course, 'Tub Clean')
        assert.equal(feed([SPIN_ONLY]).course, 'Spin Only')
        assert.equal(feed([PET_CARE]).course, 'Pet Care')
        assert.equal(feed([ALLERGY_CARE]).course, 'Allergiene')
    })

    test('soil, temperature, spin and rinse each read from their own byte', () => {
        const speed = feed([SPEED_WASH])
        assert.equal(speed.soil, 'Light')
        assert.equal(speed.temp, 'Hot')
        assert.equal(speed.spin, 'Extra High')

        const heavy = feed([HEAVY_DUTY])
        assert.equal(heavy.soil, 'Heavy')
        assert.equal(heavy.temp, 'Warm')

        const pet = feed([PET_CARE])
        assert.equal(pet.temp, 'Extra Hot')
        assert.equal(pet.spin, 'Medium')

        assert.equal(feed([RINSE_PLUS3]).rinse, 'Plus 3')
    })

    test('the not-applicable sentinels report unknown rather than a bogus setting', () => {
        // Tub Clean has no soil level and no wash temperature
        const tub = feed([TUB_CLEAN])
        assert.equal(tub.soil, 'None') // cloud: SOILWASH_DASH, 0xff
        assert.equal(tub.temp, 'None') // cloud: NO_TEMP, 0x00
        // Spin Only does not rinse
        assert.equal(feed([SPIN_ONLY]).rinse, 'None') // cloud: RINSE_DASH, 0xff
    })

    test('steam and pre-wash live in different bitfields and do not collide', () => {
        const tub = feed([TUB_CLEAN])
        assert.equal(tub.steam, 'ON')
        assert.equal(tub.pre_wash, 'OFF')
        assert.equal(tub.turbo_wash, 'OFF')

        const pet = feed([PET_CARE])
        assert.equal(pet.pre_wash, 'ON')
        assert.equal(pet.steam, 'OFF')
        assert.equal(pet.turbo_wash, 'OFF')

        // both bitfields set at once, on the course that showed steam without pre-wash
        const allergy = feed([ALLERGY_CARE])
        assert.equal(allergy.steam, 'ON')
        assert.equal(allergy.pre_wash, 'OFF')
    })

    test('turbo wash is rec[34] bit 0x20, alongside pre-wash in the same byte', () => {
        assert.equal(feed([NORMAL_IDLE]).turbo_wash, 'ON')
        assert.equal(feed([HEAVY_DUTY]).turbo_wash, 'ON')
        assert.equal(feed([SPEED_WASH]).turbo_wash, 'OFF')
    })

    test('starting the cycle moves the state and then locks the door', () => {
        const started = feed([NORMAL_IDLE, STARTS_RUNNING])
        assert.equal(started.status, 'Running')
        assert.equal(started.pre_state, 'Initial')
        assert.equal(started.door_lock, 'OFF') // the lock engages a beat later, not with the start

        const locked = feed([NORMAL_IDLE, STARTS_RUNNING, DOOR_LOCKS])
        assert.equal(locked.door_lock, 'ON')
        assert.equal(locked.pre_state, 'Running')
        assert.equal(locked.status, 'Running')
    })

    test('the countdown falls while the cycle length stays put, and energy accumulates', () => {
        const p = feed([RUNNING_COUNTDOWN])
        assert.equal(p.remaining_time, 52)
        assert.equal(p.initial_time, 54)
        assert.equal(p.spent_power, 1) // cloud: courseSpendPower 1 Wh
    })

    test('the later phases of a cycle decode from the same byte', () => {
        const rinsing = feed([RINSING])
        assert.equal(rinsing.status, 'Rinsing') // cloud: state RINSING
        assert.equal(rinsing.pre_state, 'Running')

        const spinning = feed([SPINNING])
        assert.equal(spinning.status, 'Spinning') // cloud: state SPINNING
        assert.equal(spinning.pre_state, 'Rinsing')
    })

    test('0xEB single-record frames decode with the same offsets as 0xEC', () => {
        const off = feed([EB_POWER_OFF])
        assert.equal(off.power, 'OFF') // cloud: state POWEROFF
        assert.equal(off.status, 'Off')
        assert.equal(off.pre_state, 'End')
        assert.equal(off.course, 'Bedding')
        assert.equal(off.remaining_time, 0) // zeroed while off, whatever the byte says
        assert.equal(off.spent_power, 127) // the finished cycle's energy is still there

        const ended = feed([EB_ENDS])
        assert.equal(ended.status, 'End')
        assert.equal(ended.pre_state, 'Spinning')
    })

    test('pausing and resuming a cycle moves the state and the door lock', () => {
        const paused = feed([PAUSES])
        assert.equal(paused.status, 'Pause')
        assert.equal(paused.pre_state, 'Spinning')
        assert.equal(paused.remaining_time, 5)
        assert.equal(paused.door_lock, 'ON') // still locked in the frame the pause arrives in

        const unlocked = feed([PAUSES, UNLOCKS_ON_PAUSE])
        assert.equal(unlocked.door_lock, 'OFF') // two seconds later, so the load can be reached
        assert.equal(unlocked.status, 'Pause')

        const resumed = feed([PAUSES, UNLOCKS_ON_PAUSE, RESUMES])
        assert.equal(resumed.status, 'Spinning')
        assert.equal(resumed.pre_state, 'Pause')
        assert.equal(resumed.remaining_time, 5) // the countdown does not restart
    })

    test('the end of a cycle unlocks the door and then powers off', () => {
        const ended = feed([ENDS])
        assert.equal(ended.status, 'End')
        assert.equal(ended.pre_state, 'Spinning')
        assert.equal(ended.spent_power, 144) // the whole cycle's energy
        assert.equal(ended.initial_time, 0) // the cycle-length field clears at the end
        assert.equal(ended.door_lock, 'ON')

        const unlocked = feed([ENDS, UNLOCKS_AT_END])
        assert.equal(unlocked.door_lock, 'OFF')

        const off = feed([ENDS, UNLOCKS_AT_END, POWERS_OFF])
        assert.equal(off.power, 'OFF')
        assert.equal(off.status, 'Off')
        assert.equal(off.pre_state, 'End')
        assert.equal(off.remaining_time, 0) // zeroed once off, though the byte still reads 1
        assert.equal(off.spent_power, 144) // energy survives the power-off, it is not zeroed
    })

    test('a Delay Wash publishes its countdown and its own flag', () => {
        const p = feed([DELAY_WASH])
        assert.equal(p.delay_wash, 'ON')
        assert.equal(p.reserve_time, 60) // cloud: reserveTimeMinute 60
        // the cycle's own timings are untouched by the delay
        assert.equal(p.remaining_time, 29)
        assert.equal(p.initial_time, 29)
        assert.equal(p.status, 'Initial')

        // and with no delay set the countdown reads zero rather than stale minutes
        const plain = feed([NORMAL_IDLE])
        assert.equal(plain.delay_wash, 'OFF')
        assert.equal(plain.reserve_time, 0)
    })

    test('the delay counts down only once it starts, in state Reserved', () => {
        // Armed but not started: the machine sits in Initial and the field holds what was set.
        assert.equal(feed([DELAY_WASH]).status, 'Initial')

        const started = feed([DELAY_WASH, DELAY_STARTS])
        assert.equal(started.status, 'Reserved') // cloud: state RESERVED
        assert.equal(started.delay_wash, 'ON')
        assert.equal(started.reserve_time, 60)
        assert.equal(started.drum_light, 'OFF') // cloud: drumLight DRUMLIGHT_OFF
        // the wash itself has not begun, so its own countdown is still the full cycle length
        assert.equal(started.remaining_time, 53)
        assert.equal(started.initial_time, 53)

        // and half an hour later the delay, not the cycle, is what has moved
        const later = feed([DELAY_STARTS, DELAY_COUNTS_DOWN])
        assert.equal(later.status, 'Reserved')
        assert.equal(later.reserve_time, 30) // cloud: reserveTimeMinute 30
        assert.equal(later.remaining_time, 53)
        assert.equal(later.door_lock, 'ON') // the door locks a second into the delay
    })

    test('the delay firing clears its own flag and starts the wash', () => {
        const p = feed([DELAY_COUNTS_DOWN, DELAY_FIRES])
        assert.equal(p.status, 'Running') // cloud: state RUNNING
        assert.equal(p.pre_state, 'Reserved')
        assert.equal(p.delay_wash, 'OFF') // cloud: delay DELAY_OFF
        assert.equal(p.reserve_time, 0) // cloud: reserveTimeMinute 0
        // the wash's own countdown starts from the full cycle length, untouched by the hour of delay
        assert.equal(p.remaining_time, 53)
        assert.equal(p.initial_time, 53)
        assert.equal(p.door_lock, 'ON')
    })

    test('the dispensers are told apart by the phase each one dashes in', () => {
        const p = feed([SPIN_STARTS])
        assert.equal(p.status, 'Spinning') // cloud: state SPINNING
        assert.equal(p.pre_state, 'Rinsing')
        assert.equal(p.remaining_time, 17) // cloud: remainTimeMinute 17
        // rec[31] dashes here, with the cloud naming ezCSSoftenerSetVal and nothing else
        assert.equal(p.ez_dispense_softener, 'None')
        // and rec[30] had already dashed one phase earlier, at the end of the wash
        assert.equal(p.ez_dispense_detergent, 'None')
    })

    test('a finished cycle reports End, then powers itself off', () => {
        const ended = feed([SPIN_STARTS, CYCLE_ENDS])
        assert.equal(ended.status, 'End') // cloud: state END
        assert.equal(ended.pre_state, 'Spinning')
        assert.equal(ended.power, 'ON')
        assert.equal(ended.initial_time, 0) // cloud: initialTimeMinute 0
        assert.equal(ended.remaining_time, 1) // stops at 1, not 0
        assert.equal(ended.spent_power, 83)
        assert.equal(ended.drum_light, 'ON') // cloud: drumLight DRUMLIGHT_ON

        const off = feed([CYCLE_ENDS, POWERS_OFF_AT_END])
        assert.equal(off.status, 'Off') // cloud: state POWEROFF
        assert.equal(off.pre_state, 'End')
        assert.equal(off.power, 'OFF')
        assert.equal(off.door_lock, 'OFF')
        assert.equal(off.spent_power, 83) // the energy total survives the power-off
    })

    test('the tub clean counter steps as a cycle ends', () => {
        // 34 through the wash, cloud TCLCount 34
        assert.equal(feed([SPIN_STARTS]).tub_clean_count, 34)
        // and 35 in the frame the cycle reaches End, matched by the cloud in the same second
        assert.equal(feed([SPIN_STARTS, CYCLE_ENDS]).tub_clean_count, 35)
    })

    test('the door is announced in its own frame, not in the status record', () => {
        assert.equal(feed([DOOR_OPENS]).door, 'ON')
        assert.equal(feed([DOOR_SHUTS]).door, 'OFF')

        // the frame carries nothing else, so a status record's fields survive one arriving
        const withStatus = feed([NORMAL_IDLE, DOOR_OPENS])
        assert.equal(withStatus.door, 'ON')
        assert.equal(withStatus.status, feed([NORMAL_IDLE]).status)
        assert.equal(withStatus.course, feed([NORMAL_IDLE]).course)

        // and a status record does not clear the door back to unknown
        const thenStatus = feed([DOOR_OPENS, NORMAL_IDLE])
        assert.equal(thenStatus.door, 'ON')
    })

    test('the drum light is rec[37] bit 0x40', () => {
        const on = feed([DELAY_WASH])
        assert.equal(on.drum_light, 'ON')

        const off = feed([DELAY_WASH, DRUM_LIGHT_OFF])
        assert.equal(off.drum_light, 'OFF')
        assert.equal(off.spent_power, 1) // the other byte that moved in the same frame
        assert.equal(off.delay_wash, 'ON') // and the delay is undisturbed
    })

    test('the load level reports unknown until the machine has weighed it', () => {
        const p = feed([LOAD_WEIGHED])
        assert.equal(p.load_level, 2) // cloud: LOAD_LEVEL_2

        // the 100 sentinel is what the previous record carried, before the load was sensed
        const unset = feed([NORMAL_IDLE])
        assert.equal(unset.load_level, 'None') // cloud: NOT_DEFINE_VALUE value:100
    })

    test('the second settings pass isolates one option per byte', () => {
        const soak = feed([AUTO_SOAK_ON])
        assert.equal(soak.auto_soak, 'ON') // rec[34] bit 0x80
        assert.equal(soak.turbo_wash, 'ON') // the bit beside it, undisturbed
        assert.equal(soak.pre_wash, 'OFF')

        const fresh = feed([FRESH_CARE_ON])
        assert.equal(fresh.fresh_care, 'ON') // rec[36] bit 0x40, the only byte that moved
        assert.equal(fresh.auto_soak, 'OFF')

        const lock = feed([CHILD_LOCK_ON])
        assert.equal(lock.child_lock, 'ON') // rec[37] bit 0x20
        assert.equal(lock.drum_light, 'ON') // the 0x40 bit in the same byte, undisturbed

        const maintain = feed([REMOTE_MAINTAIN_ON])
        assert.equal(maintain.remote_maintain, 'ON') // rec[40] bit 0x04
        assert.equal(maintain.delay_wash, 'ON') // a Delay Wash was armed at the time
        assert.equal(maintain.reserve_time, 60)
    })

    test('the buzzer scale and the end melody', () => {
        assert.equal(feed([BUZZER_3]).buzzer, '3') // cloud: BUZZER_3
        assert.equal(feed([AUTO_SOAK_ON]).buzzer, '4') // cloud: BUZZER_4

        // buzzer and melody went off together, which is why they are read from separate bytes but
        // have not actually been shown to move independently
        const off = feed([BUZZER_OFF])
        assert.equal(off.buzzer, 'Off')
        assert.equal(off.end_melody, 'OFF')
        assert.equal(feed([BUZZER_3]).end_melody, 'ON')
    })

    test('a cycle started at the panel sensing the load reports Detecting', () => {
        const p = feed([DETECTING])
        assert.equal(p.status, 'Detecting') // cloud: state DETECTING
        assert.equal(p.pre_state, 'Initial')
        assert.equal(p.course, 'Normal')
    })

    test('the EZDispense settings leave their sentinel when a cycle begins', () => {
        // Idle: both dispensers read LG's 0xff dash rather than a level
        const idle = feed([NORMAL_IDLE])
        assert.equal(idle.ez_dispense_detergent, 'None')
        assert.equal(idle.ez_dispense_softener, 'None')

        // Sensing: both take 0, matching the cloud's EZCSDT_OFF and EZCSSO_OFF in the same frame.
        // Which byte is which is settled by the phase each returns to the dash in, not by this frame;
        // see SPIN_STARTS and the handler comment.
        const detecting = feed([DETECTING])
        assert.equal(detecting.ez_dispense_detergent, 'Off')
        assert.equal(detecting.ez_dispense_softener, 'Off')
    })

    test('start() requests a status snapshot, so a reconnect does not leave HA blank', () => {
        // Without this the driver is purely passive: the washer only volunteers a frame when
        // something changes, so after a restart HA would sit at unknown until someone physically
        // touched the machine.
        const { thinq, dev } = makeDevice()
        dev.start()

        // AA | length | 0xF0ED status query | checksum | BB. LG's own query for this model, taken
        // verbatim from the cloud's traffic, which the washer answers with a 0xEB snapshot.
        assert.deepEqual(
            thinq.outbox.map((b) => b.toString('hex')),
            ['aa12f0ed1121010000001804111200005ebb'],
        )
    })

    test('frames that are not status records publish nothing', () => {
        const junk = [
            'aa07201902b9bb', // short 0x19
            'aa0720c302c3bb', // short 0xc3
            'aaff200a0049000fff00020103000e610f0201', // truncated 0x03 inner frame
            // a 0xEC frame cut short: the header still says 144 bytes of records, the frame is not
            'aaff200a00a2001002000100ec00900aff000e00000000bb',
        ]
        for (const frame of junk) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', buf(frame))
            assert.deepEqual(ha.devices[DEVICE_ID]?.properties ?? {}, {}, `frame ${frame} should publish nothing`)
        }
    })
})
