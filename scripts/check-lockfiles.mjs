#!/usr/bin/env node
/**
 * Fails when package-lock.json or pnpm-lock.yaml disagrees with the package.json files
 * (root + every workspace). The repo tracks both lockfiles (ADR-0001, "Package managers"); every
 * dependency or workspace change must regenerate both:
 *
 *   npm install && pnpm install --lockfile-only
 *
 * Runs with `npm test`; a CI workflow would run it too. Both installs are replayed in a
 * temporary copy of the manifests (lockfile-only, scripts ignored, nothing written to the
 * repo) and the resulting lockfiles are compared byte for byte.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const workspaces = root.workspaces ?? []

const only = process.argv[2] // "npm" | "pnpm" | undefined (both)
const work = mkdtempSync(join(tmpdir(), 'huntgry-lockfiles-'))
const failures = []

function copy(file) {
  const from = join(ROOT, file)
  if (!existsSync(from)) return
  mkdirSync(dirname(join(work, file)), { recursive: true })
  cpSync(from, join(work, file))
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf8', env: { ...process.env, CI: '1' }, shell: process.platform === 'win32' })
  if (r.error) throw r.error
  return r
}

function compare(name, file) {
  const before = readFileSync(join(ROOT, file), 'utf8')
  const after = readFileSync(join(work, file), 'utf8')
  if (before === after) {
    console.log(`✓ ${file} is in sync with the package.json files`)
    return
  }
  failures.push(`${file} is stale: run \`${name}\` and commit the result`)
  const a = before.split('\n')
  const b = after.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.error(`  first difference at ${file}:${i + 1}\n    tracked:   ${a[i] ?? '<end>'}\n    generated: ${b[i] ?? '<end>'}`)
      break
    }
  }
}

try {
  for (const file of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) copy(file)
  for (const ws of workspaces) copy(join(ws, 'package.json'))

  if (only !== 'pnpm') {
    // A package.json is enough for npm's lockfile-only resolution; postinstall scripts are not run.
    const r = run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'])
    if (r.status !== 0) failures.push(`npm install --package-lock-only failed:\n${r.stderr}`)
    else compare('npm install', 'package-lock.json')
  }
  if (only !== 'npm') {
    // Overrides pnpm's own "frozen in CI" default; scripts stay off because nothing is installed.
    const r = run('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts', '--reporter=silent'])
    if (r.status !== 0) failures.push(`pnpm install --lockfile-only failed (is pnpm installed?):\n${r.stderr}`)
    else compare('pnpm install --lockfile-only', 'pnpm-lock.yaml')
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f}`)
  process.exit(1)
}
