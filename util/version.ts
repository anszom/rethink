import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This is only what runs from the source tree with tsx: the build replaces the transpiled module with
// a constant (see scripts/write-version.sh).
function readRevision(): string {
    try {
        return execFileSync('git', ['describe', '--always', '--dirty', '--tags'], {
            cwd: dirname(fileURLToPath(import.meta.url)),
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
    } catch {
        return 'unknown'
    }
}

export const revision = readRevision()
