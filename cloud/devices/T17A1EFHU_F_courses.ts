import { SMART_COURSES } from './tl_us_washer_courses'

type SmartCourse = Exclude<(typeof SMART_COURSES.options)[number], 'Not selected'>

// Defaults from LG's T17A1EFHU_F modelJSON v0.7, SmartCourse.*.function. Course identifiers
// follow the matching T1789EFH_F top-loader catalog. Rinse is the command value, not the
// status byte: downloading a value of 1 reports 2, and downloading 2 reports 4.
type Preset = readonly [
    course: number,
    soil: number,
    spin: number,
    temp: number,
    rinse: number,
    turboWash: boolean,
    extraRinse: boolean,
    soak: boolean,
    stainCare: boolean,
]

export const SMART_COURSE_PRESETS: Record<SmartCourse, Preset> = {
    //                       Course, soil, spin, temp, rinse, Turbo, Extra, Soak, Stain
    'Small Load': [0x01, 1, 2, 4, 0, true, false, false, false],
    'Single Item': [0x07, 1, 3, 2, 0, true, false, false, false],
    'Wrinkle Stop/Gentle Wave': [0x04, 1, 1, 4, 0, false, false, false, false],
    'Rapid Clean': [0x07, 1, 3, 1, 0, true, false, false, false],
    'Sweat Stains': [0x02, 3, 3, 4, 0, true, false, true, false],
    Swimwear: [0x04, 1, 1, 2, 1, false, true, false, false],
    Curtains: [0x08, 1, 2, 4, 0, false, false, false, false],
    'Dress Shirts': [0x02, 5, 3, 5, 0, true, false, true, false],
    'Collar Stains': [0x02, 5, 3, 4, 0, true, false, false, true],
    'Pillow Covers': [0x01, 3, 3, 5, 0, true, false, false, false],
    Lingerie: [0x04, 1, 1, 4, 1, false, true, false, false],
    'Baby Wear': [0x01, 3, 3, 4, 1, true, true, false, false],
    "Children's Wear": [0x01, 5, 3, 4, 0, true, false, true, false],
    'Juice & Food Stains': [0x02, 5, 3, 5, 1, true, true, true, false],
    'Baby Bibs': [0x01, 3, 2, 5, 1, true, true, true, false],
    'Pet Hair and Odor': [0x07, 1, 4, 4, 2, true, true, false, false],
    EconoWash: [0x01, 3, 3, 2, 0, true, false, false, false],
    'Collars and Cuffs': [0x02, 5, 2, 5, 0, true, false, true, false],
    'Delicate Dresses': [0x04, 1, 1, 2, 0, false, false, false, false],
    'Half Load Wash': [0x01, 1, 3, 5, 0, true, false, false, false],
    'Full Load Wash': [0x01, 3, 4, 4, 1, true, true, false, false],
    Whites: [0x01, 5, 2, 5, 1, true, true, false, false],
}

export function smartCoursePreset(name: string): Preset | undefined {
    if (!Object.prototype.hasOwnProperty.call(SMART_COURSE_PRESETS, name)) return undefined
    return SMART_COURSE_PRESETS[name as SmartCourse]
}
