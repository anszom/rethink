// (De)serialization of the lgcloud cloud State to disk. This is the persistence side that
// monitor.ts deliberately leaves to its callers: load a complete State or nothing, and
// save a State as a whole.

import * as fs from 'node:fs'
import { type State } from './monitor'

export const DEFAULT_STATE_FILE = 'oauth.json'

// Returns a State only if the file exists and is complete; a missing, partial or corrupt
// file yields undefined ("not logged in").
export function loadState(path: string = DEFAULT_STATE_FILE): State | undefined {
    try {
        const s = JSON.parse(fs.readFileSync(path, 'utf-8')) as Partial<State>
        if (s.countryCode && s.refreshToken) return s as State
    } catch {}
    return undefined
}

export function saveState(state: State, path: string = DEFAULT_STATE_FILE): void {
    fs.writeFileSync(path, JSON.stringify(state))
}
