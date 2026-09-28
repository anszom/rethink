import { Enum } from '@/util/enum'

// Code 10 is unassigned, as are 13 and 17 in STATES — the gaps are real, and reading one back leaves
// the entity unknown rather than shifting every later label by one.
export const ERRORS = Enum.of({
    OK: 0,
    'Door lock error (DE2)': 1,
    'Door open error (DE1)': 2,
    'Water supply error (IE)': 3,
    'Water drain error (OE)': 4,
    'Out of balance error (UE)': 5,
    'Overfill error (FE)': 6,
    'Water level sensor error (PE)': 7,
    'Temperature sensor error (TE)': 8,
    'Locked motor error (LE)': 9,
    'Unknown error (dHE)': 11,
    'Power fail error (PF)': 12,
    'Unknown error (FF)': 13,
    'Unknown error (DCE)': 14,
    'Unknown error (AE)': 15,
    'EEPROM error': 16,
    'Unknown error (PS)': 17,
    'Door sensor error (DE4)': 18,
    'Vibration sensor error (VS)': 19,
    'Unknown error (LE8)': 20,
    'Unknown error (LE9)': 21,
    'Unknown error (ED1)': 22,
    'Unknown error (ED2)': 23,
    'Unknown error (ED3)': 24,
    'Unknown error (ED4)': 25,
    'Unknown error (ED5)': 26,
})

export const STATES = Enum.of({
    Off: 0,
    Ready: 1,
    Paused: 2,
    Delayed: 3,
    Measuring: 4,
    'Pre-wash': 5,
    Washing: 6,
    Rinsing: 7,
    Spinning: 8,
    Drying: 9,
    End: 10,
    Cooling: 11,
    'Rinse hold': 12,
    Refreshing: 14,
    'Steam softening': 15,
    Demo: 16,
    Error: 18,
    'Auto DT Open Pause': 19,
})

// Wool and Rinse + Spin each answer under two codes, so both read back as the one label.
export const COURSES = Enum.of({
    Cotton: 0x1,
    'Ease Care': 0x2,
    'Eco 40-60': 0x4,
    Duvet: 0x5,
    Mix: 0x7,
    'Sports Wear': 0x8,
    'Night Wash': 0x9,
    'Gentle Care': 0xb,
    'Quick 14': 0xc,
    'Steam refresh': 0xd,
    'Rinse + Spin': [0xe, 0x64],
    'Drum Clean': 0x12,
    'Wash + Dry': 0x13,
    'Spin + Drain': 0x17,
    Drying: 0x18,
    Wool: [0x1b, 0x4b],
    Delicate: 0x20,
    'Quick 30': 0x22,
    'Direct Wear': 0x24,
    'Allergy Care': 0x2d,
    'Baby Steam Care': 0x2c,
    'TurboWash 39': 0x31,
    'TurboWash 59': 0x32,
    'Baby Clothes': 0x33,
    'Children Clothing': 0x34,
    'School Uniform': 0x35,
    Swimwear: 0x36,
    'Rainy Season Care': 0x37,
    'Lightly Soiled Refresh': 0x38,
    Denim: 0x39,
    Bedding: 0x3a,
    'Sweat Stains': 0x3b,
    'Single Garments': 0x3e,
    Overnight: 0x40,
    'Fast Wash + Dry': 0x42,
    'Turbo drying': 0x45,
    'Drying shirts': 0x46,
    Sanitary: 0x48,
    'Small Load': 0x49,
    'Delicate Dresses': 0x4a,
    'Cold Wash': 0x4d,
    'Powder Residue': 0x66,
    'Cuffs + Collars': 0x6b,
    'Juice + Food Stains': 0x6c,
    'Saving Time': 0x6e,
    'Reducing Wrinkles': 0x6f,
})

export const TEMPERATURES = [
    undefined,
    10,
    20,
    30,
    40,
    50, // assumed
    60,
    95,
]

// Index 3 was 500 and marked as assumed; LG's own modelJson for Y_V8_Y___W.B32QEUK calls it
// SPIN_600, and confirms 700, 900 and the rest of the table as they stood. That spec also defines
// index 255 as SPIN_Max, which has no rpm to publish and so reads back as unknown here.
export const SPINS = [undefined, 0, 400, 600, 700, 800, 900, 1000, 1100, 1200, 1400, 1600]

// From LG's modelJson for Y_V8_Y___W.B32QEUK. The two "hold" codes are an ordinary rinse count with
// the final rinse left standing in the drum, so 4 is *not* an extra rinse even though it sorts above
// RINSE_PLUS - which is what a plain `>= 2` test gets wrong.
export const RINSES = Enum.of({
    // Not "None": homeassistant.ts publishes that payload for an undefined value, and HA renders it
    // as unknown - so a label of None makes a state the appliance really reports disappear.
    'Not selected': 0,
    Normal: 1,
    'Rinse+': 2,
    'Rinse++': 3,
    'Normal, hold': 4,
    'Rinse+, hold': 5,
})

/** The rinse codes that actually add a rinse. */
export const EXTRA_RINSE_CODES = [2, 3, 5]

// Downloaded ("smart") courses are a code space of their own, separate from COURSES: the course
// field reports the *base* programme a downloaded course was built on, and this field says which
// downloaded course it actually is. LG's modelJson names all 26 of them for
// Y_V8_Y___W.B32QEUK but carries no wire codes, so this table grows one confirmed observation at a
// time; anything unmapped is published as its raw code rather than dropped.
//
// Each entry below was read off an FSR7A04PG while the course was downloaded to it, and identified
// by the base course reported alongside: modelJson states which built-in each downloadable course
// is built on, so a base narrows the candidates and often settles them outright. Where more than one
// candidate shared a base, washer_common's old COURSES table named the same code independently and
// agreed.
//
// That table, incidentally, mixes the two code spaces - it lists 0x3a as "Bedding", which is this
// space's Blanket, while 0x3a in the base-course space is AI Wash. Conflating them is what made it
// wrong for the dial of this model.
export const SMART_COURSES = Enum.of({
    // Not "None", for the same reason as RINSES above.
    'Not selected': 0,

    // Base COTTON (0x01) - modelJson gives it ten downloadable courses, and ten codes were seen on
    // that base, so the set is closed. Eight are named by washer_common's old COURSES table under
    // its own wording; the remaining two are left to the raw-code fallback below.
    'Kids Wear': 0x34, // old table: Children Clothing
    'Rainy Season': 0x37, // old table: Rainy Season Care
    'Sweat Stain': 0x3b, // old table: Sweat Stains
    'Cold Wash': 0x4d,
    'Minimize Detergent Residue': 0x66, // old table: Powder Residue
    'Sleeve Hems and Collars': 0x6b, // old table: Cuffs + Collars
    'Juice and Food Stains': 0x6c, // old table: Juice + Food Stains
    'Minimize Wrinkles': 0x6f, // old table: Reducing Wrinkles

    // Bases with a single downloadable course, which settles them outright.
    'Gym Clothes': 0x38, // base SPORTSWEAR 0x08
    Blanket: 0x3a, // base DUVET 0x05
    Hygiene: 0x48, // base ALLERGYSPASTEAM 0x2d
    'Rinse + Spin': 0x64, // base 0x0e

    // Bases with two or three, resolved by the old table and then by elimination.
    'Swimming Wear': 0x36, // base WOOL 0x1b; old table: Swimwear
    'Lightly Soiled Items': 0x65, // base WOOL, the only one left once 0x36 is Swimming Wear
    Jeans: 0x39, // base DELICATE 0x20; old table: Denim
    'Single Garment': 0x3e, // base SPEED14 0x0c; old table: Single Garments
    'Small Load': 0x49, // base SPEED14; old table: Small Load

    // The last nine, downloaded in a stated order whose base courses match modelJson's exactly -
    // two on COTTON, two on DELICATE, two on SPINONLY, then three each on a base of their own - so
    // the ordering corroborates itself rather than resting on the report alone.
    'Baby Care': 0x47,
    'Skin Care': 0x4c,
    Lingerie: 0x4a,
    'Colour Protection': 0x3f,
    Drain: 0x79,
    Spin: 0x7a,
    'MicroPlastic Care': 0x86,
    'Silent Wash': 0x84,
    'Quick Tub Clean': 0x71,
})

export const DRYING_MODES = Enum.of({
    Off: 0x0,
    Auto: 0x2,
    '00:30': 0x3,
    '01:00': 0x4,
    '01:30': 0x5,
    '02:00': 0x6,
    '02:30': 0x7,
    Iron: 0xa,
    Delicate: 0xb,
    Eco: 0xc,
})

export const DOSES = Enum.of({ Off: 0, Low: 1, Medium: 2, High: 3 })
