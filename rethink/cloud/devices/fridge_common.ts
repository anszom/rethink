export type TemperatureUnit = 'C' | 'F'

export function fridgeRange(temperatureUnit: TemperatureUnit) {
    if(temperatureUnit === 'F') {
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
    if(temperatureUnit === 'F') {
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
export function convertFridgeTemperature(temperatureUnit: TemperatureUnit, input: number)
{
    if(temperatureUnit === 'F')
        return 44 - input
    else
        return 8 - input
}

export function convertFreezerTemperature(temperatureUnit: TemperatureUnit, input: number)
{
    if(temperatureUnit === 'F')
        return 6 - input
    else
        return -14 - input
}
