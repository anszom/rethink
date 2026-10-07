import { Enum } from '@/util/enum'

// All names except 'Delayed Start' match the LG cloud identifiers. 'Delayed Start' was chosen
// instead of 'Reserved' for clarity. This code is not "reserved for a different purpose".

export const APPLIANCE_STATES = Enum.of({
    Off: 0,
    Ready: 1,
    Running: 2,
    Pause: 3,
    Standby: 4,
    End: 5,
})

// Not all models support all states. This is ok. An unexpected code being supported is
// harmless, the appliance should not send it anyway.
export const PROCESS_STATES = Enum.of({
    Idle: 0x00,
    'Delayed Start': 0x01,
    Washing: 0x02,
    Rinsing: 0x03,
    Drying: 0x04,
    End: 0x05,
    'Night Dry': 0x06,
    Cancel: 0x63,
})

// Dishwasher courses come from a common list, but only a subset is exposed in each model.
// This table is only for reference, course names may differ slightly across appliances
// export const COURSES = Enum.of({
//     // The course byte reads 0 with nothing selected. Deliberately not labelled 'None': that is the
//     // payload publishProperty sends for an undefined value, which HA renders as unknown, and an idle
//     // appliance would then be indistinguishable from an unrecognised course code.
//     Off: 0x00,
//     Auto: 0x01,
//     Intensive: 0x02,
//     Delicate: 0x03,
//     Turbo: 0x04,
//     'Normal/Eco': 0x05,
//     Rinse: 0x06,
//     Express: 0x08,
//     'Machine clean': 0x09,
//     'One hour': 0x12,
//     'Silent night': 0x10,
//     'Download cycle': 0x0b,
// })

// Offsets within the status record body (after the [flag][length] prefix), shared by every dishwasher
// so far. Not every model decodes every field; the bits within the flag/option bytes are model-specific
// except for the ones below. Bytes without a common meaning are read from the buffer directly.
const STATUS_FIELDS = {
    state: 0,
    process: 1,
    initialTimeHour: 3,
    initialTimeMinute: 4,
    course: 5,
    remainingTimeHour: 7,
    remainingTimeMinute: 8,
    delayTimeHour: 9,
    delayTimeMinute: 10,
    flags1: 11,
    options: 12,
    rinseLevel: 13,
    saltLevel: 14,
    flags2: 15,
    flags3: 16,
    downloadCourse: 20,
} as const

export type Status = Record<keyof typeof STATUS_FIELDS, number>

export function unpackStatus(buf: Buffer): Status {
    let rv = {} as Status
    for (const [key, index] of Object.entries(STATUS_FIELDS)) {
        if (buf.length > index) rv[key as keyof Status] = buf[index]
    }

    return rv
}

// flags1
export const FLAG1_DOOR_OPEN = 0x02

// options
export const OPTION_EXTRA_DRY = 0x04
export const OPTION_HIGH_TEMP = 0x08
