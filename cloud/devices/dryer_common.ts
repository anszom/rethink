import { Enum } from '@/util/enum'

// Code tables shared by the dryers, derived from their modelJSON (MonitoringValue) and the labels the LG
// app shows for them. Codes not listed here are not known to the LG cloud either; they map to undefined.
// Course tables are not shared: the modelJSON names courses but carries no numeric codes for them.

// Status codes of the 27-inch (courseDryer27inchBase: RV13*) and 24-inch (courseDryer24inchBase:
// RC90*) dryers. Code 2 (RUNNING) is labelled "Drying" by most of these models, "Running" by a few.
export const STATES = Enum.of({
    Off: 0,
    Standby: 1, // INITIAL
    Drying: [2, 50],
    Paused: 3,
    End: 4,
    Error: 5,
    'Smart Diagnosis': 8, // AUDIBLE_DIAGNOSIS
    Cooling: 51,
    'Wrinkle care': 56,
    Delayed: 100, // RESERVED, 24-inch models only
})

// Status codes of the newer dryers (course/downloadCourse: BDH_D30007_US, BDVG_FX0003_US, SDH_GVX5_6211,
// the WashTower's dryer). Code 8 is Cooling here but Smart Diagnosis in STATES, hence the separate table.
// 'UP' here is derived from modelJSON comments like "UP가전"
export const STATES_UP = Enum.of({
    Off: 0,
    Standby: 1, // INITIAL
    Drying: [2, 7], // RUNNING, DRYING
    Paused: 3,
    End: [4, 22], // the second is END_REMOTE_MAINTAIN_ON, labelled the same in the app
    Error: 5,
    'Smart Diagnosis': 6, // AUDIBLE_DIAGNOSIS
    Cooling: 8,
    'Wrinkle care': 9,
    Delayed: [10, 12], // RESERVED, SPINREERVE
    Detecting: [11, 14], // DELAYLOAD is labelled "Detecting" by some models
    Steam: 15,
    'Clothing recognition': 16,
    'Condenser clean': 17,
    'Bedding care': 18, // BEDDINGBRUSHING
    Refreshing: 19, // DRY_REFRESHING
    'Allergy care': 20,
    'Condenser care': 21,
    'Dry ready': 23,
    'Laundry care': 24,
    Dehumidification: 25,
    'Dehumidification end': 26,
    'End waiting': 27,
    'Drum care': 28,
    'Cooldown paused': 29,
    'Cooldown standby': 30,
    // Not included, because the LG app doesn't label them:
    // 13 is AUTOTEST
    // 31 is AI_LOAD_CHECK (WashTower only, not in its modelJSON)
})

// The heat-pump models label levels 3 and 4 "Iron" and "Cupboard". The 24-inch models use another code
// space altogether (see RC90U2_WW).
export const DRY_LEVELS = Enum.of({
    'Not selected': 0,
    Damp: 1,
    Less: 2,
    Normal: 3,
    More: 4,
    Very: 5,
})

export const TEMPERATURES = Enum.of({
    'Not selected': 0,
    'Ultra Low': 1,
    Low: 2,
    Medium: 3,
    'Mid High': 4,
    High: 5,
})

// Error codes of the 27-inch dryers (STATES). Checked against the LG cloud on all four RV13 models.
export const ERRORS = Enum.of({
    OK: 0,
    'Temperature sensor error (tE1)': 1,
    'Temperature sensor error (tE2)': 2,
    'Temperature sensor error (tE5)': 5,
    'Temperature sensor error (tE6)': 6,
    'Unknown error (PS)': 13,
    'Unknown error (nP)': 19,
})

// Error codes of the newer dryers (STATES_UP), merged from their modelJSON and the WashTower's table.
// BDH_D30007_US's modelJSON numbers some of these differently (e.g. 19 as Empty water), but the LG cloud
// decodes that model's 7, 15, 19, 21 and 44 as below.
export const ERRORS_UP = Enum.of({
    OK: 0,
    'Temperature sensor error (tE1)': 1,
    'Temperature sensor error (tE2)': 2,
    'Temperature sensor error (tE3)': 3,
    'Temperature sensor error (tE4)': 4,
    'Temperature sensor error (tE5)': 5,
    'Temperature sensor error (tE6)': 6,
    'Condenser error (CE1)': 7,
    'Condenser error (CE2)': 8,
    'Heater error (HE1)': 9,
    'Unknown error (E1)': 10,
    'Unknown error (E3)': 11,
    'Unknown error (E4)': 12,
    'Unknown error (E5)': 13,
    'Drain motor error (OE)': 14,
    'Empty water container': 15,
    'Door open (dE1)': 16,
    'Filter clogged': 17,
    'Filter missing': 18,
    'EEPROM error': 19,
    'Unknown error (F1)': 20,
    'Motor error (LE2)': 21,
    'Unknown error (AE)': 22,
    'Motor error (LE1)': 31,
    'Door sensor error (dE4)': 38,
    'Motor error (LE3)': 40,
    'Door lock error (dE2)': 43,
    'Unknown error (PS)': 44,
    'Unknown error (HS)': 46,
    'Clothes not drying': 47,
    'Unknown error (nP)': 48,
    'Unknown error (IR)': 49,
    'Unknown error (BF1)': 50,
    'Gas error': 51,
    'Unknown error (dE5)': 52,
    'Dehumidification error': 53,
    'Unknown error (LO)': 54,
    'Unknown error (CC)': 55,
})

// The 24-inch models label code 3 "Time".
export const ECO_HYBRID = Enum.of({
    'Not selected': 0,
    Eco: 1,
    Normal: 2,
    Turbo: 3,
})
