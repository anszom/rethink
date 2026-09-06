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

export const SPINS = [
    undefined,
    0,
    400,
    500, // assumed
    700, // assumed
    800,
    900, // assumed
    1000,
    1100,
    1200,
    1400,
    1600,
]

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
