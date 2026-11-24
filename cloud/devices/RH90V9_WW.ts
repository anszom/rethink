import { Enum } from '@/util/enum'
import RC90U2_WW, { COURSES as RC90U2_COURSES } from './RC90U2_WW'

// LG RC10V9AV2W (ThinQ Model ID RH90V9_WW): heat pump dryer sending RC90U2_WW's records byte for byte,
// with two courses the RC9DN9029 does not have. Kept apart so that RC90U2_WW does not offer them.

const COURSES = new Enum<string>([
    ...RC90U2_COURSES.entries,
    ['Cotton+', 0x19],
    ['Tub Clean', 0x13], // the Drum Care button
])

export default class Device extends RC90U2_WW {
    protected courses() {
        return COURSES
    }
}
