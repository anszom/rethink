import { Enum } from '@/util/enum'
import { COURSES } from './washer_common'
import Base from './F_V__F___W.B_1QEUK'

// CV9011EC4 washer/dryer: same status record as F_V__F___W.B_1QEUK, but it also arrives in the 0x20 envelope,
// and the dial's 0x04 is Cotton+ (checked against the dial and the model JSON).
const courses: [string, number | readonly number[]][] = COURSES.entries.filter(([label]) => label !== 'Eco 40-60')
courses.push(['Cotton+', 0x04])

export default class Device extends Base {
    courses = new Enum(courses)

    processAABB(buf: Buffer) {
        if (this.processEnvelopedStatus(buf, 0x20, 39, this.processStatus)) return
        super.processAABB(buf)
    }
}
