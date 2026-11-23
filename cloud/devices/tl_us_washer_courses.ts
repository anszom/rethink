import { Enum } from '@/util/enum'

// Base course codes captured on T1789EFH_F; T17A1EFHU_F declares the same base courses.
export const COURSES = Enum.of({
    'Not selected': 0x00,
    Normal: 0x01,
    'Heavy Duty': 0x02,
    Delicates: 0x04,
    Waterproof: 0x05,
    'Speed Wash': 0x07,
    Bedding: 0x08,
    'Tub Clean': 0x0c,
    'Rinse+Spin': 0x11,
    'Spin Only': 0x12,
    'Deep Wash': 0x19,
    'Pre Wash+Normal': 0x29,
})

// US top-loader Smart Course identifiers captured on T1789EFH_F. T17A1EFHU_F's modelJSON
// declares the same catalog. These are protocol identifiers, not JSON order or image indexes.
export const SMART_COURSES = Enum.of({
    'Not selected': 0x00,
    'Small Load': 0x64,
    'Single Item': 0x65,
    'Wrinkle Stop/Gentle Wave': 0x67,
    'Rapid Clean': 0x68,
    'Sweat Stains': 0x69,
    Swimwear: 0x6a,
    Curtains: 0x6b,
    'Dress Shirts': 0x6d,
    'Collar Stains': 0x6e,
    'Pillow Covers': 0x6f,
    Lingerie: 0x70,
    'Baby Wear': 0x71,
    "Children's Wear": 0x73,
    'Juice & Food Stains': 0x74,
    'Baby Bibs': 0x75,
    'Pet Hair and Odor': 0x76,
    EconoWash: 0x77,
    'Collars and Cuffs': 0x78,
    'Delicate Dresses': 0x79,
    'Half Load Wash': 0x7a,
    'Full Load Wash': 0x7b,
    Whites: 0x83,
})
