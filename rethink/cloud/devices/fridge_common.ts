export type TemperatureUnit = 'C' | 'F'

export function fridgeRange(temperatureUnit: TemperatureUnit) {
    if (temperatureUnit === 'F') {
        return {
            unit_of_measurement: '°F',
            min: 33,
            max: 43,
        }
    } else {
        return {
            unit_of_measurement: '°C',
            min: 1,
            max: 7,
        }
    }
}

export function freezerRange(temperatureUnit: TemperatureUnit) {
    if (temperatureUnit === 'F') {
        return {
            unit_of_measurement: '°F',
            min: -7,
            max: 5,
        }
    } else {
        return {
            unit_of_measurement: '°C',
            min: -23,
            max: -15,
        }
    }
}

// the conversion function works the same both ways
export function convertFridgeTemperature(temperatureUnit: TemperatureUnit, input: number) {
    if (temperatureUnit === 'F') return 44 - input
    else return 8 - input
}

export function convertFreezerTemperature(temperatureUnit: TemperatureUnit, input: number) {
    if (temperatureUnit === 'F') return 6 - input
    else return -14 - input
}

// These appear to be shared across various fridge models. The buffer is truncated for lower-end models.
export const STATUS_FIELDS = [
    'monStatus',
    'fridgeSetpoint', // 44-F or 8-C
    'freezerSetpoint', // 6-F or -14-C
    'expressFreeze', // 1=off 2=on
    'freshAirFilter',
    'smartSaving',
    'waterFilter',
    'anyDoorOpen', // 0=closed 1=open
    'tempUnit', // 0=fahrenheit 1=celsius
    'smartSavingRun',
    'displayLock',
    'activeSaving',
    'ecoFriendly',
    'convertibleTemp',
    'sabbathMode',
    'dualFridge',
    'expressCool', // 0=off 1=on
    'smartCare', // 0=off 1=on
    'drawerMode',
    'pantryMode',
    'voiceMode',
    'dispenserMode',
    'dispenserCapacity',
    'dispenserUnit',
    'selfCare',
    'craftIce',
    'monDataNumber',
] as const

export type Status = Record<(typeof STATUS_FIELDS)[number], number>

export function unpackStatus(buf: Buffer): Status {
    let rv = {} as Status
    STATUS_FIELDS.forEach((key, index) => {
        if (buf.length > index) rv[key] = buf[index]
    })

    return rv
}

export function packStatus(status: Partial<Status>, length: number): Buffer {
    const rv = Buffer.alloc(length, 0xff)
    STATUS_FIELDS.forEach((key, index) => {
        if (status[key] !== undefined) rv[index] = status[key]
    })
    return rv
}
