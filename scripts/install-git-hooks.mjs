#!/usr/bin/env node
// A minimalistic reimplementation of "simple-git-hooks" to work around the issue:
// https://github.com/toplenboren/simple-git-hooks/issues/132
//
// Note that the repository layout was at a later point changed to match simple-git-hooks.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.SKIP_GIT_HOOKS) {
    console.log('[install-git-hooks] SKIP_GIT_HOOKS set, skipping')
    process.exit(0)
}

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const hooks = pkg['simple-git-hooks'] ?? {}

let gitDir
try {
    gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: pkgDir,
        encoding: 'utf8',
    }).trim()
} catch {
    console.log('[install-git-hooks] not a git checkout, skipping')
    process.exit(0)
}
gitDir = resolve(pkgDir, gitDir)

const hooksDir = join(gitDir, 'hooks')
mkdirSync(hooksDir, { recursive: true })

for (const [name, command] of Object.entries(hooks)) {
    const path = join(hooksDir, name)
    const rel = relative(hooksDir, pkgDir) || '.'
    const script = `#!/bin/sh
if [ -n "$SKIP_GIT_HOOKS" ]; then exit 0; fi
cd "$(dirname "$0")/${rel}" || exit 1
${command}\n`
    writeFileSync(path, script)
    chmodSync(path, 0o755)
    console.log(`[install-git-hooks] installed ${name} -> ${path}`)
}
