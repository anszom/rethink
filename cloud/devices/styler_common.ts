import { Enum } from '@/util/enum'

// Code tables shared by the stylers. ST_B_E4H01Y_APL measured them on the wire, and S5MPC's modelJSON
// declares the same `styler.state` and `styler.error` values.

/*
 * `styler.state`, which is NOT positional — the running codes jump to 50 and up. Every entry
 * below was measured by injecting that code and reading LG's own name back; 10..49 and 60
 * answer NOT_DEFINE_VALUE, so the gap is LG's.
 *
 * LG deliberately collapses phases: PREHEAT, STEAM and STAY all print Refreshing, and
 * COOLING / DRYING / ENDCOOLING all print Drying — the app shows the same.
 */
export const STATE = Enum.of({
    'Power off': 0, // POWEROFF
    Standby: 1, // INITIAL
    Styling: 2, // RUNNING
    Pause: 3, // PAUSE
    'Course complete': [4, 58, 59], // COMPLETE RUNNINGEND END_REMOTE_MAINTAIN_ON
    'Check appliance': 5, // ERROR
    'Smart diagnosing': 6, // DIAGNOSIS
    Storing: 7, // NIGHTDRY
    Reserved: 8, // RESERVED
    'Power-save running': 9, // SLEEP
    'Steam preparing': 50, // PRESTEAM
    Refreshing: [51, 52, 53], // PREHEAT STEAM STAY
    Drying: [54, 55, 56], // COOLING DRYING ENDCOOLING
    Sterilizing: 57, // STERILIZE
})

/*
 * `styler.error`, also not positional — LG's own Error table skips values. Every entry below was
 * measured by injecting the code and reading LG's name back; 12..17, 19..22, 24 and 27..30
 * answer NOT_DEFINE_VALUE. Where LG has an owner-facing label (Water refill / drain) that is
 * used rather than the service code.
 *
 * These matter beyond display: the appliance refuses to start a course while an error stands,
 * which is why Error is published as a problem sensor of its own, next to the message.
 */
export const ERROR = Enum.of({
    Normal: [0, 23], // ERROR_NO ERROR_NONE
    TE1: 1,
    TE2: 2,
    TE3: 3,
    TE4: 4,
    TE5: 5,
    E1: 6,
    E2: 7,
    'Water refill': 8, // ERROR_E3 — LG's own _comment is "E3_Water refill LED"
    E4: 9,
    LE2: 10,
    AE: 11,
    LE: 18,
    'Water drain': 25, // ERROR_DRAINE
    'Door open': 26, // ERROR_DE_OPEN
    'Check door closed': 31, // ERROR_DE_CLOSE
    E6: 32,
    PS: 33,
    'No filter': 34, // ERROR_IF
})

/** The two codes that mean "nothing wrong". Everything else stops a course from starting. */
export const ERROR_CLEAR = new Set([0, 23])
