import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import { Enum } from '@/util/enum'

/*
 * LG F24VDD front-load washer, deviceType 201.
 *
 * This is the deliberately narrow baseline established before the owner begins
 * the interactive capture. The appliance answered the family-wide read-only
 * F0ED status query with:
 *
 *   aa 2c | 20 eb 00 | 24 <36-byte record> | ck bb
 *   aa 52 | 20 ec 00 | <old record> 00 <current record> | ck bb
 *
 * The live capture then caught the unit timing out from INITIAL to POWER_OFF in
 * both the two-record EC transition and the following single-record EB snapshot.
 * That grounds the read-only power entity and proves that EC must use its last
 * record. The model's own MonitoringValue table supplies the state codes and
 * declares the three hour/minute pairs.
 *
 * Course, temperature, remaining/initial time were then captured live: Standard
 * course selected on the physical panel (course code 7, 40C default estimate 33
 * min), then the water temperature was raised 40C -> 60C from the ThinQ app
 * (NOT the panel) — the estimate rose to 55 min in step with the temperature
 * change, confirming the offsets.
 *
 * The owner then powered the appliance off remotely from the ThinQ app. The
 * wire captured exactly one outbound command:
 *
 *   aa 09 | f0 24 01 01 00 | ck bb
 *
 * This is byte-identical to the captured power-off command on the sibling
 * F_VB_F___W.B_2QEUK washer, so it is treated as the family-wide power-off
 * command and exposed as a writable switch. No power-ON command was captured
 * in this session (the appliance was already on throughout), so writing ON
 * is refused rather than guessed.
 *
 * The owner then discovered that selecting Standard and merely changing an
 * option (rinse count, spin, temperature) in the app does NOT reach the wire
 * at all — no TX frame appears until Start is actually pressed. Pressing
 * Start with rinse=1, spin=delicate, temp=60C sent one course-start frame and
 * the very next status record read state=Detecting (20), course=7 (Standard),
 * temperature=4 (60C) — confirming all three offsets hold during a real run,
 * not just at rest.
 *
 * The run was then paused mid-start from the ThinQ app. The wire captured:
 *
 *   aa 09 | f0 24 04 01 00 | ck bb
 *
 * — checksum-verified byte for byte, same opcode family as power-off (04
 * PAUSE vs 01 POWER, both length-1 value 00). Exposed as a Pause button.
 *
 * Resume was then pressed from the app. The wire captured a full course-start
 * frame (opcode f0 26, same course/rinse/spin/temp payload as the original
 * Start), differing from that Start frame at exactly one byte — offset 11 of
 * the inner payload goes from 0x20 (Start) to 0x00 (Resume) — everything else
 * byte-identical, checksum-verified. So Resume is implemented as "replay the
 * last Start frame with byte 11 forced to 0x00", which reproduces the exact
 * captured bytes for this run; it has not been proven across a different
 * course/option combination yet.
 *
 * A separate Start with a different course confirmed course code 1 = Steam
 * Refresh (STEAM_CLEANING in modelJSON's own ApCourse table) and that
 * reserveHour (already declared from the model's field order) reads back
 * exactly the 19-hour delay the owner set: state went to Reserved (10),
 * course 1, reserveHour 19, reserveMinute 0.
 *
 * A follow-up test changed only the reservation, from 19h to 5h, on the same
 * Steam Refresh course while the appliance was paused. Comparing the two TX
 * frames byte for byte: only inner offset 7 (the reserve-hour byte) and
 * offset 11 changed — everything else, including course, rinse, spin and
 * temp, stayed identical. This isolates offset 7 as reserve hours and (by
 * comparing against the earlier Standard start/resume pair, which showed the
 * same 0x20-vs-0x00 split) confirms offset 11 is a start-flag: 0x20 for a
 * fresh Start, 0x00 when re-arming from a state the appliance already has a
 * selection for (Resume, or changing options while paused). Both courses now
 * have a full 23-byte template with only those two bytes as variables, which
 * grounds a general Start-course/Resume builder rather than one-shot replays.
 *
 * Finally, Standard was started again with every option changed at once:
 * rinse 1->2, spin delicate->strong, temp 60C->40C, reserve 0h->3h. Comparing
 * this frame to the original Standard start isolates the last three variable
 * bytes: offset 4 is spin (matches the model's own SPIN table: 1=Extra low,
 * 4=High), offset 5 is temperature (same 3=40C/4=60C codes the status record
 * already used), offset 6 is rinse count (the literal count, matching the
 * model's RINSE_n table). The very next status record read temperature=40C
 * (record offset 10 = 3) and reserveHour=3 — both fields cross-checked
 * against what was actually selected. Rinse count and spin have no read-back
 * field of their own yet (nothing in the 36-byte record has been isolated
 * for them), so they are write-only controls for now. Because Steam Refresh
 * has only ever been captured with these three bytes at zero, spin/rinse/
 * temperature writes are restricted to courses in COURSE_WRITABLE_FIELDS
 * (currently just Standard) rather than guessed for every course.
 *
 * A fourth Standard run added a third temperature point: rinse=3, spin=Low
 * (the owner's "weak" (약), same code as the earlier "delicate" (섬세) run),
 * temp code 2, still a 3-hour reservation. The status record read back
 * temperature code 2 — grounding a third TEMPERATURE map entry (2 = 30C)
 * alongside the existing 40C/60C pair, without disturbing the already-proven
 * spin/rinse/reserve offsets.
 *
 * A fifth Standard run added rinse=4, spin=Medium (3), and cold water (냉수),
 * still a 3-hour reservation. The status record read back temperature code 1
 * for cold water, giving TEMPERATURE its fourth and final captured point;
 * the model's own temperature table has no codes below 1.
 *
 * A sixth Standard run added rinse=5 (the model's maximum, RINSE_5), spin=5
 * (the owner's "건조맞춤"/dry-fit setting — this is the model's own
 * SPIN_EXTRA_HIGH code, so "건조맞춤" and "Extra high" are the same setting
 * to the appliance), temp=60C, still a 3-hour reservation. The status record
 * read back temperature=4 (60C) and reserveHour=3, confirming the frame.
 * This is the model's last rinse count and the last spin code (0-5), so both
 * SPIN and rinse_count are now fully wire-grounded end to end for Standard.
 *
 * A seventh Standard run turned rinse and spin both off (0, the model's
 * NO_RINSE/NO_SPIN), temp=40C, 4-hour reservation. The status record read
 * back temperature=3 (40C) and reserveHour=4, confirming rinse_count/spin can
 * validly be 0 — "off" is not a refused write, it is RINSE_0/SPIN_NO_SPIN.
 *
 * The owner then started a different course, "조용조용" (Quiet), with
 * rinse=4, spin=Low ("weak"/약), temp=40C, 3h reservation, to check whether
 * a new course needs its own capture rather than reusing Standard's option
 * offsets. Comparing this frame to the Standard template byte for byte:
 * offset 2 (course) reads 9, and offsets 4/5/6/7 (spin/temp/rinse/reserve)
 * carry exactly the selected values at exactly the same positions as
 * Standard — confirming those four offsets are course-independent. Offsets
 * 10 and 12 differ from Standard's template (0 vs 128, 7 vs 5) even though
 * no option the owner changed maps to them; they are course-specific
 * constants baked into each course's own template, not general options. This
 * is why COURSE_TEMPLATE and COURSE_WRITABLE_FIELDS require a capture per
 * course: the four movable option bytes are shared, but the constant bytes
 * are not, so a course cannot be assumed to support options until captured.
 *
 * A second Quiet run changed only rinse/spin/temp (1/Extra low/60C, vs the
 * first run's 4/Low/40C), keeping the same 3h reservation. Diffing the two
 * Quiet frames: only offsets 4/5/6 moved; offsets 10 and 12 (Quiet's own
 * course constants) stayed identical across both runs, confirming they
 * really are fixed per course rather than accidentally matching once. The
 * status record read back temperature=4 (60C) and reserveHour=3, matching
 * what was set.
 *
 * The owner then started Steam Refresh again with every option left at its
 * course default (rinse/spin/temp all 0/off). The captured TX frame was
 * byte-identical to the already-stored Steam Refresh template — Steam
 * Refresh has still never been captured with a non-zero rinse/spin/temp, so
 * it remains outside COURSES_WITH_OPTIONS; this run reconfirmed the existing
 * template rather than adding new information.
 *
 * A Speedwash (course 8) run set rinse=1, spin=Medium, and left temperature
 * unselectable — reading temperature=0 (NO_TEMP) both in the TX frame and
 * the status record afterward. This matches the model's own SPEEDWASH course
 * definition, whose rinse and spin fields each declare a `selectable` list
 * but whose temp field does not — so the appliance's own UI does not offer a
 * temperature choice for this course either. Because temp has not been
 * varied on the wire for Speedwash, COURSE_WRITABLE_FIELDS marks only
 * rinse/spin as writable for course 8, leaving temp fixed at the template's
 * captured value (off) until an actual variation is captured.
 *
 * A Colorcare (course 10) run set rinse=3, spin=Low ("weak"/약), temp=30C, 3h
 * reservation. The status record read back temperature=2 (30C) and
 * reserveHour=3, confirming the same offsets hold for a fourth course. The
 * owner reported that Colorcare's app UI offers the same full rinse/spin
 * option lists as Standard/Quiet, but restricts temperature to Cold/30/40
 * (no 60) — which matches the model's own COLORCARE.temp.selectable list
 * exactly ([TEMP_COLD, TEMP_30, TEMP_40], vs Standard/Quiet's own
 * ApCourse.temp.selectable of all four codes). COURSE_WRITABLE_FIELDS.temp
 * changed from a boolean to an explicit whitelist of writable temperature
 * codes per course so this per-course subset can be enforced precisely,
 * rather than only being able to allow-all or deny-all temperature writes.
 *
 * A Rinse+Spin (course 13, RINSE_SPIN) run set rinse=1, spin=Medium ("중"),
 * temp fixed off, 3h reservation. The status record read back temperature=0
 * and reserveHour=3. The owner reported that this course's app UI only
 * offers rinse 1-5 and spin delicate/weak/medium/strong/dry-fit — no "off"
 * value for either, unlike every other captured course — while temperature
 * is shown as off and cannot be changed at all. This matches the model's own
 * RINSE_SPIN.rinse.selectable ([RINSE_1..RINSE_5], no NO_RINSE) and
 * .spin.selectable ([SPIN_VERY_LOW..SPIN_EXTRA_HIGH], no NO_SPIN) exactly,
 * and its temp field has no selectable list at all (same shape as
 * Speedwash). COURSE_WRITABLE_FIELDS.rinse/spin changed from booleans to
 * explicit whitelists alongside temp's, so a course can exclude specific
 * values (like 0/off here) rather than only allow-all or deny-all a field.
 *
 * A Speedboil (course 4, SPEEDBOIL) run set rinse=3, spin=Medium ("중"), temp
 * fixed at a new code, 3h reservation. The status record read back
 * temperature=5 at the same offset — a fifth TEMPERATURE point, 95C, above
 * the previous maximum of 60C. The owner reported this course's rinse/spin
 * options match Standard/Quiet's full lists, but temperature is fixed at
 * 95C and cannot be changed — confirmed by the model's own SPEEDBOIL.temp,
 * which declares `default: TEMP_95` with no selectable list at all (the
 * same shape as Speedwash and Rinse+Spin's fixed-temp fields).
 *
 * A Babywear (course 5, BABYWEAR) run set rinse=4, spin=Medium ("중"), temp
 * fixed off, 4h reservation. The status record read back temperature=0 and
 * reserveHour=4, confirming the same offsets hold for this eighth course.
 * The owner reported rinse/spin match Standard/Quiet's full option lists,
 * but temperature is fixed off and cannot be changed — confirmed by the
 * model's own BABYWEAR.temp, which declares `default: NO_TEMP` with no
 * selectable list at all (the same shape as Speedwash's fixed-off temp).
 *
 * An Allergy Care (course 2, ALLERGYCARE) run set rinse=4, spin=Medium
 * ("중"), temp fixed off, 3h reservation. The status record read back
 * temperature=0 and reserveHour=3, matching Babywear's shape exactly — same
 * rinse/spin defaults and full option lists, same fixed-off temp with no
 * selectable list in the model's own ALLERGYCARE.temp definition.
 *
 * A Heavy Duty (course 6, HEAVYDUTY) run set rinse=3, spin=Medium ("중"),
 * temp=60C, 4h reservation. The status record read back temperature=4 and
 * reserveHour=4. The owner reported rinse/spin match Standard/Quiet's full
 * option lists, but temperature is restricted to 40C/60C only — confirmed
 * by the model's own HEAVYDUTY.temp.selectable list of exactly
 * [TEMP_40, TEMP_60] (codes 3 and 4), the first course whose temp whitelist
 * neither spans the full range nor is empty.
 *
 * A Functional Wear (course 3, UTILITY) run set rinse=3, spin=Extra low
 * ("섬세"), temp fixed off, 3h reservation. The status record read back
 * temperature=0 and reserveHour=3. The owner reported rinse matches
 * Standard/Quiet's full option list, but spin is restricted to off/Extra
 * low only and temp is fixed off — confirmed exactly by the model's own
 * UTILITY.spin.selectable list of [NO_SPIN, SPIN_VERY_LOW] (codes 0 and 1)
 * and its temp having no selectable list at all (the same fixed-off shape
 * as Babywear and Allergy Care).
 *
 * A Duvet (course 11, DUVET) run set rinse=4, spin=Medium ("중"),
 * temp=Cold, 3h reservation. The status record read back temperature=1 and
 * reserveHour=3. The owner reported rinse matches Standard/Quiet's full
 * option list, spin is restricted to off/Extra low/Low/Medium, and temp is
 * restricted to Cold/30/40 — confirmed exactly by the model's own
 * DUVET.spin.selectable list of [NO_SPIN, SPIN_VERY_LOW, SPIN_LOW,
 * SPIN_MEDIUM] (codes 0-3, no High/Extra high) and DUVET.temp.selectable
 * of [TEMP_COLD, TEMP_30, TEMP_40] (codes 1-3, no 60C) — the first course
 * with independent partial whitelists on both spin and temp at once.
 *
 * A Lingerie/Wool (course 12, LINGERIE_WOOL) run set rinse=3, spin=Low
 * ("약"), temp=Cold, 4h reservation. The TX frame and reserve read back
 * match the selected values. The owner reported rinse matches the full list,
 * spin is restricted to off/Extra low/Low/Medium, and temp to
 * Cold/30/40 — the model's own LINGERIE_WOOL definition restricts temp to
 * the same [TEMP_COLD, TEMP_30, TEMP_40] but limits spin to only
 * [NO_SPIN, SPIN_VERY_LOW, SPIN_LOW] (codes 0-2, no Medium). The driver
 * follows the model for spin (0-2) since it is the authoritative selectable
 * list; Medium was reported available but is treated as not writable until
 * a capture shows it varying for this course.
 *
 * A Tub Clean (course 15, TUB_CLEAN) run showed all three option fields
 * fixed — rinse=2, spin=Medium, temp=60C, 3h reservation. The wire TX and
 * the status record both carry those values. The model's own TUB_CLEAN
 * definition declares no `selectable` list for any of rinse/spin/temp, only
 * `showing: NO_SELECT` with defaults RINSE_2/SPIN_MEDIUM/TEMP_60, and the
 * owner reported all three appear off/unselectable in the app — so every
 * field is treated as not writable (fixed to the captured template).
 *
 * Only fields grounded by that current baseline are exposed here. The tail of
 * the 36-byte record changes even while these values remain stable, so none of
 * its options, counters, flags, course IDs, or energy bytes are named yet. They
 * will be added only as owner-labelled transitions are captured.
 *
 * HA display conventions (device_class 'enum' + options, icons, entity naming)
 * follow the same style as the sibling washer drivers and the S5MPC styler.
 * The error and course label tables beyond what was directly observed on the
 * wire are taken from the model's own MonitoringValue.error/apCourse
 * dictionaries — the owner has approved filling these in from the model JSON
 * without a live capture for every code, since they only affect how HA
 * displays an already-correctly-decoded numeric field.
 */
const DEVICE_TYPE = 0x20
const SINGLE_STATUS = 0xeb
const DOUBLE_STATUS = 0xec
const POWER_HEARTBEAT = 0xd8
const SINGLE_BODY_LEN = 40
const DOUBLE_BODY_LEN = 78
const SINGLE_RECORD_OFFSET = 3
const DOUBLE_CURRENT_RECORD_OFFSET = 41
const RECORD_MARKER = 0x24
const STATUS_REQUEST = 'F0ED1121010000001800'
const POWER_OFF_COMMAND = 'F024010100'
const PAUSE_COMMAND = 'F024040100'

// f0 26 course-start frame templates, one per captured course. Byte 7 (0-based
// within this template) is reserve hours and byte 11 is the start-flag; both
// are overwritten by buildCourseFrame(). Every other byte matches the two
// captured frames for that course byte-for-byte and has not been varied
// independently — rinse/spin/temp are folded into the template, not exposed
// as separate controls yet.
const COURSE_TEMPLATE: Record<number, string> = {
    1: 'f026010200000000003000200100000000000000000000', // Steam Refresh (reserve zeroed here)
    7: 'f026070201040100002080200500000000000000000000', // Standard, rinse=1/spin=delicate/temp=60C
    9: 'f026090202030403002000200700000000000000000000', // Quiet (SILENT), rinse=4/spin=Low/temp=40C
    8: 'f026080203000103003080200400000000000000000000', // Speedwash, rinse=1/spin=Medium/temp=off (never seen varying)
    10: 'f0260a0202020303002000201000000000000000000000', // Colorcare, rinse=3/spin=weak(Low)/temp=30C
    13: 'f0260d0003000103002000201100000000000000000000', // Rinse+Spin, rinse=1/spin=Medium/temp=off (unselectable)
    4: 'f026040203050303002000200d00000000000000000000', // Speedboil, rinse=3/spin=Medium/temp=95C (fixed)
    5: 'f026050203000404003000200b00000000000000000000', // Babywear, rinse=4/spin=Medium/temp=off (fixed)
    2: 'f026020203000403003000200200000000000000000000', // Allergy Care, rinse=4/spin=Medium/temp=off (fixed)
    6: 'f026060303040304002000200e00000000000000000000', // Heavy Duty, rinse=3/spin=Medium/temp=60C
    3: 'f026030201000303003000200300000000000000000000', // Functional Wear, rinse=3/spin=Extra low/temp=off (fixed)
    11: 'f0260b0203010403002000200900000000000000000000', // Duvet, rinse=4/spin=Medium/temp=Cold
    12: 'f0260c0202010304002000200800000000000000000000', // Lingerie/Wool, rinse=3/spin=Low/temp=Cold
    15: 'f0260f0203040203002000200a00000000000000000000', // Tub Clean, rinse=2/spin=Medium/temp=60C (all fixed)
}
const START_FLAG = 0x20
const RESUME_FLAG = 0x00
const TEMPLATE_SPIN_OFFSET = 4
const TEMPLATE_TEMP_OFFSET = 5
const TEMPLATE_RINSE_OFFSET = 6
const TEMPLATE_RESERVE_OFFSET = 7
const TEMPLATE_FLAG_OFFSET = 11
const ALL_RINSE = [0, 1, 2, 3, 4, 5]
const ALL_SPIN = [0, 1, 2, 3, 4, 5]
const ALL_TEMP = [1, 2, 3, 4]
// Per-course, per-field write whitelists. A value is only writable for a
// course once a capture has shown that field actually varying on the wire
// for that course — a captured frame with e.g. temp always 0 does not prove
// temp is writable there, only that it defaults to off. Standard and Quiet
// have each had rinse/spin/temp independently varied across their full
// ranges and read back, and the model's own ApCourse.rinse/spin/temp
// selectable lists for both are the full sets — matching what was actually
// captured. Speedwash has only been captured once, with rinse and spin at
// non-default values and temp fixed off, matching the model's own
// SPEEDWASH.temp lacking a `selectable` list entirely (unlike its rinse/
// spin, which both declare the full lists) — so only rinse/spin are
// writable for Speedwash until a temp change is captured. Colorcare was
// captured with rinse/spin varied and temp=30C; the model's own
// COLORCARE.temp.selectable list is only [Cold,30,40] (no 60), which the
// owner also stated directly. Rinse+Spin (course 13) was captured with
// rinse=1, spin=Medium, temp fixed off; the owner reported — and the
// model's own RINSE_SPIN.rinse/spin.selectable lists confirm exactly — that
// this course excludes the 0 (off) value for both rinse and spin (unlike
// every other captured course, whose lists all start from 0), while temp
// has no selectable list at all, matching Speedwash's all-off temp. Speedboil
// (course 4) was captured with rinse/spin varied normally but temp fixed at
// 95C (code 5, a new TEMPERATURE point) — the model's own SPEEDBOIL.temp
// declares a default of TEMP_95 with no selectable list, matching Speedwash
// and Rinse+Spin's shape, and the owner confirmed 95C cannot be changed for
// this course from the app either.
const COURSE_WRITABLE_FIELDS: Record<number, { rinse: number[]; spin: number[]; temp: number[] }> = {
    7: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: ALL_TEMP },
    9: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: ALL_TEMP },
    8: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: [] },
    10: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: [1, 2, 3] },
    13: { rinse: [1, 2, 3, 4, 5], spin: [1, 2, 3, 4, 5], temp: [] },
    4: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: [] },
    5: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: [] },
    2: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: [] },
    6: { rinse: ALL_RINSE, spin: ALL_SPIN, temp: [3, 4] },
    3: { rinse: ALL_RINSE, spin: [0, 1], temp: [] },
    11: { rinse: ALL_RINSE, spin: [0, 1, 2, 3], temp: [1, 2, 3] },
    12: { rinse: ALL_RINSE, spin: [0, 1, 2], temp: [1, 2, 3] },
    15: { rinse: [], spin: [], temp: [] },
}

function buildCourseFrame(
    courseId: number,
    reserveHours: number,
    spin: number,
    temp: number,
    rinse: number,
    flag: number,
): Buffer | undefined {
    const template = COURSE_TEMPLATE[courseId]
    if (template === undefined) return undefined
    const bytes = Buffer.from(template, 'hex')
    bytes[TEMPLATE_RESERVE_OFFSET] = reserveHours
    bytes[TEMPLATE_FLAG_OFFSET] = flag
    const writable = COURSE_WRITABLE_FIELDS[courseId]
    if (writable?.spin.includes(spin)) bytes[TEMPLATE_SPIN_OFFSET] = spin
    if (writable?.temp.includes(temp)) bytes[TEMPLATE_TEMP_OFFSET] = temp
    if (writable?.rinse.includes(rinse)) bytes[TEMPLATE_RINSE_OFFSET] = rinse
    return bytes
}

// Offsets relative to the record marker byte.
const OFF = {
    marker: 0,
    state: 1,
    remainHour: 2,
    remainMinute: 3,
    initialHour: 4,
    initialMinute: 5,
    course: 6,
    error: 7,
    temperature: 10,
    reserveHour: 13,
    reserveMinute: 14,
} as const

// Exact indices from F24VDD.model.json MonitoringValue.state.
const STATE = Enum.of({
    Off: 0,
    Standby: 5,
    Pause: 6,
    'Error auto off': 7,
    Reserved: 10,
    Detecting: 20,
    'Add drain': 21,
    'Detergent amount': 22,
    Running: 23,
    Prewash: 24,
    Rinsing: 30,
    'Rinse hold': 31,
    Spinning: 40,
    Drying: 50,
    Complete: 60,
    'Fresh care': 61,
    'Freeze prevention standby': 83,
    'Freeze prevention running': 84,
    'Freeze prevention pause': 85,
    'Audible diagnosis': 101,
})

const COURSE = Enum.of({
    None: 0,
    'Allergy Care': 2,
    'Steam Refresh': 1,
    Speedboil: 4,
    Babywear: 5,
    Standard: 7,
    Speedwash: 8,
    Quiet: 9,
    Colorcare: 10,
    'Rinse+Spin': 13,
    'Heavy Duty': 6,
    'Functional Wear': 3,
    Duvet: 11,
    'Lingerie/Wool': 12,
    'Tub Clean': 15,
})

const TEMPERATURE = new Map<number, string | number>([
    [0, 'Off'],
    [1, 'Cold'],
    [2, 30],
    [3, 40],
    [4, 60],
    [5, 95],
])
const TEMPERATURE_CODE = new Map<string | number, number>([
    ['Off', 0],
    ['Cold', 1],
    [30, 2],
    [40, 3],
    [60, 4],
    [95, 5],
])

// From F24VDD.model.json MonitoringValue.spin (index -> SPIN_* label). Low(2),
// Medium(3), High(4), Extra low(1, "섬세") and Extra high(5, the owner's
// "건조맞춤"/dry-fit) have all been seen on the wire.
const SPIN = Enum.of({
    None: 0,
    'Extra low': 1,
    Low: 2,
    Medium: 3,
    High: 4,
    'Extra high': 5,
})

const ERROR_MESSAGE = Enum.of({
    Normal: 0,
    'dE2 Door open': 1,
    'IE Water inlet': 2,
    'OE Drainage': 3,
    'UE Unbalance': 4,
    'FE Overflow': 5,
    'PE Water pressure': 6,
    'tE Thermistor': 7,
    'LE Motor (BLDC)': 8,
    'CE Communication': 9,
    'dHE Service call': 10,
    'PF Power failure': 11,
    'FF Freeze protection': 12,
    'dCE Door circuit': 13,
    'VS Vibration sensor': 14,
    'EE EEPROM': 15,
    'PS Power supply': 16,
    'DE1 Door lock': 17,
    'LOE Sliding lid': 18,
    'dE4 Door': 19,
})

export default class Device extends AABBDevice {
    // Tracks what course_select/reserve_hours/spin_select/rinse_count were
    // last set to via HA, so Start course and Resume can build a full frame.
    // Defaults match the very first captured Standard start.
    private selectedCourse = 7
    private reserveHours = 0
    private spinCode = SPIN.unmap('Extra low') ?? 1
    private temperatureCode = TEMPERATURE_CODE.get(60) ?? 4
    private rinseCount = 1

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const sensor = (id: string, name: string, extra: object = {}) => ({
            platform: 'sensor',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            name,
            ...extra,
        })
        const duration = (id: string, name: string) =>
            sensor(id, name, {
                device_class: 'duration',
                unit_of_measurement: 'min',
                state_class: 'measurement',
            })
        const reading = (id: string, name: string, table: Enum<string>, extra: object = {}) =>
            sensor(id, name, {
                device_class: 'enum',
                options: table.options,
                ...extra,
            })

        const press = (id: string, name: string, icon: string) => ({
            platform: 'button',
            unique_id: `$deviceid-${id}`,
            command_topic: `$this/${id}/set`,
            payload_press: '',
            name,
            icon,
        })

        const choice = (id: string, name: string, options: string[], extra: object = {}) => ({
            platform: 'select',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            options,
            ...extra,
        })

        const number = (id: string, name: string, min: number, max: number, extra: object = {}) => ({
            platform: 'number',
            unique_id: `$deviceid-${id}`,
            state_topic: `$this/${id}`,
            command_topic: `$this/${id}/set`,
            name,
            min,
            max,
            step: 1,
            ...extra,
        })

        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: 'Power',
                        icon: 'mdi:washing-machine',
                    },
                    status: reading('status', 'Status', STATE, { icon: 'mdi:washing-machine' }),
                    course: reading('course', 'Course', COURSE, { icon: 'mdi:playlist-check' }),
                    // Only courses with a captured start template are offered — course_select
                    // is a local choice, nothing is sent until Start course is pressed.
                    course_select: choice(
                        'course_select',
                        'Course select',
                        Object.keys(COURSE_TEMPLATE)
                            .map(Number)
                            .map((id) => COURSE.map(id))
                            .filter((name) => name !== undefined) as string[],
                        { icon: 'mdi:playlist-edit' },
                    ),
                    reserve_hours: number('reserve_hours', 'Reserve hours', 0, 19, {
                        icon: 'mdi:timer-plus-outline',
                    }),
                    spin_select: choice('spin_select', 'Spin select', SPIN.options, {
                        icon: 'mdi:rotate-3d-variant',
                    }),
                    temperature_select: choice('temperature_select', 'Temperature select', ['Cold', '30', '40', '60'], {
                        icon: 'mdi:thermometer',
                    }),
                    rinse_count: number('rinse_count', 'Rinse count', 0, 5, {
                        icon: 'mdi:water-sync',
                    }),
                    start_course: press('start_course', 'Start course', 'mdi:play-circle-outline'),
                    pause: press('pause', 'Pause', 'mdi:pause-circle-outline'),
                    resume: press('resume', 'Resume', 'mdi:play-pause'),
                    // Not true device_class 'temperature': the model's own field can read
                    // "Cold" (no heating) as well as 30/40/60C, so it is a labelled setting,
                    // not a continuous physical measurement HA could show a temperature graph
                    // for.
                    temperature: sensor('temperature', 'Water temperature', {
                        icon: 'mdi:thermometer',
                    }),
                    remaining_time: duration('remaining_time', 'Remaining time'),
                    initial_time: duration('initial_time', 'Initial time'),
                    reserve_time: duration('reserve_time', 'Reserve time'),
                    error: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-error',
                        state_topic: '$this/error',
                        name: 'Error',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        device_class: 'problem',
                        entity_category: 'diagnostic',
                    },
                    error_message: reading('error_message', 'Error message', ERROR_MESSAGE, {
                        icon: 'mdi:alert-circle-outline',
                        entity_category: 'diagnostic',
                    }),
                },
            }),
        )
        this.publishProperty('course_select', COURSE.map(this.selectedCourse))
        this.publishProperty('reserve_hours', this.reserveHours)
        this.publishProperty('spin_select', SPIN.map(this.spinCode))
        this.publishProperty('temperature_select', String(TEMPERATURE.get(this.temperatureCode)))
        this.publishProperty('rinse_count', this.rinseCount)
    }

    // Family-wide read-only status request. The F24VDD answered this exact
    // packet with the CURRENT fixture used by the tests.
    start() {
        this.send(Buffer.from(STATUS_REQUEST, 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== DEVICE_TYPE) return
        if (buf[1] === POWER_HEARTBEAT && buf.length === 3) {
            this.publishProperty('power', buf[2] === 0 ? 'OFF' : 'ON')
            return
        }

        let recordOffset: number
        if (buf[1] === SINGLE_STATUS && buf.length === SINGLE_BODY_LEN) recordOffset = SINGLE_RECORD_OFFSET
        else if (buf[1] === DOUBLE_STATUS && buf.length === DOUBLE_BODY_LEN) recordOffset = DOUBLE_CURRENT_RECORD_OFFSET
        else return

        if (buf[recordOffset + OFF.marker] !== RECORD_MARKER) return

        const record = buf.subarray(recordOffset)
        const at = (offset: number) => record[offset]
        const stateCode = at(OFF.state)
        const errorCode = at(OFF.error)

        this.publishProperty('power', stateCode === 0 ? 'OFF' : 'ON')
        this.publishProperty('status', STATE.map(stateCode) ?? `Code ${stateCode}`)
        const courseCode = at(OFF.course)
        this.publishProperty('course', COURSE.map(courseCode) ?? `Code ${courseCode}`)
        this.publishProperty('temperature', TEMPERATURE.get(at(OFF.temperature)))
        this.publishProperty('remaining_time', at(OFF.remainHour) * 60 + at(OFF.remainMinute))
        this.publishProperty('initial_time', at(OFF.initialHour) * 60 + at(OFF.initialMinute))
        this.publishProperty('reserve_time', at(OFF.reserveHour) * 60 + at(OFF.reserveMinute))
        this.publishProperty('error', errorCode === 0 ? 'OFF' : 'ON')
        this.publishProperty('error_message', ERROR_MESSAGE.map(errorCode) ?? `Code ${errorCode}`)
    }

    // Only OFF is captured on the wire. No F02A ON command was observed this
    // session, so writing ON is refused rather than guessed at from siblings.
    // Pause was captured mid-run from the ThinQ app; the exact byte-for-byte
    // frame `aa 09 f0 24 04 01 00 99 bb` was verified against the checksum.
    // Start course / Resume are built from COURSE_TEMPLATE (see the header
    // comment) rather than replayed verbatim, now that two courses and two
    // reservation values isolated the reserve-hour and start-flag bytes.
    setProperty(prop: string, mqttValue: string) {
        if (prop === 'power' && mqttValue === 'OFF') {
            this.send(Buffer.from(POWER_OFF_COMMAND, 'hex'))
            return
        }
        if (prop === 'pause') {
            this.send(Buffer.from(PAUSE_COMMAND, 'hex'))
            return
        }
        if (prop === 'course_select') {
            const id = COURSE.unmap(mqttValue)
            if (id === undefined || COURSE_TEMPLATE[id] === undefined) return
            this.selectedCourse = id
            this.publishProperty('course_select', mqttValue)
            return
        }
        if (prop === 'reserve_hours') {
            const hours = Number(mqttValue)
            if (!Number.isInteger(hours) || hours < 0 || hours > 19) return
            this.reserveHours = hours
            this.publishProperty('reserve_hours', hours)
            return
        }
        if (prop === 'spin_select') {
            const code = SPIN.unmap(mqttValue)
            if (code === undefined) return
            this.spinCode = code
            this.publishProperty('spin_select', mqttValue)
            return
        }
        if (prop === 'temperature_select') {
            const numeric = Number(mqttValue)
            const code = TEMPERATURE_CODE.get(Number.isNaN(numeric) ? mqttValue : numeric)
            if (code === undefined) return
            this.temperatureCode = code
            this.publishProperty('temperature_select', mqttValue)
            return
        }
        if (prop === 'rinse_count') {
            const count = Number(mqttValue)
            if (!Number.isInteger(count) || count < 0 || count > 5) return
            this.rinseCount = count
            this.publishProperty('rinse_count', count)
            return
        }
        if (prop === 'start_course') {
            const frame = buildCourseFrame(
                this.selectedCourse,
                this.reserveHours,
                this.spinCode,
                this.temperatureCode,
                this.rinseCount,
                START_FLAG,
            )
            if (frame !== undefined) this.send(frame)
            return
        }
        if (prop === 'resume') {
            const frame = buildCourseFrame(
                this.selectedCourse,
                this.reserveHours,
                this.spinCode,
                this.temperatureCode,
                this.rinseCount,
                RESUME_FLAG,
            )
            if (frame !== undefined) this.send(frame)
            return
        }
    }
}
